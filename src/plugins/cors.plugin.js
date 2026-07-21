import fp from 'fastify-plugin'
import cors from '@fastify/cors'
import { env } from '../config/env.js'

function expandLoopbackOrigins(originList) {
  const expanded = new Set(originList)

  for (const origin of originList) {
    try {
      const url = new URL(origin)
      if (url.hostname === 'localhost') {
        url.hostname = '127.0.0.1'
        expanded.add(url.toString().replace(/\/$/, ''))
      } else if (url.hostname === '127.0.0.1') {
        url.hostname = 'localhost'
        expanded.add(url.toString().replace(/\/$/, ''))
      }
    } catch {
      expanded.add(origin)
    }
  }

  return Array.from(expanded)
}

async function corsPlugin(fastify) {
  const configuredOrigins = env.CORS_ORIGINS
    ? env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:3001']
  const origins = expandLoopbackOrigins(configuredOrigins)
  const allowSet = new Set(origins)

  // Production domains are always allowed regardless of env config, so we never
  // get blocked by a missing CORS_ORIGINS entry after a deploy. Matches:
  //   - lndry.in and any subdomain (www, api, dash, etc.)
  //   - shotlin.in and any subdomain
  const allowedHostSuffixes = ['lndry.in', 'shotlin.in']

  // *.vercel.app is broad by nature (any Vercel-hosted app, not just ours,
  // satisfies a bare suffix match). When CORS_ALLOWED_VERCEL_HOSTS is set,
  // trust only those exact hostnames instead of the whole vercel.app
  // suffix. Left unset by default so nothing breaks before the exact
  // production dashboard hostname(s) are known — tighten by setting this
  // env var once confirmed, no code change needed.
  const vercelAllowlist = env.CORS_ALLOWED_VERCEL_HOSTS
    ? new Set(env.CORS_ALLOWED_VERCEL_HOSTS.split(',').map((h) => h.trim()).filter(Boolean))
    : null

  function isOriginAllowed(origin) {
    // Non-browser requests (curl, server-to-server) send no Origin header.
    if (!origin) return true
    if (allowSet.has(origin)) return true
    try {
      const { hostname, protocol } = new URL(origin)
      if (protocol !== 'https:' && protocol !== 'http:') return false
      if (
        allowedHostSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
      ) {
        return true
      }
      if (vercelAllowlist) return vercelAllowlist.has(hostname)
      return hostname === 'vercel.app' || hostname.endsWith('.vercel.app')
    } catch {
      return false
    }
  }

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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Shop-Id', 'X-Step-Up-Token', 'x-step-up-token'],
    exposedHeaders: ['X-Total-Count', 'X-Total-Pages'],
    maxAge: 86400,
  })
}

export default fp(corsPlugin, { name: 'cors' })
