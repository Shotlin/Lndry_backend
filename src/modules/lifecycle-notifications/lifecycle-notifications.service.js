import { query as defaultQuery } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { getOrderBalanceDuePaise } from '../../utils/order-balance.js'
import { validateLink } from '../../utils/deeplink.js'
import {
  LIFECYCLE_EVENTS, STATUS_EVENTS, RECIPIENT_TYPES, PLACEHOLDERS,
} from './catalog.js'
import { render, templateProblems, SAMPLE_VARS } from './render.js'

/** How long an unfinished (PENDING) send is left alone before a retry may take it over. */
const STALE_PENDING_MINUTES = 3
const TEMPLATE_CACHE_MS = 15_000
const MASK = '••••••'

export class LifecycleRequestError extends Error {
  constructor(message, code = 'LIFECYCLE_INVALID') {
    super(message)
    this.code = code
  }
}

const money = (paise) => {
  const rupees = Number(paise) / 100
  return Number.isInteger(rupees) ? String(rupees) : rupees.toFixed(2)
}

/**
 * The order lifecycle notification engine.
 *
 * Backend events (a status change, an OTP being generated, a payment) call
 * `emit` / `handleStatusChange`. For each one it works out who should be told,
 * resolves the message (an admin's saved wording, or the built-in default),
 * fills the placeholders from real order data, sends it through the central
 * push dispatcher, and records it in `notification_events`.
 *
 * That table is also the duplicate guard: it is unique per (event, recipient,
 * order, dedupe key), so an API retry, a replayed webhook or a worker retry can never
 * send the same notification twice.
 */
export class LifecycleNotificationService {
  /**
   * `send(userId, payload)` and `balanceDue(orderId)` are injectable so the
   * whole engine can be tested without Firebase or Redis.
   */
  constructor({ query = defaultQuery, send = null, balanceDue = getOrderBalanceDuePaise } = {}) {
    this.query = query
    this._sendImpl = send
    this.balanceDue = balanceDue
    this._cache = new Map()
  }

  async _send(userId, payload) {
    if (this._sendImpl) return this._sendImpl(userId, payload)
    if (!this._notifications) {
      const [{ NotificationsService }, { NotificationsRepository }] = await Promise.all([
        import('../notifications/notifications.service.js'),
        import('../notifications/notifications.repository.js'),
      ])
      this._notifications = new NotificationsService(new NotificationsRepository(), null)
    }
    return this._notifications.sendRich(userId, payload)
  }

  /* ── Triggers ───────────────────────────────────────────────────────── */

  /**
   * An order moved from `oldStatus` to `newStatus`. Sends whatever
   * notifications that transition implies. Idempotent.
   */
  async handleStatusChange(orderId, oldStatus, newStatus, { verify = true } = {}) {
    const rules = STATUS_EVENTS[newStatus]
    if (!rules) return []

    // Only act on transitions that really committed (the job is queued from
    // inside the transaction that records the event).
    if (verify) {
      const { rows } = await this.query(
        'SELECT 1 FROM order_events WHERE order_id = $1 AND new_status = $2 LIMIT 1',
        [orderId, newStatus]
      )
      if (!rows.length) return []
    }

    const out = []
    for (const rule of rules) {
      if (rule.onlyFrom && oldStatus !== rule.onlyFrom) continue
      const extra = { reason: rule.reason, leg: rule.leg }
      if (rule.onlyIfBalanceDue) {
        const due = await this.balanceDue(orderId)
        if (!(due > 0)) continue          // already paid: no reminder, and never a hard-coded amount
        extra.remainingPaise = due
      }
      const dedupe = rule.perReconciliation ? await this._reconciliationKey(orderId) : 'once'
      out.push(...await this.emit(rule.event, { orderId, dedupe, extra }))
    }
    return out
  }

  async _reconciliationKey(orderId) {
    try {
      const { rows } = await this.query(
        'SELECT id FROM order_reconciliations WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1',
        [orderId]
      )
      return rows[0] ? `reconciliation:${rows[0].id}` : 'once'
    } catch {
      return 'once'
    }
  }

