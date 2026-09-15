const OLA_MAPS_BASE_URL = 'https://api.olamaps.io'

/**
 * Ola Maps settings service — admin-only key management + live test.
 */
export class OlaMapsSettingsService {
  constructor(repository) {
    this.repository = repository
  }

  async get() {
    const settings = await this.repository.get()
    return this._toPublicShape(settings)
  }

  /**
   * Pings the real Ola Maps API with the given key and reports what it
   * actually returned — 200 = connected, 401/403 = invalid key, anything
   * else = surfaced verbatim so a 404/500 from Ola isn't hidden.
   */
  async test(apiKey) {
    const trimmed = (apiKey || '').trim()
    if (!trimmed) {
      return { success: false, statusCode: null, message: 'API key is required' }
    }
    try {
      const url = new URL(`${OLA_MAPS_BASE_URL}/tiles/vector/v1/styles.json`)
      url.searchParams.set('api_key', trimmed)
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (res.ok) {
        return { success: true, statusCode: res.status, message: 'Connected successfully' }
      }
      if (res.status === 401 || res.status === 403) {
        return { success: false, statusCode: res.status, message: 'Invalid API key' }
      }
      return { success: false, statusCode: res.status, message: `Ola Maps returned HTTP ${res.status}` }
    } catch (err) {
      return { success: false, statusCode: null, message: `Could not reach Ola Maps: ${err.message}` }
    }
  }

  /**
   * Saves the key/enabled flag — always re-tests when the key changes so a
   * broken key can never be silently enabled. If the caller didn't change
   * the key, re-uses the last known test result rather than re-testing on
   * every toggle flip.
   */
  async save({ apiKey, isEnabled }, updatedBy) {
    const current = await this.repository.get()
    const keyChanged = apiKey !== undefined && apiKey !== current?.apiKey
    const effectiveKey = apiKey !== undefined ? apiKey : current?.apiKey

    let testResult
    if (keyChanged || !current?.lastTestStatus) {
      testResult = await this.test(effectiveKey)
    } else {
      testResult = {
        success: current.lastTestStatus === 'SUCCESS',
        statusCode: null,
        message: current.lastTestMessage,
      }
    }

    const requestedEnabled = isEnabled ?? current?.isEnabled ?? true
    const saved = await this.repository.upsert({
      apiKey: effectiveKey,
      isEnabled: Boolean(requestedEnabled) && testResult.success,
      testResult,
      updatedBy,
    })

    return { settings: this._toPublicShape(saved), testResult }
  }

  /** Never exposes the raw key to the dashboard — only a masked preview. */
  _toPublicShape(settings) {
    if (!settings) {
      return {
        configured: false,
        isEnabled: false,
        maskedKey: null,
        lastTestedAt: null,
        lastTestStatus: null,
        lastTestMessage: null,
        updatedAt: null,
      }
    }
    return {
      configured: Boolean(settings.apiKey),
      isEnabled: settings.isEnabled,
      maskedKey: settings.apiKey ? `••••${settings.apiKey.slice(-4)}` : null,
      lastTestedAt: settings.lastTestedAt,
      lastTestStatus: settings.lastTestStatus,
      lastTestMessage: settings.lastTestMessage,
      updatedAt: settings.updatedAt,
    }
  }
}
