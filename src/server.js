import { buildApp } from './app.js'
import { env } from './config/env.js'
import { testConnection, closePool } from './config/database.js'
import { closeRedis } from './config/redis.js'
import { logger } from './config/logger.js'
import { initSentry, captureException } from './config/sentry.js'

// As early as possible, per Sentry's own guidance — a no-op until
// SENTRY_DSN is set.
initSentry()
import { runPermissionAudit } from './utils/permission-audit.js'
import { startCampaignScheduler, stopCampaignScheduler } from './workers/campaign-scheduler.worker.js'
import { startPaymentExpiryWorker, stopPaymentExpiryWorker } from './workers/payment-expiry.worker.js'
import net from 'net'
import { execSync } from 'child_process'

async function checkExistingBackend() {
  const port = env.PORT || 4500
  
  // Quick TCP check if port is actually listening
  const isListening = await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true)
      else resolve(false)
    })
    server.once('listening', () => {
      server.close()
      resolve(false)
    })
    server.listen(port, '0.0.0.0')
  })

  if (!isListening) return // Port is free

  // Port is in use. Check if it's the Unified Backend
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/service-categories`)
    if (res.ok) {
      console.log(`\nUnified Backend is already running on port ${port}.`)
      console.log(`Skipping startup to avoid duplicate Node/Nodemon instances.\n`)
      process.exit(0)
    }
  } catch (e) {
    // Not responding via HTTP or not our backend
  }

  // It's in use by something else, or our backend is hung
  console.log(`\n❌ Error: Port ${port} is already in use by another process.`)
  if (process.platform === 'win32') {
    try {
      const out = execSync(`netstat -ano | findstr :${port}`).toString()
      const lines = out.split('\n').filter(Boolean)
      let foundPid = null
      for (const line of lines) {
        if (line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/)
          foundPid = parts[parts.length - 1]
          break
        }
      }
      if (foundPid) {
        const psCmd = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${foundPid}' | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json`
        const psOut = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: 'utf8' })
        const proc = JSON.parse(psOut)
        console.log(`\nConflict Details:`)
        console.log(`- PID: ${proc.ProcessId}`)
        console.log(`- Executable: ${proc.Name}`)
        console.log(`- Command Line: ${proc.CommandLine}`)
        console.log(`\nPlease stop this process before starting the Unified Backend.\n`)
      }
    } catch (e) {}
  }
  process.exit(1)
}
const validateProductionConfig = () => {
  if (env.NODE_ENV === 'production') {
    const missing = []
    if (!env.RAZORPAY_KEY_ID) missing.push('RAZORPAY_KEY_ID')
    if (!env.RAZORPAY_KEY_SECRET) missing.push('RAZORPAY_KEY_SECRET')
    if (!env.RAZORPAY_WEBHOOK_SECRET) missing.push('RAZORPAY_WEBHOOK_SECRET')
    if (!env.GOOGLE_MAPS_API_KEY) missing.push('GOOGLE_MAPS_API_KEY')

    if (missing.length > 0) {
      logger.error(`❌ Critical production configuration keys are missing: ${missing.join(', ')}`)
      process.exit(1)
    }
  }
}

// Trigger nodemon reload 3
const start = async () => {
  try {
    await checkExistingBackend()
    validateProductionConfig()

    // Test database connection before starting
    await testConnection()

    // Build Fastify app
    const app = await buildApp()

    // ─── BOOT-TIME PERMISSION AUDIT (R17 AC#9, task 2.7) ───────────
    // After every plugin and module route has been registered, ensure
    // each protected dashboard route declares a canonical Permission_String
    // (design §4.5). `app.ready()` flushes all pending registrations so
    // every onRoute hook callback has fired into `app.permissionAuditRoutes`.
    // When STRICT_PERMISSION_AUDIT is true and any violation is found, abort
    // boot with exit code 1 per R17 AC#9; otherwise log a warning so the
    // misconfiguration stays visible while Phase C wires permissions in.
    await app.ready()
    const audit = runPermissionAudit({
      collectedRoutes: app.permissionAuditRoutes,
      strict: env.STRICT_PERMISSION_AUDIT,
      logger,
    })
    if (!audit.ok) {
      // Logged at error level inside runPermissionAudit. Close the
      // half-built app to release sockets and DB clients before exit so
      // graceful shutdown observers do not see a stuck process.
      await app.close().catch(() => {})
      await closePool().catch(() => {})
      await closeRedis().catch(() => {})
      process.exit(1)
    }

    // Start listening
    await app.listen({ port: env.PORT, host: env.HOST })

    logger.info(`🚀 ${env.APP_NAME} running on http://${env.HOST}:${env.PORT}`)
    if (env.ENABLE_SWAGGER) {
      logger.info(`📖 Swagger docs at http://localhost:${env.PORT}/documentation`)
    }
    if (app.io) {
      logger.info(`🔌 Socket.IO ready on ws://${env.HOST}:${env.PORT}`)
    }

    // Start campaign scheduler poller
    startCampaignScheduler()

    // Start payment expiry worker (cleans up abandoned 15-min payment windows)
    startPaymentExpiryWorker()

    // PM2 ready signal
    if (process.send) {
      process.send('ready')
    }

    // ─── GRACEFUL SHUTDOWN ──────────────────────────
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Shutdown signal received')

      // Stop campaign scheduler
      stopCampaignScheduler()

      // Stop payment expiry worker
      stopPaymentExpiryWorker()

      // Close Socket.IO
      if (app.io) {
        app.io.close()
        logger.info('Socket.IO closed')
      }

      // Stop accepting new connections
      await app.close()
      logger.info('Fastify closed')

      // Close database pool
      await closePool()
      logger.info('PostgreSQL pool closed')

      // Close Redis
      await closeRedis()
      logger.info('Redis closed')

      logger.info('Graceful shutdown complete')
      process.exit(0)
    }

    process.on('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGTERM', () => shutdown('SIGTERM'))

    // Unhandled errors — log and exit
    process.on('unhandledRejection', (err) => {
      logger.fatal({ err }, 'Unhandled rejection')
      captureException(err)
      process.exit(1)
    })

    process.on('uncaughtException', (err) => {
      logger.fatal({ err }, 'Uncaught exception')
      captureException(err)
      process.exit(1)
    })
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server')
    captureException(err)
    process.exit(1)
  }
}

start()
