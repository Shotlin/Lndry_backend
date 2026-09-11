import { success, error } from '../../utils/apiResponse.js'
import { updateRiderAssignmentSettingsSchema } from './rider-assignment-settings.schema.js'

/**
 * Rider Assignment Settings controller — thin HTTP layer.
 */
export class RiderAssignmentSettingsController {
  constructor(service) {
    this.service = service
  }

  /** @private */
  _actor(request) {
    return { id: request.user?.id, role: request.user?.role }
  }

  /** @private */
  _formatZodErrors(zodError) {
    return zodError.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
  }

  async get(request, reply) {
    const config = await this.service.get()
    return reply.code(200).send(success(config, 'Rider assignment settings fetched'))
  }

  async update(request, reply) {
    const parsed = updateRiderAssignmentSettingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(error(this._formatZodErrors(parsed.error), 'VALIDATION_ERROR'))
    }
    const updated = await this.service.update(parsed.data, this._actor(request))
    return reply.code(200).send(success(updated, 'Rider assignment settings updated'))
  }
}
