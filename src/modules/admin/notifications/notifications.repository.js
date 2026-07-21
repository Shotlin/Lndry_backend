import { query, getClient } from '../../../config/database.js'

const TEMPLATE_COLS = `
  id, name, title, body, type, variables, image_url, deep_link,
  is_active, created_by, created_at, updated_at
`

const CAMPAIGN_COLS = `
  nc.id, nc.title, nc.body, nc.image_url, nc.deep_link, nc.type,
  nc.target_type, nc.segment, nc.target_count, nc.sent_count,
  nc.opened_count, nc.failed_count, nc.failure_summary,
  nc.status, nc.template_id, nc.scheduled_at, nc.expires_at,
  nc.sent_at, nc.created_by, nc.created_at, nc.updated_at,
  u.name AS created_by_name
`

export class AdminNotificationsRepository {
  /* ── Templates ── */

  async findAllTemplates() {
    const { rows } = await query(
      `SELECT ${TEMPLATE_COLS} FROM notification_templates ORDER BY name`
    )
    return rows
  }

  async findTemplateById(id) {
    const { rows: [t] } = await query(
      `SELECT ${TEMPLATE_COLS} FROM notification_templates WHERE id = $1`,
      [id]
    )
    return t || null
  }

  async createTemplate({ name, title, body, type = 'PUSH', variables, image_url, deep_link }) {
    const { rows: [t] } = await query(
      `INSERT INTO notification_templates
         (name, title, body, type, variables, image_url, deep_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${TEMPLATE_COLS}`,
      [name, title, body, type, JSON.stringify(variables || []), image_url || null, deep_link || null]
    )
    return t
  }

  async updateTemplate(id, updates) {
    const allowed = ['name', 'title', 'body', 'type', 'variables', 'image_url', 'deep_link', 'is_active']
    const sets = []; const params = []; let idx = 1
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = $${idx++}`)
        params.push(key === 'variables' ? JSON.stringify(updates[key]) : updates[key])
      }
    }
    if (sets.length === 0) return this.findTemplateById(id)
    sets.push(`updated_at = NOW()`)
    params.push(id)
    const { rows: [t] } = await query(
      `UPDATE notification_templates SET ${sets.join(', ')} WHERE id = $${idx} RETURNING ${TEMPLATE_COLS}`,
      params
    )
    return t || null
  }

  async deleteTemplate(id) {
    const { rowCount } = await query(
      'DELETE FROM notification_templates WHERE id = $1',
      [id]
    )
    return rowCount > 0
  }

  /* ── Campaigns ── */

  async createCampaign({ title, body, type, segment, segmentValue, image_url, deep_link, expires_at, template_id, scheduledAt, createdBy, targetCount = 0 }) {
    // Map canonical segment names to DB target_type CHECK constraint values
    const segmentToTargetType = {
      all_customers: 'all_customers',
      specific_user: 'custom_list',
      store_customers: 'all_customers',
      inactive_customers: 'no_order_30_days',
      cart_not_empty: 'wishlist_users',
      all: 'all_customers',
      new: 'all_customers',
      inactive: 'no_order_30_days',
      high_value: 'high_value',
    }
    const targetType = segmentToTargetType[segment] || 'all_customers'
    const status = scheduledAt ? 'SCHEDULED' : 'SENDING'

    const { rows: [c] } = await query(
      `INSERT INTO notification_campaigns
         (title, body, type, target_type, segment, image_url, deep_link,
          expires_at, template_id, target_count, scheduled_at, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, title, body, type, target_type, segment, image_url, deep_link,
         expires_at, template_id, target_count, sent_count, failed_count,
         status, scheduled_at, created_by, created_at`,
      [
        title, body, type || 'general', targetType, segment,
        image_url || null, deep_link || null,
        expires_at || null, template_id || null,
        targetCount, scheduledAt || null, status, createdBy,
      ]
    )
    return c
  }

  async findAllCampaigns({ offset, limit, status }) {
    const params = [limit, offset]
    let where = ''
    if (status) {
      where = 'WHERE nc.status = $3'
      params.push(status)
    }
    const { rows } = await query(
      `SELECT ${CAMPAIGN_COLS}
       FROM notification_campaigns nc
       LEFT JOIN users u ON u.id = nc.created_by
       ${where}
       ORDER BY nc.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    )
    const countRes = await query(
      `SELECT COUNT(*)::int AS total FROM notification_campaigns ${where}`,
      status ? [status] : []
    )
    return { campaigns: rows, total: countRes.rows[0].total }
  }

  async findCampaignById(id) {
    const { rows: [c] } = await query(
      `SELECT ${CAMPAIGN_COLS}
       FROM notification_campaigns nc
       LEFT JOIN users u ON u.id = nc.created_by
       WHERE nc.id = $1`,
      [id]
    )
    return c || null
  }

  async findDueScheduledCampaigns() {
    const { rows } = await query(
      `SELECT id, title, body, type, segment, image_url, deep_link, expires_at, template_id
       FROM notification_campaigns
       WHERE status = 'SCHEDULED' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 20`
    )
    return rows
  }

