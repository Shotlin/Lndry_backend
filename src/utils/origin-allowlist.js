import { env } from '../config/env.js'

/**
 * One definition of "which browser origins may talk to this API", shared by the
 * REST CORS plugin and the Socket.IO server (they used to disagree: REST also
 * trusted lndry.in / shotlin.in sub-domains, sockets only the env list).
 */
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

const ALLOWED_HOST_SUFFIXES = ['lndry.in', 'shotlin.in']

export function buildOriginChecker(config = env) {
  const configured = config.CORS_ORIGINS
    ? config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
    : ['http://localhost:3001']
  const allowSet = new Set(expandLoopbackOrigins(configured))
  const vercelAllowlist = config.CORS_ALLOWED_VERCEL_HOSTS
    ? new Set(config.CORS_ALLOWED_VERCEL_HOSTS.split(',').map((h) => h.trim()).filter(Boolean))
    : null

  /** @param {string|undefined|null} origin value of the Origin header */
  return function isOriginAllowed(origin) {
    // Non-browser clients (mobile apps, curl, server-to-server) send no Origin header.
    if (!origin) return true
    if (allowSet.has(origin)) return true
    try {
      const { hostname, protocol } = new URL(origin)
      if (protocol !== 'https:' && protocol !== 'http:') return false
      if (ALLOWED_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) return true
      if (vercelAllowlist) return vercelAllowlist.has(hostname)
      return hostname === 'vercel.app' || hostname.endsWith('.vercel.app')
    } catch {
      return false
    }
  }
}

/** Minimal Cookie header parser (name → value), enough to read the session cookie. */
export function parseCookieHeader(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    if (!name || name in out) continue
    try { out[name] = decodeURIComponent(part.slice(i + 1).trim()) } catch { out[name] = part.slice(i + 1).trim() }
  }
  return out
}
