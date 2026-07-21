import { AdminBannersService } from '../admin/banners/banners.service.js'
import { success } from '../../utils/apiResponse.js'

const svc = new AdminBannersService()

export default async function bannerRoutes(fastify) {
  fastify.get('/', async (request, reply) => {
    const banners = await svc.getActive()
    return success(banners, 'Active banners fetched')
  })
}