  async lockAndMarkSending(id) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `SELECT id FROM notification_campaigns WHERE id = $1 AND status = 'SCHEDULED' FOR UPDATE SKIP LOCKED`,
        [id]
      )
      if (rows.length === 0) {
        await client.query('ROLLBACK')
        return false
      }
      await client.query(
        `UPDATE notification_campaigns SET status = 'SENDING', updated_at = NOW() WHERE id = $1`,
        [id]
      )
      await client.query('COMMIT')
      return true
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async updateCampaignStatus(id, status, { sentCount, failedCount, failureSummary } = {}) {
    const sets = ['status = $1', 'updated_at = NOW()']
    const params = [status]
    let idx = 2

    if (sentCount !== undefined) {
      sets.push(`sent_count = $${idx++}`)
      params.push(sentCount)
    }
    if (failedCount !== undefined) {
      sets.push(`failed_count = $${idx++}`)
      params.push(failedCount)
    }
    if (failureSummary !== undefined) {
      sets.push(`failure_summary = $${idx++}`)
      params.push(JSON.stringify(failureSummary))
    }
    if (status === 'SENT') {
      sets.push('sent_at = NOW()')
    }
    params.push(id)
    const { rows: [c] } = await query(
      `UPDATE notification_campaigns SET ${sets.join(', ')} WHERE id = $${idx} RETURNING id, status, sent_count, failed_count`,
      params
    )
    return c
  }

  async cancelCampaign(id) {
    const { rows: [c] } = await query(
      `UPDATE notification_campaigns
       SET status = 'CANCELLED', updated_at = NOW()
       WHERE id = $1 AND status = 'SCHEDULED'
       RETURNING id, status`,
      [id]
    )
    return c || null
  }

  /* ── Segment Queries ── */

  async getSegmentCount(segment, segmentValue) {
    const { where, params } = buildSegmentWhere(segment, segmentValue)
    const { rows: [{ count }] } = await query(
      `SELECT COUNT(DISTINCT u.id)::int AS count
       FROM users u
       INNER JOIN fcm_tokens ft ON ft.user_id = u.id AND ft.is_active = true
       WHERE ${where}`,
      params
    )
    return count
  }

  async getTargetUsersWithTokens(segment, segmentValue) {
    const { where, params } = buildSegmentWhere(segment, segmentValue)
    const { rows } = await query(
      `SELECT DISTINCT ON (u.id) u.id AS user_id, ft.token AS fcm_token
       FROM users u
       INNER JOIN fcm_tokens ft ON ft.user_id = u.id AND ft.is_active = true
       WHERE ${where}
       ORDER BY u.id`,
      params
    )
    return rows
  }

  async deactivateInvalidTokens(tokens) {
    if (!tokens?.length) return
    await query(
      `UPDATE fcm_tokens SET is_active = false WHERE token = ANY($1)`,
      [tokens]
    )
  }
}

function buildSegmentWhere(segment, segmentValue) {
  const customerBaseWhere = "u.role = 'CUSTOMER' AND u.is_active = true"
  const params = []

  switch (segment) {
    case 'all_customers':
    case 'all':
      return { where: customerBaseWhere, params }

    case 'new':
      return {
        where: `${customerBaseWhere} AND u.created_at >= NOW() - INTERVAL '30 days'`,
        params,
      }

    case 'inactive_customers':
    case 'inactive':
      return {
        where: `${customerBaseWhere} AND u.id NOT IN (
          SELECT DISTINCT user_id FROM orders WHERE created_at >= NOW() - INTERVAL '30 days'
        )`,
        params,
      }

    case 'high_value':
      return {
        where: `${customerBaseWhere} AND u.id IN (
          SELECT user_id FROM orders WHERE status = 'DELIVERED'
          GROUP BY user_id HAVING SUM(total_amount) >= 5000
        )`,
        params,
      }

    case 'specific_user': {
      // Target a specific person by phone or user ID — no role restriction so
      // admins can test notifications with their own accounts.
      const baseWhere = "u.is_active = true"
      if (segmentValue) {
        params.push(segmentValue)
        return {
          where: `${baseWhere} AND (u.id::text = $${params.length} OR u.phone = $${params.length})`,
          params,
        }
      }
      return { where: baseWhere, params }
    }

    case 'store_customers': {
      if (segmentValue) {
        params.push(segmentValue)
        return {
          where: `${customerBaseWhere} AND u.id IN (
            SELECT DISTINCT user_id FROM orders WHERE vendor_id = $${params.length}
          )`,
          params,
        }
      }
      return { where: customerBaseWhere, params }
    }

    case 'cart_not_empty':
      return {
        where: `${customerBaseWhere} AND u.id IN (
          SELECT DISTINCT user_id FROM orders WHERE status = 'DRAFT'
        )`,
        params,
      }

    default:
      return { where: customerBaseWhere, params }
  }
}
