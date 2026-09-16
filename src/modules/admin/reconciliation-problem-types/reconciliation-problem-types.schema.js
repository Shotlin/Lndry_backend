/**
 * Reconciliation Problem Types JSON Schemas
 */

const problemTypeProperties = {
  id:          { type: 'string' },
  label:       { type: 'string' },
  description: { type: ['string', 'null'] },
  isActive:    { type: 'boolean' },
  sortOrder:   { type: 'integer' },
  createdBy:   { type: ['string', 'null'] },
  createdAt:   { type: 'string' },
  updatedAt:   { type: 'string' },
}

const problemTypeResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
    data: { type: 'object', properties: problemTypeProperties },
  },
}

export const listReconciliationProblemTypesSchema = {
  tags: ['Reconciliation Problem Types'],
  summary: 'All reconciliation problem types [ADMIN]',
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data: { type: 'array', items: { type: 'object', properties: problemTypeProperties } },
      },
    },
  },
}

export const activeReconciliationProblemTypesSchema = {
  tags: ['Reconciliation Problem Types'],
  summary: 'Active reconciliation problem types for the vendor reconcile-sheet picker',
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
              label: { type: 'string' },
              description: { type: ['string', 'null'] },
              sortOrder: { type: 'integer' },
            },
          },
        },
      },
    },
  },
}

export const createReconciliationProblemTypeSchema = {
  tags: ['Reconciliation Problem Types'],
  summary: 'Create reconciliation problem type [ADMIN]',
  body: {
    type: 'object',
    required: ['label'],
    properties: {
      label:       { type: 'string', minLength: 2, maxLength: 100 },
      description: { type: 'string', maxLength: 255 },
      sortOrder:   { type: 'integer', default: 0 },
    },
  },
  response: { 201: problemTypeResponse },
}

export const updateReconciliationProblemTypeSchema = {
  tags: ['Reconciliation Problem Types'],
  summary: 'Update reconciliation problem type [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  body: {
    type: 'object',
    properties: {
      label:       { type: 'string', minLength: 2, maxLength: 100 },
      description: { type: ['string', 'null'], maxLength: 255 },
      isActive:    { type: 'boolean' },
      sortOrder:   { type: 'integer' },
    },
  },
  response: { 200: problemTypeResponse },
}

export const deleteReconciliationProblemTypeSchema = {
  tags: ['Reconciliation Problem Types'],
  summary: 'Delete reconciliation problem type [ADMIN]',
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        message: { type: 'string' },
        data:    { type: 'null' },
      },
    },
  },
}
