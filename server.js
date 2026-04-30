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

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'padel.db');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS courts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS time_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start_hour INTEGER DEFAULT 10,
    start_minute INTEGER DEFAULT 0,
    slots_count INTEGER DEFAULT 8
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    court_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE,
    UNIQUE(court_id, date, slot_index)
  );
`);

// Migrations
try { db.exec('ALTER TABLE users ADD COLUMN calle TEXT NOT NULL DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN numero TEXT NOT NULL DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 0'); } catch {}
db.exec('UPDATE users SET approved = 1 WHERE is_admin = 1');

// Seed
(function seed() {
  db.prepare('INSERT OR IGNORE INTO courts (id, name) VALUES (1, ?)').run('Pista 1');
  db.prepare('INSERT OR IGNORE INTO courts (id, name) VALUES (2, ?)').run('Pista 2');
  db.prepare('INSERT OR IGNORE INTO time_config (id) VALUES (1)').run();
  if (!db.prepare('SELECT id FROM users WHERE username = ?').get('admin')) {
    db.prepare('INSERT INTO users (username, name, password, is_admin, approved, calle, numero) VALUES (?, ?, ?, 1, 1, ?, ?)')
      .run('admin', 'Administrador', bcrypt.hashSync('admin123', 10), 'Club El Real', '1');
    console.log('Admin creado: admin / admin123');
  }
})();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(auth.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido o expirado' }); }
};

const adminOnly = (req, res, next) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Solo administradores' });
  next();
};

const approvedOnly = (req, res, next) => {
  if (req.user.is_admin) return next();
  const u = db.prepare('SELECT approved FROM users WHERE id = ?').get(req.user.id);
  if (!u?.approved) return res.status(403).json({ error: 'PENDIENTE_APROBACION' });
  next();
};

// Normaliza texto: minúsculas + sin tildes (para comparar direcciones)
function normalizeAddr(s) {
  return s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function getConfig() { return db.prepare('SELECT * FROM time_config WHERE id = 1').get(); }
function todayString() { return new Date().toISOString().split('T')[0]; }
function nowMinutes() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
function fmtTime(m) { return `${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }
function buildSlots(cfg) {
  return Array.from({length: cfg.slots_count}, (_, i) => {
    const s = cfg.start_hour*60 + cfg.start_minute + i*90;
    return { index: i, start: fmtTime(s), end: fmtTime(s+90) };
  });
}
function getValidDates() {
  return Array.from({length: 3}, (_, i) => {
    const d = new Date(); d.setDate(d.getDate()+i); return d.toISOString().split('T')[0];
  });
}

// AUTH
app.post('/api/auth/register', (req, res) => {
  const { username, name, password, calle, numero } = req.body || {};
  if (!username?.trim() || !name?.trim() || !password || !calle?.trim() || !numero?.trim())
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  if (username.trim().length < 3) return res.status(400).json({ error: 'Usuario debe tener al menos 3 caracteres' });
  if (password.length < 4) return res.status(400).json({ error: 'Contraseña mínimo 4 caracteres' });

  // Validar que calle+número no existan ya (sin tildes, sin mayúsculas)
  const calleNorm  = normalizeAddr(calle);
  const numeroNorm = normalizeAddr(numero);
  const allUsers   = db.prepare('SELECT calle, numero FROM users').all();
  const addrTaken  = allUsers.some(u => normalizeAddr(u.calle) === calleNorm && normalizeAddr(u.numero) === numeroNorm);
  if (addrTaken) return res.status(400).json({ error: 'Ya existe un usuario registrado con esa dirección. Si crees que es un error, contacta con el administrador del club.' });

  try {
    db.prepare('INSERT INTO users (username, name, password, calle, numero, approved) VALUES (?,?,?,?,?,0)')
      .run(username.trim().toLowerCase(), name.trim(), bcrypt.hashSync(password, 10), calle.trim(), numero.trim());
    res.json({ pending: true, message: 'Registro completado. Tu cuenta está pendiente de aprobación por el administrador.' });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.trim().toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.password))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  if (!u.is_admin && !u.approved)
    return res.status(403).json({ error: 'PENDIENTE_APROBACION' });
  const user = { id: u.id, username: u.username, name: u.name, is_admin: u.is_admin, calle: u.calle, numero: u.numero };
  res.json({ token: jwt.sign(user, JWT_SECRET, { expiresIn: '30d' }), user });
});

