/**
 * Categories module — JSON Schema definitions
 */

export const listCategoriesSchema = {
  tags: ['Categories'],
  summary: 'Get all categories (cached 30 min)',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              slug: { type: 'string' },
              description: { type: ['string', 'null'] },
              image_url: { type: ['string', 'null'] },
              parent_id: { type: ['string', 'null'] },
              sort_order: { type: 'integer' },
              is_active: { type: 'boolean' },
              product_count: { type: 'integer' },
              created_at: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

export const getCategorySchema = {
  tags: ['Categories'],
  summary: 'Get single category',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const getCategoryProductsSchema = {
  tags: ['Categories'],
  summary: 'Get garment_rates by category (paginated)',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      sort: { type: 'string', enum: ['price_asc', 'price_desc', 'newest', 'popular'] },
      inStock: { type: 'boolean' },
      groupOptions: { type: 'boolean', default: false },
    },
  },
}

export const createCategorySchema = {
  tags: ['Categories'],
  summary: 'Create category [ADMIN]',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 },
      description: { type: 'string', maxLength: 500 },
      image_url: { type: 'string' },
      parent_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
      sort_order: { type: 'integer', minimum: 0, default: 0 },
      is_active: { type: 'boolean' },
    },
  },
}

export const updateCategorySchema = {
  tags: ['Categories'],
  summary: 'Update category [ADMIN]',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 },
      description: { type: 'string', maxLength: 500 },
      image_url: { type: 'string' },
      parent_id: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
      sort_order: { type: 'integer', minimum: 0 },
      is_active: { type: 'boolean' },
    },
  },
}

export const deleteCategorySchema = {
  tags: ['Categories'],
  summary: 'Delete category [ADMIN]',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}
