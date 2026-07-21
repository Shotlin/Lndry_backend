/**
 * Products module — JSON Schema definitions
 */

export const listProductsSchema = {
  tags: ['Products'],
  summary: 'List garment_rates (filter, sort, paginate)',
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      category: { type: 'string', format: 'uuid' },
      search: { type: 'string', maxLength: 100 },
      status: { type: 'string', enum: ['active', 'inactive', 'low_stock', 'out_of_stock', 'on_sale'] },
      sort: { type: 'string', enum: ['price_asc', 'price_desc', 'newest', 'popular', 'name_asc', 'name_desc', 'stock_asc'] },
      minPrice: { type: 'number', minimum: 0 },
      maxPrice: { type: 'number', minimum: 0 },
      inStock: { type: 'boolean' },
      groupOptions: { type: 'boolean', default: false },
    },
  },
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
              id: { type: 'string' },
              name: { type: 'string' },
              slug: { type: 'string' },
              price: { type: 'number' },
              sale_price: { type: 'number', nullable: true },
              // Fastify's response serializer drops any property not listed
              // here even though the repository selects it — cost_price is
              // the admin's demo/reference price and was silently vanishing
              // from every response until this was added.
              cost_price: { type: 'number', nullable: true },
              stock_quantity: { type: 'integer' },
              unit: { type: 'string' },
              thumbnail_url: { type: 'string', nullable: true },
              is_active: { type: 'boolean' },
              is_featured: { type: 'boolean' },
              total_sold: { type: 'integer' },
              sku: { type: 'string', nullable: true },
              barcode: { type: 'string', nullable: true },
              low_stock_threshold: { type: 'integer' },
              category_id: { type: 'string', nullable: true },
              category_name: { type: 'string', nullable: true },
              // Product family / option fields (Phase 1 contract).
              // Declared here because Fastify's response serializer
              // (fast-json-stringify) drops any property not present in the
              // schema — without these the repository's option columns never
              // reach the Flutter client on the /garment_rates list endpoint.
              product_family_id: { type: 'string', nullable: true },
              family_name: { type: 'string', nullable: true },
              option_label: { type: 'string', nullable: true },
              option_count: { type: 'integer' },
              option_sort_order: { type: 'integer' },
              is_default_option: { type: 'boolean' },
              food_type: { type: 'string', nullable: true },
              origin_tag: { type: 'string', nullable: true },
              custom_badges: { type: 'array', items: { type: 'string' }, nullable: true },
              display_delivery_minutes: { type: 'integer', nullable: true },
              net_quantity: { type: 'string', nullable: true },
              avg_rating: { type: 'number', nullable: true },
              rating_count: { type: 'integer', nullable: true },
            },
          },
        },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            limit: { type: 'integer' },
            total: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
      },
    },
  },
}

export const searchProductsSchema = {
  tags: ['Products'],
  summary: 'Full-text search garment_rates',
  querystring: {
    type: 'object',
    required: ['q'],
    properties: {
      q: { type: 'string', minLength: 1, maxLength: 100 },
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    },
  },
}

export const featuredProductsSchema = {
  tags: ['Products'],
  summary: 'Featured/bestseller garment_rates (cached)',
}

export const getProductSchema = {
  tags: ['Products'],
  summary: 'Single product detail (by UUID or slug)',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
}

export const getRelatedProductsSchema = {
  tags: ['Products'],
  summary: 'Related garment_rates by same category',
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}

export const createProductSchema = {
  tags: ['Products'],
  summary: 'Create product [ADMIN]',
  security: [{ bearerAuth: [] }],
  body: {
    type: 'object',
    // 'price' was dropped from the garment_types table by migration 062 and
    // the repository's create() never reads it — kept accepted-but-optional
    // below for backward compatibility, but it can no longer be required.
    required: ['name', 'categoryId'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 200 },
      description: { type: 'string', maxLength: 10000 },
      price: { type: 'number', minimum: 0 },
      salePrice: { type: 'number', minimum: 0 },
      costPrice: { type: 'number', minimum: 0 },
      categoryId: { type: 'string', format: 'uuid' },
      stock: { type: 'integer', minimum: 0, default: 0 },
      unit: { type: 'string', enum: ['kg', 'g', 'l', 'ml', 'piece', 'pack', 'dozen', 'box'] },
      sku: { type: 'string', maxLength: 100 },
      barcode: { type: 'string', maxLength: 100 },
      thumbnailUrl: { type: 'string' },
      images: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      isFeatured: { type: 'boolean', default: false },
      isActive: { type: 'boolean', default: true },
      lowStockThreshold: { type: 'integer', minimum: 0 },
      maxOrderQty: { type: 'integer', minimum: 1 },
      ingredients: { type: 'string', maxLength: 5000 },
      allergenInfo: { type: 'string', maxLength: 1000 },
      shelfLife: { type: 'string', maxLength: 200 },
      storageInstructions: { type: 'string', maxLength: 500 },
      certifications: { type: 'array', items: { type: 'string' } },
      nutritionInfo: { type: 'object', additionalProperties: { type: 'string' } },
      metaTitle: { type: 'string', maxLength: 160 },
      metaDescription: { type: 'string', maxLength: 500 },
      brand: { type: 'string', maxLength: 200 },
      brandLogoUrl: { type: 'string' },
      netQuantity: { type: 'string', maxLength: 200 },
      highlights: {
        type: 'object',
        patternProperties: {
          '.*': { type: 'string' }
        },
        additionalProperties: false,
        default: {}
      },
      attributes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' }
          },
          required: ['label', 'value']
        },
        default: []
      },
      vendorName: { type: 'string', maxLength: 200 },
      vendorAddress: { type: 'string' },
      vendorFssai: { type: 'string', maxLength: 50 },
      returnPolicy: { type: 'string', enum: ['no_return', '7_day', 'instant'], default: 'no_return' },
      avgRating: { type: 'number', minimum: 0, maximum: 5 },
      ratingCount: { type: 'integer', minimum: 0 },
      isAuthentic: { type: 'boolean', default: true },
      productFamilyId: { type: 'string', format: 'uuid' },
      optionLabel: { type: 'string', maxLength: 100 },
      optionSortOrder: { type: 'integer', minimum: 0, default: 0 },
      isDefaultOption: { type: 'boolean', default: false },
      foodType: { type: 'string', enum: ['VEG', 'NON_VEG', 'EGG', 'NONE'], default: 'NONE' },
      originTag: { type: 'string', enum: ['IMPORTED', 'LOCAL', 'NONE'], default: 'NONE' },
      customBadges: { type: 'array', items: { type: 'string', maxLength: 50 }, default: [] },
      displayDeliveryMinutes: { type: 'integer', minimum: 1, maximum: 180 },
      variants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            price: { type: 'number' },
            salePrice: { type: 'number' },
            stockQuantity: { type: 'integer' },
            sku: { type: 'string' },
            isActive: { type: 'boolean' }
          }
        }
      },
    },
  },
}

