import { success, error } from '../../../utils/apiResponse.js'

/**
 * Ola Maps settings controller — thin HTTP layer
 */
export class OlaMapsSettingsController {
  constructor(service) {
    this.service = service
  }

  async get(request, reply) {
    const settings = await this.service.get()
    return reply.code(200).send(success(settings, 'Ola Maps settings fetched'))
  }

  async test(request, reply) {
    const { apiKey } = request.body || {}
    if (!apiKey) {
      return reply.code(400).send(error('apiKey is required', 'VALIDATION_ERROR'))
    }
    const result = await this.service.test(apiKey)
    return reply.code(200).send(success(result, result.success ? 'Connection successful' : 'Connection failed'))
  }

  async save(request, reply) {
    const { apiKey, isEnabled } = request.body || {}
    const { settings, testResult } = await this.service.save({ apiKey, isEnabled }, request.user?.id ?? null)
    const message = !testResult.success && isEnabled !== false
      ? 'Saved, but the key failed its connection test — Ola Maps stays disabled.'
      : 'Ola Maps settings saved'
    return reply.code(200).send(success({ settings, testResult }, message))
  }
}
