import { env } from '../../config/env.js'
import { success, error } from '../../utils/apiResponse.js'
import { captureRawBody } from '../../utils/rawBody.js'
import { verifyPartnerLeadSignature } from './partner-leads.contract.js'
import { PartnerLeadsService } from './partner-leads.service.js'

const bodySchema = {
  type: 'object', additionalProperties: false,
  required: ['fullName', 'businessName', 'email', 'phone', 'city', 'serviceArea', 'selectedServices', 'businessType', 'yearsInBusiness', 'estimatedMonthlyOrders', 'privacyConsent', 'submittedAt'],
  properties: {
    fullName: { type: 'string', minLength: 2, maxLength: 100 }, businessName: { type: 'string', minLength: 2, maxLength: 140 },
    email: { type: 'string', format: 'email', maxLength: 254 }, phone: { type: 'string', pattern: '^\\+[1-9][0-9]{7,14}$' },
    city: { type: 'string', minLength: 2, maxLength: 80 }, address: { type: ['string', 'null'], maxLength: 500 },
    serviceArea: { type: 'string', minLength: 2, maxLength: 180 }, selectedServices: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 2, maxLength: 80 } },
    businessType: { type: 'string', minLength: 2, maxLength: 80 }, yearsInBusiness: { type: 'string', minLength: 2, maxLength: 40 },
    estimatedMonthlyOrders: { type: 'string', minLength: 2, maxLength: 60 }, pickupDelivery: { type: ['string', 'null'], maxLength: 120 },
    dailyCapacity: { type: ['string', 'null'], maxLength: 80 }, message: { type: ['string', 'null'], maxLength: 3000 },
    privacyConsent: { const: true }, submittedAt: { type: 'string', format: 'date-time' },
  },
}

export default async function partnerLeadsRoutes(fastify) {
  const service = new PartnerLeadsService()
  fastify.post('/partner-leads', {
    preParsing: captureRawBody,
    config: { rawBody: true, publicRoute: true },
    schema: { tags: ['Partner Intake'], summary: 'Receive a signed website partner lead', body: bodySchema },
  }, async (request, reply) => {
    const verification = verifyPartnerLeadSignature({ headers: request.headers, rawBody: request.rawBody, secret: env.WEBSITE_PARTNER_LEAD_HMAC_SECRET })
    if (!verification.ok) {
      const status = verification.code === 'PARTNER_LEAD_INTAKE_NOT_CONFIGURED' ? 503 : 401
      return reply.code(status).send(error('Partner lead handoff could not be verified', verification.code))
    }
    try {
      const result = await service.receiveWebsiteLead(verification.externalLeadId, request.body, { ip: request.ip, userAgent: request.headers['user-agent'] })
      return reply.code(result.duplicate ? 200 : 201).send(success(result, result.duplicate ? 'Partner lead already received' : 'Partner lead received'))
    } catch (err) {
      request.log.error({ err }, 'Partner lead intake failed')
      return reply.code(500).send(error('Partner lead handoff failed'))
    }
  })
}
