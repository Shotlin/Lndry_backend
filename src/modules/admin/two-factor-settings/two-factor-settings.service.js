import { decryptSecret, encryptSecret, maskSecret } from '../../../utils/secret-box.js'
import { emit as emitAudit } from '../../../utils/audit-log.js'
import { getSmsConfig } from '../../../utils/sms-config.js'
import { sendSmsOtp } from '../../../utils/sms.js'
import { logger } from '../../../config/logger.js'

const TWO_FACTOR_BASE = 'https://2factor.in/API/V1'
const TEMPLATE_RE = /^[A-Za-z0-9_\- ]{1,100}$/

const bad = (message, code = 'VALIDATION_ERROR', statusCode = 400) => ({ statusCode, message, code })

/** 2Factor.in SMS-OTP admin settings: API key, template name, on/off, live test, test OTP. */
export class TwoFactorSettingsService {
  constructor(repository) {
    this.repository = repository
  }

  async get() {
    const row = await this.repository.get()
    const active = await getSmsConfig()
    return {
      ...this._publicShape(row),
      effective: active ? { source: active.source } : { source: 'none' },
    }
  }

  /** Asks 2Factor for the account's SMS balance — a real, free call that also proves the key is valid. */
  async test(apiKey) {
    const key = (apiKey || '').trim()
    if (!key) return { success: false, message: 'API key is required', balance: null }
    try {
      const res = await fetch(`${TWO_FACTOR_BASE}/${encodeURIComponent(key)}/BAL/SMS`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      const data = await res.json().catch(() => ({}))
      if (data.Status === 'Success') {
        const balance = String(data.Details ?? '')
        return { success: true, message: `Connected — ${balance} SMS credits left`, balance }
      }
      return { success: false, message: data.Details ? `2Factor says: ${data.Details}` : `2Factor returned HTTP ${res.status}`, balance: null }
    } catch (err) {
      return { success: false, message: `Could not reach 2Factor: ${err.message}`, balance: null }
    }
  }

  /** Test whatever key is typed, or the saved one when nothing is typed. */
  async testTypedOrStored(typedKey) {
    if (typedKey && typedKey.trim()) return this.test(typedKey)
    const row = await this.repository.get()
    if (!row?.apiKeyEnc) return { success: false, message: 'Enter an API key first', balance: null }
    return this.test(decryptSecret(row.apiKeyEnc))
  }

  /**
   * Saves key / template / on-off. A new key is always tested first and a key that
   * fails is NOT stored. SMS can only be switched on with a key that passed its test.
   */
  async save({ apiKey, template, isEnabled }, adminUserId, actor = {}) {
    const cur = await this.repository.get()
    const newKey = apiKey !== undefined ? String(apiKey).trim() : undefined
    const tpl = template !== undefined ? String(template).trim() : (cur?.template || 'LndryAppOTP')
    if (!TEMPLATE_RE.test(tpl)) throw bad('Template name may only contain letters, numbers, spaces, - and _ (max 100).')

    let apiKeyEnc = cur?.apiKeyEnc ?? null
    let testResult = null
    let balance = cur?.lastBalance ?? null

    if (newKey) {
      testResult = await this.test(newKey)
      if (!testResult.success) throw bad(`Not saved — ${testResult.message}`, 'TWO_FACTOR_TEST_FAILED')
      apiKeyEnc = encryptSecret(newKey)
      balance = testResult.balance
    }

    const wantEnabled = isEnabled !== undefined ? Boolean(isEnabled) : Boolean(cur?.isEnabled)
    if (wantEnabled && !apiKeyEnc) throw bad('Add an API key before turning SMS on.')
    if (wantEnabled && !newKey && cur?.lastTestStatus !== 'SUCCESS') {
      // re-verify the stored key before enabling
      testResult = await this.test(decryptSecret(apiKeyEnc))
      if (!testResult.success) throw bad(`Not turned on — ${testResult.message}`, 'TWO_FACTOR_TEST_FAILED')
      balance = testResult.balance
    }

    const saved = await this.repository.upsert(
      { apiKeyEnc, template: tpl, isEnabled: wantEnabled, testResult, balance },
      adminUserId,
    )
    if (newKey || saved.isEnabled !== Boolean(cur?.isEnabled) || tpl !== cur?.template) {
      emitAudit('two_factor_settings_updated', {
        actor_user_id: adminUserId ?? null,
        actor_role: 'ADMIN',
        target_type: 'two_factor_settings',
        target_id: saved.id,
        before: { enabled: Boolean(cur?.isEnabled), template: cur?.template ?? null, key_set: Boolean(cur?.apiKeyEnc) },
        after: { enabled: saved.isEnabled, template: saved.template, key_set: Boolean(saved.apiKeyEnc), key_changed: Boolean(newKey) },
        ip_address: actor.ip ?? null,
        user_agent: actor.userAgent ?? null,
      })
      logger.info({ adminUserId, enabled: saved.isEnabled }, '2Factor settings updated from dashboard')
    }
    return { settings: await this.get(), testResult }
  }

  async remove(adminUserId, actor = {}) {
    const cur = await this.repository.get()
    const saved = await this.repository.clear(adminUserId)
    if (cur?.apiKeyEnc) {
      emitAudit('two_factor_settings_updated', {
        actor_user_id: adminUserId ?? null,
        actor_role: 'ADMIN',
        target_type: 'two_factor_settings',
        target_id: saved?.id ?? cur.id,
        before: { enabled: Boolean(cur.isEnabled), key_set: true },
        after: { enabled: false, key_set: false },
        ip_address: actor.ip ?? null,
        user_agent: actor.userAgent ?? null,
      })
    }
    return { settings: await this.get() }
  }

  /** Sends a real OTP SMS (costs 1 credit) so the admin can see it arrive. Uses the configuration in force. */
  async sendTestOtp(phone) {
    const clean = String(phone || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '')
    if (!/^[6-9]\d{9}$/.test(clean)) throw bad('Enter a valid 10-digit Indian mobile number.')
    const cfg = await getSmsConfig()
    if (!cfg) throw bad('SMS is not switched on — add the API key and turn it on first.', 'SMS_NOT_CONFIGURED')
    const res = await sendSmsOtp(clean)
    if (!res.success) throw bad(`2Factor could not send the SMS: ${res.message || 'unknown error'}`, 'SMS_SEND_FAILED', 502)
    return { sent: true, phone: `••••••${clean.slice(-4)}`, message: 'Test OTP sent — check the phone.' }
  }

  _publicShape(row) {
    let maskedKey = null
    if (row?.apiKeyEnc) {
      try { maskedKey = maskSecret(decryptSecret(row.apiKeyEnc)) } catch { maskedKey = '(unreadable — re-enter)' }
    }
    return {
      configured: Boolean(row?.apiKeyEnc),
      isEnabled: Boolean(row?.isEnabled),
      maskedKey,
      template: row?.template || 'LndryAppOTP',
      lastTestedAt: row?.lastTestedAt ?? null,
      lastTestStatus: row?.lastTestStatus ?? null,
      lastTestMessage: row?.lastTestMessage ?? null,
      lastBalance: row?.lastBalance ?? null,
      updatedAt: row?.updatedAt ?? null,
    }
  }
}
