import { RazorpaySettingsController } from './razorpay-settings.controller.js'
import { RazorpaySettingsService } from './razorpay-settings.service.js'
import { RazorpaySettingsRepository } from './razorpay-settings.repository.js'
import { requireStepUp } from '../../../middlewares/requireStepUp.js'
import {
  getRazorpaySettingsSchema,
  testRazorpaySchema,
  saveRazorpayModeSchema,
  setRazorpayActiveModeSchema,
  clearRazorpayModeSchema,
} from './razorpay-settings.schema.js'

/**
 * Razorpay admin settings. Prefix: /api/v1/admin/razorpay-settings
 * Reading and connection tests need an admin; anything that stores, switches or removes keys
 * also needs the dashboard's TOTP step-up (when step-up enforcement is on).
 */
export default async function razorpaySettingsRoutes(fastify) {
  const controller = new RazorpaySettingsController(new RazorpaySettingsService(new RazorpaySettingsRepository()))

  const adminOnly = [fastify.authenticate, fastify.requireAdmin]
  const highRisk = [fastify.authenticate, fastify.requireAdmin, requireStepUp]

  fastify.get('/', { schema: getRazorpaySettingsSchema, preHandler: adminOnly }, controller.get.bind(controller))
  fastify.post('/test', { schema: testRazorpaySchema, preHandler: adminOnly }, controller.test.bind(controller))
  fastify.put('/modes/:mode', { schema: saveRazorpayModeSchema, preHandler: highRisk }, controller.save.bind(controller))
  fastify.delete('/modes/:mode', { schema: clearRazorpayModeSchema, preHandler: highRisk }, controller.clear.bind(controller))
  fastify.put('/active-mode', { schema: setRazorpayActiveModeSchema, preHandler: highRisk }, controller.setActive.bind(controller))
}
