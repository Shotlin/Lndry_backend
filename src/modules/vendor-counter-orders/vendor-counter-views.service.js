import { query } from '../../config/database.js'

const iso = (value) => (value ? String(value).slice(0, 10) : null)

/**
 * Read-side views for the counter screens: work-queue, claims, returns and
 * print history rows already joined with the tag / order / customer names the
 * screens show. Each work order may live in store_orders (counter) or orders
 * (pickup-delivery), so order details are resolved from whichever holds it.
 */
export class VendorCounterViewsService {
  async unitView(vendorId, id) {
    const { rows } = await query(
      `SELECT gu.id, gu.order_id, gu.active_tag_code, gu.sequence, gu.store_line_index, gu.state, gu.location, gu.condition,
              gt.name AS garment_name, gt.unit AS garment_unit,
              COALESCE(so.order_number, o.order_number) AS order_number,
              COALESCE(so.expected_delivery_date::text, NULL) AS expected_delivery_date, so.items,
              cu.name AS customer_name, cu.phone AS customer_phone,
              (SELECT COUNT(*)::int FROM vendor_garment_unit_events e WHERE e.unit_id = gu.id) AS event_count,
              (SELECT COUNT(*)::int FROM vendor_garment_unit_events e WHERE e.unit_id = gu.id AND e.event_type IN ('TAG_REPRINTED','TAG_REPLACED')) AS reprint_count
       FROM vendor_garment_units gu
       JOIN garment_types gt ON gt.id = gu.garment_type_id
       LEFT JOIN store_orders so ON so.id = gu.order_id
       LEFT JOIN orders o ON o.id = gu.order_id
       LEFT JOIN users cu ON cu.id = gu.customer_user_id
       WHERE gu.vendor_id = $1 AND gu.id = $2`,
      [vendorId, id]
    )
    const unit = rows[0]
    if (!unit) return null
    const [events, history] = await Promise.all([
      query(
        `SELECT e.id, e.event_type, e.from_state, e.to_state, e.location, e.note, e.created_at, u.name AS actor_name
         FROM vendor_garment_unit_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.unit_id = $1 ORDER BY e.created_at ASC`, [id]),
      query(
        `SELECT h.id, h.tag_code, h.status, h.issued_at, h.retirement_reason, h.replacement_tag_id, r.tag_code AS replacement_code, u.name AS actor_name
         FROM vendor_garment_tag_history h
         LEFT JOIN vendor_garment_tag_history r ON r.id = h.replacement_tag_id
         LEFT JOIN users u ON u.id = COALESCE(h.retired_by, h.issued_by)
         WHERE h.unit_id = $1 AND h.status <> 'ACTIVE' ORDER BY h.version ASC`, [id]),
    ])
    return {
      id: unit.id, orderId: unit.order_id, orderNumber: unit.order_number || '', tagCode: unit.active_tag_code, sequence: unit.sequence,
      garmentName: unit.garment_name, serviceName: unit.items?.[unit.store_line_index]?.serviceName || '', unit: unit.garment_unit,
      state: unit.state, location: unit.location, condition: unit.condition, customerName: unit.customer_name || '', customerPhone: unit.customer_phone || '',
      expectedDeliveryDate: iso(unit.expected_delivery_date), eventCount: unit.event_count, reprintCount: unit.reprint_count,
      events: events.rows.map((e) => ({ id: e.id, eventType: e.event_type, fromState: e.from_state, toState: e.to_state, location: e.location, note: e.note, actor: e.actor_name || 'Team member', createdAt: e.created_at })),
      reprints: history.rows.map((h) => ({ id: h.id, previousTagCode: h.tag_code, newTagCode: h.replacement_code || '', reason: h.retirement_reason || '', actor: h.actor_name || 'Team member', createdAt: h.issued_at })),
    }
  }

