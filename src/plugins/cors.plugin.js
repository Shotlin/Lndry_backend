import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import { buildOriginChecker } from '../utils/origin-allowlist.js'

async function corsPlugin(fastify) {
  const isOriginAllowed = buildOriginChecker()

  await fastify.register(cors, {
    origin(origin, cb) {
      cb(null, isOriginAllowed(origin))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // X-Shop-Id is set by the dashboard's axios interceptor for every
    // shop-scoped request (multi-vendor design — see dashboard
    // src/lib/api.ts and design.md "X-Shop-Id Interceptor"). Must be in
    // allowedHeaders so the browser preflight passes. Without it, every
    // shop-scoped GET/POST fails with net::ERR_FAILED at the browser.
    // Idempotency-Key: the counter website (Vercel, cross-origin) attaches a UUID to every write so a retry after a
    // lost response cannot double-book or double-charge (see plugins/idempotency.plugin.js). Without it in this list
    // the browser's preflight rejects every such POST with a bare "Failed to fetch".
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Shop-Id', 'X-Step-Up-Token', 'x-step-up-token', 'Idempotency-Key'],
    exposedHeaders: ['X-Total-Count', 'X-Total-Pages'],
    maxAge: 86400,
  })
}

export default fp(corsPlugin, { name: 'cors' })
