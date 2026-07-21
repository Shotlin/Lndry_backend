import { query } from '../../../config/database.js'
import { success } from '../../../utils/apiResponse.js'

export default async function adminActivityLogRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply)
    await fastify.requireAdmin(request, reply)
  })

  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          adminId: { type: 'string' },
          action: { type: 'string' },
          entityType: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { page = 1, limit = 50, adminId, action, entityType } = request.query
    const offset = (page - 1) * limit
    const params = []
    const clauses = []
    let idx = 1

    if (adminId) { clauses.push(`al.admin_id = $${idx++}`); params.push(adminId) }
    if (action) { clauses.push(`al.action = $${idx++}`); params.push(action) }
    if (entityType) { clauses.push(`al.entity_type = $${idx++}`); params.push(entityType) }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

    const { rows } = await query(
      `SELECT al.*, u.name AS admin_name
       FROM admin_activity_log al
       LEFT JOIN users u ON u.id = al.admin_id
       ${where}
       ORDER BY al.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    )

    const countRes = await query(
      `SELECT COUNT(*)::int AS total FROM admin_activity_log al ${where}`,
      params
    )

    return success({
      logs: rows,
      total: countRes.rows[0].total,
      page,
      limit,
    }, 'Activity log fetched')
  })
}
