import { success, error } from '../../../utils/apiResponse.js'

/** Thin HTTP layer. Service errors are thrown as { statusCode, message, code }. */
export class RazorpaySettingsController {
  constructor(service) {
    this.service = service
  }

  _actor(request) {
    return { ip: request.ip, userAgent: request.headers['user-agent'] }
  }

  async _run(reply, fn, okMessage) {
    try {
      const data = await fn()
      return reply.code(200).send(success(data, okMessage))
    } catch (err) {
      if (err?.statusCode) return reply.code(err.statusCode).send(error(err.message, err.code || 'ERROR'))
      throw err
    }
  }

  get(request, reply) {
    return this._run(reply, () => this.service.get(), 'Razorpay settings fetched')
  }

  test(request, reply) {
    const { mode, keyId, keySecret } = request.body || {}
    return this._run(reply, () => this.service.test(mode, { keyId, keySecret }), 'Connection test finished')
  }

  save(request, reply) {
    return this._run(
      reply,
      () => this.service.saveMode(request.params.mode, request.body || {}, request.user?.id ?? null, this._actor(request)),
      'Razorpay keys saved',
    )
  }

  setActive(request, reply) {
    return this._run(
      reply,
      () => this.service.setActiveMode(request.body?.mode, request.user?.id ?? null, this._actor(request)),
      'Razorpay mode switched',
    )
  }

  clear(request, reply) {
    return this._run(
      reply,
      () => this.service.clearMode(request.params.mode, request.user?.id ?? null, this._actor(request)),
      'Razorpay keys removed',
    )
  }
}
