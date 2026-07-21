# LNDRY Platform — Fastify Backend

## Prerequisites

- Node.js >= 18
- Docker & Docker Compose (for PostgreSQL + Redis)

## Quick Start

```bash
npm install
npm run infra:up
npm run db:migrate
npm run db:seed
npm run dev
```

Server starts at **http://localhost:4500**

If you have not created an env file yet:

```bash
cp .env.example .env
```

Use `npm run setup:local` to run infra + migrate + seed in one command.

- Health check: `GET /health`
- Swagger docs: `GET /documentation`

## Development Workflow

When developing the LNDRY Platform (which includes the User App, Vendor App, and Dashboard), **start the Unified Backend only once.**

```bash
npm run dev
```

### Important Guidelines:
- **Reuse the existing backend:** All frontend applications should communicate with this single running instance of the Unified Backend.
- **Avoid Duplicate Instances:** Do not launch multiple `npm run dev` instances for the backend. The backend includes a boot-time check; if it detects that the Unified Backend is already running on port 4500, it will log a message and exit cleanly to avoid `EADDRINUSE` crashes.
- **Port Conflicts:** If another process (not the Unified Backend) is occupying port 4500, the startup script will automatically detect the conflict and print the offending process's PID, Executable, and Command Line. Stop that process before starting the Unified Backend.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with nodemon (auto-reload) |
| `npm start` | Start production server |
| `npm run start:pm2` | Start with PM2 cluster mode |
| `npm run db:migrate` | Run SQL migrations |
| `npm run db:seed` | Seed sample data |
| `npm test` | Run tests (vitest) |
| `npm run lint` | ESLint check |
| `npm run format` | Prettier format |

## Architecture

```
Route → preHandler (auth/role) → JSON Schema Validation → Controller → Service → Repository → PostgreSQL
                                                                         ↕
                                                                     Redis Cache
```

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for full details.
