import { getClient, query } from '../../config/database.js'
import { emitInTx } from '../../utils/audit-log.js'
import { PARTNER_LEAD_SOURCE } from './partner-leads.contract.js'

export class PartnerLeadsService {
  async list({ state, page = 1, limit = 25 } = {}) {
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1)
    const safeLimit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25))
    const values = []
    const conditions = []
    if (state) {
      values.push(state)
      conditions.push(`state = $${values.length}`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const count = await getClient().then(async (client) => {
      try { return await client.query(`SELECT count(1)::int AS total FROM partner_leads ${where}`, values) } finally { client.release() }
    })
    const client = await getClient()
    try {
      const offset = (safePage - 1) * safeLimit
      const rows = await client.query(`
        SELECT id, external_lead_id, full_name, business_name, email, phone, city,
          service_area, services, business_type, daily_capacity, state,
          source_submitted_at, received_at, last_received_at, received_count,
          claimed_by_user_id, claimed_at
        FROM partner_leads ${where}
        ORDER BY received_at DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `, [...values, safeLimit, offset])
      return { leads: rows.rows, page: safePage, limit: safeLimit, total: count.rows[0].total }
    } finally { client.release() }
  }

  async claim(leadId, actorId, requestMeta = {}) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const updated = await client.query(`
        UPDATE partner_leads
        SET state = 'CLAIMED', claimed_by_user_id = $2, claimed_at = now()
        WHERE id = $1 AND state = 'RECEIVED'
        RETURNING id, state, claimed_by_user_id, claimed_at
      `, [leadId, actorId])
      if (!updated.rowCount) {
        await client.query('ROLLBACK')
        const existing = await query('SELECT state FROM partner_leads WHERE id = $1', [leadId])
        if (!existing.rowCount) throw { statusCode: 404, message: 'Partner lead not found' }
        throw { statusCode: 409, message: `Partner lead is already ${String(existing.rows[0].state).toLowerCase()}` }
      }
      const lead = updated.rows[0]
      await emitInTx(client, 'partner_lead_claimed', {
        actor_user_id: actorId, actor_role: 'ADMIN', target_type: 'partner_lead', target_id: lead.id,
        after: { state: lead.state, claimedBy: actorId },
        ip_address: requestMeta.ip || null, user_agent: requestMeta.userAgent || null,
      })
      await client.query('COMMIT')
      return lead
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* transaction already rolled back */ }
      throw error
    } finally { client.release() }
  }

  async receiveWebsiteLead(externalLeadId, input, requestMeta = {}) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const inserted = await client.query(`
        INSERT INTO partner_leads (
          source, external_lead_id, full_name, business_name, email, phone, city,
          address, service_area, services, business_type, years_in_business,
          estimated_monthly_orders, pickup_delivery, daily_capacity, message,
          privacy_consent, source_submitted_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
          $13, $14, $15, $16, $17, $18
        ) ON CONFLICT (source, external_lead_id) DO NOTHING
        RETURNING id, state, received_at
      `, [
        PARTNER_LEAD_SOURCE, externalLeadId, input.fullName, input.businessName,
        input.email, input.phone, input.city, input.address || null,
        input.serviceArea, JSON.stringify(input.selectedServices), input.businessType,
        input.yearsInBusiness, input.estimatedMonthlyOrders, input.pickupDelivery || null,
        input.dailyCapacity || null, input.message || null, input.privacyConsent,
        input.submittedAt,
      ])

      if (inserted.rowCount) {
        const lead = inserted.rows[0]
        await emitInTx(client, 'partner_lead_received', {
          target_type: 'partner_lead', target_id: lead.id,
          after: { source: PARTNER_LEAD_SOURCE, externalLeadId, state: lead.state },
          ip_address: requestMeta.ip || null, user_agent: requestMeta.userAgent || null,
        })
        await client.query('COMMIT')
        return { leadId: lead.id, duplicate: false, state: lead.state }
      }

      const existing = await client.query(`
        UPDATE partner_leads
        SET last_received_at = now(), received_count = received_count + 1
        WHERE source = $1 AND external_lead_id = $2
        RETURNING id, state
      `, [PARTNER_LEAD_SOURCE, externalLeadId])
      await client.query('COMMIT')
      return { leadId: existing.rows[0].id, duplicate: true, state: existing.rows[0].state }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
