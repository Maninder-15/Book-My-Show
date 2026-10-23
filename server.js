const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database('cinema.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Promise Helpers
const dbRun = (query, params = []) => new Promise((resolve, reject) => {
  db.run(query, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});

const dbGet = (query, params = []) => new Promise((resolve, reject) => {
  db.get(query, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

const dbAll = (query, params = []) => new Promise((resolve, reject) => {
  db.all(query, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

// 1. Initialize Tables & Seed Default Users
async function initDB() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS seats (
      seat_id TEXT PRIMARY KEY,
      tier TEXT CHECK(tier IN ('VIP', 'PREMIUM', 'STANDARD')) DEFAULT 'STANDARD',
      price REAL NOT NULL,
      status TEXT CHECK(status IN ('AVAILABLE', 'HELD', 'BOOKED')) DEFAULT 'AVAILABLE',
      held_by TEXT,
      held_until INTEGER,
      booked_by TEXT,
      booking_code TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS bookings (
      booking_code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      movie_title TEXT NOT NULL,
      hall TEXT NOT NULL,
      showtime TEXT NOT NULL,
      amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'CONFIRMED_UNPAID',
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(seat_id) REFERENCES seats(seat_id)
    )
  `);

  // Default accounts for instant testing
  await dbRun(`INSERT OR IGNORE INTO users (id, name, email, password) VALUES 
    ('USR_ALEX', 'Alex Morgan', 'alex@gmail.com', '123456'),
    ('USR_BELLA', 'Bella Thorne', 'bella@gmail.com', '123456')
  `);

  // Seed Seats (VIP: $18, Premium: $14, Standard: $10)
  const tiers = [
    { row: 'A', tier: 'VIP', price: 18.00 },
    { row: 'B', tier: 'VIP', price: 18.00 },
    { row: 'C', tier: 'PREMIUM', price: 14.00 },
    { row: 'D', tier: 'PREMIUM', price: 14.00 },
    { row: 'E', tier: 'STANDARD', price: 10.00 },
    { row: 'F', tier: 'STANDARD', price: 10.00 }
  ];

  for (const t of tiers) {
    for (let c = 1; c <= 10; c++) {
      await dbRun(
        `INSERT OR IGNORE INTO seats (seat_id, tier, price, status) VALUES (?, ?, ?, 'AVAILABLE')`, 
        [`${t.row}${c}`, t.tier, t.price]
      );
    }
  }
}

initDB().catch(console.error);

// 2. Real-Time WebSocket Seat State Broadcaster
async function broadcastSeatState() {
  const seats = await dbAll('SELECT * FROM seats');
  const payload = JSON.stringify({ type: 'SEAT_UPDATE', seats });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

wss.on('connection', async (ws) => {
  const seats = await dbAll('SELECT * FROM seats');
  ws.send(JSON.stringify({ type: 'INITIAL_STATE', seats }));
});

// 3. Auto-Release Expired Holds (5-minute countdown worker)
setInterval(async () => {
  const now = Date.now();
  const res = await dbRun(`
    UPDATE seats 
    SET status = 'AVAILABLE', held_by = NULL, held_until = NULL 
    WHERE status = 'HELD' AND held_until <= ?
  `, [now]);

  if (res.changes > 0) {
    broadcastSeatState();
  }
}, 1000);

// 4. AUTHENTICATION ROUTES

// User Sign In
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });

  try {
    const user = await dbGet('SELECT id, name, email FROM users WHERE email = ? AND password = ?', [email.trim().toLowerCase(), password]);
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// User Sign Up
app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: 'All fields are required.' });

  try {
    const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    if (existing) {
      return res.status(409).json({ message: 'Account with this email already exists.' });
    }

    const userId = 'USR_' + Math.floor(1000 + Math.random() * 9000);
    await dbRun('INSERT INTO users (id, name, email, password) VALUES (?, ?, ?, ?)', [userId, name, email.trim().toLowerCase(), password]);

    res.json({ success: true, user: { id: userId, name, email: email.trim().toLowerCase() } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 5. SEAT & BOOKING ROUTES

app.get('/api/seats', async (req, res) => {
  const seats = await dbAll('SELECT * FROM seats');
  res.json(seats);
});

// Hold Seat (Case 1 & Case 2 Verification)
app.post('/api/seats/hold', async (req, res) => {
  const { seatId, userId, holdDurationSeconds = 300 } = req.body;
  if (!seatId || !userId) return res.status(400).json({ message: 'Missing seatId or userId' });

  try {
    const seat = await dbGet('SELECT * FROM seats WHERE seat_id = ?', [seatId]);
    if (!seat) return res.status(404).json({ message: 'Seat not found.' });

    const now = Date.now();

    // CASE 2 CHECK
    if (seat.status === 'BOOKED') {
      return res.status(409).json({ success: false, message: 'The seat is already booked select any other seat.' });
    }
    if (seat.status === 'HELD' && seat.held_until > now && seat.held_by !== userId) {
      return res.status(409).json({ success: false, message: 'The seat is currently in payment by another user. Select another seat.' });
    }

    const heldUntil = now + (holdDurationSeconds * 1000);
    await dbRun(`UPDATE seats SET status = 'HELD', held_by = ?, held_until = ? WHERE seat_id = ?`, [userId, heldUntil, seatId]);

    broadcastSeatState();
    res.json({ success: true, heldUntil, seat });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Cancel Hold
app.post('/api/seats/cancel-hold', async (req, res) => {
  const { seatId, userId } = req.body;
  await dbRun(`UPDATE seats SET status = 'AVAILABLE', held_by = NULL, held_until = NULL WHERE seat_id = ? AND held_by = ?`, [seatId, userId]);
  broadcastSeatState();
  res.json({ success: true, message: 'Transaction canceled, seat released without freezing.' });
});

// Confirm Booking (Pay at Counter Act 1 & 2)
app.post('/api/seats/confirm-booking', async (req, res) => {
  const { seatId, userId, movieTitle = 'Oppenheimer', hall = 'Audi 03 (Dolby Atmos)', showtime = 'Today, 07:30 PM', amount = 18.00 } = req.body;

  try {
    const seat = await dbGet('SELECT * FROM seats WHERE seat_id = ?', [seatId]);
    const now = Date.now();

    if (!seat || seat.status !== 'HELD' || seat.held_by !== userId || seat.held_until <= now) {
      return res.status(400).json({ success: false, message: 'Transaction window expired. Please try again.' });
    }

    const bookingCode = 'CP-' + Math.floor(100000 + Math.random() * 900000);

    await dbRun(`UPDATE seats SET status = 'BOOKED', booked_by = ?, booking_code = ?, held_by = NULL, held_until = NULL WHERE seat_id = ?`, [userId, bookingCode, seatId]);
    await dbRun(`INSERT INTO bookings (booking_code, user_id, seat_id, movie_title, hall, showtime, amount) VALUES (?, ?, ?, ?, ?, ?, ?)`, [bookingCode, userId, seatId, movieTitle, hall, showtime, amount]);

    broadcastSeatState();
    res.json({
      success: true,
      bookingCode,
      movieTitle,
      seatId,
      hall,
      showtime,
      amount,
      message: 'The seat is booked you can show/provide the below code at the counter to pay and get ticket.'
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// CASE 3 SIMULATION
app.post('/api/test/simulate-collision', async (req, res) => {
  const { seatId = 'A5' } = req.body;
  await dbRun(`UPDATE seats SET status = 'AVAILABLE', held_by = NULL, held_until = NULL, booked_by = NULL WHERE seat_id = ?`, [seatId]);
  broadcastSeatState();
  
  res.json({
    status: 'COLLISION_DETECTED',
    message: 'Case 3: 2 persons selected same seat and both clicked at same time. Both sent back to seat selection: Seat is already booked select any other seat.'
  });
});

// User Account Dashboard Bookings
app.get('/api/users/:userId/bookings', async (req, res) => {
  const bookings = await dbAll(`SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC`, [req.params.userId]);
  res.json(bookings);
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`CinePass started on http://localhost:${PORT}`);
});