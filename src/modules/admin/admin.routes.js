import { AdminController } from './admin.controller.js'
import { AdminService } from './admin.service.js'
import { AdminRepository } from './admin.repository.js'
import {
  getAllUsersSchema,
  updateUserRoleSchema,
  blockUserSchema,
  getSettingsSchema,
  updateSettingsSchema,
} from './admin.schema.js'

import { requireStepUp } from '../../middlewares/requireStepUp.js'

// New sub-modules
import adminAuthRoutes from './auth/auth.routes.js'
import adminDashboardRoutes from './dashboard/dashboard.routes.js'
import adminOrderRoutes from './orders/orders.routes.js'
import adminProductRoutes from './products/products.routes.js'
import adminCustomerRoutes from './customers/customers.routes.js'
import adminRiderRoutes from './riders/riders.routes.js'
import adminPaymentsRoutes from './payments/payments.routes.js'
import adminNotificationRoutes from './notifications/notifications.routes.js'
import adminAnalyticsRoutes from './analytics/analytics.routes.js'
import adminBannerRoutes from './banners/banners.routes.js'
import adminActivityLogRoutes from './activity-log/activity-log.routes.js'
import { roleRoutes, teamRoutes } from './team/team.routes.js'
import adminThemeRoutes from './themes/themes.routes.js'
import adminThemeTabRoutes from './theme-tabs/theme-tabs.routes.js'
import adminSectionRoutes from './sections/sections.routes.js'
import adminCustomerSegmentsRoutes from './customer-segments/customer-segments.routes.js'
import adminFirstTimeOffersRoutes from './first-time-offers/first-time-offers.routes.js'
import adminOrderRecoveryRoutes from './order-recovery/order-recovery.routes.js'
import adminCartMilestonesRoutes from './cart-milestones/cart-milestones.routes.js'
import adminReferralProgramsRoutes from './referral-programs/referral-programs.routes.js'
import { adminReferralsRoutes } from '../referrals/referrals.routes.js'
import adminOlaMapsSettingsRoutes from './ola-maps-settings/ola-maps-settings.routes.js'

/**
 * Admin routes plugin
 * Prefix: /api/v1/admin
 * All routes require ADMIN role
 */
export default async function adminRoutes(fastify) {
  const repository = new AdminRepository()
  const service = new AdminService(repository)
  const controller = new AdminController(service)

  const adminAuth = [fastify.authenticate, fastify.requireAdmin]

// ─── Legacy endpoints (kept for backwards compatibility) ───

  // Users management (not replicated in new sub-modules)
  fastify.get('/users', {
    schema: getAllUsersSchema,
    preHandler: adminAuth,
  }, controller.getAllUsers.bind(controller))

  const highRiskAuth = [fastify.authenticate, fastify.requireAdmin, requireStepUp]

  fastify.patch('/users/:id/role', {
    schema: updateUserRoleSchema,
    preHandler: highRiskAuth,
  }, controller.updateUserRole.bind(controller))

  fastify.put('/users/:id/block', {
    schema: blockUserSchema,
    preHandler: highRiskAuth,
  }, controller.blockUser.bind(controller))

  // Settings (not replicated)
  fastify.get('/settings', {
    schema: getSettingsSchema,
    preHandler: adminAuth,
  }, controller.getSettings.bind(controller))

  fastify.put('/settings', {
    schema: updateSettingsSchema,
    preHandler: highRiskAuth,
  }, controller.updateSettings.bind(controller))

  // ─── New Sub-Modules ────────────────────────────────
  fastify.register(adminAuthRoutes, { prefix: '/auth' })
  fastify.register(adminDashboardRoutes, { prefix: '/dashboard' })
  fastify.register(adminOrderRoutes, { prefix: '/orders' })
  fastify.register(adminProductRoutes, { prefix: '/garment_rates' })
  fastify.register(adminProductRoutes, { prefix: '/products' })
  fastify.register(adminCustomerRoutes, { prefix: '/customers' })
  fastify.register(adminRiderRoutes, { prefix: '/riders' })
  fastify.register(adminPaymentsRoutes, { prefix: '/payments' })
  fastify.register(adminNotificationRoutes, { prefix: '/notifications' })
  fastify.register(adminAnalyticsRoutes, { prefix: '/analytics' })
  fastify.register(adminBannerRoutes, { prefix: '/banners' })
  fastify.register(adminActivityLogRoutes, { prefix: '/activity-log' })
  fastify.register(roleRoutes, { prefix: '/roles' })
  fastify.register(teamRoutes, { prefix: '/team' })
  fastify.register(adminThemeRoutes, { prefix: '/themes' })
  fastify.register(adminThemeTabRoutes, { prefix: '/theme-tabs' })
  fastify.register(adminSectionRoutes, { prefix: '/sections' })
  fastify.register(adminCustomerSegmentsRoutes, { prefix: '/customer-segments' })
  fastify.register(adminFirstTimeOffersRoutes, { prefix: '/first-time-offers' })
  fastify.register(adminOrderRecoveryRoutes, { prefix: '/incomplete-orders' })
  fastify.register(adminCartMilestonesRoutes, { prefix: '/cart-milestones' })
  fastify.register(adminReferralProgramsRoutes, { prefix: '/referral-programs' })
  fastify.register(adminReferralsRoutes, { prefix: '/referrals' })
  fastify.register(adminOlaMapsSettingsRoutes, { prefix: '/ola-maps-settings' })
}
