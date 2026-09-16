import { success } from '../../utils/apiResponse.js'

/**
 * Referrals controller — customer-facing "Refer & Earn" data.
 */
export class ReferralsController {
  constructor(service) {
    this.service = service
  }

  async getMySummary(request, reply) {
    const summary = await this.service.getMySummary(request.user.id)
    return reply.code(200).send(success(summary, 'Referral summary fetched'))
  }

  async getMyHistory(request, reply) {
    const { referrals, pagination } = await this.service.getMyHistory(request.user.id, request.query)
    return reply.code(200).send(success(referrals, 'Referral history fetched', { pagination }))
  }
}
