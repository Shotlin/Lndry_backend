import { TwoFactorSettingsController } from './two-factor-settings.controller.js'
import { TwoFactorSettingsService } from './two-factor-settings.service.js'
import { TwoFactorSettingsRepository } from './two-factor-settings.repository.js'
import { requireStepUp } from '../../../middlewares/requireStepUp.js'
import {
  getTwoFactorSettingsSchema,
  testTwoFactorSchema,
  saveTwoFactorSchema,
  removeTwoFactorSchema,
  sendTestOtpSchema,
} from './two-factor-settings.schema.js'

/**
 * 2Factor (SMS OTP) admin settings. Prefix: /api/v1/admin/two-factor-settings
 * Changing the key / switching SMS on-off needs the dashboard TOTP step-up (when enforced).
 */
export default async function twoFactorSettingsRoutes(fastify) {
  const controller = new TwoFactorSettingsController(new TwoFactorSettingsService(new TwoFactorSettingsRepository()))
  const adminOnly = [fastify.authenticate, fastify.requireAdmin]
  const highRisk = [fastify.authenticate, fastify.requireAdmin, requireStepUp]

  fastify.get('/', { schema: getTwoFactorSettingsSchema, preHandler: adminOnly }, controller.get.bind(controller))
  fastify.post('/test', { schema: testTwoFactorSchema, preHandler: adminOnly }, controller.test.bind(controller))
  fastify.post('/send-test-otp', { schema: sendTestOtpSchema, preHandler: highRisk }, controller.sendTest.bind(controller))
  fastify.put('/', { schema: saveTwoFactorSchema, preHandler: highRisk }, controller.save.bind(controller))
  fastify.delete('/', { schema: removeTwoFactorSchema, preHandler: highRisk }, controller.remove.bind(controller))
}
