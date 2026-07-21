import { success, error } from '../../utils/apiResponse.js'
import { UsersService } from '../users/users.service.js'
import { UsersRepository } from '../users/users.repository.js'

export default async function customerRoutes(fastify) {
  const repository = new UsersRepository()
  const service = new UsersService(repository)

  fastify.get('/me', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Customer Profile'],
      summary: 'Get customer profile',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const profile = await service.getProfile(request.user.id)
    if (!profile) {
      return reply.code(404).send(error('Customer profile not found', 'CUSTOMER_NOT_FOUND'))
    }
    return reply.code(200).send(success(profile, 'Customer profile fetched successfully'))
  })

  fastify.patch('/me', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Customer Profile'],
      summary: 'Update customer profile',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          photo_url: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { name, email, photo_url } = request.body
    const updateData = {}
    if (name !== undefined) updateData.name = name
    if (email !== undefined) updateData.email = email
    if (photo_url !== undefined) updateData.avatar_url = photo_url

    const result = await service.updateProfile(request.user.id, updateData)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'UPDATE_PROFILE_FAILED'))
    }
    return reply.code(200).send(success(result.user, 'Customer profile updated successfully'))
  })

  fastify.delete('/account', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Customer Profile'],
      summary: 'Anonymise and soft-delete customer account',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    await service.repo.deleteUser(request.user.id)
    reply.clearCookie('refreshToken', { path: '/api/v1/auth' })
    return reply.code(200).send(success(null, 'Customer account soft-deleted and anonymised successfully'))
  })
}
