# MealRescue

MealRescue is a full-stack web application for redistributing surplus food from donors to recipient organizations with volunteer coordination and admin oversight.

## Features

- Role-based authentication: donor, recipient, volunteer, and admin
- Donation creation and management with image uploads
- Recipient matching recommendations based on quantity, urgency, and distance
- Reservation workflow with stock validation and safe cancellations
- Volunteer pickup task coordination
- Notifications and admin dashboard
- SQLite database with transactional updates for reservation safety

## Quick start

1. Install dependencies:
   npm install
2. Start the app:
   npm start
3. Open http://localhost:3001

## Default accounts

- Admin: admin@mealrescue.com / admin123
- Donor: donor@mealrescue.com / donor123
- Recipient: recipient@mealrescue.com / recipient123
- Volunteer: volunteer@mealrescue.com / volunteer123

## Notes

The project is intentionally designed to run without additional infrastructure. It uses SQLite for local development and session-based authentication.
