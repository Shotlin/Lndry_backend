import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

let firebaseApp = null
let _admin = null

/** FCM `sendEach` accepts at most 500 messages per call. */
const FCM_BATCH_LIMIT = 500

/**
 * Initialize Firebase Admin SDK (lazy singleton — safe to call multiple times)
 */
async function getFirebaseApp() {
  if (firebaseApp) return firebaseApp

  if (!env.FCM_ENABLED || !env.FIREBASE_PROJECT_ID) {
    return null
  }

  try {
    const admin = (await import('firebase-admin')).default
    _admin = admin

    // Guard: if default app already exists (e.g. from another import path), reuse it
    if (admin.apps.length > 0) {
      firebaseApp = admin.apps[0]
      logger.info('Firebase Admin SDK reused existing app')
      return firebaseApp
    }

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: env.FIREBASE_PROJECT_ID,
        privateKey: env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
      }),
    })

    logger.info('Firebase Admin SDK initialized')
    return firebaseApp
  } catch (err) {
    logger.error({ err }, 'Firebase Admin SDK init failed')
    return null
  }
}

/**
 * Build one FCM message. Every push — transactional, campaign or test — goes
 * through here so channel, priority and image handling stay identical.
 */
export function buildMessage(fcmToken, { title, body, imageUrl, deepLink, data = {}, ttlSeconds }) {
  const stringData = Object.fromEntries(
    Object.entries({
      ...data,
      ...(deepLink && !data.deepLink ? { deepLink } : {}),
      ...(imageUrl ? { imageUrl } : {}),
    })
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, String(v)])
  )
  const image = imageUrl && isValidHttpsUrl(imageUrl) ? imageUrl : undefined

  return {
    token: fcmToken,
    notification: {
      title,
      body,
      ...(image ? { imageUrl: image } : {}),
    },
    data: stringData,
    android: {
      priority: 'high',
      ...(ttlSeconds > 0 ? { ttl: Math.min(Math.floor(ttlSeconds), 2419200) * 1000 } : {}),
      notification: {
        sound: 'default',
        channelId: 'lndry_notifications',
        imageUrl: image,
        // No `clickAction` on purpose: with one set, Android builds the tap
        // intent from that action and — unless the app declares an activity
        // for it — the tap opens nothing when the app is closed or in the
        // background. Without it FCM launches the app's normal launch
        // activity and hands the `data` to the app.
      },
    },
    apns: {
      payload: { aps: { sound: 'default', badge: 1, ...(image ? { mutableContent: true } : {}) } },
      fcmOptions: image ? { imageUrl: image } : undefined,
    },
  }
}

/**
 * Send a list of individually built messages (each may carry its own data),
 * in chunks of 500. Returns one result per input message, in order:
 *   { token, success, messageId?, errorCode?, tokenInvalid }
 * Never throws for a per-message failure; if FCM itself is not configured every
 * result is `{ success:false, errorCode:'FCM_NOT_CONFIGURED' }`.
 */
export async function sendPushMessages(messages) {
  if (!messages?.length) return { configured: true, results: [] }

  const app = await getFirebaseApp()
  if (!app) {
    return {
      configured: false,
      results: messages.map((m) => ({
        token: m.token, success: false, errorCode: 'FCM_NOT_CONFIGURED', tokenInvalid: false,
      })),
    }
  }

  const admin = _admin || (await import('firebase-admin')).default
  const results = []

  for (let i = 0; i < messages.length; i += FCM_BATCH_LIMIT) {
    const chunk = messages.slice(i, i + FCM_BATCH_LIMIT)
    try {
      const res = await admin.messaging().sendEach(chunk)
      res.responses.forEach((r, idx) => {
        const token = chunk[idx].token
        if (r.success) {
          results.push({ token, success: true, messageId: r.messageId, tokenInvalid: false })
        } else {
          results.push({
            token,
            success: false,
            errorCode: r.error?.code || r.error?.errorInfo?.code || 'UNKNOWN',
            tokenInvalid: isTokenInvalidError(r.error),
          })
        }
      })
    } catch (err) {
      logger.error({ err: err.message }, 'FCM sendEach chunk failed')
      chunk.forEach((m) => results.push({
        token: m.token, success: false, errorCode: err.code || 'SEND_FAILED', tokenInvalid: false,
      }))
    }
  }

  return { configured: true, results }
}

/**
 * Send push notification to a single device token.
 * Returns { success, messageId } or { success: false, reason, tokenInvalid }
 */
export async function sendPush(fcmToken, { title, body, imageUrl, deepLink, data = {} }) {
  const app = await getFirebaseApp()
  if (!app) {
    logger.debug({ title }, 'FCM not configured — skipping push notification')
    return { success: false, reason: 'FCM not configured' }
  }

  try {
    const admin = _admin || (await import('firebase-admin')).default
    const result = await admin.messaging().send(buildMessage(fcmToken, { title, body, imageUrl, deepLink, data }))
    logger.info({ messageId: result, title }, 'Push notification sent')
    return { success: true, messageId: result }
  } catch (err) {
    const tokenInvalid = isTokenInvalidError(err)
    logger.error({ err: err.message, title, tokenInvalid }, 'Push notification failed')
    return { success: false, reason: err.message, tokenInvalid }
  }
}

/**
 * Send the same push to many tokens (chunked). Kept for existing callers;
 * new code should use the notification dispatcher, which also records
 * per-device delivery results.
 */
export async function sendPushBatch(fcmTokens, { title, body, imageUrl, deepLink, data = {} }) {
  if (!fcmTokens?.length) return { success: false, reason: 'No tokens', sent: 0, failed: 0 }

  const { configured, results } = await sendPushMessages(
    fcmTokens.map((t) => buildMessage(t, { title, body, imageUrl, deepLink, data }))
  )
  if (!configured) {
    logger.debug({ title }, 'FCM not configured — skipping batch push')
    return { success: false, reason: 'FCM not configured', sent: 0, failed: 0 }
  }

  const sent = results.filter((r) => r.success).length
  const invalidTokens = results.filter((r) => r.tokenInvalid).map((r) => r.token)
  logger.info({ title, sent, failed: results.length - sent }, 'Batch push complete')
  return { success: true, sent, failed: results.length - sent, invalidTokens }
}

// Export a getter for messaging instance (used by firebase.js re-export)
export const firebaseMessaging = null // lazy — use sendPush/sendPushBatch

function isValidHttpsUrl(url) {
  if (!url || typeof url !== 'string') return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

function isTokenInvalidError(err) {
  if (!err) return false
  const code = err.code || err.errorInfo?.code || ''
  // Only deactivate on definitive "token no longer valid" errors
  // Do NOT deactivate on quota/rate-limit/server errors
  return (
    code === 'messaging/registration-token-not-registered' ||
    code === 'messaging/invalid-registration-token' ||
    code.includes('registration-token-not-registered')
  )
}
