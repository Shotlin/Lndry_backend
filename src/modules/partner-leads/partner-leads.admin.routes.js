import { success, error } from '../../utils/apiResponse.js'
import { PartnerLeadsService } from './partner-leads.service.js'

const states = ['RECEIVED', 'CLAIMED', 'ARCHIVED']

export default async function partnerLeadsAdminRoutes(fastify) {
  const service = new PartnerLeadsService()
  const admin = [fastify.authenticate, fastify.authorize(['ADMIN'])]

  fastify.get('/partner-leads', {
    preHandler: admin,
    config: { requiredPermission: 'vendors.view' },
    schema: {
      tags: ['Partner Intake'], summary: 'List canonical partner-lead staging records',
      querystring: { type: 'object', additionalProperties: false, properties: {
        state: { type: 'string', enum: states }, page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      } },
    },
  }, async (request, reply) => reply.send(success(await service.list(request.query), 'Partner leads fetched')))

  fastify.post('/partner-leads/:id/claim', {
    preHandler: admin,
    config: { requiredPermission: 'vendors.update' },
    schema: {
      tags: ['Partner Intake'], summary: 'Claim a partner lead for controlled onboarding follow-up',
      params: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    try {
      const lead = await service.claim(request.params.id, request.user.id, { ip: request.ip, userAgent: request.headers['user-agent'] })
      return reply.send(success(lead, 'Partner lead claimed'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Unable to claim partner lead'))
    }
  })
}