  async containerView(vendorId, id) {
    const { rows } = await query(
      `SELECT c.id, c.order_id, c.tag_code, c.sequence, c.total_count, c.weight_kg, c.state, c.location, c.condition, c.created_at, c.updated_at, c.delivered_at,
              COALESCE(so.order_number, o.order_number) AS order_number, so.expected_delivery_date::text AS expected_delivery_date,
              cu.name AS customer_name, cu.phone AS customer_phone
       FROM vendor_laundry_containers c
       LEFT JOIN store_orders so ON so.id = c.order_id LEFT JOIN orders o ON o.id = c.order_id
       LEFT JOIN users cu ON cu.id = c.customer_user_id
       WHERE c.vendor_id = $1 AND c.id = $2`, [vendorId, id])
    const c = rows[0]
    if (!c) return null
    const events = await query(
      `SELECT e.id, e.event_type, e.from_state, e.to_state, e.location, e.note, e.created_at, u.name AS actor_name
       FROM vendor_laundry_container_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.container_id = $1 ORDER BY e.created_at ASC`, [id])
    return {
      id: c.id, orderId: c.order_id, orderNumber: c.order_number || '', tagCode: c.tag_code, sequence: c.sequence, total: c.total_count,
      weightKg: c.weight_kg == null ? null : Number(c.weight_kg), state: c.state, location: c.location, condition: c.condition,
      customerName: c.customer_name || '', customerPhone: c.customer_phone || '', expectedDeliveryDate: iso(c.expected_delivery_date),
      createdAt: c.created_at, updatedAt: c.updated_at, deliveredAt: c.delivered_at,
      events: events.rows.map((e) => ({ id: e.id, eventType: e.event_type, fromState: e.from_state, toState: e.to_state, location: e.location, note: e.note, actor: e.actor_name || 'Team member', createdAt: e.created_at })),
    }
  }

  async productionTasks(vendorId, { status, overdue } = {}) {
    const params = [vendorId]
    const where = ['t.vendor_id = $1']
    if (status) { params.push(String(status).toUpperCase().replace(/\s+/g, '_')); where.push(`t.status = $${params.length}`) }
    const { rows } = await query(
      `SELECT t.id, t.garment_unit_id, t.station, t.kind, t.status, t.priority, t.reason, t.created_at, t.completed_at,
              gu.active_tag_code, gt.name AS garment_name, COALESCE(so.order_number, o.order_number) AS order_number,
              so.expected_delivery_date::text AS due, au.name AS assigned_name, t.assigned_to
       FROM vendor_production_tasks t
       LEFT JOIN vendor_garment_units gu ON gu.id = t.garment_unit_id
       LEFT JOIN garment_types gt ON gt.id = gu.garment_type_id
       LEFT JOIN store_orders so ON so.id = t.order_id LEFT JOIN orders o ON o.id = t.order_id
       LEFT JOIN vendor_employees ve ON ve.id = t.assigned_to LEFT JOIN users au ON au.id = ve.user_id
       WHERE ${where.join(' AND ')} ORDER BY (t.status IN ('COMPLETED','CANCELLED')), t.priority DESC, t.created_at DESC LIMIT 500`, params)
    const today = new Date().toISOString().slice(0, 10)
    const mapped = rows.map((t) => ({
      id: t.id, unitId: t.garment_unit_id, tagCode: t.active_tag_code || '', orderNumber: t.order_number || '', garment: t.garment_name || '',
      station: t.station, kind: t.kind, status: t.status, priority: t.priority, assignedTo: t.assigned_name || '', assignedToId: t.assigned_to || '',
      reason: t.reason || '', createdAt: t.created_at, completedAt: t.completed_at, dueDate: iso(t.due),
      overdue: Boolean(t.due && iso(t.due) < today && !['COMPLETED', 'CANCELLED'].includes(t.status)),
    }))
    return overdue ? mapped.filter((t) => t.overdue) : mapped
  }

  async qualityClaims(vendorId) {
    const { rows } = await query(
      `SELECT q.id, q.garment_unit_id, q.category, q.severity, q.status, q.description, q.opened_at, q.decision, q.resolution_note,
              gu.active_tag_code, gu.state, gt.name AS garment_name, COALESCE(so.order_number, o.order_number) AS order_number, ou.name AS opened_by_name,
              c.id AS correction_id, c.summary AS correction_summary, c.customer_message, c.issued_at
       FROM vendor_quality_claims q
       LEFT JOIN vendor_garment_units gu ON gu.id = q.garment_unit_id
       LEFT JOIN garment_types gt ON gt.id = gu.garment_type_id
       LEFT JOIN store_orders so ON so.id = q.order_id LEFT JOIN orders o ON o.id = q.order_id
       LEFT JOIN users ou ON ou.id = q.opened_by
       LEFT JOIN vendor_customer_corrections c ON c.claim_id = q.id
       WHERE q.vendor_id = $1 ORDER BY q.opened_at DESC LIMIT 300`, [vendorId])
    return rows.map((q) => ({
      id: q.id, unitId: q.garment_unit_id, tagCode: q.active_tag_code || '', orderNumber: q.order_number || '', garment: q.garment_name || '', state: q.state || '',
      category: q.category, severity: q.severity, status: q.status, description: q.description, openedAt: q.opened_at, openedBy: q.opened_by_name || 'Team member',
      decision: q.decision, resolutionNote: q.resolution_note || '',
      correction: q.correction_id ? { id: q.correction_id, status: 'Issued', summary: q.correction_summary, customerMessage: q.customer_message, issuedAt: q.issued_at } : null,
    }))
  }

