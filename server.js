const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3001;
const appDir = __dirname;
const uploadsDir = path.join(appDir, 'uploads');
const dbPath = path.join(appDir, 'data', 'mealrescue.db');

if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const safeName = `${Date.now()}-${Math.round(Math.random() * 100000)}${ext}`;
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported image format'));
    }
  }
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir));
app.use('/public', express.static(path.join(appDir, 'public')));
app.use(session({
  secret: 'mealrescue-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
}

function getSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function allSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function withTransaction(callback) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN IMMEDIATE', async (beginErr) => {
        if (beginErr) {
          reject(beginErr);
          return;
        }

        try {
          const result = await callback();
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              reject(commitErr);
            } else {
              resolve(result);
            }
          });
        } catch (error) {
          db.run('ROLLBACK', () => reject(error));
        }
      });
    });
  });
}

function getJustLoggedUser(req) {
  return req.session && req.session.user ? req.session.user : null;
}

function requireAuth(req, res, next) {
  if (!getJustLoggedUser(req)) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    const user = getJustLoggedUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!roles.includes(user.role)) {
      return res.status(403).json({ error: 'You do not have access to this resource.' });
    }
    next();
  };
}

function normalizeRole(role) {
  return String(role || '').toLowerCase();
}

function createNotification(userId, title, message, type = 'info') {
  return runSql(
    'INSERT INTO notifications (user_id, title, message, type, is_read, created_at) VALUES (?, ?, ?, ?, 0, CURRENT_TIMESTAMP)',
    [userId, title, message, type]
  );
}

function estimateDistanceKm(startLocation, endLocation) {
  const a = String(startLocation || '').toLowerCase();
  const b = String(endLocation || '').toLowerCase();
  if (!a || !b) return 14;
  if (a === b) return 4;
  const overlap = a.split(/[^a-z0-9]+/).filter(Boolean).filter((word) => b.includes(word)).length;
  if (overlap > 0) return 6 + overlap * 3;
  return 18 + Math.abs(a.length - b.length) % 20;
}

function computeDonationMatch(donation, recipient) {
  const now = Date.now();
  const deadline = new Date(donation.collection_deadline).getTime();
  const hoursLeft = Math.max(0, (deadline - now) / (1000 * 60 * 60));
  const urgencyScore = Math.min(100, Math.max(0, (24 - Math.max(0, hoursLeft)) / 24 * 100));
  const quantityFit = Math.min(100, (donation.available_quantity / Math.max(1, donation.total_quantity)) * 100);
  const distanceScore = Math.max(0, 100 - estimateDistanceKm(donation.pickup_location, recipient.location || donation.pickup_location) * 2.5);
  const categoryScore = donation.category.toLowerCase().includes((recipient.preferred_category || '').toLowerCase()) ? 100 : 72;
  const total = Math.min(100, Math.round(
    (quantityFit * 0.28) +
    (distanceScore * 0.22) +
    (urgencyScore * 0.25) +
    (categoryScore * 0.25)
  ));

  let reason = `This donation fits your needs because it has ${donation.available_quantity} units remaining and is within ${Math.round(estimateDistanceKm(donation.pickup_location, recipient.location || donation.pickup_location))} km.`;
  if (hoursLeft < 12) {
    reason += ' It is urgent and needs quick pickup.';
  }
  if (donation.category.toLowerCase().includes((recipient.preferred_category || '').toLowerCase())) {
    reason += ' Its food category aligns with your organization profile.';
  }

  return {
    score: total,
    distanceKm: estimateDistanceKm(donation.pickup_location, recipient.location || donation.pickup_location),
    quantityFit,
    urgencyScore,
    categoryScore,
    explanation: reason,
    remainingHours: Math.max(0, Math.ceil(hoursLeft))
  };
}

