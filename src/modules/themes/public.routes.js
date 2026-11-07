import { PublicThemeController } from './public.controller.js'

const ctrl = new PublicThemeController()

/**
 * The tab home builder still queries tables of a previous product (`categories`, `garment_rates`) that were
 * renamed or dropped. No LNDRY client calls this endpoint, but it is public, so instead of crashing with a 500
 * for every request it answers "not available". (A missing table/column is the only case handled here.)
 */
function legacyCatalogueGuard(handler) {
  return async function guarded(request, reply) {
    try {
      return await handler(request, reply)
    } catch (err) {
      if (err?.code === '42P01' || err?.code === '42703') {
        request.log.warn({ err: err.message, route: request.routeOptions?.url }, 'Theme home requested but its legacy catalogue tables are missing')
        return reply.code(404).send({ success: false, message: 'This content is not available', code: 'NOT_AVAILABLE' })
      }
      throw err
    }
  }
}

export default async function publicThemeRoutes(fastify) {
  // NO auth hook — this is a public endpoint
  fastify.get('/active', {
    schema: {
      tags: ['Theme'],
      summary: 'Get active theme for the app (public, no auth)',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: {
              anyOf: [
                { type: 'object', additionalProperties: true },
                { type: 'null' },
              ],
            },
          },
        },
      },
    },
  }, ctrl.getActiveTheme.bind(ctrl))

  fastify.get('/tabs', {
    schema: {
      tags: ['Theme'],
      summary: 'Get all active tab themes (public, no auth)',
      querystring: {
        type: 'object',
        properties: {
          store_key: {
            type: 'string',
            enum: ['zepto', 'off_zone', 'super_mall', 'cafe'],
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, ctrl.getTabThemes.bind(ctrl))

  fastify.get('/tabs/:key/home', {
    schema: {
      tags: ['Theme'],
      summary: 'Get resolved home merchandising for a tab (public, no auth)',
      params: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          store_key: {
            type: 'string',
            enum: ['zepto', 'off_zone', 'super_mall', 'cafe'],
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, legacyCatalogueGuard(ctrl.getTabHomeContent.bind(ctrl)))

  fastify.get('/tabs/:tabKey/sections', {
    schema: {
      tags: ['Theme'],
      summary: 'Get section manifest for a tab (public, no auth)',
      params: {
        type: 'object',
        required: ['tabKey'],
        properties: {
          tabKey: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          store_key: {
            type: 'string',
            enum: ['zepto', 'off_zone', 'super_mall', 'cafe'],
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, ctrl.getSectionManifest.bind(ctrl))

  fastify.post('/analytics', {
    schema: {
      tags: ['Theme'],
      summary: 'Record theme analytics events (public)',
      body: {
        type: 'object',
        properties: {
          events: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                theme_id: { type: 'string' },
                tab_key: { type: 'string' },
                event_type: { type: 'string' },
                user_id: { type: 'string' },
                session_id: { type: 'string' },
                store_key: { type: 'string' },
                section_key: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, ctrl.recordAnalytics.bind(ctrl))
}
