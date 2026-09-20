import { query, getClient } from '../../../config/database.js'

const TEMPLATE_COLS = `
  id, name, title, body, type, variables, image_url, deep_link,
  deep_link_type, deep_link_params,
  is_active, created_by, created_at, updated_at
`

const CAMPAIGN_COLS = `
  nc.id, nc.title, nc.body, nc.image_url, nc.deep_link, nc.type,
  nc.target_type, nc.segment, nc.target_count, nc.sent_count,
  nc.opened_count, nc.failed_count, nc.failure_summary,
  nc.status, nc.template_id, nc.scheduled_at, nc.expires_at,
  nc.sent_at, nc.created_by, nc.created_at, nc.updated_at,
  nc.audience, nc.target_app, nc.deep_link_type, nc.deep_link_params, nc.device_count,
  u.name AS created_by_name
`

const CAMPAIGN_RETURN = `
  id, title, body, image_url, deep_link, type, target_type, segment, target_count, sent_count,
  opened_count, failed_count, failure_summary, status, template_id, scheduled_at, expires_at,
  sent_at, created_by, created_at, updated_at, audience, target_app, deep_link_type,
  deep_link_params, device_count
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

  async createTemplate({ name, title, body, type = 'PUSH', variables, image_url, deep_link, deep_link_type, deep_link_params }) {
    const { rows: [t] } = await query(
      `INSERT INTO notification_templates
         (name, title, body, type, variables, image_url, deep_link, deep_link_type, deep_link_params)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${TEMPLATE_COLS}`,
      [name, title, body, type, JSON.stringify(variables || []), image_url || null, deep_link || null,
        deep_link_type || null, JSON.stringify(deep_link_params || {})]
    )
    return t
  }

  async updateTemplate(id, updates) {
    const allowed = ['name', 'title', 'body', 'type', 'variables', 'image_url', 'deep_link',
      'deep_link_type', 'deep_link_params', 'is_active']
    const sets = []; const params = []; let idx = 1
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = $${idx++}`)
        params.push(['variables', 'deep_link_params'].includes(key) ? JSON.stringify(updates[key]) : updates[key])
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

  /**
   * Create a campaign row. `status` is DRAFT, SCHEDULED or SENDING; the audience
   * spec and deep link are stored so a scheduled send is exact.
   */
  async createCampaign({
    title, body, type, image_url, link, deepLinkText, audience, targetApp, expires_at, template_id,
    scheduledAt, status, createdBy, targetCount = 0, deviceCount = 0,
  }) {
    const { rows: [c] } = await query(
      `INSERT INTO notification_campaigns
         (title, body, type, target_type, segment, image_url, deep_link, deep_link_type, deep_link_params,
          audience, target_app, expires_at, template_id, target_count, device_count,
          scheduled_at, status, created_by)
       VALUES ($1, $2, $3, 'by_role', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING ${CAMPAIGN_RETURN}`,
      [
        title, body, type || 'general', audience?.kind || null,
        image_url || null, deepLinkText || null, link?.type || null, JSON.stringify(link?.params || {}),
        JSON.stringify(audience), targetApp || null, expires_at || null, template_id || null,
        targetCount, deviceCount, scheduledAt || null, status, createdBy,
      ]
    )
    return c
  }

  /** Edit a draft in place. Only DRAFT campaigns can be edited. */
  async updateDraft(id, fields) {
    const map = {
      title: 'title', body: 'body', type: 'type', image_url: 'image_url',
      deepLinkText: 'deep_link', expires_at: 'expires_at', template_id: 'template_id',
      targetApp: 'target_app', targetCount: 'target_count', deviceCount: 'device_count',
    }
    const sets = []; const params = []; let idx = 1
    for (const [k, col] of Object.entries(map)) {
      if (fields[k] !== undefined) { sets.push(`${col} = $${idx++}`); params.push(fields[k]) }
    }
    if (fields.link !== undefined) {
      sets.push(`deep_link_type = $${idx++}`, `deep_link_params = $${idx++}`)
      params.push(fields.link?.type || null, JSON.stringify(fields.link?.params || {}))
    }
    if (fields.audience !== undefined) {
      sets.push(`audience = $${idx++}`, `segment = $${idx++}`)
      params.push(JSON.stringify(fields.audience), fields.audience?.kind || null)
    }
    if (!sets.length) return this.findCampaignById(id)
    sets.push('updated_at = NOW()')
    params.push(id)
    const { rows: [c] } = await query(
      `UPDATE notification_campaigns SET ${sets.join(', ')}
        WHERE id = $${idx} AND status = 'DRAFT' RETURNING ${CAMPAIGN_RETURN}`,
      params
    )
    return c || null
  }

  /** Move a DRAFT to SCHEDULED or SENDING. */
  async activateDraft(id, { status, scheduledAt, targetCount, deviceCount }) {
    const { rows: [c] } = await query(
      `UPDATE notification_campaigns
          SET status = $2, scheduled_at = $3, target_count = $4, device_count = $5, updated_at = NOW()
        WHERE id = $1 AND status = 'DRAFT' RETURNING ${CAMPAIGN_RETURN}`,
      [id, status, scheduledAt || null, targetCount, deviceCount]
    )
    return c || null
  }

  async deleteCampaign(id) {
    const { rowCount } = await query(
      `DELETE FROM notification_campaigns WHERE id = $1 AND status IN ('DRAFT', 'CANCELLED')`,
      [id]
    )
    return rowCount > 0
  }

  /** Per-app / per-status breakdown for the campaign detail view. */
  async getCampaignBreakdown(id) {
    const { rows } = await query(
      `SELECT app_type, status, COUNT(*)::int AS count,
              COUNT(opened_at)::int AS opened
         FROM notification_deliveries WHERE campaign_id = $1
        GROUP BY app_type, status`,
      [id]
    )
    return rows
  }

  /** Recent failure reasons for a campaign (for the detail view). */
  async getCampaignErrors(id) {
    const { rows } = await query(
      `SELECT error_code, COUNT(*)::int AS count FROM notification_deliveries
        WHERE campaign_id = $1 AND status <> 'SENT' GROUP BY error_code ORDER BY count DESC LIMIT 10`,
      [id]
    )
    return rows
  }

  async insertInboxItems(userIds, { title, body, type, data }) {
    if (!userIds.length) return new Map()
    const { rows } = await query(
      `INSERT INTO notifications (user_id, title, body, type, data)
       SELECT uid, $2, $3, $4, $5::jsonb FROM unnest($1::uuid[]) AS uid
       RETURNING id, user_id`,
      [userIds, title, body, type, JSON.stringify(data || {})]
    )
    return new Map(rows.map((r) => [r.user_id, r.id]))
  }

  /** People (or vendors) matching a name / phone / email fragment, with live device counts. */
  async searchRecipients({ q, type, limit = 15 }) {
    const term = `%${String(q || '').trim().replace(/[%_]/g, '')}%`
    if (type === 'vendor') {
      const { rows } = await query(
        `SELECT v.id, v.name, v.city, v.pincode,
                (SELECT COUNT(*)::int FROM fcm_tokens ft
                   JOIN vendor_employees ve ON ve.user_id = ft.user_id
                  WHERE ve.vendor_id = v.id AND ve.is_active AND ve.deleted_at IS NULL
                    AND ve.role IN ('VENDOR_OWNER','VENDOR_STAFF') AND ft.is_active) AS devices
           FROM vendors v
          WHERE v.deleted_at IS NULL AND (v.name ILIKE $1 OR v.city ILIKE $1 OR v.pincode ILIKE $1)
          ORDER BY v.name LIMIT ${Number(limit)}`,
        [term]
      )
      return rows
    }
    const roleFilter = type === 'captain'
      ? `AND EXISTS (SELECT 1 FROM vendor_employees ve WHERE ve.user_id = u.id AND ve.role = 'VENDOR_RIDER' AND ve.is_active AND ve.deleted_at IS NULL)`
      : type === 'customer'
        ? `AND NOT EXISTS (SELECT 1 FROM vendor_employees ve WHERE ve.user_id = u.id AND ve.is_active AND ve.deleted_at IS NULL)`
        : ''
    const { rows } = await query(
      `SELECT u.id, u.name, u.phone, u.email,
              (SELECT COUNT(*)::int FROM fcm_tokens ft WHERE ft.user_id = u.id AND ft.is_active) AS devices
         FROM users u
        WHERE u.is_active = true ${roleFilter}
          AND (u.name ILIKE $1 OR u.phone ILIKE $1 OR u.email ILIKE $1)
        ORDER BY u.name NULLS LAST LIMIT ${Number(limit)}`,
      [term]
    )
    return rows
  }

  /** Current devices for one user (test send + recipient preview). */
  async findUserBasic(userId) {
    const { rows: [u] } = await query(
      `SELECT id, name, phone, is_active FROM users WHERE id = $1`, [userId]
    )
    return u || null
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
      `SELECT id FROM notification_campaigns
        WHERE status = 'SCHEDULED' AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT 20`
    )
    return rows
  }

  /** A worker crash mid-send leaves SENDING forever; surface those as FAILED. */
  async failStuckSending(olderThanMinutes = 30) {
    const { rows } = await query(
      `UPDATE notification_campaigns
          SET status = 'FAILED', updated_at = NOW(),
              failure_summary = COALESCE(failure_summary, '{}'::jsonb) || '{"reason":"Send did not finish (server restarted)"}'::jsonb
        WHERE status = 'SENDING' AND updated_at < NOW() - ($1 || ' minutes')::interval
        RETURNING id`,
      [String(olderThanMinutes)]
    )
    return rows
  }

  async getCampaignForSend(id) {
    const { rows: [c] } = await query(
      `SELECT ${CAMPAIGN_RETURN} FROM notification_campaigns nc WHERE id = $1`, [id]
    )
    return c || null
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

  async updateCampaignStatus(id, status, { sentCount, failedCount, failureSummary, targetCount, deviceCount } = {}) {
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
    if (targetCount !== undefined) {
      sets.push(`target_count = $${idx++}`)
      params.push(targetCount)
    }
    if (deviceCount !== undefined) {
      sets.push(`device_count = $${idx++}`)
      params.push(deviceCount)
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

export function buildSegmentWhere(segment, segmentValue) {
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
