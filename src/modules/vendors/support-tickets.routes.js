import { success, error } from '../../utils/apiResponse.js'
import { SupportTicketsRepository } from './support-tickets.repository.js'
import { SupportTicketsService } from './support-tickets.service.js'
import { VendorsRepository } from './vendors.repository.js'

/**
 * Vendor Support Tickets Routes
 * Prefix: /api/v1/vendor/support-tickets
 *
 * GET  /              — list tickets for the authenticated vendor
 * POST /              — create a new ticket
 * GET  /:id           — ticket detail (with admin's reply, if any)
 * POST /:id/rate      — vendor confirms satisfied: 1-5 star rating, closes the ticket
 * POST /:id/follow-up — vendor says not satisfied: sends a follow-up message, reopens the ticket
 */
export default async function supportTicketsRoutes(fastify) {
  const svc = new SupportTicketsService(
    new SupportTicketsRepository(),
    new VendorsRepository()
  )

  // All routes require a valid JWT
  fastify.addHook('preHandler', fastify.authenticate)

  fastify.post('/', {
    schema: {
      tags: ['Vendor Support'],
      summary: 'Create a support ticket',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    try {
      const ticket = await svc.create(request.user.id, request.body)
      return reply.code(201).send(success(ticket, 'Support ticket created successfully'))
    } catch (err) {
      const code = err.statusCode ?? 500
      return reply.code(code).send(error(err.message ?? 'Failed to create ticket', 'CREATE_TICKET_FAILED'))
    }
  })

  fastify.get('/', {
    schema: {
      tags: ['Vendor Support'],
      summary: 'List support tickets',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    try {
      const { page = 1, limit = 20 } = request.query
      const result = await svc.list(request.user.id, { page: Number(page), limit: Number(limit) })
      return reply.code(200).send(success(result.tickets, 'Tickets fetched', {
        page: result.page,
        limit: result.limit,
        total: result.total,
      }))
    } catch (err) {
      const code = err.statusCode ?? 500
      return reply.code(code).send(error(err.message ?? 'Failed to fetch tickets', 'FETCH_TICKETS_FAILED'))
    }
  })

  fastify.get('/:id', {
    schema: {
      tags: ['Vendor Support'],
      summary: 'Get ticket detail, including any admin reply',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    try {
      const ticket = await svc.getOne(request.user.id, request.params.id)
      return reply.send(success(ticket, 'Ticket fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch ticket'))
    }
  })

  fastify.post('/:id/rate', {
    schema: {
      tags: ['Vendor Support'],
      summary: 'Rate a replied ticket as satisfied (1-5 stars) — closes it',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['rating'],
        properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } },
      },
    },
  }, async (request, reply) => {
    try {
      const ticket = await svc.rate(request.user.id, request.params.id, request.body.rating)
      return reply.send(success(ticket, 'Thank you for your feedback'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to submit rating'))
    }
  })

  fastify.post('/:id/follow-up', {
    schema: {
      tags: ['Vendor Support'],
      summary: 'Not satisfied — send a follow-up message, reopens the ticket',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['message'],
        properties: { message: { type: 'string', minLength: 3, maxLength: 2000 } },
      },
    },
  }, async (request, reply) => {
    try {
      const ticket = await svc.followUp(request.user.id, request.params.id, request.body.message)
      return reply.send(success(ticket, 'Follow-up sent'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to send follow-up'))
    }
  })
}

/**
 * Admin Support Tickets Routes
 * Prefix: /api/v1/admin/support-tickets
 *
 * GET  /          — list every vendor's tickets (optional ?status= filter)
 * GET  /:id       — ticket detail
 * POST /:id/reply — reply to the vendor, moves ticket to REPLIED
 * POST /:id/close — close directly, no rating involved
 */
export async function adminSupportTicketsRoutes(fastify) {
  const svc = new SupportTicketsService(
    new SupportTicketsRepository(),
    new VendorsRepository()
  )

  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.authorize(['ADMIN']))

  fastify.get('/', {
    schema: {
      tags: ['Admin Support'],
      summary: 'List support tickets across all vendors [Admin]',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['OPEN', 'REPLIED', 'CLOSED'] },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { status, page = 1, limit = 20 } = request.query
      const result = await svc.adminList({ status, page: Number(page), limit: Number(limit) })
      return reply.send(success(result.tickets, 'Tickets fetched', {
        page: result.page,
        limit: result.limit,
        total: result.total,
      }))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch tickets'))
    }
  })

  fastify.get('/:id', {
    schema: { tags: ['Admin Support'], summary: 'Get ticket detail [Admin]' },
  }, async (request, reply) => {
    try {
      const ticket = await svc.adminGetOne(request.params.id)
      return reply.send(success(ticket, 'Ticket fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch ticket'))
    }
  })

  fastify.post('/:id/reply', {
    schema: {
      tags: ['Admin Support'],
      summary: 'Reply to a vendor ticket [Admin]',
      body: {
        type: 'object',
        required: ['reply'],
        properties: { reply: { type: 'string', minLength: 3, maxLength: 2000 } },
      },
    },
  }, async (request, reply) => {
    try {
      const ticket = await svc.adminReply(request.params.id, request.user.id, request.body.reply)
      return reply.send(success(ticket, 'Reply sent'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to send reply'))
    }
  })

  fastify.post('/:id/close', {
    schema: { tags: ['Admin Support'], summary: 'Close a ticket directly [Admin]' },
  }, async (request, reply) => {
    try {
      const ticket = await svc.adminClose(request.params.id)
      return reply.send(success(ticket, 'Ticket closed'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to close ticket'))
    }
  })
}
