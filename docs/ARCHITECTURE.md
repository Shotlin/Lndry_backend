# Backend Architecture

## Request lifecycle

```
Route → preHandler (auth/role/permission) → JSON Schema Validation (AJV) → preHandler (sanitize)
      → Controller → Service → Repository → PostgreSQL
                                    ↕
                                 Redis (cache, rate limit, idempotency, BullMQ queues)
```

Fastify plugin registration order (`src/app.js`) matters and is, in order: error handler, CORS, helmet, rate limiting, auth (JWT), idempotency, swagger, multipart, compress, Socket.IO — then the global `sanitize` hook, then module routes.

## Module layout

Each domain lives under `src/modules/<domain>/` with a consistent 4-file shape:

- `*.routes.js` — Fastify route registration, `preHandler` wiring (auth/permissions/rate limits)
- `*.controller.js` — thin HTTP layer: parse request, call service, shape response
- `*.service.js` — business logic
- `*.repository.js` — parameterized SQL (raw `pg`, no ORM)
- `*.schema.js` — JSON-Schema request/response validation consumed by the route

~40 active modules live under `src/modules/` (auth, users, orders, payments, vendors, shops, delivery, admin, reviews, notifications, etc.). Retired features live in `archived_modules/` with matching tests in `archived_tests/` — their routes are present but commented out in `src/app.js`; this is a deliberate, documented state, not dead code left by accident.

## Cross-cutting concerns

- **Auth**: JWT access/refresh tokens (`@fastify/jwt`), OTP-based login with hashed OTPs + Redis-backed lockout. `fastify.authenticate` does a per-request DB check for `is_blocked`/`session_version` (instant revocation).
- **Multi-tenancy**: `src/middlewares/shop-scope.js` enforces vendor/shop data isolation, with a Redis-cached staff-active check and audit-logged denials.
- **Caching**: Redis via `src/utils/cache.js` (generic get/set/pattern-delete) and `src/utils/report-cache.js` for precomputed reports. Authenticated/user-scoped responses are forced `Cache-Control: no-store`; public catalog/banner/theme responses stay cacheable for CDN edge caching (see the comment in `src/app.js`'s `onSend` hook).
- **Realtime**: Socket.IO with JWT-authenticated handshake and room-based scoping (`user:{id}`, `order:{id}`, `shop:{id}`, etc.), backed by a Redis adapter for multi-instance broadcast.
- **Background work**: BullMQ workers (`src/workers/`) plus two lightweight in-process interval pollers (payment-expiry, campaign-scheduler) that use `SELECT ... FOR UPDATE SKIP LOCKED` so they're safe to run from multiple instances/PM2 workers.
- **Validation**: Fastify's native JSON-Schema + AJV (`removeAdditional: 'all'`, `coerceTypes`) per-route via `*.schema.js` files.
- **Logging**: structured Pino logging with OTP/PII field redaction.

## Deployment

Docker multi-stage build; `docker-compose.prod.yml` runs `postgres`, `redis`, a one-shot `migrate` job, `api`, a separate `worker` process (BullMQ consumers), `nginx`, and a `cloudflared` tunnel (no public ports exposed). Migrations are plain numbered SQL files (`src/database/migrations/`), applied via a custom idempotent runner (`src/database/migrate.js`) — no migration framework.
