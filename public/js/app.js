const state = { user: null };

function setMessage(text, isError = false) {
  const el = document.getElementById('auth-message');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? '#b63d3d' : '#2b8f5d';
}

function appendTypeBadge(status) {
  const value = String(status || 'pending').toLowerCase();
  const map = {
    accepted: 'badge success',
    pending: 'badge warning',
    rejected: 'badge danger',
    cancelled: 'badge danger',
    active: 'badge',
    closed: 'badge danger',
    completed: 'badge success',
    assigned: 'badge info',
    collected: 'badge warning'
  };
  return `<span class="${map[value] || 'badge info'}">${status || 'pending'}</span>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

function initAuthUI() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((item) => item.classList.toggle('active', item === tab));
      const target = tab.dataset.target;
      document.querySelectorAll('.auth-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== target));
    });
  });

  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(loginForm);
      const payload = {
        email: formData.get('email'),
        password: formData.get('password')
      };

      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error || 'Login failed.', true);
        return;
      }
      state.user = data.user;
      window.location.href = `/${data.user.role}.html`;
    });
  }

  const registerForm = document.getElementById('register-form');
  if (registerForm) {
    registerForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(registerForm);
      const payload = {
        name: formData.get('name'),
        email: formData.get('email'),
        password: formData.get('password'),
        role: formData.get('role'),
        organizationName: formData.get('organizationName'),
        location: formData.get('location'),
        phone: formData.get('phone')
      };

      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error || 'Registration failed.', true);
        return;
      }
      state.user = data.user;
      window.location.href = `/${data.user.role}.html`;
    });
  }

  const logoutButton = document.getElementById('logout-btn');
  if (logoutButton) {
    logoutButton.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/';
    });
  }
}

async function requireUser(pageRole) {
  const sessionResponse = await fetch('/api/session');
  const sessionData = await sessionResponse.json();
  const user = sessionData.user;
  if (!user) {
    window.location.href = '/';
    return null;
  }
  state.user = user;
  const userPill = document.getElementById('user-pill');
  if (userPill) {
    userPill.textContent = `${user.name} • ${user.role}`;
  }
  if (pageRole && user.role !== pageRole) {
    window.location.href = `/${user.role}.html`;
    return null;
  }
  return user;
}

function renderStats(stats) {
  const statsGrid = document.getElementById('stats-grid');
  if (!statsGrid || !stats) return;

  const entries = Object.entries(stats).map(([label, value]) => ({
    label: label.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase()).replace(/\s+/g, ' '),
    value
  }));

  statsGrid.innerHTML = entries.map((entry) => `
    <div class="stat-card">
      <h3>${escapeHtml(entry.label)}</h3>
      <div class="value">${escapeHtml(String(entry.value))}</div>
    </div>
  `).join('');
}

function renderNotifications(notifications) {
  const target = document.getElementById('notifications');
  if (!target) return;
  if (!Array.isArray(notifications) || notifications.length === 0) {
    target.innerHTML = '<div class="notification-item">No notifications yet.</div>';
    return;
  }

  target.innerHTML = notifications.map((item) => `
    <div class="notification-item">
      <strong>${escapeHtml(item.title)}</strong>
      <div class="small mt-2">${escapeHtml(item.message)}</div>
      <div class="small mt-2">${new Date(item.created_at).toLocaleString()}</div>
    </div>
  `).join('');
}

function renderDonorDashboard(data) {
  renderStats(data.stats);
  renderNotifications(data.notifications || []);

  const donationList = document.getElementById('donation-list');
  if (donationList) {
    if (!data.donations || data.donations.length === 0) {
      donationList.innerHTML = '<div class="small">No donations yet.</div>';
      return;
    }

    donationList.innerHTML = '<table><thead><tr><th>Food</th><th>Available</th><th>Deadline</th><th>Status</th></tr></thead><tbody>' + data.donations.map((item) => `
      <tr>
        <td>${escapeHtml(item.food_name)}<div class="small">${escapeHtml(item.category)}</div></td>
        <td>${escapeHtml(String(item.available_quantity))}/${escapeHtml(String(item.total_quantity))}</td>
        <td>${new Date(item.collection_deadline).toLocaleString()}</td>
        <td>${appendTypeBadge(item.status)}</td>
      </tr>
    `).join('') + '</tbody></table>';
  }

  const reservationList = document.getElementById('reservation-list');
  if (reservationList) {
    if (!data.reservations || data.reservations.length === 0) {
      reservationList.innerHTML = '<div class="small">No reservation requests received.</div>';
      return;
    }

    reservationList.innerHTML = data.reservations.map((item) => `
      <div class="notification-item">
        <div><strong>${escapeHtml(item.food_name)}</strong> — Qty ${escapeHtml(String(item.requested_quantity))}</div>
        <div class="small">Recipient: ${escapeHtml(item.recipient_name || 'Unknown')}</div>
        <div class="mt-2">${appendTypeBadge(item.status)}</div>
        ${item.status === 'pending' ? `
          <div class="inline-actions mt-2">
            <button class="button" data-action="accepted" data-reservation="${item.id}">Accept</button>
            <button class="button danger" data-action="rejected" data-reservation="${item.id}">Reject</button>
          </div>
        ` : ''}
      </div>
    `).join('');

    reservationList.querySelectorAll('[data-reservation]').forEach((button) => {
      button.addEventListener('click', async () => {
        const response = await fetch(`/api/reservations/${button.dataset.reservation}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: button.dataset.action })
        });
        const data = await response.json();
        if (!response.ok) {
          alert(data.error || 'Unable to update reservation.');
          return;
        }
        alert(data.message);
        window.location.reload();
      });
    });
  }

  const donationForm = document.getElementById('donation-form');
  if (donationForm) {
    donationForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(donationForm);
      const response = await fetch('/api/donations', {
        method: 'POST',
        body: formData
      });
      const result = await response.json();
      if (!response.ok) {
        alert(result.error || 'Unable to create donation.');
        return;
      }
      alert(result.message || 'Donation created.');
      donationForm.reset();
      window.location.reload();
    });
  }
}

