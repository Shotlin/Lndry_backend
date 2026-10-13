import { decryptSecret, encryptSecret, maskSecret } from '../../../utils/secret-box.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { getRazorpay } from '../../../config/razorpay.js'
import { logger } from '../../../config/logger.js'

const RAZORPAY_API = 'https://api.razorpay.com/v1'
const MODES = ['TEST', 'LIVE']
const KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/

const bad = (message, code = 'VALIDATION_ERROR', statusCode = 400) => ({ statusCode, message, code })

/**
 * Razorpay admin settings: two independent credential sets (TEST / LIVE) and
 * an active-mode switch. Nothing is stored or activated unless Razorpay itself
 * accepted the credentials a moment earlier.
 */
export class RazorpaySettingsService {
  constructor(repository) {
    this.repository = repository
  }

  async get() {
    const row = await this.repository.get()
    const [effective, pendingPayments] = await Promise.all([
      getRazorpay().catch(() => null),
      this.repository.countPendingPayments(),
    ])
    return {
      activeMode: row?.activeMode ?? 'TEST',
      effective: effective
        ? { mode: effective.mode, source: effective.source, keyId: effective.keyId }
        : { mode: null, source: 'none', keyId: null },
      webhookUrl: `${process.env.PUBLIC_API_URL || 'https://api.lndry.in'}/api/webhook/razorpay`,
      pendingPayments,
      test: this._sidePublic(row?.TEST),
      live: this._sidePublic(row?.LIVE),
      updatedAt: row?.updatedAt ?? null,
    }
  }

  /** Live check against Razorpay. Uses the typed values, or the stored ones for whatever is left blank. */
  async test(mode, { keyId, keySecret } = {}) {
    const m = this._mode(mode)
    const row = await this.repository.get()
    const stored = row?.[m]
    const effectiveId = (keyId || '').trim() || stored?.keyId
    let effectiveSecret = (keySecret || '').trim()
    if (!effectiveSecret && stored?.keySecretEnc && (!keyId || keyId.trim() === stored.keyId)) {
      effectiveSecret = decryptSecret(stored.keySecretEnc)
    }
    return this._ping(m, effectiveId, effectiveSecret)
  }

  async saveMode(mode, { keyId, keySecret, webhookSecret }, adminUserId, actor = {}) {
    const m = this._mode(mode)
    const row = await this.repository.get()
    const cur = row?.[m] ?? {}
    const newId = keyId !== undefined ? String(keyId).trim() : undefined
    const newSecret = keySecret !== undefined ? String(keySecret).trim() : undefined

    const update = {}
    let testResult = null

    if (newId || newSecret) {
      const idChanged = newId && newId !== cur.keyId
      if (idChanged && !newSecret) throw bad('Enter the Key Secret together with a new Key ID.')
      const id = newId || cur.keyId
      const secret = newSecret || (cur.keySecretEnc ? decryptSecret(cur.keySecretEnc) : '')
      if (!id || !secret) throw bad('Both Key ID and Key Secret are required.')
      testResult = await this._ping(m, id, secret)
      if (!testResult.success) {
        throw bad(`Not saved — ${testResult.message}`, 'RAZORPAY_TEST_FAILED')
      }
      update.keyId = id
      update.keySecretEnc = encryptSecret(secret)
      update.test = testResult
    }
    if (webhookSecret !== undefined) {
      const w = String(webhookSecret).trim()
      if (w.length > 200) throw bad('Webhook secret is too long.')
      update.webhookSecretEnc = w ? encryptSecret(w) : null
    }
    if (update.keyId === undefined && update.webhookSecretEnc === undefined) {
      throw bad('Nothing to save — enter a Key ID and Key Secret, or a webhook secret.')
    }
    if (update.keyId === undefined && !cur.keyId) {
      throw bad(`Save the ${m} Key ID and Key Secret first, then the webhook secret.`)
    }

    const saved = await this.repository.saveCredentials(m, update, adminUserId)
    emitAudit('razorpay_settings_updated', {
      actor_user_id: adminUserId ?? null,
      actor_role: 'ADMIN',
      target_type: 'razorpay_settings',
      target_id: saved.id,
      before: { mode: m, key_id: cur.keyId ?? null },
      after: { mode: m, key_id: saved[m].keyId, webhook_secret_set: Boolean(saved[m].webhookSecretEnc) },
      ip_address: actor.ip ?? null,
      user_agent: actor.userAgent ?? null,
    })
    logger.info({ mode: m, adminUserId }, 'Razorpay credentials updated from dashboard')
    return {
      settings: await this.get(),
      testResult,
      takesEffectNow: saved.activeMode === m,
    }
  }