async function initDatabase() {
  const schema = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      organization_name TEXT,
      location TEXT,
      phone TEXT,
      preferred_category TEXT,
      verification_status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS donations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donor_id INTEGER NOT NULL,
      food_name TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      total_quantity INTEGER NOT NULL,
      available_quantity INTEGER NOT NULL,
      preparation_time TEXT,
      storage_info TEXT,
      pickup_location TEXT,
      collection_deadline DATETIME NOT NULL,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(donor_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      donation_id INTEGER NOT NULL,
      recipient_id INTEGER NOT NULL,
      requested_quantity INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(donation_id) REFERENCES donations(id),
      FOREIGN KEY(recipient_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS pickup_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reservation_id INTEGER NOT NULL,
      donor_id INTEGER NOT NULL,
      recipient_id INTEGER NOT NULL,
      volunteer_id INTEGER,
      pickup_location TEXT,
      scheduled_time DATETIME,
      status TEXT DEFAULT 'assigned',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(reservation_id) REFERENCES reservations(id),
      FOREIGN KEY(volunteer_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`
  ];

  for (const statement of schema) {
    await runSql(statement);
  }
}

async function seedDefaultUsers() {
  const defaultAccounts = [
    {
      name: 'MealRescue Admin',
      email: 'admin@mealrescue.com',
      password: 'admin123',
      role: 'admin',
      organization_name: 'MealRescue Admin',
      location: 'City Center',
      phone: '1111111111',
      verification_status: 'approved'
    },
    {
      name: 'Green Plate Donor',
      email: 'donor@mealrescue.com',
      password: 'donor123',
      role: 'donor',
      organization_name: 'Green Plate',
      location: 'Downtown',
      phone: '2222222222',
      verification_status: 'approved'
    },
    {
      name: 'Hope Shelter',
      email: 'recipient@mealrescue.com',
      password: 'recipient123',
      role: 'recipient',
      organization_name: 'Hope Shelter',
      location: 'West End',
      phone: '3333333333',
      preferred_category: 'vegetarian',
      verification_status: 'approved'
    },
    {
      name: 'Volunteer One',
      email: 'volunteer@mealrescue.com',
      password: 'volunteer123',
      role: 'volunteer',
      organization_name: 'Community Drivers',
      location: 'North Block',
      phone: '4444444444',
      verification_status: 'approved'
    }
  ];

  for (const account of defaultAccounts) {
    const existing = await getSql('SELECT id FROM users WHERE email = ?', [account.email]);
    if (!existing) {
      const hash = await bcrypt.hash(account.password, 10);
      await runSql(
        `INSERT INTO users (name, email, password_hash, role, organization_name, location, phone, preferred_category, verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [account.name, account.email, hash, account.role, account.organization_name, account.location, account.phone, account.preferred_category || null, account.verification_status]
      );
    }
  }

  const sampleDonation = await getSql('SELECT id FROM donations WHERE food_name = ?', ['Vegetable Rice Bowl']);
  if (!sampleDonation) {
    const donor = await getSql('SELECT id FROM users WHERE email = ?', ['donor@mealrescue.com']);
    const donationDeadline = new Date(Date.now() + 1000 * 60 * 60 * 12).toISOString();
    await runSql(
      `INSERT INTO donations (donor_id, food_name, category, description, image_url, total_quantity, available_quantity, preparation_time, storage_info, pickup_location, collection_deadline, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [donor.id, 'Vegetable Rice Bowl', 'Meals', 'Fresh rice bowls prepared for community distribution.', '/uploads/sample-food.svg', 80, 80, '5:00 PM', 'Warm storage, ideally within 2 hours', 'Downtown', donationDeadline, 'active']
    );
  }
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(appDir, 'public', 'index.html'));
});

app.get('/dashboard', requireAuth, (_req, res) => {
  const user = getJustLoggedUser(_req);
  const page = user && user.role ? `${user.role}.html` : 'index.html';
  res.sendFile(path.join(appDir, 'public', page), (err) => {
    if (err) {
      res.sendFile(path.join(appDir, 'public', 'index.html'));
    }
  });
});

app.get(/^\/(donor|recipient|volunteer|admin)\.html$/, (req, res) => {
  const requestedRole = req.params[0];
  const user = getJustLoggedUser(req);

  if (!user) {
    return res.redirect('/');
  }

  if (user.role !== requestedRole) {
    return res.redirect(`/${user.role}.html`);
  }

  const page = `${requestedRole}.html`;
  res.sendFile(path.join(appDir, 'public', page), (err) => {
    if (err) {
      res.status(404).send('Page not found');
    }
  });
});

app.get('/public/:page', (_req, res) => {
  const page = _req.params.page;
  res.sendFile(path.join(appDir, 'public', page), (err) => {
    if (err) {
      res.status(404).send('Page not found');
    }
  });
});

app.get('/api/session', (req, res) => {
  const user = getJustLoggedUser(req);
  if (!user) return res.json({ user: null });
  res.json({ user });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role, organizationName, location, phone, preferredCategory } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'Name, email, password, and role are required.' });
    }

    const existing = await getSql('SELECT id FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const normalizedRole = normalizeRole(role);
    if (!['donor', 'recipient', 'volunteer', 'admin'].includes(normalizedRole)) {
      return res.status(400).json({ error: 'Invalid role selected.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const result = await runSql(
      `INSERT INTO users (name, email, password_hash, role, organization_name, location, phone, preferred_category, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), String(email).trim().toLowerCase(), hashed, normalizedRole, organizationName || null, location || null, phone || null, preferredCategory || null, normalizedRole === 'admin' ? 'approved' : 'pending']
    );

    const user = {
      id: result.id,
      name: name.trim(),
      email: String(email).trim().toLowerCase(),
      role: normalizedRole,
      organizationName: organizationName || null,
      location: location || null,
      phone: phone || null,
      preferredCategory: preferredCategory || null,
      verificationStatus: normalizedRole === 'admin' ? 'approved' : 'pending'
    };
    req.session.user = user;
    await createNotification(user.id, 'Welcome to MealRescue', 'Your account has been created. Check platform updates and pending verification status.', 'welcome');
    res.status(201).json({ message: 'Account created successfully.', user });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Unable to register user.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const userRow = await getSql('SELECT * FROM users WHERE email = ?', [String(email).trim().toLowerCase()]);
    if (!userRow) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordOk = await bcrypt.compare(password, userRow.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = {
      id: userRow.id,
      name: userRow.name,
      email: userRow.email,
      role: userRow.role,
      organizationName: userRow.organization_name,
      location: userRow.location,
      phone: userRow.phone,
      preferredCategory: userRow.preferred_category,
      verificationStatus: userRow.verification_status
    };

    req.session.user = user;
    res.json({ message: 'Login successful.', user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Unable to log in.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ message: 'Logged out successfully.' });
  });
});

