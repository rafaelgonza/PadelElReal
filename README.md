# 🎾 Pádel Club — Gestión de Reservas

Aplicación web para gestionar reservas de pistas de pádel. Construida con Node.js + Express + SQLite, optimizada para el despliegue más económico en Railway.

## Stack técnico

| Componente | Tecnología | Coste Railway |
|---|---|---|
| Servidor | Node.js + Express | ~$5/mes (Starter) |
| Base de datos | SQLite (better-sqlite3) | Incluido (con Volume) |
| Frontend | HTML/CSS/JS vanilla | Incluido |
| **Total** | **1 solo servicio** | **~$5–6/mes** |

> **¿Por qué SQLite?** Evita pagar un servicio de base de datos separado (PostgreSQL en Railway cuesta extra). Un solo servicio = mínimo coste.

## Funcionalidades

- ✅ Login y registro de usuarios
- ✅ Reserva de 2 pistas de pádel
- ✅ Máximo 2 días de antelación para reservar
- ✅ Máximo 1 reserva por usuario por día
- ✅ Turnos de 1h 30min
- ✅ Eliminación de reservas propias
- ✅ Panel de administrador para configurar horarios (verano/invierno)
- ✅ Vista gráfica con calendario interactivo
- ✅ Slots pasados marcados automáticamente

## Instalación local

```bash
npm install
npm start
```

Accede en `http://localhost:3000`

### Credenciales por defecto
- **Admin:** usuario `admin`, contraseña `admin123` ← ¡Cámbiala en producción!

---

## Despliegue en Railway

### Opción A — Railway CLI (recomendada)

```bash
# 1. Instalar Railway CLI
npm install -g @railway/cli

# 2. Login
railway login

# 3. Crear proyecto
railway init

# 4. Desplegar
railway up
```

### Opción B — GitHub (más fácil)

1. Sube el proyecto a GitHub
2. En [railway.app](https://railway.app), clic en **New Project → Deploy from GitHub**
3. Selecciona tu repositorio
4. Railway detecta automáticamente Node.js y ejecuta `npm start`

### ⚠️ IMPORTANTE: Persistencia de datos (SQLite)

Sin un volumen, los datos se pierden al redesplegar. Configura un volumen:

1. En Railway, ve a tu servicio → **Volumes** → **Add Volume**
2. Mount path: `/data`
3. En **Variables**, añade: `DB_PATH=/data/padel.db`

### Variables de entorno recomendadas

| Variable | Descripción | Ejemplo |
|---|---|---|
| `JWT_SECRET` | Clave secreta para tokens | `cambia-esto-por-algo-seguro-123` |
| `DB_PATH` | Ruta de la base de datos | `/data/padel.db` |
| `APP_TIMEZONE` | Zona horaria | `Europe/Madrid` |
| `PORT` | Puerto (Railway lo pone automáticamente) | `3000` |

---

## Estructura del proyecto

```
padel-app/
├── server.js         # Servidor Express + rutas API
├── package.json
├── .gitignore
└── public/
    └── index.html    # Frontend SPA completo
```

## API Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/auth/login` | Iniciar sesión |
| POST | `/api/auth/register` | Registrar usuario |
| GET | `/api/reservations?date=YYYY-MM-DD` | Ver reservas del día |
| POST | `/api/reservations` | Crear reserva |
| DELETE | `/api/reservations/:id` | Eliminar reserva |
| GET | `/api/config` | Ver configuración de horarios |
| PUT | `/api/config` | Actualizar horarios (admin) |
| GET | `/api/admin/users` | Listar usuarios (admin) |

## Panel de Administrador

El usuario `admin` tiene acceso a un panel (botón ⚙️ en la cabecera) donde puede:
- Cambiar la **hora de inicio** de las pistas (6:00 – 22:00)
- Cambiar los **minutos de inicio** (:00 o :30)
- Cambiar el **número de turnos** por día (1–16)
- Ver una **vista previa** de todos los horarios resultantes en tiempo real

Esto permite adaptar los horarios según temporada (verano/invierno).
