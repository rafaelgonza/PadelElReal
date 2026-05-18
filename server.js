process.env.TZ = process.env.APP_TIMEZONE || 'Europe/Madrid';

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT    = process.env.PORT || 3000;
const APP_URL  = (process.env.APP_URL || 'https://padelelreal-production.up.railway.app').replace(/\/$/, '');
const JWT_SECRET = process.env.JWT_SECRET || 'padel-jwt-secret-change-me-in-production-2024';

// ─── LOGGER ───────────────────────────────────────────────────────────────────
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // debug | info | warn | error
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const logger = {
  _fmt(level, msg, meta) {
    const ts = new Date().toISOString();
    const base = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
    return meta ? `${base} | ${JSON.stringify(meta)}` : base;
  },
  debug(msg, meta) { if (LEVELS[LOG_LEVEL] <= 0) console.debug(this._fmt('debug', msg, meta)); },
  info (msg, meta) { if (LEVELS[LOG_LEVEL] <= 1) console.info (this._fmt('info',  msg, meta)); },
  warn (msg, meta) { if (LEVELS[LOG_LEVEL] <= 2) console.warn (this._fmt('warn',  msg, meta)); },
  error(msg, meta) { if (LEVELS[LOG_LEVEL] <= 3) console.error(this._fmt('error', msg, meta)); },
};

// ─── ERRORES GLOBALES ─────────────────────────────────────────────────────────
process.on('uncaughtException',  e => { logger.error('UncaughtException',  { message: e.message, stack: e.stack }); process.exit(1); });
process.on('unhandledRejection', e => { logger.error('UnhandledRejection', { message: String(e) }); });

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
    -- Horario invierno
    winter_start_hour   INTEGER DEFAULT 10,
    winter_start_minute INTEGER DEFAULT 0,
    winter_slots_count  INTEGER DEFAULT 7,
    -- Horario verano
    summer_start_hour   INTEGER DEFAULT 9,
    summer_start_minute INTEGER DEFAULT 0,
    summer_slots_count  INTEGER DEFAULT 9,
    -- Fecha inicio de cada temporada (mes y dia)
    summer_start_month  INTEGER DEFAULT 6,
    summer_start_day    INTEGER DEFAULT 1,
    winter_start_month  INTEGER DEFAULT 10,
    winter_start_day    INTEGER DEFAULT 1,
    -- Franja de descanso (minutos desde medianoche, 0/0 = sin descanso)
    winter_break_start  INTEGER DEFAULT 0,
    winter_break_end    INTEGER DEFAULT 0,
    summer_break_start  INTEGER DEFAULT 0,
    summer_break_end    INTEGER DEFAULT 0
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
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// ─── MIGRATIONS ───────────────────────────────────────────────────────────────
try { db.exec('ALTER TABLE users ADD COLUMN calle TEXT NOT NULL DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN numero TEXT NOT NULL DEFAULT ""'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN force_password_change INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN winter_break_start INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN winter_break_end   INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN summer_break_start INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN summer_break_end   INTEGER DEFAULT 0'); } catch {}
db.exec('UPDATE users SET approved = 1 WHERE is_admin = 1');

// Migrate old single-schedule config to new winter/summer schema
try { db.exec('ALTER TABLE time_config ADD COLUMN winter_start_hour   INTEGER DEFAULT 10'); } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN winter_start_minute INTEGER DEFAULT 0');  } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN winter_slots_count  INTEGER DEFAULT 7');  } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN summer_start_hour   INTEGER DEFAULT 9');  } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN summer_start_minute INTEGER DEFAULT 0');  } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN summer_slots_count  INTEGER DEFAULT 9');  } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN summer_start_month  INTEGER DEFAULT 6');  } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN summer_start_day    INTEGER DEFAULT 1');  } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN winter_start_month  INTEGER DEFAULT 10'); } catch {}
try { db.exec('ALTER TABLE time_config ADD COLUMN winter_start_day    INTEGER DEFAULT 1');  } catch {}
try { db.exec("ALTER TABLE time_config ADD COLUMN theme TEXT DEFAULT 'mediterranean'"); } catch {}

