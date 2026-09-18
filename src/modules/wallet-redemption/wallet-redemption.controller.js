import { success, error } from '../../utils/apiResponse.js'

/**
 * Wallet Redemption controller — thin HTTP layer shared by both the
 * vendor-facing routes (mounted at /api/v1/vendor) and the customer-facing
 * pending-check route (added onto the existing /api/v1/wallet prefix).
 */
export class WalletRedemptionController {
  constructor(service) {
    this.service = service
  }

  _actorCtx(request) {
    return {
      userId: request.user?.id ?? null,
      role: request.user?.role ?? null,
      vendorId: request.vendorId,
      ip: request.ip ?? null,
      userAgent: request.headers?.['user-agent'] ?? null,
    }
  }

  /**
   * Every error the service throws carries a statusCode (see
   * wallet-redemption.service.js) — anything without one is a genuine
   * unexpected failure and is left to propagate to the global error
   * handler. attemptsRemaining rides along outside the standard error()
   * shape (the same feedback order_otps' verify flow gives, but that
   * flow's callers let it get silently dropped by the global handler —
   * this module surfaces it deliberately instead).
   */
  _handleError(reply, err) {
    if (!err?.statusCode) throw err
    const body = error(err.message, err.code)
    if (err.attemptsRemaining !== undefined) body.attemptsRemaining = err.attemptsRemaining
    return reply.code(err.statusCode).send(body)
  }

  async lookupPhone(request, reply) {
    const phone = String(request.body?.phone || '').trim()
    if (!phone) return reply.code(400).send(error('phone is required', 'VALIDATION_ERROR'))
    try {
      const result = await this.service.lookupByPhone(phone, this._actorCtx(request))
      if (!result) return reply.code(404).send(error('No LNDRY account found for this phone number', 'NOT_FOUND'))
      return reply.code(200).send(success(result, 'Customer found'))
    } catch (err) {
      return this._handleError(reply, err)
    }
  }

  async createRequest(request, reply) {
    try {
      const result = await this.service.createRequest(
        request.vendorId,
        request.user.id,
        request.body,
        this._actorCtx(request)
      )
      return reply.code(200).send(success(result, 'Wallet redemption request created'))
    } catch (err) {
      return this._handleError(reply, err)
    }
  }

  async confirmRequest(request, reply) {
    try {
      const result = await this.service.confirmRequest(
        request.params.id,
        request.vendorId,
        request.body?.otp,
        this._actorCtx(request)
      )
      return reply.code(200).send(success(result, 'Wallet redemption confirmed'))
    } catch (err) {
      return this._handleError(reply, err)
    }
  }

  async cancelRequest(request, reply) {
    try {
      const result = await this.service.cancelRequest(request.params.id, request.vendorId)
      return reply.code(200).send(success(result, 'Wallet redemption request cancelled'))
    } catch (err) {
      return this._handleError(reply, err)
    }
  }

  async getPending(request, reply) {
    reply.header('Cache-Control', 'no-store')
    const result = await this.service.getPendingForCustomer(request.user.id)
    return reply.code(200).send(success(result, result ? 'Pending redemption request' : 'No pending request'))
  }
}
