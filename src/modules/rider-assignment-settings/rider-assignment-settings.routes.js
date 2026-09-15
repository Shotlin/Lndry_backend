import { RiderAssignmentSettingsController } from './rider-assignment-settings.controller.js'
import { RiderAssignmentSettingsService } from './rider-assignment-settings.service.js'
import { RiderAssignmentSettingsRepository } from './rider-assignment-settings.repository.js'
import { requirePermission } from '../../middlewares/permission-check.js'

/**
 * Rider Assignment Settings admin routes plugin — Phase 5 of the
 * rider-assignment initiative (see CLAUDE.md).
 * Prefix: /api/v1/admin/rider-assignment-settings
 *
 *   GET  /  — fetch the current settings
 *   PUT  /  — update them (broadcast_timeout_minutes for now)
 *
 * Plain admin auth (no TOTP step-up) — this is an operational timing
 * knob, not a financial setting like fee-settings' write path.
 */
export default async function riderAssignmentSettingsRoutes(fastify) {
  const repository = new RiderAssignmentSettingsRepository()
  const service = new RiderAssignmentSettingsService(repository)
  const controller = new RiderAssignmentSettingsController(service)
  const readAuth = [fastify.authenticate, requirePermission('riders.view')]
  const writeAuth = [fastify.authenticate, requirePermission('riders.assign')]

  fastify.get('/', {
    schema: { tags: ['Rider Assignment Settings'], summary: 'Get rider assignment settings' },
    config: { requiredPermission: 'riders.view' },
    preHandler: readAuth,
  }, controller.get.bind(controller))

  fastify.put('/', {
    schema: { tags: ['Rider Assignment Settings'], summary: 'Update rider assignment settings' },
    config: { requiredPermission: 'riders.assign' },
    preHandler: writeAuth,
  }, controller.update.bind(controller))
}
