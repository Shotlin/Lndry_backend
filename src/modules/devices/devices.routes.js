import { success } from '../../utils/apiResponse.js'
import { AuthRepository } from '../auth/auth.repository.js'

export default async function devicesRoutes(fastify) {
  const repo = new AuthRepository()

  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Devices'],
      summary: 'Register or update user device FCM token',
      body: {
        type: 'object',
        required: ['device_id', 'platform', 'fcm_token'],
        properties: {
          device_id: { type: 'string' },
          platform: { type: 'string', enum: ['IOS', 'ANDROID', 'WEB', 'UNKNOWN'] },
          fcm_token: { type: 'string' },
          app_version: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { device_id, platform, fcm_token, app_version } = request.body
    await repo.registerDevice({
      userId: request.user.id,
      deviceId: device_id,
      platform,
      fcmToken: fcm_token,
      appVersion: app_version
    })
    return reply.code(200).send(success(null, 'Device registered successfully'))
  })

  fastify.delete('/:deviceId', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Devices'],
      summary: 'Remove registered device FCM token',
      params: {
        type: 'object',
        required: ['deviceId'],
        properties: {
          deviceId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { deviceId } = request.params
    await repo.deleteDevice(request.user.id, deviceId)
    return reply.code(200).send(success(null, 'Device removed successfully'))
  })
}
