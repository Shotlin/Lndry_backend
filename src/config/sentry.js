import * as Sentry from '@sentry/node'
import { env } from './env.js'

// Fully inert until SENTRY_DSN is set — safe to call unconditionally from
// server.js and the error handler regardless of environment.
const enabled = Boolean(env.SENTRY_DSN)

export function initSentry() {
  if (!enabled) return
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: 0.1,
  })
}

export function captureException(error, context) {
  if (!enabled) return
  Sentry.captureException(error, context)
}
