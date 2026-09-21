import { v4 as uuidv4 } from 'uuid'
import { redis } from '../../config/redis.js'
import { query } from '../../config/database.js'
import { success, error } from '../../utils/apiResponse.js'
import { checkVendorEligibility } from './vendor-eligibility.js'
import { AssistedBookingService } from '../admin/assisted-booking/assisted-booking.service.js'

export default async function quotesRoutes(fastify) {
  const assistedBooking = new AssistedBookingService()

  // POST /api/v1/quotes -> Generate quote
  fastify.post('/', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Quotes'],
      summary: 'Create laundry quotation',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['vendor_id'],
        properties: {
          vendor_id: { type: 'string', format: 'uuid' },
          // Informational only — no longer used to constrain rate lookup,
          // since a single order can span multiple of this vendor's
          // services (e.g. a per-kg wash line and a per-piece dry-clean
          // line in the same cart). Each garment_line resolves its own
          // rate against (vendor_id, garment_type_id) regardless of which
          // service it's rated under.
          service_id: { type: 'string', format: 'uuid' },
          garment_lines: {
            type: 'array',
            items: {
              type: 'object',
              required: ['garment_type_id', 'quantity'],
              properties: {
                garment_type_id: { type: 'string', format: 'uuid' },
                quantity: { type: 'integer', minimum: 1 }
              }
            }
          },
          estimated_weight_kg: { type: 'number', minimum: 0.1 },
          // 'ASSISTED' = "Book With Expert Check": no garments/services are
          // chosen here — the laundry inspects them and sets the price
          // through the normal re-evaluation flow.
          booking_type: { type: 'string', enum: ['STANDARD', 'ASSISTED'] }
        }
      }
    }
  }, async (request, reply) => {
    const { vendor_id, service_id, garment_lines, estimated_weight_kg, booking_type } = request.body
    const customerId = request.user.id

    // 1. Verify eligibility (approved, enabled, published, configurations, proximity)
    const eligibility = await checkVendorEligibility(customerId, vendor_id)
    if (!eligibility.eligible) {
      return reply.code(400).send(error(eligibility.message, eligibility.code))
    }

    // 1b. Assisted booking: nothing to price. Only vendors the admin has
    // enabled offer it (same rule the customer-facing config uses).
    if (booking_type === 'ASSISTED') {
      if (!(await assistedBooking.isAvailableForVendor(vendor_id))) {
        return reply.code(400).send(error('Book With Expert Check is not available for this laundry.', 'ASSISTED_BOOKING_UNAVAILABLE'))
      }
      const assistedExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString()
      const assistedRes = await query(
        `INSERT INTO quotes (
          customer_id, vendor_id, service_id, estimated_weight_kg, estimate_paise, pricing_snapshot, expires_at, booking_type
        ) VALUES ($1, $2, NULL, NULL, 0, '[]', $3, 'ASSISTED')
        RETURNING id`,
        [customerId, vendor_id, assistedExpiry]
      )
      const assistedQuoteId = assistedRes.rows[0].id
      await redis.setex(`quote:${assistedQuoteId}`, 600, JSON.stringify({
        quote_id: assistedQuoteId, vendor_id, garment_lines: [], estimate_paise: 0,
        booking_type: 'ASSISTED', expiry: assistedExpiry,
      }))
      return reply.code(201).send(success({
        quote_id: assistedQuoteId,
        estimate_paise: 0,
        expiry: assistedExpiry,
        booking_type: 'ASSISTED',
      }, 'Quotation generated successfully'))
    }

    let estimate_paise = 0
    const snapshot_lines = []

    // 2. Pricing calculation — each garment_line resolves its own rate
    // against (vendor_id, garment_type_id), so a single quote/order can
    // freely mix lines from different vendor_services (e.g. a per-kg wash
    // item alongside a per-piece dry-clean item for the same vendor).
    if (garment_lines && garment_lines.length > 0) {
      for (const line of garment_lines) {
        const rateRes = await query(
          `SELECT vsr.rate_paise, gt.name, gt.unit
             FROM vendor_service_rates vsr
             JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
             JOIN garment_types gt ON vsr.garment_type_id = gt.id
            WHERE vs.vendor_id = $1
              AND vsr.garment_type_id = $2
              AND vsr.is_active = true
              AND vs.deleted_at IS NULL
              AND vs.approval_status = 'APPROVED'
            LIMIT 1`,
          [vendor_id, line.garment_type_id]
        )

        if (rateRes.rows.length === 0) {
          return reply.code(400).send(error(`Service rate not configured for garment type ${line.garment_type_id}`, 'SERVICE_RATE_NOT_CONFIGURED'))
        }

        const rateRow = rateRes.rows[0]
        const rate_paise = rateRow.rate_paise
        const line_total = rate_paise * line.quantity
        estimate_paise += line_total

        snapshot_lines.push({
          garment_type_id: line.garment_type_id,
          name: rateRow.name,
          unit: rateRow.unit,
          quantity: line.quantity,
          rate_paise,
          total_paise: line_total
        })
      }
    } else if (estimated_weight_kg) {
      // Find weight rate ('kg' unit) — any of this vendor's active services.
      const rateRes = await query(
        `SELECT vsr.rate_paise, gt.id, gt.name, gt.unit
           FROM vendor_service_rates vsr
           JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
           JOIN garment_types gt ON vsr.garment_type_id = gt.id
          WHERE vs.vendor_id = $1
            AND gt.unit = 'kg'
            AND vsr.is_active = true
            AND vs.deleted_at IS NULL
            AND vs.approval_status = 'APPROVED'
          LIMIT 1`,
        [vendor_id]
      )

      if (rateRes.rows.length === 0) {
        return reply.code(400).send(error('Service rate not configured for weight-based orders', 'SERVICE_RATE_NOT_CONFIGURED'))
      }

      const rateRow = rateRes.rows[0]
      const rate_paise = rateRow.rate_paise
      const total = Math.round(rate_paise * estimated_weight_kg)
      estimate_paise = total

      snapshot_lines.push({
        garment_type_id: rateRow.id,
        name: rateRow.name,
        unit: rateRow.unit,
        quantity: 1,
        weight: estimated_weight_kg,
        rate_paise,
        total_paise: total
      })
    } else {
      return reply.code(400).send(error('Either garment_lines or estimated_weight_kg must be provided', 'INVALID_INPUT'))
    }

    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 mins

    // 3. Save quote in PostgreSQL
    const insertRes = await query(
      `INSERT INTO quotes (
        customer_id, vendor_id, service_id, estimated_weight_kg, estimate_paise, pricing_snapshot, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, expires_at`,
      [customerId, vendor_id, service_id || null, estimated_weight_kg || null, estimate_paise, JSON.stringify(snapshot_lines), expiry]
    )
    const quote_id = insertRes.rows[0].id

    const quote = {
      quote_id,
      vendor_id,
      service_id,
      garment_lines: snapshot_lines,
      estimated_weight_kg: estimated_weight_kg || null,
      estimate_paise,
      expiry
    }

    // 4. Save in Redis for checkout lifecycle cache
    await redis.setex(`quote:${quote_id}`, 600, JSON.stringify(quote))

    return reply.code(201).send(success({
      quote_id,
      estimate_paise,
      expiry
    }, 'Quotation generated successfully'))
  })

  // PATCH /api/v1/quotes/:quoteId -> Update quote
  fastify.patch('/:quoteId', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Quotes'],
      summary: 'Update quote garment quantities and recalculate price',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['quoteId'],
        properties: {
          quoteId: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        properties: {
          garment_lines: {
            type: 'array',
            items: {
              type: 'object',
              required: ['garment_type_id', 'quantity'],
              properties: {
                garment_type_id: { type: 'string', format: 'uuid' },
                quantity: { type: 'integer', minimum: 1 }
              }
            }
          },
          estimated_weight_kg: { type: 'number', minimum: 0.1 }
        }
      }
    }
  }, async (request, reply) => {
    const { quoteId } = request.params
    const { garment_lines, estimated_weight_kg } = request.body
    const customerId = request.user.id

    // 1. Fetch quote from Postgres and validate ownership
    const quoteRes = await query('SELECT * FROM quotes WHERE id = $1', [quoteId])
    if (quoteRes.rows.length === 0) {
      return reply.code(404).send(error('Quotation not found or expired', 'QUOTE_NOT_FOUND'))
    }
    const dbQuote = quoteRes.rows[0]
    if (dbQuote.customer_id !== customerId) {
      return reply.code(403).send(error('Forbidden - you do not own this quotation', 'FORBIDDEN'))
    }
    if (dbQuote.booking_type === 'ASSISTED') {
      return reply.code(400).send(error('An assisted booking has no items to update — the laundry sets the price after inspection.', 'ASSISTED_QUOTE_NOT_EDITABLE'))
    }

    let estimate_paise = 0
    const snapshot_lines = []

    // 2. Pricing recalculation — same per-line (vendor_id, garment_type_id)
    // resolution as POST /quotes, so a quote can be updated to span
    // multiple of this vendor's services too.
    if (garment_lines && garment_lines.length > 0) {
      for (const line of garment_lines) {
        const rateRes = await query(
          `SELECT vsr.rate_paise, gt.name, gt.unit
             FROM vendor_service_rates vsr
             JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
             JOIN garment_types gt ON vsr.garment_type_id = gt.id
            WHERE vs.vendor_id = $1
              AND vsr.garment_type_id = $2
              AND vsr.is_active = true
              AND vs.deleted_at IS NULL
              AND vs.approval_status = 'APPROVED'
            LIMIT 1`,
          [dbQuote.vendor_id, line.garment_type_id]
        )

        if (rateRes.rows.length === 0) {
          return reply.code(400).send(error(`Service rate not configured for garment type ${line.garment_type_id}`, 'SERVICE_RATE_NOT_CONFIGURED'))
        }

        const rateRow = rateRes.rows[0]
        const rate_paise = rateRow.rate_paise
        const line_total = rate_paise * line.quantity
        estimate_paise += line_total

        snapshot_lines.push({
          garment_type_id: line.garment_type_id,
          name: rateRow.name,
          unit: rateRow.unit,
          quantity: line.quantity,
          rate_paise,
          total_paise: line_total
        })
      }
    } else if (estimated_weight_kg) {
      const rateRes = await query(
        `SELECT vsr.rate_paise, gt.id, gt.name, gt.unit
           FROM vendor_service_rates vsr
           JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
           JOIN garment_types gt ON vsr.garment_type_id = gt.id
          WHERE vs.vendor_id = $1
            AND gt.unit = 'kg'
            AND vsr.is_active = true
            AND vs.deleted_at IS NULL
            AND vs.approval_status = 'APPROVED'
          LIMIT 1`,
        [dbQuote.vendor_id]
      )

      if (rateRes.rows.length === 0) {
        return reply.code(400).send(error('Service rate not configured for weight-based orders', 'SERVICE_RATE_NOT_CONFIGURED'))
      }

      const rateRow = rateRes.rows[0]
      const rate_paise = rateRow.rate_paise
      const total = Math.round(rate_paise * estimated_weight_kg)
      estimate_paise = total

      snapshot_lines.push({
        garment_type_id: rateRow.id,
        name: rateRow.name,
        unit: rateRow.unit,
        quantity: 1,
        weight: estimated_weight_kg,
        rate_paise,
        total_paise: total
      })
    } else {
      return reply.code(400).send(error('Either garment_lines or estimated_weight_kg must be provided', 'INVALID_INPUT'))
    }

    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString() // reset TTL

    // 3. Update PostgreSQL
    await query(
      `UPDATE quotes 
       SET estimate_paise = $1, pricing_snapshot = $2, estimated_weight_kg = $3, expires_at = $4
       WHERE id = $5`,
      [estimate_paise, JSON.stringify(snapshot_lines), estimated_weight_kg || null, expiry, quoteId]
    )

    const quote = {
      quote_id: quoteId,
      vendor_id: dbQuote.vendor_id,
      service_id: dbQuote.service_id,
      garment_lines: snapshot_lines,
      estimated_weight_kg: estimated_weight_kg || null,
      estimate_paise,
      expiry
    }

    // 4. Update Redis
    await redis.setex(`quote:${quoteId}`, 600, JSON.stringify(quote))

    return reply.code(200).send(success({
      quote_id: quoteId,
      estimate_paise,
      expiry
    }, 'Quotation updated and recalculated successfully'))
  })
}
