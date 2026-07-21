import { success, error } from '../../utils/apiResponse.js'

export class SlotsController {
  constructor(service) {
    this.service = service
  }

  async getAvailableSlots(request, reply) {
    const vendorId = request.params.vendorId || request.query.vendorId || request.query.vendor_id
    const date = request.query.date
    try {
      const slots = await this.service.getAvailableSlots(vendorId, date)
      // Only return slots with remainingCapacity > 0
      const activeSlots = slots.filter(s => s.remainingCapacity > 0)
      return reply.send(success(activeSlots, 'Available slots fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch slots'))
    }
  }

  async holdSlot(request, reply) {
    const vendorId = request.body.vendor_id || request.body.vendorId
    const slotId = request.body.slot_id || request.body.slotId
    const date = request.body.date
    const quoteId = request.body.quote_id || request.body.quoteId
    try {
      const hold = await this.service.holdSlot(request.user.id, vendorId, slotId, date, quoteId)
      return reply.code(201).send(success(hold, 'Slot held successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to hold slot'))
    }
  }

  async releaseHold(request, reply) {
    const { holdId } = request.params
    try {
      const released = await this.service.releaseHold(request.user.id, holdId)
      if (!released) {
        return reply.code(404).send(error('Slot hold not found or already released', 'NOT_FOUND'))
      }
      return reply.code(200).send(success(null, 'Slot hold released successfully'))
    } catch (err) {
      return reply.code(500).send(error(err.message || 'Failed to release slot hold'))
    }
  }
}
