import { OrderRecoveryRepository } from './order-recovery.repository.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { NotificationsService } from '../../notifications/notifications.service.js'
import { CouponsRepository } from '../../coupons/coupons.repository.js'
import { CouponsService } from '../../coupons/coupons.service.js'

/**
 * Order Recovery service — admin visibility + recovery actions for
 * incomplete checkouts (order_drafts that never became a real order).
 * Ported from bakaloo-backend's abandoned-carts service (see CLAUDE.md's
 * "Bakaloo Feature Port" section). Deliberately does not touch
 * payment-expiry.worker.js's cancellation logic — this is visibility +
 * recovery actions only.
 */
export class OrderRecoveryService {
  constructor(repository = new OrderRecoveryRepository()) {
    this.repo = repository
    this.couponsService = new CouponsService(new CouponsRepository())
  }

  async listAll(filters) {
    return this.repo.findAll(filters)
  }

  async getSummary() {
    return this.repo.getSummary()
  }

  async getDetail(id) {
    return this.repo.findById(id)
  }

  /**
   * Sends a reminder via the app's real, existing single-send notification
   * primitive (in-app + socket + push) — the same one orders use everywhere
   * else. No new send path.
   */
  async sendReminder(id, { title, body }, adminUserId, fastify) {
    const draft = await this.repo.findById(id)
    if (!draft) {
      return { success: false, message: 'Incomplete order not found', code: 'NOT_FOUND' }
    }

    const notifService = new NotificationsService(new NotificationsRepository(), fastify)
    const notification = await notifService.sendNotification(draft.user.id, {
      title,
      body,
      type: 'order_recovery',
      data: { orderDraftId: id },
    })

    await this.repo.recordEvent(id, {
      eventType: 'REMINDER_SENT',
      actorId: adminUserId,
      metadata: { notificationId: notification.id },
    })

    return { success: true, notificationId: notification.id }
  }

  /**
   * Two modes, both thin orchestration over the already-existing coupon
   * targeting system (Phase 2) — no new coupon engine:
   *   - couponId given: add this customer to an already-existing coupon's
   *     individual-target list via the non-destructive addTargetUser.
   *   - otherwise: create a brand-new coupon, forced INDIVIDUAL-targeted to
   *     just this customer (client input for targetType/targetUserIds is
   *     ignored/overridden server-side).
   */
  async issueCoupon(id, payload, actor) {
    const draft = await this.repo.findById(id)
    if (!draft) {
      return { success: false, message: 'Incomplete order not found', code: 'NOT_FOUND' }
    }
    const userId = draft.user.id

    if (payload.couponId) {
      const couponsRepo = new CouponsRepository()
      await couponsRepo.addTargetUser(payload.couponId, userId)
      await this.repo.recordEvent(id, {
        eventType: 'COUPON_ISSUED',
        actorId: actor.userId,
        metadata: { couponId: payload.couponId },
      })
      return { success: true, couponId: payload.couponId }
    }

    const couponData = {
      ...payload,
      targetType: 'INDIVIDUAL',
      targetUserIds: [userId],
    }
    delete couponData.couponId

    const result = await this.couponsService.create(couponData, actor)
    if (!result.success) {
      return result
    }

    await this.repo.recordEvent(id, {
      eventType: 'COUPON_ISSUED',
      actorId: actor.userId,
      metadata: { couponId: result.coupon.id },
    })
    return { success: true, couponId: result.coupon.id, code: result.coupon.code }
  }
}