// If old schema had start_hour/start_minute/slots_count, copy to winter
try {
  const old = db.prepare('SELECT start_hour, start_minute, slots_count FROM time_config WHERE id=1').get();
  if (old?.start_hour) {
    db.exec(`UPDATE time_config SET winter_start_hour=${old.start_hour}, winter_start_minute=${old.start_minute}, winter_slots_count=${old.slots_count} WHERE id=1`);
  }
} catch {}

// ─── SEED ─────────────────────────────────────────────────────────────────────
(function seed() {
  db.prepare('INSERT OR IGNORE INTO courts (id, name) VALUES (1, ?)').run('Pista 1');
  db.prepare('INSERT OR IGNORE INTO courts (id, name) VALUES (2, ?)').run('Pista 2');
  db.prepare('INSERT OR IGNORE INTO time_config (id) VALUES (1)').run();
  if (!db.prepare('SELECT id FROM users WHERE username = ?').get('admin')) {
    db.prepare('INSERT INTO users (username, name, password, is_admin, approved, calle, numero) VALUES (?,?,?,1,1,?,?)')
      .run('admin', 'Administrador', bcrypt.hashSync('admin123', 10), 'Club El Real', '1');
    logger.info('Admin por defecto creado: admin / admin123');
  }
  logger.info('Base de datos inicializada', { path: DB_PATH });
})();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// HTTP request logger
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    const start = Date.now();
    res.on('finish', () => {
      const ms    = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      const user  = req.user ? `${req.user.username}(${req.user.id})` : 'anon';
      logger[level](`${req.method} ${req.path} ${res.statusCode} ${ms}ms`, { user, ip: req.ip });
    });
  }
  next();
});