// RESERVATIONS
app.get('/api/reservations', authenticate, approvedOnly, (req, res) => {
  const { date } = req.query;
  if (!getValidDates().includes(date)) return res.status(400).json({ error: 'Fecha no válida' });
  const config = getConfig();
  const reservations = db.prepare(`
    SELECT r.id, r.user_id, r.court_id, r.date, r.slot_index, u.name as user_name, u.calle, u.numero
    FROM reservations r JOIN users u ON r.user_id = u.id WHERE r.date = ?
    ORDER BY r.slot_index, r.court_id
  `).all(date);
  res.json({ slots: buildSlots(config), reservations, config, today: todayString(), nowMinutes: nowMinutes() });
});

app.post('/api/reservations', authenticate, approvedOnly, (req, res) => {
  if (req.user.is_admin) return res.status(403).json({ error: 'El administrador no puede hacer reservas' });
  const { court_id, date, slot_index } = req.body || {};
  if (!getValidDates().includes(date)) return res.status(400).json({ error: 'Fecha no válida' });
  if (![1,2].includes(Number(court_id))) return res.status(400).json({ error: 'Pista no válida' });
  const cfg = getConfig();
  const idx = Number(slot_index);
  if (isNaN(idx) || idx < 0 || idx >= cfg.slots_count) return res.status(400).json({ error: 'Horario no válido' });
  if (date === todayString() && nowMinutes() >= cfg.start_hour*60+cfg.start_minute+idx*90)
    return res.status(400).json({ error: 'Esa hora ya ha pasado' });

  // Verificar que el turno solicitado no colisiona con turnos ya reservados por este usuario:
  // No puede reservar el mismo turno, el anterior ni el posterior (en cualquier pista)
  const userReservationsDay = db.prepare('SELECT slot_index FROM reservations WHERE user_id=? AND date=?').all(req.user.id, date);
  for (const existing of userReservationsDay) {
    if (Math.abs(existing.slot_index - idx) <= 1) {
      return res.status(400).json({ error: 'No puedes reservar ese turno: es el mismo, el anterior o el siguiente a una reserva que ya tienes ese día.' });
    }
  }
  try {
    const r = db.prepare('INSERT INTO reservations (user_id,court_id,date,slot_index) VALUES (?,?,?,?)').run(req.user.id, Number(court_id), date, idx);
    res.json({ id: r.lastInsertRowid, message: '¡Reserva creada!' });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Esa pista ya está reservada en ese horario' });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.delete('/api/reservations/:id', authenticate, approvedOnly, (req, res) => {
  const r = db.prepare('SELECT * FROM reservations WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
  if (r.user_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Sin permiso' });
  db.prepare('DELETE FROM reservations WHERE id=?').run(req.params.id);
  res.json({ message: 'Reserva eliminada' });
});

// CONFIG
app.get('/api/config', authenticate, (req, res) => res.json(getConfig()));

app.put('/api/config', authenticate, adminOnly, (req, res) => {
  const h=Number(req.body.start_hour), m=Number(req.body.start_minute), s=Number(req.body.slots_count);
  if (isNaN(h)||h<6||h>22) return res.status(400).json({ error: 'Hora inválida (6-22)' });
  if (![0,30].includes(m)) return res.status(400).json({ error: 'Minutos: 0 o 30' });
  if (isNaN(s)||s<1||s>16) return res.status(400).json({ error: 'Turnos inválidos (1-16)' });
  if (h*60+m+s*90>1440) return res.status(400).json({ error: 'El último turno pasa de medianoche' });
  db.prepare('UPDATE time_config SET start_hour=?,start_minute=?,slots_count=? WHERE id=1').run(h,m,s);
  res.json({ message: 'Configuración guardada' });
});

// ADMIN: USERS
app.get('/api/admin/users', authenticate, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id,username,name,calle,numero,is_admin,approved,created_at FROM users ORDER BY approved ASC, created_at DESC').all());
});

app.patch('/api/admin/users/:id/approval', authenticate, adminOnly, (req, res) => {
  const u = db.prepare('SELECT id,is_admin FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.is_admin) return res.status(400).json({ error: 'No se puede modificar al admin' });
  db.prepare('UPDATE users SET approved=? WHERE id=?').run(req.body.approved ? 1 : 0, req.params.id);
  res.json({ message: req.body.approved ? 'Acceso concedido' : 'Acceso denegado' });
});

// ADMIN: HISTORY
app.get('/api/admin/history', authenticate, adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.court_id, r.date, r.slot_index, r.created_at, u.name as user_name, u.calle, u.numero
    FROM reservations r JOIN users u ON r.user_id = u.id
    ORDER BY r.date DESC, r.slot_index ASC, r.court_id ASC LIMIT 300
  `).all();
  res.json({ reservations: rows, config: getConfig() });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🎾 Club El Real de Espartinas — http://localhost:${PORT}`));
