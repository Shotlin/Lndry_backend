import { success, error } from '../../utils/apiResponse.js'

const STATUS = { NOT_FOUND: 404, SLUG_TAKEN: 409, VALIDATION_ERROR: 400 }

export class BlogController {
  constructor(service) {
    this.service = service
  }

  _fail(reply, result) {
    return reply.code(STATUS[result.code] ?? 400).send(error(result.message, result.code, result.fieldErrors))
  }

  _paged(reply, r, message) {
    return reply.code(200).send(success(r.posts, message, { page: r.page, total: r.total, totalPages: r.totalPages }))
  }

  // ----------------------------------------------------------------- public
  async publicList(request, reply) {
    const r = await this.service.publicList({ page: request.query.page, category: request.query.category })
    reply.header('Cache-Control', 'public, max-age=30')
    return this._paged(reply, r, 'Posts fetched')
  }

  async featured(request, reply) {
    reply.header('Cache-Control', 'public, max-age=30')
    return reply.send(success(await this.service.featured(), 'Featured post fetched'))
  }

  async trending(request, reply) {
    reply.header('Cache-Control', 'public, max-age=30')
    return reply.send(success(await this.service.trending(request.query.limit ?? 5), 'Trending posts fetched'))
  }

  async search(request, reply) {
    return reply.send(success(await this.service.search(request.query.q), 'Search results'))
  }

  async categories(request, reply) {
    reply.header('Cache-Control', 'public, max-age=30')
    return reply.send(success(await this.service.categories(), 'Categories fetched'))
  }

  async category(request, reply) {
    const category = await this.service.publicCategory(request.params.slug)
    if (!category) return reply.code(404).send(error('Category not found', 'NOT_FOUND'))
    return reply.send(success(category, 'Category fetched'))
  }

  async post(request, reply) {
    const post = await this.service.publicPost(request.params.slug)
    if (!post) return reply.code(404).send(error('Post not found', 'NOT_FOUND'))
    reply.header('Cache-Control', 'public, max-age=30')
    return reply.send(success(post, 'Post fetched'))
  }

  async recordView(request, reply) {
    await this.service.recordView(request.params.slug)
    return reply.send(success(null, 'OK'))
  }

  async sitemap(request, reply) {
    const [posts, categories] = await Promise.all([this.service.sitemap(), this.service.categories()])
    return reply.send(success({ posts, categories: categories.map((c) => ({ slug: c.slug })) }, 'Sitemap data'))
  }

  // ------------------------------------------------------------------ admin
  async adminList(request, reply) {
    const r = await this.service.adminList(request.query)
    return this._paged(reply, r, 'Posts fetched')
  }

  async adminStats(request, reply) {
    return reply.send(success(await this.service.stats(), 'Stats fetched'))
  }

  async adminGet(request, reply) {
    const r = await this.service.adminGet(request.params.id)
    if (!r.success) return this._fail(reply, r)
    return reply.send(success(r.post, 'Post fetched'))
  }

  async adminCreate(request, reply) {
    const r = await this.service.createPost(request.body, { userId: request.user?.id })
    if (!r.success) return this._fail(reply, r)
    return reply.code(201).send(success(r.post, 'Post saved'))
  }

  async adminUpdate(request, reply) {
    const r = await this.service.updatePost(request.params.id, request.body)
    if (!r.success) return this._fail(reply, r)
    return reply.send(success(r.post, 'Post saved'))
  }

  async adminDelete(request, reply) {
    const r = await this.service.deletePost(request.params.id)
    if (!r.success) return this._fail(reply, r)
    return reply.send(success(null, 'Post deleted'))
  }

  async adminCategories(request, reply) {
    return reply.send(success(await this.service.adminCategories(), 'Categories fetched'))
  }

  async adminCategoryCreate(request, reply) {
    const r = await this.service.createCategory(request.body)
    if (!r.success) return this._fail(reply, r)
    return reply.code(201).send(success(r.category, 'Category created'))
  }

  async adminCategoryUpdate(request, reply) {
    const r = await this.service.updateCategory(request.params.id, request.body)
    if (!r.success) return this._fail(reply, r)
    return reply.send(success(r.category, 'Category updated'))
  }

  async adminCategoryDelete(request, reply) {
    const r = await this.service.deleteCategory(request.params.id)
    if (!r.success) return this._fail(reply, r)
    return reply.send(success(null, 'Category deleted'))
  }
}
