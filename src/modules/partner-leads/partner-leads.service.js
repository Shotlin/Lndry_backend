import { getClient } from '../../config/database.js'
import { emitInTx } from '../../utils/audit-log.js'
import { PARTNER_LEAD_SOURCE } from './partner-leads.contract.js'

export class PartnerLeadsService {
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