  /**
   * Send one lifecycle event for an order.
   *  - dedupe: what makes this send distinct ('once' = at most once per order)
   *  - extra:  event-specific values ({ otp, amountPaise, remainingPaise, reason, leg })
   */
  async emit(eventKey, { orderId, dedupe = 'once', extra = {} } = {}) {
    const def = LIFECYCLE_EVENTS[eventKey]
    if (!def) throw new LifecycleRequestError(`Unknown lifecycle event ${eventKey}`)
    const ctx = await this._context(orderId)
    if (!ctx) return []

    const tpl = await this._template(eventKey)
    const leg = def.leg || extra.leg || (/PICKUP|PICKED_UP/.test(eventKey) ? 'PICKUP' : 'DELIVERY')
    const recipients = await this._recipients(tpl.recipient, def, ctx, leg)
    const captain = await this._captainName(orderId, leg)

    const results = []
    for (const userId of recipients) {
      results.push(await this._sendOne({ eventKey, def, tpl, ctx, userId, dedupe, extra, captain }))
    }
    return results
  }

  async _sendOne({ eventKey, def, tpl, ctx, userId, dedupe, extra, captain }) {
    const claimed = await this._claim(eventKey, tpl.recipient, ctx.id, userId, dedupe)
    if (!claimed) return { userId, status: 'DUPLICATE' }

    if (!tpl.enabled) {
      await this._finish(claimed, { status: 'SKIPPED', skip_reason: 'DISABLED' })
      return { userId, status: 'SKIPPED' }
    }

    const vars = await this._vars(def, tpl, ctx, extra, captain)
    const title = render(tpl.title, vars)
    const body = render(tpl.body, vars)
    const masked = { ...vars, otp: vars.otp ? MASK : vars.otp }

    try {
      const r = await this._send(userId, {
        title, body,
        type: `lifecycle_${eventKey.toLowerCase()}`,
        imageUrl: tpl.imageUrl || undefined,
        link: { type: tpl.linkType, params: { ...tpl.linkParams, orderId: ctx.id, vendorId: ctx.vendor_id } },
        data: {
          event: eventKey,
          orderId: ctx.id,
          orderNumber: ctx.order_number,
          target: tpl.recipient.toLowerCase(),
        },
        notificationId: undefined,
      })
      const p = r?.push || {}
      let status = 'SENT'
      if (p.configured === false) status = 'FAILED'
      else if (!p.devices) status = 'NO_DEVICE'
      else if (!p.sent) status = 'FAILED'
      else if (p.sent < p.devices) status = 'PARTIAL'
      await this._finish(claimed, {
        status,
        title: render(tpl.title, masked),
        body: render(tpl.body, masked),
        notification_id: r?.notification?.id || null,
        devices_total: p.devices || 0,
        devices_sent: p.sent || 0,
        devices_failed: (p.failed || 0) + (p.invalid || 0),
        error_summary: p.configured === false ? 'Push service not configured' : null,
        sent: status === 'SENT' || status === 'PARTIAL',
      })
      return { userId, status }
    } catch (err) {
      logger.error({ err: err.message, eventKey, orderId: ctx.id }, 'Lifecycle notification failed')
      await this._finish(claimed, { status: 'FAILED', error_summary: String(err.message).slice(0, 300) })
      return { userId, status: 'FAILED' }
    }
  }

  /**
   * Take the right to send this notification. Returns the event row id when we
   * won it (first time, or a stale unfinished attempt being retried), or null
   * when it was already handled.
   */
  async _claim(eventKey, recipientType, orderId, userId, dedupe) {
    const { rows } = await this.query(
      `INSERT INTO notification_events (event_key, recipient_type, order_id, recipient_user_id, dedupe_key, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       ON CONFLICT ON CONSTRAINT uq_notification_event DO UPDATE
          SET attempts = notification_events.attempts + 1, updated_at = NOW()
        WHERE notification_events.status = 'PENDING'
          AND notification_events.updated_at < NOW() - ($6 || ' minutes')::interval
       RETURNING id`,
      [eventKey, recipientType, orderId, userId, dedupe, String(STALE_PENDING_MINUTES)]
    )
    return rows[0]?.id || null
  }

  async _finish(id, f) {
    await this.query(
      `UPDATE notification_events
          SET status = $2, skip_reason = $3, title = COALESCE($4, title), body = COALESCE($5, body),
              notification_id = $6, devices_total = $7, devices_sent = $8, devices_failed = $9,
              error_summary = $10, updated_at = NOW(),
              sent_at = CASE WHEN $11 THEN NOW() ELSE sent_at END
        WHERE id = $1`,
      [id, f.status, f.skip_reason || null, f.title || null, f.body || null, f.notification_id || null,
        f.devices_total || 0, f.devices_sent || 0, f.devices_failed || 0, f.error_summary || null, !!f.sent]
    )
  }