const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(auth.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido o expirado' }); }
};
const adminOnly    = (req, res, next) => { if (!req.user.is_admin) return res.status(403).json({ error: 'Solo administradores' }); next(); };
const approvedOnly = (req, res, next) => {
  if (req.user.is_admin) return next();
  const u = db.prepare('SELECT approved FROM users WHERE id=?').get(req.user.id);
  if (!u?.approved) return res.status(403).json({ error: 'PENDIENTE_APROBACION' });
  next();
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// Para comparar direcciones ignorando tildes y mayúsculas
function normalizeAddr(s) {
  return s.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Normaliza el nombre de calle para almacenamiento:
//   - Elimina prefijos (calle, avda, c/, etc.)
//   - Convierte a MAYÚSCULAS
function normalizeCalle(s) {
  let v = s.trim();
  // Eliminar prefijos comunes al inicio (case-insensitive)
  const prefijos = [
    /^c(?:alle)?\s*[.\/\s]\s*/i,
    /^av(?:enida|da?)?\s*[.\/\s]\s*/i,
    /^pza?\s*[.\/\s]\s*/i,
    /^plaza\s*[.\/\s]\s*/i,
    /^urb(?:anizaci[oó]n)?\s*[.\/\s]\s*/i,
    /^p(?:aseo|so)?\s*[.\/\s]\s*/i,
    /^ctra?\s*[.\/\s]\s*/i,
    /^carretera\s*[.\/\s]\s*/i,
    /^r(?:onda)?\s*[.\/\s]\s*/i,
    /^cam(?:ino)?\s*[.\/\s]\s*/i,
    /^cl\s*[.\/\s]\s*/i,
  ];
  for (const re of prefijos) {
    const nuevo = v.replace(re, '');
    if (nuevo !== v) { v = nuevo; break; }
  }
  return v.trim().toUpperCase();
}

// Normaliza el número: mayúsculas y sin espacios extra
function normalizeNumero(s) {
  return s.trim().toUpperCase();
}

function getFullConfig() {
  return db.prepare('SELECT * FROM time_config WHERE id=1').get();
}

// Devuelve el horario activo (verano o invierno) según la fecha dada (YYYY-MM-DD)
function getActiveConfig(dateStr) {
  const cfg = getFullConfig();
  const [y, m, d] = (dateStr || todayString()).split('-').map(Number);
  const md        = m * 100 + d;
  const summerMD  = cfg.summer_start_month * 100 + cfg.summer_start_day;
  const winterMD  = cfg.winter_start_month * 100 + cfg.winter_start_day;

  let isSummer;
  if (summerMD < winterMD) {
    isSummer = md >= summerMD && md < winterMD;
  } else {
    // temporada de verano cruza año nuevo
    isSummer = md >= summerMD || md < winterMD;
  }

  return {
    start_hour:   isSummer ? cfg.summer_start_hour   : cfg.winter_start_hour,
    start_minute: isSummer ? cfg.summer_start_minute : cfg.winter_start_minute,
    slots_count:  isSummer ? cfg.summer_slots_count  : cfg.winter_slots_count,
    break_start:  isSummer ? cfg.summer_break_start  : cfg.winter_break_start,
    break_end:    isSummer ? cfg.summer_break_end    : cfg.winter_break_end,
    active_season: isSummer ? 'summer' : 'winter',
  };
}

// Devuelve true si el turno (startMin, endMin) solapa con la franja de descanso
function slotInBreak(cfg, slotStartMin, slotEndMin) {
  if (!cfg.break_start && !cfg.break_end) return false;
  if (cfg.break_start >= cfg.break_end) return false;
  return slotStartMin < cfg.break_end && slotEndMin > cfg.break_start;
}

function todayString() { return new Date().toISOString().split('T')[0]; }
function nowMinutes()   { const n = new Date(); return n.getHours()*60 + n.getMinutes(); }
function fmtTime(m)     { return `${String(Math.floor(m/60)%24).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }
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

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { username, name, password, calle, numero } = req.body || {};
  if (!username?.trim() || !name?.trim() || !password || !calle?.trim() || !numero?.trim())
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  if (username.trim().length < 3) return res.status(400).json({ error: 'Usuario debe tener al menos 3 caracteres' });
  if (password.length < 4)        return res.status(400).json({ error: 'Contraseña mínimo 4 caracteres' });

  const calleNorm = normalizeAddr(calle), numNorm = normalizeAddr(numero);
  const taken = db.prepare('SELECT calle, numero FROM users').all()
    .some(u => normalizeAddr(u.calle) === calleNorm && normalizeAddr(u.numero) === numNorm);
  if (taken) return res.status(400).json({ error: 'Ya existe un usuario registrado con esa dirección. Si crees que es un error, contacta con el administrador del club.' });

  try {
    const uname = username.trim().toLowerCase();
    const calleNorm2 = normalizeCalle(calle);
    const numNorm2    = normalizeNumero(numero);
    db.prepare('INSERT INTO users (username, name, password, calle, numero, approved) VALUES (?,?,?,?,?,0)')
      .run(uname, name.trim(), bcrypt.hashSync(password, 10), calleNorm2, numNorm2);
    logger.info('Registro nuevo usuario (pendiente aprobación)', { username: uname, calle: calleNorm2, numero: numNorm2 });
    res.json({ pending: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) {
      logger.warn('Registro fallido: usuario duplicado', { username: username.trim().toLowerCase() });
      return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    }
    logger.error('Error en registro', { error: e.message });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const uname = username?.trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(uname);
  if (!u || !bcrypt.compareSync(password, u.password)) {
    logger.warn('Login fallido: credenciales incorrectas', { username: uname, ip: req.ip });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  if (!u.is_admin && !u.approved) {
    logger.info('Login denegado: usuario pendiente de aprobación', { username: uname });
    return res.status(403).json({ error: 'PENDIENTE_APROBACION' });
  }
  const user = { id: u.id, username: u.username, name: u.name, is_admin: u.is_admin, calle: u.calle, numero: u.numero };
  logger.info('Login correcto', { username: uname, is_admin: !!u.is_admin, forceChange: !!u.force_password_change });
  // Si tiene clave temporal, devolvemos token de corta duración y flag
  const token = jwt.sign(
    { ...user, force_password_change: !!u.force_password_change },
    JWT_SECRET,
    { expiresIn: u.force_password_change ? '1h' : '30d' }
  );
  res.json({ token, user, force_password_change: !!u.force_password_change });
});

// ─── RESERVATIONS ─────────────────────────────────────────────────────────────
app.get('/api/reservations', authenticate, approvedOnly, (req, res) => {
  const { date } = req.query;
  if (!getValidDates().includes(date)) return res.status(400).json({ error: 'Fecha no válida' });
  const config = getActiveConfig(date);
  const reservations = db.prepare(`
    SELECT r.id, r.user_id, r.court_id, r.date, r.slot_index, u.name as user_name, u.calle, u.numero
    FROM reservations r JOIN users u ON r.user_id=u.id WHERE r.date=?
    ORDER BY r.slot_index, r.court_id
  `).all(date);
  res.json({ slots: buildSlots(config), reservations, config, today: todayString(), nowMinutes: nowMinutes() });
});

app.post('/api/reservations', authenticate, approvedOnly, (req, res) => {
  if (req.user.is_admin) return res.status(403).json({ error: 'El administrador no puede hacer reservas' });
  const { court_id, date, slot_index } = req.body || {};
  if (!getValidDates().includes(date)) return res.status(400).json({ error: 'Fecha no válida' });
  if (![1,2].includes(Number(court_id))) return res.status(400).json({ error: 'Pista no válida' });
  const cfg = getActiveConfig(date);
  const idx = Number(slot_index);
  if (isNaN(idx) || idx < 0 || idx >= cfg.slots_count) return res.status(400).json({ error: 'Horario no válido' });
  if (date === todayString() && nowMinutes() >= cfg.start_hour*60+cfg.start_minute+idx*90)
    return res.status(400).json({ error: 'Esa hora ya ha pasado' });
  const slotStart = cfg.start_hour*60 + cfg.start_minute + idx*90;
  if (slotInBreak(cfg, slotStart, slotStart+90))
    return res.status(400).json({ error: 'Ese turno está bloqueado por la franja de descanso del mediodía' });
  const userRes = db.prepare('SELECT slot_index FROM reservations WHERE user_id=? AND date=?').all(req.user.id, date);
  for (const r of userRes) {
    if (Math.abs(r.slot_index - idx) <= 1)
      return res.status(400).json({ error: 'No puedes reservar ese turno: es el mismo, el anterior o el siguiente a una reserva que ya tienes ese día.' });
  }
  try {
    const r = db.prepare('INSERT INTO reservations (user_id,court_id,date,slot_index) VALUES (?,?,?,?)').run(req.user.id, Number(court_id), date, idx);
    logger.info('Reserva creada', { reservationId: r.lastInsertRowid, userId: req.user.id, username: req.user.username, courtId: Number(court_id), date, slotIndex: idx });
    res.json({ id: r.lastInsertRowid, message: '¡Reserva creada!' });
  } catch(e) {
    if (e.message.includes('UNIQUE')) {
      logger.warn('Reserva fallida: pista ya ocupada', { userId: req.user.id, courtId: Number(court_id), date, slotIndex: idx });
      return res.status(409).json({ error: 'Esa pista ya está reservada en ese horario' });
    }
    logger.error('Error creando reserva', { error: e.message, userId: req.user.id });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.delete('/api/reservations/:id', authenticate, approvedOnly, (req, res) => {
  const r = db.prepare('SELECT * FROM reservations WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
  if (r.user_id !== req.user.id && !req.user.is_admin) {
    logger.warn('Intento de borrar reserva ajena', { requestUser: req.user.id, ownerUser: r.user_id, reservationId: r.id });
    return res.status(403).json({ error: 'Sin permiso' });
  }
  db.prepare('DELETE FROM reservations WHERE id=?').run(req.params.id);
  logger.info('Reserva eliminada', { reservationId: r.id, deletedBy: req.user.username, isAdmin: !!req.user.is_admin, courtId: r.court_id, date: r.date });
  res.json({ message: 'Reserva eliminada' });
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
app.get('/api/config', authenticate, (req, res) => {
  const cfg = getFullConfig();
  const active = getActiveConfig(todayString());
  res.json({ ...cfg, active_season: active.active_season });
});

app.put('/api/config', authenticate, adminOnly, (req, res) => {
  const b = req.body || {};
  const fields = ['winter_start_hour','winter_start_minute','winter_slots_count',
                  'summer_start_hour','summer_start_minute','summer_slots_count',
                  'summer_start_month','summer_start_day','winter_start_month','winter_start_day',
                  'winter_break_start','winter_break_end','summer_break_start','summer_break_end'];
  const vals = {};
  for (const f of fields) { vals[f] = Number(b[f]); if (isNaN(vals[f])) return res.status(400).json({ error: `Campo inválido: ${f}` }); }

  // Validaciones
  for (const season of ['winter','summer']) {
    const h = vals[`${season}_start_hour`], m = vals[`${season}_start_minute`], s = vals[`${season}_slots_count`];
    if (h < 6 || h > 22)       return res.status(400).json({ error: `Hora de ${season} inválida (6-22)` });
    if (![0,30].includes(m))    return res.status(400).json({ error: `Minutos de ${season}: 0 o 30` });
    if (s < 1 || s > 16)        return res.status(400).json({ error: `Turnos de ${season} inválidos (1-16)` });
    if (h*60+m+s*90 > 1440)     return res.status(400).json({ error: `Horario de ${season}: el último turno pasa de medianoche` });
  }
  for (const season of ['summer','winter']) {
    const mon = vals[`${season}_start_month`], day = vals[`${season}_start_day`];
    if (mon < 1 || mon > 12)    return res.status(400).json({ error: `Mes de inicio de ${season} inválido` });
    if (day < 1 || day > 31)    return res.status(400).json({ error: `Día de inicio de ${season} inválido` });
  }
  for (const season of ['summer','winter']) {
    const bs = vals[`${season}_break_start`], be = vals[`${season}_break_end`];
    if (bs < 0 || bs > 1439)    return res.status(400).json({ error: `Hora de inicio de descanso de ${season} inválida` });
    if (be < 0 || be > 1440)    return res.status(400).json({ error: `Hora de fin de descanso de ${season} inválida` });
    if (be > 0 && bs >= be)     return res.status(400).json({ error: `El fin del descanso de ${season} debe ser posterior al inicio` });
  }

  db.prepare(`UPDATE time_config SET
    winter_start_hour=@winter_start_hour, winter_start_minute=@winter_start_minute, winter_slots_count=@winter_slots_count,
    summer_start_hour=@summer_start_hour, summer_start_minute=@summer_start_minute, summer_slots_count=@summer_slots_count,
    summer_start_month=@summer_start_month, summer_start_day=@summer_start_day,
    winter_start_month=@winter_start_month, winter_start_day=@winter_start_day,
    winter_break_start=@winter_break_start, winter_break_end=@winter_break_end,
    summer_break_start=@summer_break_start, summer_break_end=@summer_break_end
    WHERE id=1`).run(vals);
  logger.info('Configuración de horarios actualizada', { updatedBy: req.user.username, ...vals });
  res.json({ message: 'Configuración guardada' });
});

// ─── ADMIN: USERS ─────────────────────────────────────────────────────────────
app.get('/api/admin/users', authenticate, adminOnly, (req, res) => {
  res.json(db.prepare('SELECT id,username,name,calle,numero,is_admin,approved,created_at FROM users ORDER BY approved ASC, created_at DESC').all());
});

app.patch('/api/admin/users/:id/approval', authenticate, adminOnly, (req, res) => {
  const u = db.prepare('SELECT id,is_admin FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.is_admin) return res.status(400).json({ error: 'No se puede modificar al admin' });
  const approved = req.body.approved ? 1 : 0;
  db.prepare('UPDATE users SET approved=? WHERE id=?').run(approved, req.params.id);
  logger.info(approved ? 'Acceso concedido a usuario' : 'Acceso denegado a usuario', { targetUserId: req.params.id, adminUser: req.user.username });
  res.json({ message: approved ? 'Acceso concedido' : 'Acceso denegado' });
});

app.patch('/api/admin/users/:id', authenticate, adminOnly, (req, res) => {
  const { name, username, password, calle, numero } = req.body || {};
  const u = db.prepare('SELECT id,is_admin FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (!name?.trim() || !username?.trim()) return res.status(400).json({ error: 'Nombre y usuario son obligatorios' });
  if (username.trim().length < 3) return res.status(400).json({ error: 'Usuario mínimo 3 caracteres' });
  if (password && password.length < 4) return res.status(400).json({ error: 'Contraseña mínimo 4 caracteres' });
  if (!calle?.trim() || !numero?.trim()) return res.status(400).json({ error: 'Calle y número son obligatorios' });

  const calleNorm2 = normalizeCalle(calle);
  const numNorm2   = normalizeNumero(numero);

  // Verificar que la dirección no la tenga ya otro usuario
  const addrTaken = db.prepare('SELECT calle, numero FROM users WHERE id != ?').all(req.params.id)
    .some(row => normalizeAddr(row.calle) === normalizeAddr(calleNorm2) && normalizeAddr(row.numero) === normalizeAddr(numNorm2));
  if (addrTaken) return res.status(400).json({ error: 'Ya existe otro usuario con esa dirección' });

  try {
    if (password) {
      db.prepare('UPDATE users SET name=?, username=?, password=?, calle=?, numero=? WHERE id=?')
        .run(name.trim(), username.trim().toLowerCase(), bcrypt.hashSync(password, 10), calleNorm2, numNorm2, req.params.id);
    } else {
      db.prepare('UPDATE users SET name=?, username=?, calle=?, numero=? WHERE id=?')
        .run(name.trim(), username.trim().toLowerCase(), calleNorm2, numNorm2, req.params.id);
    }
    logger.info('Usuario editado por admin', { targetUserId: req.params.id, adminUser: req.user.username, passwordChanged: !!password, calle: calleNorm2, numero: numNorm2 });
    res.json({ message: 'Usuario actualizado' });
  } catch(e) {
    if (e.message.includes('UNIQUE')) {
      logger.warn('Edición de usuario fallida: username duplicado', { targetUserId: req.params.id });
      return res.status(400).json({ error: 'Ese nombre de usuario ya existe' });
    }
    logger.error('Error editando usuario', { error: e.message });
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ─── RESET DE CONTRASEÑA POR TOKEN ───────────────────────────────────────────

// Genera un enlace de reseteo (admin) — el admin nunca ve ninguna contraseña
app.post('/api/admin/users/:id/reset-link', authenticate, adminOnly, (req, res) => {
  const u = db.prepare('SELECT id,is_admin,username,name FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.is_admin) return res.status(400).json({ error: 'No se puede resetear la contraseña del admin' });

  // Token criptográficamente seguro de 48 bytes → 96 hex chars
  const token     = require('crypto').randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

  // Invalidar tokens anteriores del mismo usuario y crear uno nuevo
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(u.id);
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?,?,?)').run(u.id, token, expiresAt);

  const resetUrl = `${APP_URL}/reset?token=${token}`;
  logger.info('Enlace de reseteo generado', { targetUserId: u.id, targetUsername: u.username, adminUser: req.user.username, expiresAt });
  res.json({ reset_url: resetUrl, expires_at: expiresAt, user_name: u.name });
});

// Valida un token de reseteo (sin autenticación — lo usa el vecino desde el enlace)
app.get('/api/auth/reset-token/:token', (req, res) => {
  const row = db.prepare(`
    SELECT t.*, u.username, u.name FROM password_reset_tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token=? AND t.used=0
  `).get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Enlace no válido o ya utilizado' });
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM password_reset_tokens WHERE id=?').run(row.id);
    return res.status(410).json({ error: 'Este enlace ha caducado (válido 24h). Pide uno nuevo al administrador.' });
  }
  res.json({ valid: true, name: row.name, username: row.username });
});

// Aplica el reseteo: establece nueva contraseña usando el token
app.post('/api/auth/reset-password', (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token || !new_password) return res.status(400).json({ error: 'Faltan datos' });
  if (new_password.length < 4) return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });

  const row = db.prepare(`
    SELECT t.*, u.username FROM password_reset_tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token=? AND t.used=0
  `).get(token);
  if (!row) return res.status(404).json({ error: 'Enlace no válido o ya utilizado' });
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM password_reset_tokens WHERE id=?').run(row.id);
    return res.status(410).json({ error: 'Este enlace ha caducado. Pide uno nuevo al administrador.' });
  }

  db.prepare('UPDATE users SET password=?, force_password_change=0 WHERE id=?')
    .run(bcrypt.hashSync(new_password, 10), row.user_id);
  db.prepare('UPDATE password_reset_tokens SET used=1 WHERE id=?').run(row.id);

  logger.info('Contraseña restablecida por token', { userId: row.user_id, username: row.username });
  res.json({ message: 'Contraseña actualizada correctamente' });
});

// Cambiar contraseña propia (usuario autenticado)
app.post('/api/auth/change-password', authenticate, (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password || new_password.length < 4)
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres' });
  db.prepare('UPDATE users SET password=?, force_password_change=0 WHERE id=?')
    .run(bcrypt.hashSync(new_password, 10), req.user.id);
  logger.info('Contraseña cambiada (autenticado)', { userId: req.user.id, username: req.user.username });
  res.json({ message: 'Contraseña actualizada correctamente' });
});

app.delete('/api/admin/users/:id', authenticate, adminOnly, (req, res) => {
  const u = db.prepare('SELECT id,is_admin FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  if (u.is_admin) return res.status(400).json({ error: 'No se puede eliminar al administrador' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ message: 'Usuario eliminado' });
});

// ─── ADMIN: HISTORY ───────────────────────────────────────────────────────────
app.get('/api/admin/history', authenticate, adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.court_id, r.date, r.slot_index, r.created_at, u.name as user_name, u.calle, u.numero
    FROM reservations r JOIN users u ON r.user_id=u.id
    ORDER BY r.created_at DESC LIMIT 500
  `).all();
  res.json({ reservations: rows, config: getFullConfig() });
});