export const updateProductSchema = {
  tags: ['Products'],
  summary: 'Update product [ADMIN]',
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
      name: { type: 'string', minLength: 2, maxLength: 200 },
      description: { type: 'string', maxLength: 10000 },
      price: { type: 'number', minimum: 0 },
      salePrice: { type: 'number', minimum: 0 },
      costPrice: { type: 'number', minimum: 0 },
      categoryId: { type: 'string', format: 'uuid' },
      stock: { type: 'integer', minimum: 0 },
      unit: { type: 'string', enum: ['kg', 'g', 'l', 'ml', 'piece', 'pack', 'dozen', 'box'] },
      sku: { type: 'string', maxLength: 100 },
      barcode: { type: 'string', maxLength: 100 },
      thumbnailUrl: { type: 'string' },
      images: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      isFeatured: { type: 'boolean' },
      isActive: { type: 'boolean' },
      lowStockThreshold: { type: 'integer', minimum: 0 },
      maxOrderQty: { type: 'integer', minimum: 1 },
      ingredients: { type: 'string', maxLength: 5000 },
      allergenInfo: { type: 'string', maxLength: 1000 },
      shelfLife: { type: 'string', maxLength: 200 },
      storageInstructions: { type: 'string', maxLength: 500 },
      certifications: { type: 'array', items: { type: 'string' } },
      nutritionInfo: { type: 'object', additionalProperties: { type: 'string' } },
      metaTitle: { type: 'string', maxLength: 160 },
      metaDescription: { type: 'string', maxLength: 500 },
      brand: { type: 'string', maxLength: 200 },
      brandLogoUrl: { type: 'string' },
      netQuantity: { type: 'string', maxLength: 200 },
      highlights: {
        type: 'object',
        patternProperties: {
          '.*': { type: 'string' }
        },
        additionalProperties: false,
        default: {}
      },
      attributes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' }
          },
          required: ['label', 'value']
        },
        default: []
      },
      vendorName: { type: 'string', maxLength: 200 },
      vendorAddress: { type: 'string' },
      vendorFssai: { type: 'string', maxLength: 50 },
      returnPolicy: { type: 'string', enum: ['no_return', '7_day', 'instant'], default: 'no_return' },
      avgRating: { type: 'number', minimum: 0, maximum: 5 },
      ratingCount: { type: 'integer', minimum: 0 },
      isAuthentic: { type: 'boolean', default: true },
      productFamilyId: { type: 'string', format: 'uuid' },
      optionLabel: { type: 'string', maxLength: 100 },
      optionSortOrder: { type: 'integer', minimum: 0, default: 0 },
      isDefaultOption: { type: 'boolean', default: false },
      foodType: { type: 'string', enum: ['VEG', 'NON_VEG', 'EGG', 'NONE'], default: 'NONE' },
      originTag: { type: 'string', enum: ['IMPORTED', 'LOCAL', 'NONE'], default: 'NONE' },
      customBadges: { type: 'array', items: { type: 'string', maxLength: 50 }, default: [] },
      displayDeliveryMinutes: { type: 'integer', minimum: 1, maximum: 180 },
      variants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            price: { type: 'number' },
            salePrice: { type: 'number' },
            stockQuantity: { type: 'integer' },
            sku: { type: 'string' },
            isActive: { type: 'boolean' }
          }
        }
      },
    },
  },
}

export const pairWithSchema = {
  params: {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' } },
    required: ['id']
  },
  querystring: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }
  }
}

export const updateStockSchema = {
  tags: ['Products'],
  summary: 'Update stock quantity [ADMIN]',
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
    required: ['stock'],
    properties: {
      stock: { type: 'integer', minimum: 0 },
    },
  },
}

export const deleteProductSchema = {
  tags: ['Products'],
  summary: 'Delete product [ADMIN]',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
}