function renderRecipientDashboard(data) {
  renderStats({
    Available: data.stats?.available || 0,
    Requests: data.stats?.totalRequests || 0,
    Accepted: data.stats?.accepted || 0
  });
  renderNotifications(data.notifications || []);

  const donationList = document.getElementById('donation-list');
  if (donationList) {
    const donations = data.donations || [];
    donationList.innerHTML = donations.map((item) => `
      <div class="notification-item">
        <div style="display:flex; justify-content:space-between; gap:12px; align-items:center;">
          <div>
            <strong>${escapeHtml(item.food_name)}</strong>
            <div class="small">${escapeHtml(item.category)} • ${escapeHtml(item.donor_name || 'Donor')}</div>
          </div>
          <span class="badge">${escapeHtml(String(item.match && item.match.score))}% match</span>
        </div>
        <div class="small mt-2">Distance: ${escapeHtml(String(item.match ? item.match.distanceKm : 0))} km • Available: ${escapeHtml(String(item.available_quantity))}</div>
        <div class="small mt-2">${escapeHtml(item.match ? item.match.explanation : '')}</div>
        <form class="inline-actions mt-2" data-request-form data-donation="${item.id}">
          <input type="number" min="1" max="${item.available_quantity}" value="${Math.min(10, item.available_quantity)}" name="quantity" style="max-width: 110px;" />
          <button type="submit" class="button">Request</button>
        </form>
      </div>
    `).join('') || '<div class="small">No donations currently available.</div>';

    donationList.querySelectorAll('[data-request-form]').forEach((form) => {
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const donationId = form.dataset.donation;
        const quantity = new FormData(form).get('quantity');
        const response = await fetch('/api/reservations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ donationId, quantity })
        });
        const result = await response.json();
        if (!response.ok) {
          alert(result.error || 'Unable to request donation.');
          return;
        }
        alert(result.message || 'Request sent.');
        window.location.reload();
      });
    });
  }

  const reservationList = document.getElementById('reservation-list');
  if (reservationList) {
    const rows = data.reservations || [];
    reservationList.innerHTML = rows.length ? rows.map((item) => `
      <div class="notification-item">
        <strong>${escapeHtml(item.food_name)}</strong>
        <div class="small">Qty: ${escapeHtml(String(item.requested_quantity))}</div>
        <div class="mt-2">${appendTypeBadge(item.status)}</div>
      </div>
    `).join('') : '<div class="small">No reservation history.</div>';
  }
}

