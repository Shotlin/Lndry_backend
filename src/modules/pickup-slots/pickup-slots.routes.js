import { SlotsController } from './pickup-slots.controller.js'
import { SlotsService } from './pickup-slots.service.js'

export default async function slotRoutes(fastify) {
  const service = new SlotsService()
  const controller = new SlotsController(service)

  // 1. GET /vendors/:vendorId/pickup-slots
  fastify.get('/vendors/:vendorId/pickup-slots', {
    schema: {
      tags: ['Slots'],
      summary: 'Get available pickup slots for a vendor on a specific date',
      params: {
        type: 'object',
        required: ['vendorId'],
        properties: {
          vendorId: { type: 'string', format: 'uuid' }
        }
      },
      querystring: {
        type: 'object',
        required: ['date'],
        properties: {
          date: { type: 'string' },
          service_id: { type: 'string', format: 'uuid' },
          quote_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, controller.getAvailableSlots.bind(controller))

  // 2. POST /slot-holds
  fastify.post('/slot-holds', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Slots'],
      summary: 'Create a 10-minute hold on a pickup slot',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['vendor_id', 'slot_id', 'date'],
        properties: {
          vendor_id: { type: 'string', format: 'uuid' },
          slot_id: { type: 'string', format: 'uuid' },
          date: { type: 'string' },
          quote_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, controller.holdSlot.bind(controller))

  // 3. DELETE /slot-holds/:holdId
  fastify.delete('/slot-holds/:holdId', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Slots'],
      summary: 'Release a pickup slot hold',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['holdId'],
        properties: {
          holdId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, controller.releaseHold.bind(controller))

  // --- BACKWARD COMPATIBILITY ALIASES ---
  fastify.get('/slots/available', {
    schema: {
      tags: ['Slots'],
      summary: 'Get available pickup slots (legacy)',
      querystring: {
        type: 'object',
        required: ['vendorId', 'date'],
        properties: {
          vendorId: { type: 'string', format: 'uuid' },
          date: { type: 'string' }
        }
      }
    }
  }, controller.getAvailableSlots.bind(controller))

  fastify.post('/slots/hold', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Slots'],
      summary: 'Create a 10-minute hold on a pickup slot (legacy)',
      body: {
        type: 'object',
        required: ['vendorId', 'slotId', 'date'],
        properties: {
          vendorId: { type: 'string', format: 'uuid' },
          slotId: { type: 'string', format: 'uuid' },
          date: { type: 'string' }
        }
      }
    }
  }, controller.holdSlot.bind(controller))
}
