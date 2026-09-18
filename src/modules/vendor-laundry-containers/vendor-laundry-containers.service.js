import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorLaundryContainersRepository } from './vendor-laundry-containers.repository.js'

const CONTAINER_STATES = ['INTAKE', 'PROCESSING', 'READY', 'DISPATCHED', 'DELIVERED', 'MISSING', 'DAMAGED', 'CANCELLED']

export class VendorLaundryContainersService {
  constructor(repository = new VendorLaundryContainersRepository()) {
    this.repo = repository
  }

  async generate(vendorId, actor, input) {
    const order = await this.repo.findOrder(vendorId, input.orderId)
    if (!order) return { success: false, message: 'Order not found for this vendor', code: 'NOT_FOUND' }
    const count = Math.trunc(Number(input.count))
    if (!Number.isSafeInteger(count) || count <= 0 || count > 500) return { success: false, message: 'count must be an integer between 1 and 500' }
    const already = await this.repo.existingCount(order.id)
    if (already > 0) return { success: false, message: `${already} bag(s) already exist for this order`, code: 'ALREADY_GENERATED' }
    const weightKg = input.weightKg === undefined ? null : Number(input.weightKg)
    const containers = await this.repo.createBatch(vendorId, actor.userId, order.id, order.customer_user_id, count, weightKg)
    emitAudit('vendor_laundry_containers_generated', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'order', target_id: order.id,
      before: null, after: { count: containers.length }, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, containers }
  }

  async listForOrder(vendorId, orderId) {
    return this.repo.listForOrder(vendorId, orderId)
  }

  async getDetail(vendorId, id) {
    const container = await this.repo.findById(vendorId, id)
    if (!container) return null
    return { ...container, events: await this.repo.eventsFor(id) }
  }

  async scan(vendorId, actor, input) {
    const tagCode = String(input.tagCode || '').trim()
    if (!tagCode || tagCode.length > 40) return { success: false, message: 'Scan a container tag code' }
    const container = await this.repo.findByTag(vendorId, tagCode)
    if (!container) return { success: false, message: 'Container tag was not found', code: 'TAG_NOT_FOUND' }

    const nextState = input.nextState ? String(input.nextState).toUpperCase() : undefined
    const alreadyAtStage = Boolean(nextState && nextState === container.state)
    if (nextState !== undefined && !CONTAINER_STATES.includes(nextState)) return { success: false, message: 'Unknown container state', code: 'INVALID_CONTAINER_TRANSITION' }
    const location = String(input.location || container.location || '').trim().slice(0, 80) || container.location
    const note = String(input.note || '').trim().slice(0, 500)
    const condition = String(input.condition || container.condition || 'Normal').trim().slice(0, 40) || 'Normal'

    if (nextState && nextState !== container.state && !VendorLaundryContainersRepository.TRANSITIONS[container.state]?.includes(nextState)) {
      return { success: false, message: `Cannot move a container from ${container.state} to ${nextState}`, code: 'INVALID_CONTAINER_TRANSITION' }
    }

    if (nextState && nextState !== container.state) {
      const fromState = container.state
      await this.repo.transition(container.id, { state: nextState, location, condition, deliveredAt: nextState === 'DELIVERED' ? new Date() : null })
      await this.repo.appendEvent(container.id, { eventType: 'STATE_TRANSITION', fromState, toState: nextState, location, note, actorId: actor.userId })
      emitAudit('vendor_laundry_container_scanned', {
        actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_laundry_container', target_id: container.id,
        before: { state: fromState, location: container.location }, after: { state: nextState, location, tagCode },
        ip_address: actor.ip, user_agent: actor.userAgent,
      })
      return { success: true, container: await this.getDetail(vendorId, container.id), scanResult: 'accepted' }
    }

    await this.repo.touch(container.id, { location, condition })
    await this.repo.appendEvent(container.id, { eventType: 'SCAN', location, note, actorId: actor.userId })
    return { success: true, container: await this.getDetail(vendorId, container.id), scanResult: alreadyAtStage ? 'already_at_stage' : 'accepted' }
  }
}
