import { logger } from '../../config/logger.js'
import { emit as emitAudit } from '../../utils/audit-log.js'
import { StoreOrdersRepository } from './store-orders.repository.js'

/**
 * Store Orders service — the vendor-desktop side resolves a walk-in
 * customer's phone to a real account and pushes the completed sale here;
 * the customer-app side reads their own list back for order history.
 */
export class StoreOrdersService {
  constructor(repository = new StoreOrdersRepository()) {
    this.repo = repository
  }

  /**
   * Phone lookup is a real-name-and-account oracle by phone number, even
   * without a wallet balance attached — the route layer rate-limits and
   * audit-logs every call regardless of outcome, this just does the lookup.
   */
  async resolvePhone(phone) {
    return this.repo.findByPhone(phone)
  }

  async pushOrder(data, actor) {
    if (!data.customerUserId || !data.posOrderId || data.totalPaise == null) {
      return { success: false, message: 'customerUserId, posOrderId and totalPaise are required' }
    }
    const order = await this.repo.upsert({ ...data, vendorId: actor.vendorId })
    emitAudit('store_order_pushed', {
      actor_user_id: actor.userId,
      actor_role: actor.role,
      target_type: 'store_order',
      target_id: order.id,
      before: null,
      after: order,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    logger.info({ storeOrderId: order.id, vendorId: actor.vendorId }, 'Store order pushed from desktop POS')
    return { success: true, order }
  }

  async listMine(customerUserId) {
    return this.repo.findByCustomer(customerUserId)
  }
}
