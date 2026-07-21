import { query } from '../../config/database.js'
import { success, error } from '../../utils/apiResponse.js'

/**
 * Tip presets routes plugin
 * Public: GET /api/v1/tip-presets
 * Admin: CRUD /api/v1/admin/tip-presets
 */
export default async function tipPresetsRoutes(fastify) {
  // ─── Public: GET / ────────────────
  fastify.get('/', {
    schema: { tags: ['Tip Presets'], summary: 'Get active tip presets' },
  }, async (request, reply) => {
    const { rows } = await query(
      `SELECT amount, emoji FROM tip_presets
       WHERE is_active = true ORDER BY sort_order`
    )
    return reply.code(200).send(success(rows, 'Tip presets fetched'))
  })
}

/**
 * Admin tip-presets routes
 * Prefix: /api/v1/admin/tip-presets
 */
export async function adminTipPresetsRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate)
  fastify.addHook('preHandler', fastify.requireAdmin)

  // GET / — List all
  fastify.get('/', async (request, reply) => {
    const { rows } = await query(
      `SELECT id, amount, emoji, sort_order, is_active, created_at
       FROM tip_presets ORDER BY sort_order`
    )
    return reply.code(200).send(success(rows, 'Tip presets fetched'))
  })

  // POST / — Create
  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount: { type: 'number', minimum: 1, maximum: 500 },
          emoji: { type: 'string', maxLength: 10 },
          sortOrder: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const { amount, emoji, sortOrder = 0 } = request.body
    const { rows } = await query(
      `INSERT INTO tip_presets (amount, emoji, sort_order)
       VALUES ($1, $2, $3) RETURNING *`,
      [amount, emoji || null, sortOrder]
    )
    return reply.code(201).send(success(rows[0], 'Tip preset created'))
  })

  // PUT /:id — Update
  fastify.put('/:id', {
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          amount: { type: 'number', minimum: 1, maximum: 500 },
          emoji: { type: 'string', maxLength: 10 },
          sortOrder: { type: 'integer' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const { amount, emoji, sortOrder, isActive } = request.body
    const { rows } = await query(
      `UPDATE tip_presets
       SET amount = COALESCE($2, amount),
           emoji = COALESCE($3, emoji),
           sort_order = COALESCE($4, sort_order),
           is_active = COALESCE($5, is_active)
       WHERE id = $1 RETURNING *`,
      [id, amount, emoji, sortOrder, isActive]
    )
    if (rows.length === 0) return reply.code(404).send(error('Not found', 'NOT_FOUND'))
    return reply.code(200).send(success(rows[0], 'Tip preset updated'))
  })

  // DELETE /:id
  fastify.delete('/:id', async (request, reply) => {
    await query(`DELETE FROM tip_presets WHERE id = $1`, [request.params.id])
    return reply.code(200).send(success(null, 'Tip preset deleted'))
  })
}