  async corrections(vendorId) {
    const { rows } = await query(
      `SELECT c.id, c.customer_user_id, c.order_id, c.claim_id, c.garment_unit_id, c.decision, c.summary, c.customer_message, c.issued_at, iu.name AS issued_by_name
       FROM vendor_customer_corrections c JOIN vendor_quality_claims q ON q.id = c.claim_id LEFT JOIN users iu ON iu.id = c.issued_by WHERE q.vendor_id = $1 ORDER BY c.issued_at DESC LIMIT 300`, [vendorId])
    return rows.map((c) => ({
      id: c.id, customerId: c.customer_user_id, orderId: c.order_id, claimId: c.claim_id, garmentUnitId: c.garment_unit_id, decision: c.decision, status: 'Issued',
      summary: c.summary, customerMessage: c.customer_message, issuedAt: c.issued_at, issuedBy: c.issued_by_name || 'Team member',
    }))
  }

  async qualityAnalytics(vendorId) {
    const { rows } = await query(
      `SELECT category, decision, status, EXTRACT(EPOCH FROM (resolved_at - opened_at)) / 3600 AS hours FROM vendor_quality_claims WHERE vendor_id = $1`, [vendorId])
    const byCategory = {}
    const byDecision = {}
    let resolved = 0; let open = 0; let rejected = 0; let rewash = 0; let hours = 0; let hourSamples = 0
    for (const r of rows) {
      byCategory[r.category] = (byCategory[r.category] || 0) + 1
      if (r.decision) byDecision[r.decision] = (byDecision[r.decision] || 0) + 1
      if (r.status === 'OPEN') open += 1
      else resolved += 1
      if (r.decision === 'REJECT' || r.status === 'REJECTED') rejected += 1
      if (r.decision === 'REWASH') rewash += 1
      if (r.hours != null) { hours += Number(r.hours); hourSamples += 1 }
    }
    const corrections = await query('SELECT COUNT(*)::int AS n FROM vendor_customer_corrections c JOIN vendor_quality_claims q ON q.id = c.claim_id WHERE q.vendor_id = $1', [vendorId])
    return {
      totalClaims: rows.length, openClaims: open, resolvedClaims: resolved, rejectedClaims: rejected, rewashClaims: rewash,
      correctionDocuments: corrections.rows[0].n, averageResolutionHours: hourSamples ? Math.round((hours / hourSamples) * 10) / 10 : null, byCategory, byDecision,
    }
  }

  async returns(vendorId) {
    const { rows } = await query(
      `SELECT r.id, r.status, r.order_id, r.customer_user_id, r.amount_paise, r.reason, r.note, r.created_at, r.decision_note,
              COALESCE(so.order_number, o.order_number) AS order_number, cu.name AS customer_name
       FROM vendor_return_cases r
       LEFT JOIN store_orders so ON so.id = r.order_id LEFT JOIN orders o ON o.id = r.order_id LEFT JOIN users cu ON cu.id = r.customer_user_id
       WHERE r.vendor_id = $1 ORDER BY r.created_at DESC LIMIT 300`, [vendorId])
    return rows.map((r) => ({
      id: r.id, status: r.status, orderId: r.order_id, orderNumber: r.order_number || '', customerId: r.customer_user_id, customerName: r.customer_name || '',
      amountPaise: r.amount_paise, reason: r.reason, note: r.note || '', decisionNote: r.decision_note || '', createdAt: r.created_at,
    }))
  }

  async printJobs(vendorId, { orderId } = {}) {
    const params = [vendorId]
    let where = 'p.vendor_id = $1'
    if (orderId) { params.push(orderId); where += ` AND p.order_id = $${params.length}` }
    const { rows } = await query(
      `SELECT p.id, p.order_id, p.document_type, p.requested_copies, p.status, p.failure_reason, p.garment_unit_ids, p.container_ids, p.created_at, cu.name AS created_by_name
       FROM vendor_print_jobs p LEFT JOIN users cu ON cu.id = p.created_by WHERE ${where} ORDER BY p.created_at DESC LIMIT 300`, params)
    return rows.map((p) => ({
      id: p.id, orderId: p.order_id, documentType: p.document_type, requestedCopies: p.requested_copies, requestedBy: p.created_by_name || 'Team member',
      createdAt: p.created_at, status: p.status, failureReason: p.failure_reason || '', tagIds: [...(p.garment_unit_ids || []), ...(p.container_ids || [])],
    }))
  }
}