  /* ── Data for the message ───────────────────────────────────────────── */

  async _context(orderId) {
    const { rows } = await this.query(
      `SELECT o.id, o.order_number, o.user_id, o.vendor_id, o.status, o.total_amount,
              to_char(o.pickup_date, 'FMDD Mon') AS pickup_date_text,
              CASE WHEN vs.id IS NULL THEN NULL
                   ELSE to_char(vs.start_time, 'FMHH12:MI AM') || ' – ' || to_char(vs.end_time, 'FMHH12:MI AM') END AS pickup_slot_text,
              cu.name AS customer_name, v.name AS vendor_name
         FROM orders o
         LEFT JOIN users cu ON cu.id = o.user_id
         LEFT JOIN vendors v ON v.id = o.vendor_id
         LEFT JOIN vendor_slots vs ON vs.id = o.vendor_slot_id
        WHERE o.id = $1`,
      [orderId]
    )
    return rows[0] || null
  }

  async _vars(def, tpl, ctx, extra, captain) {
    const text = `${tpl.title} ${tpl.body}`
    let remaining = extra.remainingPaise
    if (remaining === undefined && text.includes('remainingAmount')) {
      try { remaining = await this.balanceDue(ctx.id) } catch { remaining = 0 }
    }
    return {
      customerName: ctx.customer_name || 'there',
      vendorName: ctx.vendor_name || 'your laundry partner',
      captainName: captain || 'Your captain',
      orderId: ctx.order_number || ctx.id,
      pickupDate: ctx.pickup_date_text || '',
      pickupSlot: ctx.pickup_slot_text || '',
      amount: extra.amountPaise !== undefined ? money(extra.amountPaise) : money(Math.round(Number(ctx.total_amount || 0) * 100)),
      remainingAmount: remaining !== undefined ? money(remaining) : '',
      otp: extra.otp ?? '',
      reason: extra.reason || '',
    }
  }

  async _captainName(orderId, leg) {
    const { rows } = await this.query(
      `SELECT u.name FROM order_assignments oa
         JOIN users u ON u.id = COALESCE(oa.employee_id, oa.rider_id)
        WHERE oa.order_id = $1 AND oa.assignment_type = $2 AND oa.status NOT IN ('OFFERED', 'CANCELLED')
        ORDER BY oa.created_at DESC LIMIT 1`,
      [orderId, leg === 'ANY' ? 'PICKUP' : leg]
    )
    return rows[0]?.name || null
  }

  /** Who receives it — resolved from the order, never from anything client-supplied. */
  async _recipients(type, def, ctx, leg) {
    if (type === 'CUSTOMER') return ctx.user_id ? [ctx.user_id] : []
    if (type === 'VENDOR') {
      const { rows } = await this.query(
        `SELECT DISTINCT ve.user_id FROM vendor_employees ve
          WHERE ve.vendor_id = $1 AND ve.is_active = true AND ve.deleted_at IS NULL
            AND (ve.role = 'VENDOR_OWNER'
                 OR (ve.role = 'VENDOR_STAFF' AND ve.permissions @> '["shop_orders.view"]'::jsonb))`,
        [ctx.vendor_id]
      )
      return rows.map((r) => r.user_id)
    }
    if (type === 'CAPTAIN') {
      const legs = (def.leg === 'ANY' || leg === 'ANY') ? ['PICKUP', 'DELIVERY'] : [leg]
      const { rows } = await this.query(
        `SELECT DISTINCT COALESCE(oa.employee_id, oa.rider_id) AS user_id FROM order_assignments oa
          WHERE oa.order_id = $1 AND oa.assignment_type = ANY($2::text[])
            AND oa.status NOT IN ('OFFERED', 'CANCELLED')`,
        [ctx.id, legs]
      )
      return rows.map((r) => r.user_id).filter(Boolean)
    }
    return []
  }

  /* ── Templates (what the dashboard edits) ───────────────────────────── */

