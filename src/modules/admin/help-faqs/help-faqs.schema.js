/**
 * Help FAQs JSON Schemas
 *
 * NB: this Fastify instance runs Ajv with `removeAdditional: 'all'`, so every
 * response field must be listed under `properties` or it is silently dropped.
 */

const faqProperties = {
  id:        { type: 'string' },
  question:  { type: 'string' },
  answer:    { type: 'string' },
  sortOrder: { type: 'integer' },
  isActive:  { type: 'boolean' },
  createdBy: { type: ['string', 'null'] },
  createdAt: { type: 'string' },
  updatedAt: { type: 'string' },
}

const faqResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: faqProperties },
  },
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
}

export const listHelpFaqsSchema = {
  tags: ['Help FAQs'],
  summary: 'All FAQs, including disabled ones [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: faqProperties } },
      },
    },
  },
}

export const createHelpFaqSchema = {
  tags: ['Help FAQs'],
  summary: 'Create FAQ [ADMIN]',
  body: {
    type: 'object',
    required: ['question', 'answer'],
    properties: {
      question:  { type: 'string', minLength: 3, maxLength: 500 },
      answer:    { type: 'string', minLength: 1, maxLength: 4000 },
      sortOrder: { type: 'integer' },
      isActive:  { type: 'boolean' },
    },
  },
  response: { 201: faqResponse },
}

export const updateHelpFaqSchema = {
  tags: ['Help FAQs'],
  summary: 'Update FAQ [ADMIN]',
  params: idParams,
  body: {
    type: 'object',
    properties: {
      question:  { type: 'string', minLength: 3, maxLength: 500 },
      answer:    { type: 'string', minLength: 1, maxLength: 4000 },
      sortOrder: { type: 'integer' },
      isActive:  { type: 'boolean' },
    },
  },
  response: { 200: faqResponse },
}

export const deleteHelpFaqSchema = {
  tags: ['Help FAQs'],
  summary: 'Delete FAQ [ADMIN]',
  params: idParams,
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'null' },
      },
    },
  },
}

/** Public, customer-facing list: only what the app needs to render. */
export const publicFaqsSchema = {
  tags: ['Customer Profile'],
  summary: 'Active Help & FAQs for the customer app',
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
              id:       { type: 'string' },
              question: { type: 'string' },
              answer:   { type: 'string' },
            },
          },
        },
      },
    },
  },
}
