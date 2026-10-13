import { success, error } from '../../../utils/apiResponse.js'

export class TwoFactorSettingsController {
  constructor(service) {
    this.service = service
  }

  _actor(request) {
    return { ip: request.ip, userAgent: request.headers['user-agent'] }
  }

  async _run(reply, fn, okMessage) {
    try {
      return reply.code(200).send(success(await fn(), okMessage))
    } catch (err) {
      if (err?.statusCode) return reply.code(err.statusCode).send(error(err.message, err.code || 'ERROR'))
      throw err
    }
  }

  get(request, reply) {
    return this._run(reply, () => this.service.get(), '2Factor settings fetched')
  }

  test(request, reply) {
    return this._run(reply, () => this.service.testTypedOrStored(request.body?.apiKey), 'Connection test finished')
  }

  save(request, reply) {
    return this._run(reply, () => this.service.save(request.body || {}, request.user?.id ?? null, this._actor(request)), '2Factor settings saved')
  }

  remove(request, reply) {
    return this._run(reply, () => this.service.remove(request.user?.id ?? null, this._actor(request)), '2Factor key removed')
  }

  sendTest(request, reply) {
    return this._run(reply, () => this.service.sendTestOtp(request.body?.phone), 'Test OTP sent')
  }
}