app.get('/api/notifications', requireAuth, async (req, res) => {
  const rows = await allSql('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', [req.session.user.id]);
  res.json({ notifications: rows });
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  await runSql('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
  res.json({ message: 'Notification marked as read.' });
});

app.get('/api/donations', requireAuth, async (req, res) => {
  try {
    const user = req.session.user;

    if (user.role === 'donor') {
      const rows = await allSql(`SELECT d.*, u.name AS donor_name FROM donations d JOIN users u ON u.id = d.donor_id WHERE d.donor_id = ? ORDER BY d.created_at DESC`, [user.id]);
      return res.json({ donations: rows });
    }

    if (user.role === 'recipient') {
      const rows = await allSql(`SELECT d.*, u.name AS donor_name, u.location AS donor_location FROM donations d JOIN users u ON u.id = d.donor_id WHERE d.status = 'active' AND d.available_quantity > 0 AND d.collection_deadline > datetime('now') ORDER BY d.collection_deadline ASC`, []);
      const enriched = rows.map((donation) => ({
        ...donation,
        match: computeDonationMatch(donation, user)
      }));
      return res.json({ donations: enriched.sort((a, b) => b.match.score - a.match.score) });
    }

    const rows = await allSql(`SELECT d.*, u.name AS donor_name FROM donations d JOIN users u ON u.id = d.donor_id ORDER BY d.created_at DESC`, []);
    res.json({ donations: rows });
  } catch (error) {
    console.error('List donations error:', error);
    res.status(500).json({ error: 'Unable to load donations.' });
  }
});

app.post('/api/donations', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (req.session.user.role !== 'donor') {
      return res.status(403).json({ error: 'Only donors can create donation listings.' });
    }

    const {
      foodName,
      category,
      description,
      totalQuantity,
      preparationTime,
      storageInfo,
      pickupLocation,
      collectionDeadline
    } = req.body;

    if (!foodName || !category || !totalQuantity || !pickupLocation || !collectionDeadline) {
      return res.status(400).json({ error: 'Missing required donation fields.' });
    }

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : '/uploads/sample-food.svg';
    const result = await runSql(
      `INSERT INTO donations (donor_id, food_name, category, description, image_url, total_quantity, available_quantity, preparation_time, storage_info, pickup_location, collection_deadline, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [req.session.user.id, foodName, category, description || '', imageUrl, Number(totalQuantity), Number(totalQuantity), preparationTime || '', storageInfo || '', pickupLocation, new Date(collectionDeadline).toISOString()]
    );

    await createNotification(req.session.user.id, 'Donation published', `${foodName} is now available for collection.`, 'donation');
    res.status(201).json({ message: 'Donation created successfully.', donationId: result.id });
  } catch (error) {
    console.error('Create donation error:', error);
    res.status(500).json({ error: 'Unable to create donation.' });
  }
});

app.put('/api/donations/:id', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (req.session.user.role !== 'donor') {
      return res.status(403).json({ error: 'Only donors can update donation listings.' });
    }

    const donation = await getSql('SELECT * FROM donations WHERE id = ? AND donor_id = ?', [req.params.id, req.session.user.id]);
    if (!donation) {
      return res.status(404).json({ error: 'Donation not found.' });
    }

    const {
      foodName,
      category,
      description,
      totalQuantity,
      preparationTime,
      storageInfo,
      pickupLocation,
      collectionDeadline
    } = req.body;

    const imageUrl = req.file ? `/uploads/${req.file.filename}` : donation.image_url;
    const safeQuantity = Number(totalQuantity || donation.total_quantity);
    const newAvailable = Math.max(0, safeQuantity - (donation.total_quantity - donation.available_quantity));

    await runSql(
      `UPDATE donations SET food_name=?, category=?, description=?, image_url=?, total_quantity=?, available_quantity=?, preparation_time=?, storage_info=?, pickup_location=?, collection_deadline=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [foodName || donation.food_name, category || donation.category, description || donation.description, imageUrl, safeQuantity, newAvailable, preparationTime || donation.preparation_time, storageInfo || donation.storage_info, pickupLocation || donation.pickup_location, new Date(collectionDeadline || donation.collection_deadline).toISOString(), req.params.id]
    );
    res.json({ message: 'Donation updated successfully.' });
  } catch (error) {
    console.error('Update donation error:', error);
    res.status(500).json({ error: 'Unable to update donation.' });
  }
});

