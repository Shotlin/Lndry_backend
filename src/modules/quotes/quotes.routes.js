import { v4 as uuidv4 } from 'uuid'
import { redis } from '../../config/redis.js'
import { query } from '../../config/database.js'
import { success, error } from '../../utils/apiResponse.js'

/**
 * Checks if a vendor is eligible for a customer based on visibility rules and proximity radius.
 * Returns { eligible: boolean, message: string }
 */
async function checkVendorEligibility(customerId, vendorId) {
  // 1. Fetch vendor visibility flags and radius
  const eligibilityRes = await query(
    `SELECT v.id, v.lat, v.lng, v.approved_service_radius_km, v.vendor_approved, v.account_enabled, v.marketplace_published
     FROM vendors v
     WHERE v.id = $1 AND v.deleted_at IS NULL`,
    [vendorId]
  )

  if (eligibilityRes.rows.length === 0) {
    return { eligible: false, message: 'Vendor not found', code: 'VENDOR_NOT_FOUND' }
  }

  const v = eligibilityRes.rows[0]
  if (!v.vendor_approved || !v.account_enabled || !v.marketplace_published) {
    return { eligible: false, message: 'Vendor is not currently active on the marketplace', code: 'VENDOR_NOT_ELIGIBLE' }
  }

  // 2. Check if service is configured (has active services with rate configured)
  const serviceConfiguredRes = await query(
    `SELECT 1 
     FROM vendor_services vs 
     JOIN vendor_service_rates vsr ON vs.id = vsr.vendor_service_id 
     WHERE vs.vendor_id = $1 AND vsr.is_active = true AND vs.deleted_at IS NULL
     LIMIT 1`,
    [vendorId]
  )
  if (serviceConfiguredRes.rows.length === 0) {
    return { eligible: false, message: 'Vendor service rates are not configured yet', code: 'VENDOR_NOT_ELIGIBLE' }
  }

  // 3. Check if capacity is configured (has active slots)
  const capacityConfiguredRes = await query(
    `SELECT 1 
     FROM vendor_slots vs 
     WHERE vs.vendor_id = $1 AND vs.is_active = true
     LIMIT 1`,
    [vendorId]
  )
  if (capacityConfiguredRes.rows.length === 0) {
    return { eligible: false, message: 'Vendor pickup capacity is not configured yet', code: 'VENDOR_NOT_ELIGIBLE' }
  }

  // 4. Proximity check using customer default address
  const addrRes = await query(
    `SELECT lat, lng 
     FROM addresses 
     WHERE user_id = $1 AND is_default = true 
     LIMIT 1`,
    [customerId]
  )
  if (addrRes.rows.length > 0) {
    const addr = addrRes.rows[0]
    if (addr.lat && addr.lng && v.lat && v.lng) {
      const distanceRes = await query(
        `SELECT (6371 * acos(
           LEAST(1.0, GREATEST(-1.0,
             cos(radians($1::float8)) * cos(radians($3::float8))
               * cos(radians($4::float8) - radians($2::float8))
               + sin(radians($1::float8)) * sin(radians($3::float8))
           ))
         ))::numeric(7,2) AS distance_km`,
        [addr.lat, addr.lng, v.lat, v.lng]
      )
      const dist = Number(distanceRes.rows[0]?.distance_km || 0)
      if (dist > Number(v.approved_service_radius_km)) {
        return { eligible: false, message: 'Vendor does not deliver to your location', code: 'VENDOR_OUT_OF_RADIUS' }
      }
    }
  }

  return { eligible: true }
}

export default async function quotesRoutes(fastify) {
  // POST /api/v1/quotes -> Generate quote
  fastify.post('/', {
    preHandler: [fastify.authenticate, fastify.authorize(['CUSTOMER'])],
    schema: {
      tags: ['Quotes'],
      summary: 'Create laundry quotation',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['vendor_id', 'service_id'],
        properties: {
          vendor_id: { type: 'string', format: 'uuid' },
          service_id: { type: 'string', format: 'uuid' }, // vendor_service_id
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
    const { vendor_id, service_id, garment_lines, estimated_weight_kg } = request.body
    const customerId = request.user.id

    // 1. Verify eligibility (approved, enabled, published, configurations, proximity)
    const eligibility = await checkVendorEligibility(customerId, vendor_id)
    if (!eligibility.eligible) {
      return reply.code(400).send(error(eligibility.message, eligibility.code))
    }

    let estimate_paise = 0
    const snapshot_lines = []

    // 2. Pricing calculation (Category -> Vendor Service -> Garment Type -> Vendor Service Rate)
    if (garment_lines && garment_lines.length > 0) {
      for (const line of garment_lines) {
        const rateRes = await query(
          `SELECT vsr.rate_paise, gt.name, gt.unit
             FROM vendor_service_rates vsr
             JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
             JOIN garment_types gt ON vsr.garment_type_id = gt.id
            WHERE vs.id = $1
              AND vs.vendor_id = $2
              AND vsr.garment_type_id = $3
              AND vsr.is_active = true
              AND vs.deleted_at IS NULL`,
          [service_id, vendor_id, line.garment_type_id]
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
      // Find weight rate ('kg' unit) under the selected service
      const rateRes = await query(
        `SELECT vsr.rate_paise, gt.id, gt.name, gt.unit
           FROM vendor_service_rates vsr
           JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
           JOIN garment_types gt ON vsr.garment_type_id = gt.id
          WHERE vs.id = $1
            AND vs.vendor_id = $2
            AND gt.unit = 'kg'
            AND vsr.is_active = true
            AND vs.deleted_at IS NULL
          LIMIT 1`,
        [service_id, vendor_id]
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
      [customerId, vendor_id, service_id, estimated_weight_kg || null, estimate_paise, JSON.stringify(snapshot_lines), expiry]
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

    let estimate_paise = 0
    const snapshot_lines = []

    // 2. Pricing recalculation (Category -> Vendor Service -> Garment Type -> Vendor Service Rate)
    if (garment_lines && garment_lines.length > 0) {
      for (const line of garment_lines) {
        const rateRes = await query(
          `SELECT vsr.rate_paise, gt.name, gt.unit
             FROM vendor_service_rates vsr
             JOIN vendor_services vs ON vsr.vendor_service_id = vs.id
             JOIN garment_types gt ON vsr.garment_type_id = gt.id
            WHERE vs.id = $1
              AND vs.vendor_id = $2
              AND vsr.garment_type_id = $3
              AND vsr.is_active = true
              AND vs.deleted_at IS NULL`,
          [dbQuote.service_id, dbQuote.vendor_id, line.garment_type_id]
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
          WHERE vs.id = $1
            AND vs.vendor_id = $2
            AND gt.unit = 'kg'
            AND vsr.is_active = true
            AND vs.deleted_at IS NULL
          LIMIT 1`,
        [dbQuote.service_id, dbQuote.vendor_id]
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
