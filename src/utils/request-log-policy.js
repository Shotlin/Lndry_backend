// Decides which requests get Fastify's per-request log lines.
//
// Why this exists: with the default behaviour Fastify writes TWO JSON lines per request
// ("incoming request" + "request completed"). On the production t3.medium (2 vCPU) the load test of
// 2026-11-07 showed the log pipeline (pino -> pm2-runtime -> dockerd json-file) using ~54 % of one
// core at ~800 req/s, more than nginx. Health probes alone (Docker healthchecks every 15 s plus any
// uptime monitor) were logged like real traffic.
//
// LOG_REQUESTS modes:
//   all    (default, today's behaviour) log every request, except health probes
//   errors log only responses with status >= 400 or slower than LOG_SLOW_REQUEST_MS (recommended in prod)
//   off    no per-request lines at all (errors are still logged by the error handler)

export const QUIET_PATH_PREFIXES = ['/health']

export function isQuietPath(url) {
  const path = String(url ?? '').split('?')[0]
  return QUIET_PATH_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

/** True when Fastify's built-in "incoming request" / "request completed" lines should be suppressed. */
export function shouldDisableRequestLogging(url, mode) {
  if (mode === 'all') return isQuietPath(url)
  return true // 'errors' and 'off': suppressed here; 'errors' re-adds selected lines via logCompletedRequest
}

/** In 'errors' mode: should this finished request still be logged? */
export function shouldLogCompleted({ mode, url, statusCode, elapsedMs, slowMs }) {
  if (mode !== 'errors') return false
  if (statusCode >= 400) return true
  return !isQuietPath(url) && elapsedMs >= slowMs
}