app.delete('/api/donations/:id', requireAuth, async (req, res) => {
  try {
    if (req.session.user.role !== 'donor') {
      return res.status(403).json({ error: 'Only donors can close donation listings.' });
    }

    const donation = await getSql('SELECT * FROM donations WHERE id = ? AND donor_id = ?', [req.params.id, req.session.user.id]);
    if (!donation) {
      return res.status(404).json({ error: 'Donation not found.' });
    }

    await runSql('UPDATE donations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['closed', req.params.id]);
    res.json({ message: 'Donation closed successfully.' });
  } catch (error) {
    console.error('Close donation error:', error);
    res.status(500).json({ error: 'Unable to close donation.' });
  }
});

app.get('/api/donations/:id/matches', requireAuth, async (req, res) => {
  try {
    const donation = await getSql('SELECT d.*, u.name AS donor_name, u.location AS donor_location FROM donations d JOIN users u ON u.id = d.donor_id WHERE d.id = ?', [req.params.id]);
    if (!donation) {
      return res.status(404).json({ error: 'Donation not found.' });
    }

    const user = await getSql('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
    const match = computeDonationMatch(donation, user);
    res.json({ donation, match });
  } catch (error) {
    console.error('Match view error:', error);
    res.status(500).json({ error: 'Unable to compute match.' });
  }
});

app.get('/api/reservations', requireAuth, async (req, res) => {
  const user = req.session.user;
  let query = '';
  let params = [];

  if (user.role === 'recipient') {
    query = `SELECT r.*, d.food_name, d.pickup_location, d.collection_deadline, u.name AS donor_name FROM reservations r JOIN donations d ON d.id = r.donation_id JOIN users u ON u.id = d.donor_id WHERE r.recipient_id = ? ORDER BY r.requested_at DESC`;
    params = [user.id];
  } else if (user.role === 'donor') {
    query = `SELECT r.*, d.food_name, d.pickup_location, u.name AS recipient_name FROM reservations r JOIN donations d ON d.id = r.donation_id JOIN users u ON u.id = r.recipient_id WHERE d.donor_id = ? ORDER BY r.requested_at DESC`;
    params = [user.id];
  } else {
    query = `SELECT r.*, d.food_name, u.name AS donor_name FROM reservations r JOIN donations d ON d.id = r.donation_id JOIN users u ON u.id = d.donor_id WHERE r.status IN ('accepted','pending') ORDER BY r.requested_at DESC`;
  }

  const rows = await allSql(query, params);
  res.json({ reservations: rows });
});

app.post('/api/reservations', requireAuth, async (req, res) => {
  try {
    if (req.session.user.role !== 'recipient') {
      return res.status(403).json({ error: 'Only recipient organizations can request food.' });
    }

    const { donationId, quantity } = req.body;
    if (!donationId || !quantity || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'A valid quantity is required.' });
    }

    const requestQty = Number(quantity);
    await withTransaction(async () => {
      const donation = await getSql('SELECT * FROM donations WHERE id = ?', [donationId]);
      if (!donation) throw new Error('Donation not found.');
      if (donation.status !== 'active') throw new Error('This donation is no longer active.');
      if (requestQty > donation.available_quantity) throw new Error('Requested quantity exceeds the remaining stock.');

      const existing = await getSql('SELECT id FROM reservations WHERE donation_id = ? AND recipient_id = ? AND status IN (\'pending\', \'accepted\')', [donationId, req.session.user.id]);
      if (existing) {
        throw new Error('You already have an active reservation for this donation.');
      }

      await runSql(
        'INSERT INTO reservations (donation_id, recipient_id, requested_quantity, status, requested_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
        [donationId, req.session.user.id, requestQty, 'pending']
      );

      const donor = await getSql('SELECT * FROM users WHERE id = ?', [donation.donor_id]);
      await createNotification(donor.id, 'New reservation request', `${req.session.user.organizationName || req.session.user.name} requested ${requestQty} units from ${donation.food_name}.`, 'reservation');
      await createNotification(req.session.user.id, 'Reservation submitted', `Your request for ${requestQty} units of ${donation.food_name} is pending donor approval.`, 'reservation');
    });

    res.json({ message: 'Reservation request submitted successfully.' });
  } catch (error) {
    console.error('Reservation error:', error);
    res.status(400).json({ error: error.message || 'Unable to submit reservation request.' });
  }
});

