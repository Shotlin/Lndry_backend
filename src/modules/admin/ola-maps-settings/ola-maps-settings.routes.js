import { OlaMapsSettingsController } from './ola-maps-settings.controller.js'
import { OlaMapsSettingsService } from './ola-maps-settings.service.js'
import { OlaMapsSettingsRepository } from './ola-maps-settings.repository.js'
import {
  getOlaMapsSettingsSchema,
  testOlaMapsSettingsSchema,
  saveOlaMapsSettingsSchema,
} from './ola-maps-settings.schema.js'

/**
 * Ola Maps admin settings routes
 * Prefix: /api/v1/admin/ola-maps-settings
 */
export default async function olaMapsSettingsRoutes(fastify) {
  const repository = new OlaMapsSettingsRepository()
  const service = new OlaMapsSettingsService(repository)
  const controller = new OlaMapsSettingsController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: getOlaMapsSettingsSchema }, controller.get.bind(controller))
  fastify.post('/test', { schema: testOlaMapsSettingsSchema }, controller.test.bind(controller))
  fastify.put('/', { schema: saveOlaMapsSettingsSchema }, controller.save.bind(controller))
}