// ─── ADMIN: EXPORTAR USUARIOS ────────────────────────────────────────────────
app.get('/api/admin/export-users', authenticate, adminOnly, (req, res) => {
  const users = db.prepare(
    'SELECT name,username,calle,numero,approved,created_at FROM users WHERE is_admin=0 ORDER BY name ASC'
  ).all();

  // Build CSV
  const header = 'Nombre,Usuario,Calle,Numero,Acceso,Fecha_registro';
  const rows   = users.map(u =>
    [u.name, u.username, u.calle, u.numero, u.approved ? 'si' : 'no', u.created_at]
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  );
  const csv = [header, ...rows].join('\r\n');

  logger.info('Exportación de usuarios', { adminUser: req.user.username, count: users.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="usuarios_padel_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('﻿' + csv); // BOM para que Excel lo abra bien
});

// ─── ADMIN: IMPORTAR USUARIOS ─────────────────────────────────────────────────
app.post('/api/admin/import-users', authenticate, adminOnly, (req, res) => {
  const { users } = req.body || {};
  if (!Array.isArray(users) || users.length === 0)
    return res.status(400).json({ error: 'No se han enviado usuarios para importar' });
  if (users.length > 200)
    return res.status(400).json({ error: 'Máximo 200 usuarios por importación' });

  const results = { created: 0, skipped: 0, errors: [] };
  const importStmt = db.prepare(
    'INSERT OR IGNORE INTO users (username,name,password,calle,numero,approved,force_password_change) VALUES (?,?,?,?,?,?,1)'
  );
  // Temp password hash (force_password_change=1, recibirán enlace de reset)
  const tempHash = bcrypt.hashSync('PENDIENTE_RESET_' + Date.now(), 10);

  const importMany = db.transaction((list) => {
    for (const u of list) {
      const uname  = (u.usuario || u.username || '').trim().toLowerCase();
      const name   = (u.nombre  || u.name     || '').trim();
      const calle  = normalizeCalle(u.calle   || '');
      const numero = normalizeNumero(u.numero  || '');
      const approved = ['si','yes','1','true'].includes(String(u.acceso || u.approved || 'no').toLowerCase()) ? 1 : 0;

      if (!uname || uname.length < 3 || !name || !calle || !numero) {
        results.errors.push(`Fila ignorada — datos incompletos: ${JSON.stringify(u)}`);
        results.skipped++;
        continue;
      }
      const r = importStmt.run(uname, name, tempHash, calle, numero, approved);
      if (r.changes > 0) results.created++;
      else { results.skipped++; results.errors.push(`Usuario duplicado ignorado: ${uname}`); }
    }
  });

  try {
    importMany(users);
    logger.info('Importación de usuarios', { adminUser: req.user.username, ...results });
    res.json({ message: `Importación completada: ${results.created} creados, ${results.skipped} omitidos.`, ...results });
  } catch(e) {
    logger.error('Error en importación de usuarios', { error: e.message });
    res.status(500).json({ error: 'Error durante la importación: ' + e.message });
  }
});

// ─── ADMIN: CAMBIAR CONTRASEÑA DEL ADMIN ──────────────────────────────────────
app.post('/api/admin/change-password', authenticate, adminOnly, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Contraseña actual y nueva son obligatorias' });
  if (new_password.length < 4)
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 4 caracteres' });

  const admin = db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, admin.password))
    return res.status(401).json({ error: 'La contraseña actual es incorrecta' });
  if (current_password === new_password)
    return res.status(400).json({ error: 'La nueva contraseña debe ser distinta a la actual' });

  db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  logger.info('Contraseña del administrador cambiada', { adminUser: req.user.username });
  res.json({ message: 'Contraseña actualizada correctamente' });
});