  async _template(eventKey) {
    const hit = this._cache.get(eventKey)
    if (hit && Date.now() - hit.at < TEMPLATE_CACHE_MS) return hit.value
    const def = LIFECYCLE_EVENTS[eventKey]
    const { rows: [o] } = await this.query(
      'SELECT * FROM notification_event_templates WHERE event_key = $1', [eventKey]
    )
    const value = {
      recipient: o?.recipient_type || def.recipient,
      title: o?.title ?? def.title,
      body: o?.body ?? def.body,
      enabled: o ? o.enabled : true,
      linkType: o ? (o.deep_link_type || null) : def.link,
      linkParams: o?.deep_link_params || {},
      imageUrl: o?.image_url || null,
      custom: !!o,
      updatedAt: o?.updated_at || null,
    }
    this._cache.set(eventKey, { at: Date.now(), value })
    return value
  }

  /** Every lifecycle event with its effective wording (default or customised). */
  async listTemplates() {
    const { rows } = await this.query('SELECT * FROM notification_event_templates')
    const byKey = new Map(rows.map((r) => [r.event_key, r]))
    return Object.entries(LIFECYCLE_EVENTS).map(([key, def]) => {
      const o = byKey.get(key)
      return {
        eventKey: key,
        group: def.group,
        label: def.label,
        trigger: def.trigger,
        defaultRecipient: def.recipient,
        recipientType: o?.recipient_type || def.recipient,
        enabled: o ? o.enabled : true,
        title: o?.title ?? def.title,
        body: o?.body ?? def.body,
        defaultTitle: def.title,
        defaultBody: def.body,
        linkType: o ? (o.deep_link_type || null) : def.link,
        defaultLinkType: def.link,
        linkParams: o?.deep_link_params || {},
        imageUrl: o?.image_url || null,
        isCustom: !!o,
        updatedAt: o?.updated_at || null,
        placeholders: def.placeholders.map((name) => ({ name, description: PLACEHOLDERS[name] })),
      }
    })
  }

