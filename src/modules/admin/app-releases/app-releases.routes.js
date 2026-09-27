import { AppReleasesController } from './app-releases.controller.js'
import { AppReleasesService } from './app-releases.service.js'
import { AppReleasesRepository } from './app-releases.repository.js'
import {
  listAppReleasesSchema,
  uploadAppReleaseSchema,
  deleteAppReleaseSchema,
  publicLatestAppReleaseSchema,
  publicAllAppReleasesSchema,
} from './app-releases.schema.js'

/**
 * Admin routes plugin — prefix /api/v1/admin/app-releases. The upload
 * route's per-call `request.file({ limits })` override (in the controller)
 * is what lets APKs (70-120MB) through — @fastify/multipart is registered
 * exactly once at the app root (plugins/multipart.plugin.js, 5MB default
 * for every other upload endpoint); re-registering it here would throw
 * "Content type parser 'multipart/form-data' already present" since the
 * plugin hoists itself to the root instance regardless of nesting.
 */
export default async function appReleasesRoutes(fastify) {
  const repository = new AppReleasesRepository()
  const service = new AppReleasesService(repository)
  const controller = new AppReleasesController(service)

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', { schema: listAppReleasesSchema }, controller.listForApp.bind(controller))
  fastify.post('/', { schema: uploadAppReleaseSchema }, controller.upload.bind(controller))
  fastify.delete('/:id', { schema: deleteAppReleaseSchema }, controller.delete.bind(controller))
}

/**
 * Public routes plugin — prefix /api/v1/app-releases. No auth: this is
 * what the public website's download buttons and version badges call.
 */
export async function publicAppReleasesRoutes(fastify) {
  const repository = new AppReleasesRepository()
  const service = new AppReleasesService(repository)
  const controller = new AppReleasesController(service)

  fastify.get('/latest', { schema: publicLatestAppReleaseSchema }, controller.publicLatest.bind(controller))
  fastify.get('/all', { schema: publicAllAppReleasesSchema }, controller.publicAll.bind(controller))
  fastify.get('/download/:app', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, controller.download.bind(controller))
}
