process.env.TZ = process.env.APP_TIMEZONE || 'Europe/Madrid';

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'padel-jwt-secret-change-me-in-production-2024';

// ─── DATABASE SETUP ────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'padel.db');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    password   TEXT NOT NULL,
    is_admin   INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS courts (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS time_config (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    start_hour   INTEGER DEFAULT 10,
    start_minute INTEGER DEFAULT 0,
    slots_count  INTEGER DEFAULT 8
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    court_id   INTEGER NOT NULL,
    date       TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE,
    UNIQUE(court_id, date, slot_index)
  );
`);

// Seed initial data
(function seedData() {
  db.prepare('INSERT OR IGNORE INTO courts (id, name) VALUES (1, ?)').run('Pista 1');
  db.prepare('INSERT OR IGNORE INTO courts (id, name) VALUES (2, ?)').run('Pista 2');
  db.prepare('INSERT OR IGNORE INTO time_config (id, start_hour, start_minute, slots_count) VALUES (1, 10, 0, 8)').run();

  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, name, password, is_admin) VALUES (?, ?, ?, 1)').run('admin', 'Administrador', hash);
    console.log('✅ Admin creado: usuario=admin contraseña=admin123');
  }
})();

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};

const adminOnly = (req, res, next) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Acceso solo para administradores' });
  next();
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getConfig() {
  return db.prepare('SELECT * FROM time_config WHERE id = 1').get();
}

function slotToTime(config, slotIndex) {
  const total = config.start_hour * 60 + config.start_minute + slotIndex * 90;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getValidDates() {
  const now = new Date();
  const dates = [];
  for (let i = 0; i <= 2; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

function todayString() {
  return new Date().toISOString().split('T')[0];
}

function nowMinutes() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, name, password } = req.body || {};
  if (!username?.trim() || !name?.trim() || !password) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }
  if (username.trim().length < 3) {
    return res.status(400).json({ error: 'El usuario debe tener al menos 3 caracteres' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = db.prepare('INSERT INTO users (username, name, password) VALUES (?, ?, ?)').run(username.trim().toLowerCase(), name.trim(), hash);
    const user = { id: r.lastInsertRowid, username: username.trim().toLowerCase(), name: name.trim(), is_admin: 0 };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  const dbUser = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  if (!dbUser || !bcrypt.compareSync(password, dbUser.password)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const user = { id: dbUser.id, username: dbUser.username, name: dbUser.name, is_admin: dbUser.is_admin };
  const token = jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user });
});

// ─── RESERVATIONS ROUTES ──────────────────────────────────────────────────────
app.get('/api/reservations', authenticate, (req, res) => {
  const { date } = req.query;
  const validDates = getValidDates();

  if (!date || !validDates.includes(date)) {
    return res.status(400).json({ error: 'Fecha no válida. Solo se permiten reservas hasta 2 días de antelación.' });
  }

  const config = getConfig();
  const slots = [];
  for (let i = 0; i < config.slots_count; i++) {
    const startMin = config.start_hour * 60 + config.start_minute + i * 90;
    const endMin = startMin + 90;
    const fmtTime = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    slots.push({ index: i, start: fmtTime(startMin), end: fmtTime(endMin) });
  }

  const reservations = db.prepare(`
    SELECT r.id, r.user_id, r.court_id, r.date, r.slot_index, r.created_at,
           u.name as user_name, u.username
    FROM reservations r
    JOIN users u ON r.user_id = u.id
    WHERE r.date = ?
    ORDER BY r.slot_index, r.court_id
  `).all(date);

  res.json({ slots, reservations, config, today: todayString(), nowMinutes: nowMinutes() });
});

app.post('/api/reservations', authenticate, (req, res) => {
  const { court_id, date, slot_index } = req.body || {};
  const userId = req.user.id;

  // Validate date
  const validDates = getValidDates();
  if (!date || !validDates.includes(date)) {
    return res.status(400).json({ error: 'Solo puedes reservar con un máximo de 2 días de antelación' });
  }

  // Validate court
  if (![1, 2].includes(Number(court_id))) {
    return res.status(400).json({ error: 'Pista no válida' });
  }

  // Validate slot index
  const config = getConfig();
  const slotIdx = Number(slot_index);
  if (isNaN(slotIdx) || slotIdx < 0 || slotIdx >= config.slots_count) {
    return res.status(400).json({ error: 'Horario no válido' });
  }

  // Check slot is not in the past (only for today)
  if (date === todayString()) {
    const slotStartMin = config.start_hour * 60 + config.start_minute + slotIdx * 90;
    if (nowMinutes() >= slotStartMin) {
      return res.status(400).json({ error: 'No puedes reservar una hora que ya ha comenzado o pasado' });
    }
  }

  // Check user doesn't already have a reservation today
  const existingUserReservation = db.prepare(
    'SELECT id FROM reservations WHERE user_id = ? AND date = ?'
  ).get(userId, date);

  if (existingUserReservation) {
    return res.status(400).json({ error: 'Ya tienes una reserva para ese día. Solo se permite 1 reserva por usuario por día.' });
  }

  try {
    const result = db.prepare(
      'INSERT INTO reservations (user_id, court_id, date, slot_index) VALUES (?, ?, ?, ?)'
    ).run(userId, Number(court_id), date, slotIdx);

    res.json({ id: result.lastInsertRowid, message: '¡Reserva creada correctamente!' });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Esa pista ya está reservada en ese horario' });
    }
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.delete('/api/reservations/:id', authenticate, (req, res) => {
  const { id } = req.params;
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);

  if (!reservation) return res.status(404).json({ error: 'Reserva no encontrada' });

  if (reservation.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'No tienes permiso para eliminar esta reserva' });
  }

  db.prepare('DELETE FROM reservations WHERE id = ?').run(id);
  res.json({ message: 'Reserva eliminada correctamente' });
});

// ─── CONFIG ROUTES ────────────────────────────────────────────────────────────
app.get('/api/config', authenticate, (req, res) => {
  res.json(getConfig());
});

app.put('/api/config', authenticate, adminOnly, (req, res) => {
  const { start_hour, start_minute, slots_count } = req.body || {};
  const h = Number(start_hour);
  const m = Number(start_minute);
  const s = Number(slots_count);

  if (isNaN(h) || h < 6 || h > 22) return res.status(400).json({ error: 'Hora de inicio inválida (6-22)' });
  if (![0, 30].includes(m)) return res.status(400).json({ error: 'Los minutos deben ser 0 o 30' });
  if (isNaN(s) || s < 1 || s > 16) return res.status(400).json({ error: 'Número de turnos inválido (1-16)' });

  // Validate last slot doesn't go past midnight
  const lastSlotEnd = h * 60 + m + s * 90;
  if (lastSlotEnd > 24 * 60) {
    return res.status(400).json({ error: 'La configuración hace que el último turno pase de medianoche' });
  }

  db.prepare('UPDATE time_config SET start_hour = ?, start_minute = ?, slots_count = ? WHERE id = 1').run(h, m, s);
  res.json({ message: 'Configuración actualizada correctamente' });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
app.get('/api/admin/users', authenticate, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, name, is_admin, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

app.get('/api/admin/reservations', authenticate, adminOnly, (req, res) => {
  const { date } = req.query;
  const targetDate = date || todayString();
  const reservations = db.prepare(`
    SELECT r.id, r.court_id, r.date, r.slot_index, r.created_at,
           u.name as user_name, u.username
    FROM reservations r
    JOIN users u ON r.user_id = u.id
    WHERE r.date = ?
    ORDER BY r.slot_index, r.court_id
  `).all(targetDate);
  res.json(reservations);
});

// ─── FALLBACK ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🎾 Padel Reservas corriendo en http://localhost:${PORT}`);
  console.log(`📁 Base de datos: ${DB_PATH}`);
  console.log(`🕐 Zona horaria: ${process.env.TZ}`);
});