  _validateTemplate(eventKey, t) {
    const problems = templateProblems(eventKey, t)
    if (!RECIPIENT_TYPES.includes(t.recipientType)) problems.push('Choose customer, vendor or captain as the recipient.')
    if (t.linkType) {
      const v = validateLink({ type: t.linkType, params: { orderId: 'x', vendorId: 'x', ...(t.linkParams || {}) } })
      if (!v.ok) problems.push(v.error)
    }
    if (t.imageUrl && !/^https:\/\//i.test(t.imageUrl)) problems.push('The image must be an https link or an uploaded image.')
    if (String(t.title).length > 120) problems.push('The title is too long (max 120 characters).')
    if (String(t.body).length > 400) problems.push('The message is too long (max 400 characters).')
    if (problems.length) throw new LifecycleRequestError(problems.join(' '))
  }

  /** Save an admin's version of a lifecycle notification. */
  async saveTemplate(eventKey, patch, adminId) {
    const def = LIFECYCLE_EVENTS[eventKey]
    if (!def) throw new LifecycleRequestError('Unknown notification event.', 'NOT_FOUND')
    const current = (await this.listTemplates()).find((t) => t.eventKey === eventKey)
    const next = {
      recipientType: patch.recipient_type ?? current.recipientType,
      title: patch.title ?? current.title,
      body: patch.body ?? current.body,
      enabled: patch.enabled ?? current.enabled,
      linkType: patch.link !== undefined ? (patch.link?.type || null) : current.linkType,
      linkParams: patch.link !== undefined ? (patch.link?.params || {}) : current.linkParams,
      imageUrl: patch.image_url !== undefined ? (patch.image_url || null) : current.imageUrl,
    }
    this._validateTemplate(eventKey, next)
    await this.query(
      `INSERT INTO notification_event_templates
         (event_key, recipient_type, title, body, enabled, deep_link_type, deep_link_params, image_url, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_key) DO UPDATE SET
         recipient_type = EXCLUDED.recipient_type, title = EXCLUDED.title, body = EXCLUDED.body,
         enabled = EXCLUDED.enabled, deep_link_type = EXCLUDED.deep_link_type,
         deep_link_params = EXCLUDED.deep_link_params, image_url = EXCLUDED.image_url,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [eventKey, next.recipientType, next.title.trim(), next.body.trim(), next.enabled,
        next.linkType, JSON.stringify(next.linkParams), next.imageUrl, adminId || null]
    )
    this._cache.delete(eventKey)
    return (await this.listTemplates()).find((t) => t.eventKey === eventKey)
  }

  /** Discard the admin's version — the built-in wording applies again. */
  async resetTemplate(eventKey) {
    if (!LIFECYCLE_EVENTS[eventKey]) throw new LifecycleRequestError('Unknown notification event.', 'NOT_FOUND')
    await this.query('DELETE FROM notification_event_templates WHERE event_key = $1', [eventKey])
    this._cache.delete(eventKey)
    return (await this.listTemplates()).find((t) => t.eventKey === eventKey)
  }

  /** How a (possibly unsaved) title/message will read with realistic order data. */
  preview(eventKey, { title, body } = {}) {
    const def = LIFECYCLE_EVENTS[eventKey]
    if (!def) throw new LifecycleRequestError('Unknown notification event.', 'NOT_FOUND')
    return {
      title: render(title ?? def.title, SAMPLE_VARS),
      body: render(body ?? def.body, SAMPLE_VARS),
    }
  }

  /** Send the current wording of one event, filled with sample data, to one user. */
  async sendTest(eventKey, userId) {
    const def = LIFECYCLE_EVENTS[eventKey]
    if (!def) throw new LifecycleRequestError('Unknown notification event.', 'NOT_FOUND')
    const tpl = await this._template(eventKey)
    const r = await this._send(userId, {
      title: `[Test] ${render(tpl.title, SAMPLE_VARS)}`,
      body: render(tpl.body, SAMPLE_VARS),
      type: 'lifecycle_test',
      imageUrl: tpl.imageUrl || undefined,
      link: tpl.linkType ? { type: tpl.linkType, params: tpl.linkParams } : null,
      data: { event: eventKey, target: tpl.recipient.toLowerCase(), test: 'true' },
    })
    return r?.push || {}
  }

  /* ── Audit log ──────────────────────────────────────────────────────── */

  async listLog({ page = 1, limit = 25, event, status, order } = {}) {
    const where = []; const params = []
    if (event) { params.push(event); where.push(`ne.event_key = $${params.length}`) }
    if (status) { params.push(status); where.push(`ne.status = $${params.length}`) }
    if (order) { params.push(`%${order}%`); where.push(`o.order_number ILIKE $${params.length}`) }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows } = await this.query(
      `SELECT ne.id, ne.event_key, ne.recipient_type, ne.status, ne.skip_reason, ne.title, ne.body,
              ne.devices_total, ne.devices_sent, ne.devices_failed, ne.error_summary, ne.attempts,
              ne.created_at, ne.sent_at, o.id AS order_id, o.order_number,
              u.name AS recipient_name, u.phone AS recipient_phone,
              (SELECT string_agg(DISTINCT d.app_type, ',') FROM notification_deliveries d
                WHERE d.notification_id = ne.notification_id) AS apps,
              (SELECT COUNT(*)::int FROM notification_deliveries d
                WHERE d.notification_id = ne.notification_id AND d.opened_at IS NOT NULL) AS opened
         FROM notification_events ne
         LEFT JOIN orders o ON o.id = ne.order_id
         LEFT JOIN users u ON u.id = ne.recipient_user_id
         ${w}
         ORDER BY ne.created_at DESC
         LIMIT ${Number(limit)} OFFSET ${(Number(page) - 1) * Number(limit)}`,
      params
    )
    const { rows: [c] } = await this.query(
      `SELECT COUNT(*)::int AS total FROM notification_events ne LEFT JOIN orders o ON o.id = ne.order_id ${w}`, params
    )
    return {
      events: rows.map((r) => ({
        ...r,
        label: LIFECYCLE_EVENTS[r.event_key]?.label || r.event_key,
        opened: r.opened || 0,
      })),
      total: c.total,
    }
  }

  /* ── OTP hygiene ────────────────────────────────────────────────────── */

  /**
   * The OTP has been used: blank it in the customer's notification inbox so a
   * spent code (and the previous codes for that order) no longer sits there.
   */
  async redactOtpNotifications(orderId, purpose) {
    const event = purpose === 'DELIVERY' ? 'DELIVERY_OTP' : 'PICKUP_OTP'
    const label = purpose === 'DELIVERY' ? 'Delivery' : 'Pickup'
    try {
      await this.query(
        `UPDATE notifications
            SET title = $3, body = 'This code has been used and is no longer valid.'
          WHERE data->>'orderId' = $1 AND data->>'event' = $2`,
        [orderId, event, `${label} OTP (used)`]
      )
    } catch (err) {
      logger.warn({ err: err.message, orderId }, 'Could not redact used OTP notifications')
    }
  }
}

let shared
/** The process-wide instance used by the triggers. */
export function lifecycleNotifications() {
  return (shared ??= new LifecycleNotificationService())
}
