#!/usr/bin/env node
/**
 * HTTP load test — N simultaneous customers hitting the real API.
 *
 *   node scripts/load/run-load.mjs --url http://127.0.0.1:4590 --tokens /tmp/load-tokens.json \
 *        --connections 1000 --duration 20
 *
 * Scenarios (each run for --duration seconds with --connections concurrent clients):
 *   health              GET /health                       (floor: framework + network only)
 *   discovery           GET /discovery/vendors?lat&lng    (public; the heaviest read)
 *   home (authed)       GET /discovery/home               (default address → nearby vendors)
 *   validate-location   POST /addresses/validate-location (authed)
 *   mixed customer      authed mix of the above + order list + addresses
 *
 * Run it against a staging copy sized like production. Needs `ulimit -n` ≥ connections + 100.
 * Prints a table and exits non-zero when error rate or p99 breaches the thresholds.
 */
import fs from 'node:fs'
import autocannon from 'autocannon'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d }
const URL_BASE = arg('url', 'http://127.0.0.1:4590')
const CONNECTIONS = Number(arg('connections', 1000))
const DURATION = Number(arg('duration', 20))
const ONLY = arg('only', null)
const MAX_ERROR_RATE = Number(arg('max-error-rate', 0.01))
const MAX_P99_MS = Number(arg('max-p99-ms', 3000))
const { center, tokens } = JSON.parse(fs.readFileSync(arg('tokens', '/tmp/load-tokens.json'), 'utf8'))

const jitter = () => ({ lat: (center.lat + (Math.random() - 0.5) * 0.14).toFixed(5), lng: (center.lng + (Math.random() - 0.5) * 0.14).toFixed(5) })
const bearer = () => ({ authorization: `Bearer ${tokens[Math.floor(Math.random() * tokens.length)]}` })

const scenarios = {
  health: { requests: [{ method: 'GET', path: '/health' }] },
  discovery: {
    requests: [{ method: 'GET', setupRequest: (req) => { const p = jitter(); req.path = `/api/v1/discovery/vendors?lat=${p.lat}&lng=${p.lng}&limit=20`; return req } }],
  },
  'home (authed)': { requests: [{ method: 'GET', path: '/api/v1/discovery/home', setupRequest: (req) => { req.headers = { ...bearer() }; return req } }] },
  'validate-location': {
    requests: [{ method: 'POST', path: '/api/v1/addresses/validate-location', headers: { 'content-type': 'application/json' },
      setupRequest: (req) => { const p = jitter(); req.headers = { 'content-type': 'application/json', ...bearer() }; req.body = JSON.stringify({ lat: Number(p.lat), lng: Number(p.lng) }); return req } }],
  },
  'mixed customer': {
    requests: [
      { method: 'GET', path: '/api/v1/discovery/home', setupRequest: (r) => { r.headers = { ...bearer() }; return r } },
      { method: 'GET', setupRequest: (r) => { const p = jitter(); r.path = `/api/v1/discovery/vendors?lat=${p.lat}&lng=${p.lng}`; return r } },
      { method: 'GET', path: '/api/v1/addresses', setupRequest: (r) => { r.headers = { ...bearer() }; return r } },
      { method: 'GET', path: '/api/v1/orders', setupRequest: (r) => { r.headers = { ...bearer() }; return r } },
    ],
  },
}

const rows = []
let failed = false
for (const [name, def] of Object.entries(scenarios)) {
  if (ONLY && !name.startsWith(ONLY)) continue
  process.stdout.write(`▶ ${name.padEnd(20)} ${CONNECTIONS} connections × ${DURATION}s … `)
  const r = await autocannon({ url: URL_BASE, connections: CONNECTIONS, duration: DURATION, timeout: 30, ...def })
  const total = r['2xx'] + r.non2xx
  const errRate = total ? (r.non2xx + r.errors + r.timeouts) / (total + r.errors) : 1
  const row = {
    scenario: name, rps: Math.round(r.requests.average), p50: r.latency.p50, p97_5: r.latency.p97_5, p99: r.latency.p99, max: r.latency.max,
    '2xx': r['2xx'], non2xx: r.non2xx, errors: r.errors, timeouts: r.timeouts, errRatePct: +(errRate * 100).toFixed(2),
  }
  rows.push(row)
  const bad = errRate > MAX_ERROR_RATE || row.p99 > MAX_P99_MS
  if (bad) failed = true
  console.log(`${row.rps} req/s · p50 ${row.p50}ms · p99 ${row.p99}ms · errors ${row.errRatePct}% ${bad ? '❌' : '✅'}`)
}
console.table(rows)
if (failed) { console.error(`\nThresholds breached (error rate > ${MAX_ERROR_RATE * 100}% or p99 > ${MAX_P99_MS} ms)`); process.exit(2) }
