import fp from 'fastify-plugin'
import { env } from '../config/env.js'
import { captureException } from '../config/sentry.js'

/**
 * Global error handler plugin
 * Maps known errors to proper HTTP responses
 * Hides stack traces in production
 */
async function errorHandlerPlugin(fastify) {
  fastify.setErrorHandler((error, request, reply) => {
    const { statusCode = 500, message, validation, code } = error
    const requestId = request.id || undefined

    // Fastify validation errors (JSON Schema)
    if (validation) {
      const fieldErrors = validation.map((v) => ({
        field: v.instancePath?.replace('/', '') || v.params?.missingProperty,
        message: v.message,
      }))
      return reply.code(400).send({
        success: false,
        message: 'Validation error',
        code: 'VALIDATION_ERROR',
        errors: fieldErrors,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation error',
          field_errors: fieldErrors,
          request_id: requestId
        }
      })
    }

    // Rate-limit errors — pass through with 429
    if (statusCode === 429 || code === 'FST_RATE_LIMIT_EXCEEDED') {
      const errMsg = message || 'Rate limit exceeded'
      return reply.code(429).send({
        success: false,
        message: errMsg,
        code: 'RATE_LIMIT_EXCEEDED',
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: errMsg,
          request_id: requestId
        }
      })
    }

    // Known HTTP errors
    if (statusCode < 500) {
      const errCode = code || 'ERROR'
      return reply.code(statusCode).send({
        success: false,
        message,
        code: errCode,
        error: {
          code: errCode,
          message,
          request_id: requestId
        }
      })
    }

    // 500 — Internal server error
    request.log.error({ err: error }, 'Internal server error')
    captureException(error, { extra: { requestId, url: request.url, method: request.method } })

    const errMsg = env.NODE_ENV === 'production'
      ? 'Internal server error'
      : message
    const response = {
      success: false,
      message: errMsg,
      code: 'INTERNAL_ERROR',
      error: {
        code: 'INTERNAL_ERROR',
        message: errMsg,
        request_id: requestId
      }
    }

    if (env.NODE_ENV !== 'production') {
      response.stack = error.stack
    }

    return reply.code(500).send(response)
  })

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      success: false,
      message: `Route ${request.method} ${request.url} not found`,
      code: 'NOT_FOUND',
    })
  })
}

export default fp(errorHandlerPlugin, { name: 'error-handler' })
