import { AdminBannersService, ACTIVE_BANNERS_CACHE_KEY, ACTIVE_BANNERS_TTL_S } from '../admin/banners/banners.service.js'
import { cacheWrap } from '../../utils/cache.js'
import { success } from '../../utils/apiResponse.js'

const svc = new AdminBannersService()

export default async function bannerRoutes(fastify) {
  // Same for every caller, hit by every app open -> cached (60 s). Admin edits
  // clear the key (see AdminBannersService), so changes still show up at once.
  fastify.get('/', async (request, reply) => {
    const banners = await cacheWrap(ACTIVE_BANNERS_CACHE_KEY, ACTIVE_BANNERS_TTL_S, () => svc.getActive())
    return success(banners, 'Active banners fetched')
  })
}
