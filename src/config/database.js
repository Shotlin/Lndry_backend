import pg from 'pg'
import fs from 'node:fs'
import { env } from './env.js'
import { logger } from './logger.js'
import { waitForDb } from '../database/waitForDb.js'

const { Pool } = pg

export const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  min: env.DB_POOL_MIN,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT,
  // Time a request may WAIT for a free pooled connection. Floored at 8s: every
  // env template used to ship 2000, which turns any burst of simultaneous orders
  // into a wave of "timeout exceeded when trying to connect" 500s instead of a
  // short queue.
  connectionTimeoutMillis: Math.max(env.DB_CONNECTION_TIMEOUT, 8000),
  // Per-session safety nets enforced by PostgreSQL itself.
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  idle_in_transaction_session_timeout: env.DB_IDLE_IN_TX_TIMEOUT_MS,
  application_name: 'lndry-api',
  // Certificate verification stays on (Node's built-in trusted CA store
  // already covers most managed Postgres providers using publicly-trusted
  // certs). DB_SSL_CA_PATH lets a self-managed/private CA be trusted
  // explicitly instead of disabling verification wholesale.
  ...(env.DB_SSL && {
    ssl: {
      rejectUnauthorized: true,
      ...(env.DB_SSL_CA_PATH && { ca: fs.readFileSync(env.DB_SSL_CA_PATH, 'utf8') }),
    },
  }),
})

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PostgreSQL pool error')
})

pool.on('connect', () => {
  logger.debug('New PostgreSQL client connected')
})

/**
 * Execute a parameterized SQL query
 * @param {string} text - SQL query with $1, $2, ... placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<pg.QueryResult>}
 */
export const query = (text, params) => pool.query(text, params)

// ── Transaction clients can never starve the pool ────────────────────────
// A transaction holds ONE pooled connection for its whole life, and a lot of
// code runs further queries through the shared pool while it is open
// (notifications, referrals, cache refreshes ...). If every pooled connection
// is held by a transaction that is waiting for a second one, nothing can ever
// proceed: the pool deadlocks until the connection timeout and the requests
// fail. That is exactly what ~20 simultaneous checkouts did on a 20-connection
// pool. Capping how many connections transactions may hold at 70% of the pool
// guarantees the remainder is always available for those nested queries.
const TX_CLIENT_LIMIT = Math.max(1, Math.floor(env.DB_POOL_MAX * 0.7))
let txClientsInUse = 0
const txWaiters = []
// Waiting here means a request is queued behind other transactions, not failing. Queued work is
// mostly checkouts whose customer has ALREADY PAID, so queue generously (the app waits 30s, the
// server request timeout is 60s) and let the payment reconciler mop up anything that still times out.
const TX_WAIT_MS = Math.max(env.DB_CONNECTION_TIMEOUT, 20000)

function acquireTxSlot() {
  if (txClientsInUse < TX_CLIENT_LIMIT) {
    txClientsInUse++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null }
    waiter.timer = setTimeout(() => {
      const i = txWaiters.indexOf(waiter)
      if (i >= 0) txWaiters.splice(i, 1)
      reject(new Error('timeout exceeded when trying to start a database transaction (server busy)'))
    }, TX_WAIT_MS)
    txWaiters.push(waiter)
  })
}

function releaseTxSlot() {
  const next = txWaiters.shift()
  if (next) {
    clearTimeout(next.timer)
    next.resolve() // hand the slot straight to the next waiter
  } else {
    txClientsInUse--
  }
}

/**
 * Get a client from the pool for transactions. `release()` is idempotent, so a
 * success path that releases early (to free the connection before follow-up
 * work) and a `finally` that releases again are both safe.
 * @returns {Promise<pg.PoolClient>}
 */
export const getClient = async () => {
  await acquireTxSlot()
  let client
  try {
    client = await pool.connect()
  } catch (err) {
    releaseTxSlot()
    throw err
  }
  const release = client.release.bind(client)
  let released = false
  client.release = (arg) => {
    if (released) return
    released = true
    releaseTxSlot()
    release(arg)
  }
  return client
}

/** Live pool numbers for health checks / metrics. */
export const poolStats = () => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
  txClientsInUse,
  txClientLimit: TX_CLIENT_LIMIT,
  txWaiting: txWaiters.length,
})

/**
 * Test the database connection
 */
export const testConnection = async () => {
  await waitForDb(pool, {
    retries: env.DB_CONNECT_RETRIES,
    delayMs: env.DB_CONNECT_RETRY_DELAY,
    logger,
  })

  const client = await pool.connect()
  try {
    await client.query('SELECT NOW()')
    logger.info('✅ PostgreSQL connected successfully')
  } finally {
    client.release()
  }
}

/**
 * Close the pool (for graceful shutdown)
 */
export const closePool = () => pool.end()
