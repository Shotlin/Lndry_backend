export const productAnalyticsSchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      sortBy: { type: 'string', enum: ['revenue', 'sold', 'views'], default: 'revenue' },
    },
  },
}

export const deadStockSchema = {
  querystring: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, default: 30 },
    },
  },
}

export const lowMarginSchema = {
  querystring: {
    type: 'object',
    properties: {
      threshold: { type: 'number', minimum: 0, maximum: 100, default: 15 },
    },
  },
}

export const exportProductsSchema = {
  querystring: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['csv', 'xlsx'], default: 'csv' },
    },
  },
}

export const bulkUpdateSchema = {
  body: {
    type: 'object',
    required: ['garment_rates'],
    properties: {
      garment_rates: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'integer' },
            price: { type: 'number', minimum: 0 },
            sale_price: { type: ['number', 'null'], minimum: 0 },
            category_id: { type: 'integer' },
            is_active: { type: 'boolean' },
          },
        },
      },
    },
  },
}

export const duplicateSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'integer' } },
  },
}

export const searchBarcodeSchema = {
  params: {
    type: 'object',
    required: ['code'],
    properties: { code: { type: 'string', minLength: 1 } },
  },
}