// ─── THEME ───────────────────────────────────────────────────────────────────
app.get('/api/theme', (req, res) => {
  const cfg = db.prepare('SELECT theme FROM time_config WHERE id=1').get();
  res.json({ theme: cfg?.theme || 'mediterranean' });
});

app.post('/api/admin/theme', authenticate, adminOnly, (req, res) => {
  const { theme } = req.body || {};
  if (!['mediterranean', 'classic'].includes(theme))
    return res.status(400).json({ error: 'Tema no válido' });
  db.prepare("UPDATE time_config SET theme=? WHERE id=1").run(theme);
  logger.info('Tema cambiado', { theme, adminUser: req.user.username });
  res.json({ message: 'Tema actualizado', theme });
});

app.get('*', (req, res) => {
  const cfg = db.prepare('SELECT theme FROM time_config WHERE id=1').get();
  const theme = cfg?.theme || 'mediterranean';
  const file  = theme === 'classic' ? 'index_classic.html' : 'index.html';
  res.sendFile(path.join(__dirname, 'public', file));
});

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Error no controlado en ruta', { method: req.method, path: req.path, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
  logger.info('🎾 Club El Real de Espartinas arrancado', {
    port: PORT,
    appUrl: APP_URL,
    db: DB_PATH,
    timezone: process.env.TZ,
    logLevel: LOG_LEVEL,
    nodeEnv: process.env.NODE_ENV || 'development',
  });
});
