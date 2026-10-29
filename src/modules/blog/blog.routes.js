import { BlogController } from './blog.controller.js'
import { BlogService } from './blog.service.js'
import { BlogRepository } from './blog.repository.js'
import * as s from './blog.schema.js'

const build = () => new BlogController(new BlogService(new BlogRepository()))

/**
 * Public blog reads (no login). Prefix: /api/v1/blog
 * Only live posts (published, publish date reached) are ever returned.
 */
export default async function publicBlogRoutes(fastify) {
  const c = build()
  fastify.get('/posts', { schema: s.publicListSchema }, c.publicList.bind(c))
  fastify.get('/posts/featured', { schema: s.publicFeaturedSchema }, c.featured.bind(c))
  fastify.get('/posts/trending', { schema: s.publicTrendingSchema }, c.trending.bind(c))
  fastify.get('/posts/search', { schema: s.publicSearchSchema }, c.search.bind(c))
  fastify.get('/posts/:slug', { schema: s.publicPostSchema }, c.post.bind(c))
  fastify.post('/posts/:slug/view', { schema: s.publicViewSchema }, c.recordView.bind(c))
  fastify.get('/categories', { schema: s.publicCategoriesSchema }, c.categories.bind(c))
  fastify.get('/categories/:slug', { schema: s.publicCategorySchema }, c.category.bind(c))
  fastify.get('/sitemap', { schema: s.publicSitemapSchema }, c.sitemap.bind(c))
}

/**
 * Admin blog management. Prefix: /api/v1/admin/blog
 * The dashboard's Blog and Blog Categories pages call these.
 */
// The article body is HTML. The global request sanitizer would delete every tag,
// so it is exempted here; BlogService runs sanitizeBlogHtml (an allowlist) on it.
const RICH_TEXT = { rawBodyFields: ['contentHtml'] }

export async function adminBlogRoutes(fastify) {
  const c = build()

  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/posts', { schema: s.adminListSchema }, c.adminList.bind(c))
  fastify.get('/stats', { schema: s.adminStatsSchema }, c.adminStats.bind(c))
  fastify.get('/posts/:id', { schema: s.adminGetSchema }, c.adminGet.bind(c))
  fastify.post('/posts', { schema: s.adminCreateSchema, config: RICH_TEXT }, c.adminCreate.bind(c))
  fastify.put('/posts/:id', { schema: s.adminUpdateSchema, config: RICH_TEXT }, c.adminUpdate.bind(c))
  fastify.delete('/posts/:id', { schema: s.adminDeleteSchema }, c.adminDelete.bind(c))

  fastify.get('/categories', { schema: s.adminCategoriesSchema }, c.adminCategories.bind(c))
  fastify.post('/categories', { schema: s.adminCategoryCreateSchema }, c.adminCategoryCreate.bind(c))
  fastify.put('/categories/:id', { schema: s.adminCategoryUpdateSchema }, c.adminCategoryUpdate.bind(c))
  fastify.delete('/categories/:id', { schema: s.adminCategoryDeleteSchema }, c.adminCategoryDelete.bind(c))
}