  async setActiveMode(mode, adminUserId, actor = {}) {
    const m = this._mode(mode)
    const row = await this.repository.get()
    const side = row?.[m]
    if (!side?.keyId || !side?.keySecretEnc) {
      throw bad(`Add and test the ${m} keys before switching to ${m} mode.`, 'RAZORPAY_MODE_NOT_CONFIGURED')
    }
    const check = await this._ping(m, side.keyId, decryptSecret(side.keySecretEnc))
    // record the fresh result either way so the dashboard shows it
    await this.repository.saveCredentials(m, { test: check }, adminUserId)
    if (!check.success) throw bad(`Not switched — ${check.message}`, 'RAZORPAY_TEST_FAILED')

    const before = row.activeMode
    const saved = await this.repository.setActiveMode(m, adminUserId)
    if (before !== m) {
      emitAudit('razorpay_mode_changed', {
        actor_user_id: adminUserId ?? null,
        actor_role: 'ADMIN',
        target_type: 'razorpay_settings',
        target_id: saved.id,
        before: { mode: before },
        after: { mode: m },
        ip_address: actor.ip ?? null,
        user_agent: actor.userAgent ?? null,
      })
      logger.warn({ from: before, to: m, adminUserId }, 'Razorpay active mode changed')
    }
    const warnings = []
    if (!side.webhookSecretEnc) warnings.push(`No ${m} webhook secret saved — Razorpay webhooks will be rejected until you add it.`)
    return { settings: await this.get(), warnings }
  }

  async clearMode(mode, adminUserId, actor = {}) {
    const m = this._mode(mode)
    const row = await this.repository.get()
    if (row?.activeMode === m) {
      throw bad(`${m} is the active mode — switch to the other mode before removing its keys.`, 'RAZORPAY_MODE_ACTIVE')
    }
    const saved = await this.repository.clearCredentials(m, adminUserId)
    emitAudit('razorpay_credentials_removed', {
      actor_user_id: adminUserId ?? null,
      actor_role: 'ADMIN',
      target_type: 'razorpay_settings',
      target_id: saved.id,
      before: { mode: m, key_id: row?.[m]?.keyId ?? null },
      after: { mode: m, key_id: null },
      ip_address: actor.ip ?? null,
      user_agent: actor.userAgent ?? null,
    })
    return { settings: await this.get() }
  }

  _mode(mode) {
    const m = String(mode || '').toUpperCase()
    if (!MODES.includes(m)) throw bad('mode must be TEST or LIVE')
    return m
  }

  async _ping(mode, keyId, keySecret) {
    if (!keyId || !keySecret) {
      return { success: false, statusCode: null, message: 'Key ID and Key Secret are required.' }
    }
    const match = KEY_ID_RE.exec(keyId)
    if (!match) {
      return { success: false, statusCode: null, message: 'Key ID should look like rzp_test_xxxxxxxx or rzp_live_xxxxxxxx.' }
    }
    const keyMode = match[1].toUpperCase()
    if (keyMode !== mode) {
      return {
        success: false,
        statusCode: null,
        message: `This is a ${keyMode} key — paste it in the ${keyMode === 'TEST' ? 'Test' : 'Live'} section, not the ${mode === 'TEST' ? 'Test' : 'Live'} one.`,
      }
    }
    try {
      const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64')
      const res = await fetch(`${RAZORPAY_API}/orders?count=1`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) return { success: true, statusCode: res.status, message: `Connected to Razorpay (${mode} mode)` }
      if (res.status === 401 || res.status === 403) {
        return { success: false, statusCode: res.status, message: 'Razorpay rejected these credentials (wrong Key ID or Key Secret).' }
      }
      return { success: false, statusCode: res.status, message: `Razorpay returned HTTP ${res.status}` }
    } catch (err) {
      return { success: false, statusCode: null, message: `Could not reach Razorpay: ${err.message}` }
    }
  }

  /** Never returns a secret — masked preview only. */
  _sidePublic(side) {
    let maskedSecret = null
    if (side?.keySecretEnc) {
      try { maskedSecret = maskSecret(decryptSecret(side.keySecretEnc)) } catch { maskedSecret = '(unreadable — re-enter)' }
    }
    return {
      configured: Boolean(side?.keyId && side?.keySecretEnc),
      keyId: side?.keyId ?? null,
      maskedSecret,
      webhookConfigured: Boolean(side?.webhookSecretEnc),
      lastTestedAt: side?.lastTestedAt ?? null,
      lastTestStatus: side?.lastStatus ?? null,
      lastTestMessage: side?.lastMessage ?? null,
    }
  }
}