function renderVolunteerDashboard(data) {
  renderStats({
    Assigned: data.stats?.assigned || 0,
    Collected: data.stats?.collected || 0,
    Completed: data.stats?.completed || 0
  });
  renderNotifications(data.notifications || []);

  const taskList = document.getElementById('task-list');
  if (taskList) {
    if (!data.tasks || data.tasks.length === 0) {
      taskList.innerHTML = '<div class="small">No tasks assigned yet.</div>';
      return;
    }

    taskList.innerHTML = data.tasks.map((task) => `
      <div class="notification-item">
        <div><strong>${escapeHtml(task.food_name)}</strong></div>
        <div class="small">Donor: ${escapeHtml(task.donor_name)} • Recipient: ${escapeHtml(task.recipient_name)}</div>
        <div class="small mt-2">Location: ${escapeHtml(task.pickup_location || task.donation_location || 'Main pickup point')}</div>
        <div class="mt-2">${appendTypeBadge(task.status)}</div>
        <div class="inline-actions mt-2">
          ${task.status === 'assigned' ? '<button class="button" data-task-action="accepted" data-task-id="' + task.id + '">Accept task</button>' : ''}
          ${task.status !== 'completed' ? '<button class="button secondary" data-task-action="collected" data-task-id="' + task.id + '">Mark collected</button>' : ''}
          ${task.status === 'collected' ? '<button class="button" data-task-action="delivered" data-task-id="' + task.id + '">Mark delivered</button>' : ''}
        </div>
      </div>
    `).join('');

    taskList.querySelectorAll('[data-task-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const response = await fetch(`/api/tasks/${button.dataset.taskId}/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: button.dataset.taskAction })
        });
        const result = await response.json();
        if (!response.ok) {
          alert(result.error || 'Unable to update task.');
          return;
        }
        alert(result.message || 'Task updated.');
        window.location.reload();
      });
    });
  }
}

function renderAdminDashboard(data) {
  renderStats(data.stats);

  const orgList = document.getElementById('org-list');
  if (orgList) {
    const pendingOrganizations = data.pendingOrganizations || [];
    orgList.innerHTML = pendingOrganizations.length ? pendingOrganizations.map((person) => `
      <div class="notification-item">
        <strong>${escapeHtml(person.name)}</strong>
        <div class="small">${escapeHtml(person.organization_name || 'No organization')} • ${escapeHtml(person.role)}</div>
        <div class="small mt-2">${escapeHtml(person.email)}</div>
        <div class="inline-actions mt-2">
          <button class="button" data-verify="approved" data-user-id="${person.id}">Approve</button>
          <button class="button danger" data-verify="rejected" data-user-id="${person.id}">Reject</button>
        </div>
      </div>
    `).join('') : '<div class="small">No pending approvals.</div>';

    orgList.querySelectorAll('[data-verify]').forEach((button) => {
      button.addEventListener('click', async () => {
        const response = await fetch(`/api/admin/users/${button.dataset.userId}/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: button.dataset.verify })
        });
        const result = await response.json();
        if (!response.ok) {
          alert(result.error || 'Unable to update verification.');
          return;
        }
        alert(result.message || 'Verification updated.');
        window.location.reload();
      });
    });
  }
}

async function loadDashboardPage() {
  const page = window.location.pathname.replace('/', '').replace(/\.(html)?$/, '') || 'index';
  if (page === 'index') {
    return;
  }

  const user = await requireUser(page);
  if (!user) return;

  const response = await fetch('/api/dashboard');
  const data = await response.json();

  if (page === 'donor') {
    renderDonorDashboard(data);
  }
  if (page === 'recipient') {
    renderRecipientDashboard(data);
  }
  if (page === 'volunteer') {
    renderVolunteerDashboard(data);
  }
  if (page === 'admin') {
    renderAdminDashboard(data);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initAuthUI();
  loadDashboardPage();
});