app.post('/api/reservations/:id/decision', requireAuth, async (req, res) => {
  try {
    if (req.session.user.role !== 'donor') {
      return res.status(403).json({ error: 'Only donors can accept or reject reservations.' });
    }

    const { decision } = req.body;
    const validDecisions = ['accepted', 'rejected', 'cancelled'];
    if (!validDecisions.includes(decision)) {
      return res.status(400).json({ error: 'Invalid decision.' });
    }

    await withTransaction(async () => {
      const reservation = await getSql('SELECT r.*, d.donor_id, d.food_name, d.available_quantity, d.total_quantity, d.pickup_location FROM reservations r JOIN donations d ON d.id = r.donation_id WHERE r.id = ?', [req.params.id]);
      if (!reservation) throw new Error('Reservation not found.');
      if (reservation.donor_id !== req.session.user.id) {
        throw new Error('You are not authorized to manage this reservation.');
      }

      if (decision === 'accepted') {
        if (reservation.status !== 'pending') throw new Error('This reservation is already processed.');
        if (reservation.available_quantity < reservation.requested_quantity) throw new Error('Not enough quantity left to accept this request.');

        await runSql('UPDATE reservations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['accepted', req.params.id]);
        const nextAvailable = reservation.available_quantity - reservation.requested_quantity;
        await runSql('UPDATE donations SET available_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextAvailable, reservation.donation_id]);

        const recipient = await getSql('SELECT * FROM users WHERE id = ?', [reservation.recipient_id]);
        await createNotification(recipient.id, 'Reservation accepted', `Your request for ${reservation.requested_quantity} units of ${reservation.food_name} has been accepted.`, 'acceptance');

        const volunteer = await getSql('SELECT * FROM users WHERE role = ? ORDER BY id LIMIT 1', ['volunteer']);
        await runSql(
          `INSERT INTO pickup_tasks (reservation_id, donor_id, recipient_id, volunteer_id, pickup_location, scheduled_time, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'assigned', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [reservation.id, reservation.donor_id, reservation.recipient_id, volunteer ? volunteer.id : null, reservation.pickup_location || 'Donor location', new Date(Date.now() + 1000 * 60 * 60 * 4).toISOString()]
        );
        if (volunteer) {
          await createNotification(volunteer.id, 'New pickup task', `Pickup assigned for ${reservation.food_name}. Confirm pickup and delivery schedule.`, 'pickup');
        }
      }

      if (decision === 'rejected') {
        if (reservation.status === 'cancelled') throw new Error('This reservation has already been cancelled.');
        await runSql('UPDATE reservations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['rejected', req.params.id]);
        const recipient = await getSql('SELECT * FROM users WHERE id = ?', [reservation.recipient_id]);
        await createNotification(recipient.id, 'Reservation rejected', `Your request for ${reservation.food_name} was not approved by the donor.`, 'rejection');
      }

      if (decision === 'cancelled') {
        if (reservation.status === 'accepted') {
          const donation = await getSql('SELECT * FROM donations WHERE id = ?', [reservation.donation_id]);
          await runSql('UPDATE donations SET available_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [donation.available_quantity + reservation.requested_quantity, reservation.donation_id]);
        }
        await runSql('UPDATE reservations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['cancelled', req.params.id]);
        const donor = await getSql('SELECT * FROM users WHERE id = ?', [reservation.donor_id]);
        await createNotification(donor.id, 'Reservation cancelled', `A reservation for ${reservation.food_name} was cancelled by the recipient.`, 'cancellation');
      }
    });

    res.json({ message: `Reservation ${decision} successfully.` });
  } catch (error) {
    console.error('Reservation decision error:', error);
    res.status(400).json({ error: error.message || 'Unable to update reservation status.' });
  }
});

app.get('/api/tasks', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'volunteer') {
    const rows = await allSql(`SELECT t.*, r.requested_quantity, d.food_name, d.pickup_location AS donation_location, donor.name AS donor_name, recipient.name AS recipient_name
      FROM pickup_tasks t
      JOIN reservations r ON r.id = t.reservation_id
      JOIN donations d ON d.id = r.donation_id
      JOIN users donor ON donor.id = d.donor_id
      JOIN users recipient ON recipient.id = r.recipient_id
      WHERE t.volunteer_id = ? ORDER BY t.created_at DESC`, [user.id]);
    return res.json({ tasks: rows });
  }

  const rows = await allSql(`SELECT t.*, r.requested_quantity, d.food_name, donor.name AS donor_name, recipient.name AS recipient_name FROM pickup_tasks t JOIN reservations r ON r.id = t.reservation_id JOIN donations d ON d.id = r.donation_id JOIN users donor ON donor.id = d.donor_id JOIN users recipient ON recipient.id = r.recipient_id WHERE t.donor_id = ? OR t.recipient_id = ? ORDER BY t.created_at DESC`, [user.id, user.id]);
  res.json({ tasks: rows });
});

app.post('/api/tasks/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['accepted', 'collected', 'delivered', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid task status.' });
    }

    const task = await getSql('SELECT * FROM pickup_tasks WHERE id = ?', [req.params.id]);
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const user = req.session.user;
    if (user.role !== 'volunteer' && user.id !== task.donor_id && user.id !== task.recipient_id) {
      return res.status(403).json({ error: 'You cannot update this task.' });
    }

    await runSql('UPDATE pickup_tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, req.params.id]);
    const donor = await getSql('SELECT * FROM users WHERE id = ?', [task.donor_id]);
    const recipient = await getSql('SELECT * FROM users WHERE id = ?', [task.recipient_id]);

    if (status === 'accepted') {
      await createNotification(donor.id, 'Pickup accepted', 'The volunteer has accepted the assigned pickup task.', 'pickup');
      await createNotification(recipient.id, 'Pickup accepted', 'The volunteer has accepted the pickup assignment and will coordinate collection.', 'pickup');
    }

    if (status === 'collected') {
      await createNotification(donor.id, 'Food collected', 'The food has been collected from the donor and is en route.', 'pickup');
      await createNotification(recipient.id, 'Food collected', 'The food has been collected and is being delivered.', 'pickup');
    }

    if (status === 'delivered' || status === 'completed') {
      await runSql('UPDATE reservations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['completed', task.reservation_id]);
      await createNotification(donor.id, 'Delivery completed', 'The donation has been successfully delivered and recorded.', 'pickup');
      await createNotification(recipient.id, 'Delivery completed', 'The donation has been successfully delivered and recorded.', 'pickup');
    }

    res.json({ message: 'Pickup status updated.' });
  } catch (error) {
    console.error('Task update error:', error);
    res.status(500).json({ error: 'Unable to update task status.' });
  }
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
  const user = req.session.user;

  if (user.role === 'donor') {
    const donations = await allSql('SELECT * FROM donations WHERE donor_id = ? ORDER BY created_at DESC', [user.id]);
    const reservations = await allSql(`SELECT r.*, d.food_name, u.name AS recipient_name FROM reservations r JOIN donations d ON d.id = r.donation_id JOIN users u ON u.id = r.recipient_id WHERE d.donor_id = ? ORDER BY r.requested_at DESC`, [user.id]);
    const notifications = await allSql('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [user.id]);
    return res.json({ role: 'donor', donations, reservations, notifications, stats: { donations: donations.length, pending: reservations.filter((r) => r.status === 'pending').length, accepted: reservations.filter((r) => r.status === 'accepted').length, cancelled: reservations.filter((r) => r.status === 'cancelled').length } });
  }

  if (user.role === 'recipient') {
    const reservations = await allSql(`SELECT r.*, d.food_name, d.pickup_location, u.name AS donor_name FROM reservations r JOIN donations d ON d.id = r.donation_id JOIN users u ON u.id = d.donor_id WHERE r.recipient_id = ? ORDER BY r.requested_at DESC`, [user.id]);
    const donations = await allSql(`SELECT d.*, u.name AS donor_name FROM donations d JOIN users u ON u.id = d.donor_id WHERE d.status = 'active' AND d.available_quantity > 0 ORDER BY d.collection_deadline ASC`, []);
    const matches = donations.map((donation) => ({ ...donation, match: computeDonationMatch(donation, user) })).sort((a,b) => b.match.score - a.match.score);
    const notifications = await allSql('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [user.id]);
    return res.json({ role: 'recipient', reservations, donations: matches, notifications, stats: { available: donations.length, totalRequests: reservations.length, accepted: reservations.filter((r) => r.status === 'accepted').length } });
  }

  if (user.role === 'volunteer') {
    const tasks = await allSql(`SELECT t.*, d.food_name, donor.name AS donor_name, recipient.name AS recipient_name FROM pickup_tasks t JOIN reservations r ON r.id = t.reservation_id JOIN donations d ON d.id = r.donation_id JOIN users donor ON donor.id = d.donor_id JOIN users recipient ON recipient.id = r.recipient_id WHERE t.volunteer_id = ? ORDER BY t.created_at DESC`, [user.id]);
    const notifications = await allSql('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [user.id]);
    return res.json({ role: 'volunteer', tasks, notifications, stats: { assigned: tasks.filter((t) => t.status === 'assigned').length, collected: tasks.filter((t) => t.status === 'collected').length, completed: tasks.filter((t) => t.status === 'completed').length } });
  }

  const totalUsers = await getSql('SELECT COUNT(*) AS total FROM users');
  const totalDonors = await getSql('SELECT COUNT(*) AS total FROM users WHERE role = ?', ['donor']);
  const totalRecipients = await getSql('SELECT COUNT(*) AS total FROM users WHERE role = ?', ['recipient']);
  const totalVolunteers = await getSql('SELECT COUNT(*) AS total FROM users WHERE role = ?', ['volunteer']);
  const totalDonations = await getSql('SELECT COUNT(*) AS total FROM donations');
  const availableDonations = await getSql('SELECT COUNT(*) AS total FROM donations WHERE status = ? AND available_quantity > 0', ['active']);
  const reservedDonations = await getSql('SELECT COUNT(*) AS total FROM reservations WHERE status = ?', ['accepted']);
  const deliveredDonations = await getSql('SELECT COUNT(*) AS total FROM reservations WHERE status = ?', ['completed']);
  const cancelledDonations = await getSql('SELECT COUNT(*) AS total FROM reservations WHERE status = ?', ['cancelled']);
  const pendingOrganizations = await allSql('SELECT * FROM users WHERE role IN (\'donor\', \'recipient\', \'volunteer\') AND verification_status = ? ORDER BY created_at DESC', ['pending']);

  return res.json({
    role: 'admin',
    stats: {
      totalUsers: totalUsers.total,
      totalDonors: totalDonors.total,
      totalRecipients: totalRecipients.total,
      totalVolunteers: totalVolunteers.total,
      totalDonations: totalDonations.total,
      availableDonations: availableDonations.total,
      reservedDonations: reservedDonations.total,
      deliveredDonations: deliveredDonations.total,
      cancelledDonations: cancelledDonations.total
    },
    pendingOrganizations
  });
});

app.get('/api/admin/users', requireRole(['admin']), async (_req, res) => {
  const rows = await allSql('SELECT * FROM users ORDER BY created_at DESC');
  res.json({ users: rows });
});

app.post('/api/admin/users/:id/verify', requireRole(['admin']), async (req, res) => {
  const { status } = req.body;
  const allowed = ['approved', 'rejected', 'pending'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid verification status.' });
  }

  await runSql('UPDATE users SET verification_status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ message: 'Verification updated.' });
});

app.listen(PORT, async () => {
  await initDatabase();
  await seedDefaultUsers();
  console.log(`MealRescue server running at http://localhost:${PORT}`);
});
