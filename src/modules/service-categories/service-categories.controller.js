import { success, error } from '../../utils/apiResponse.js'

/**
 * Categories controller — thin HTTP layer
 */
export class CategoriesController {
  constructor(service) {
    this.service = service
  }

  /** GET / */
  async list(request, reply) {
    const categories = await this.service.listAll()
    return reply.code(200).send(success(categories, 'Categories fetched'))
  }

  /** GET /:id */
  async getOne(request, reply) {
    const category = await this.service.getById(request.params.id)
    if (!category) {
      return reply.code(404).send(error('Category not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(category, 'Category fetched'))
  }

  /** GET /:id/garment_rates */
  async getProducts(request, reply) {
    const user = request?.user
    const customerContext =
      user && user.id && (!user.role || user.role === 'CUSTOMER')
        ? { userId: user.id }
        : null
    const result = await this.service.getProducts(
      request.params.id,
      request.query,
      customerContext
    )
    if (!result) {
      return reply.code(404).send(error('Category not found', 'NOT_FOUND'))
    }
    return reply.code(200).send(success(result.data, 'Products fetched', { pagination: result.pagination }))
  }

  /** POST / */
  async create(request, reply) {
    const result = await this.service.create(request.body)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'DUPLICATE'))
    }
    return reply.code(201).send(success(result.category, 'Category created'))
  }

  /** PUT /:id */
  async update(request, reply) {
    const result = await this.service.update(request.params.id, request.body)
    if (!result.success) {
      return reply.code(result.message === 'Category not found' ? 404 : 400)
        .send(error(result.message, result.message === 'Category not found' ? 'NOT_FOUND' : 'DUPLICATE'))
    }
    return reply.code(200).send(success(result.category, 'Category updated'))
  }

  /** DELETE /:id */
  async delete(request, reply) {
    try {
      const result = await this.service.delete(request.params.id)
      if (!result.success) {
        const statusCode = result.message.includes('not found') ? 404 : 400
        const errCode = result.message.includes('not found') ? 'NOT_FOUND' : 'DELETE_FAILED'
        return reply.code(statusCode).send(error(result.message, errCode))
      }
      return reply.code(200).send(success(null, 'Category deleted'))
    } catch (err) {
      console.error("Category Controller [delete] Error:", err)
      throw err
    }
  }
}
