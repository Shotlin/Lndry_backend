/**
 * Shared order-line recalculation math, used by the rider's immediate
 * doorstep weigh-in (applies instantly, no customer approval) and the
 * vendor's authoritative reconciliation (staged, requires customer accept).
 *
 * Extracted from the pre-existing (and, until this change, non-functional)
 * `reconcileReceipt` in vendor-orders.service.js. Real bugs fixed along
 * the way:
 *   1. The old weight-adjustment target line was picked via
 *      `.find(l => l.rate_paise > 0)` — nearly every line matches that, not
 *      just the continuous-unit one. This version filters on
 *      `CONTINUOUS_UNITS` (kg, sqft).
 *   2. When `confirmed_lines` was supplied, the old subtotal was summed only
 *      over the lines explicitly mentioned — any other line on the order
 *      silently dropped out of the total. This version always recomputes
 *      the full subtotal over every line on the order, applying corrections
 *      where supplied and falling back to the existing confirmed/estimated
 *      quantity otherwise — which is also what makes it safe to supply a
 *      weight/area correction and line corrections in the same call.
 *   3. Continuous-unit lines (kg, sqft) take an exact decimal correction
 *      (e.g. 1.2 kg) priced as `rate_paise * decimal_quantity` — not rounded
 *      to a whole unit. Piece-priced lines stay whole-number counts,
 *      corrected via +/- like normal item quantities.
 *
 * Reclassification (vendor-only — the rider never reclassifies, only
 * corrects quantity/weight): `reclassifications` lets a line's service
 * change entirely (e.g. a customer picked "Wash & Fold" per-kg for a
 * garment the vendor determines is actually a delicate dry-clean item
 * priced per-piece). The caller resolves the new rate/unit/name against
 * this vendor's own `vendor_service_rates` *before* calling this function —
 * kept here as a plain data lookup so this function stays a pure sync
 * calculation with no DB access.
 *
 * New lines (vendor-only, same reasoning as reclassification): `newLines`
 * adds a service to the order that wasn't there at checkout — either a
 * wholly new addition, or the destination for a *partial* quantity moved
 * out of an existing continuous-unit line (the vendor reduces that line's
 * kg/sqft via `confirmedWeightKg` and adds the moved garments here under
 * whatever service/quantity they actually belong to — reclassification only
 * ever converts 100% of a line, this is what covers "some of it moves").
 * Each entry needs no `order_line_id` (it doesn't exist yet) — it's staged
 * in `order_reconciliations.line_changes` with `order_line_id: null` and
 * only actually INSERTed into `order_lines` once the customer accepts.
 */

// Units priced by a continuous measurement rather than a discrete count —
// corrected via an exact decimal (kg or sq ft), never a rounded whole
// number. Anything else (e.g. 'piece'/'item') is a discrete count.
const CONTINUOUS_UNITS = new Set(['kg', 'sqft'])

/**
 * @param {object} params
 * @param {object} params.orderRow - { fee_breakdown, estimated_amount_paise, payable_amount_paise }
 * @param {Array}  params.lines - order_lines rows: { id, garment_type_id, name, unit, rate_paise, estimated_quantity, confirmed_quantity }
 * @param {Array}  [params.confirmedLines] - [{ order_line_id, confirmed_quantity }] — whole-number counts, piece lines only.
 * @param {number} [params.confirmedWeightKg] - exact decimal measurement (kg or sq ft) for this order's continuous-unit line.
 * @param {Map<string, {garmentTypeId: string, name: string, unit: string, ratePaise: number}>} [params.reclassifications] - keyed by order_line_id
 * @param {Array<{garmentTypeId: string, name: string, unit: string, ratePaise: number, quantity: number}>} [params.newLines] - brand-new services to add
 * @returns {{
 *   previousSubtotalPaise: number, proposedSubtotalPaise: number,
 *   previousPayableAmountPaise: number, proposedPayableAmountPaise: number,
 *   previousWeightKg: number|null, proposedWeightKg: number|null,
 *   newFeeBreakdown: object, lineChanges: Array
 * }}
 */
export function computeRecalculatedTotals({ orderRow, lines, confirmedLines, confirmedWeightKg, reclassifications, newLines }) {
  const hasNewLines = Array.isArray(newLines) && newLines.length > 0
  if ((!confirmedLines || confirmedLines.length === 0) && confirmedWeightKg == null && (!reclassifications || reclassifications.size === 0) && !hasNewLines) {
    throw { statusCode: 400, message: 'Either confirmed_lines, confirmed_weight_kg, a reclassification, or a new line is required', code: 'INVALID_INPUT' }
  }

  const feeBreakdown = typeof orderRow.fee_breakdown === 'string'
    ? JSON.parse(orderRow.fee_breakdown)
    : (orderRow.fee_breakdown || {})
  const previousSubtotalPaise = feeBreakdown.subtotal_paise ?? orderRow.estimated_amount_paise ?? 0
  const previousPayableAmountPaise = orderRow.payable_amount_paise ?? 0

  // A reclassify-only line entry may omit confirmed_quantity entirely (the
  // vendor is only changing the service, not the count) — only map entries
  // that actually specify a quantity, so `.has()` below doesn't report a
  // change for a line whose quantity was never touched.
  const confirmedByLineId = new Map(
    (confirmedLines || [])
      .filter(c => typeof c.confirmed_quantity === 'number')
      .map(c => [c.order_line_id, c.confirmed_quantity])
  )

  // A weight/area correction targets exactly one continuous-unit line — the
  // one with the largest existing value (estimated_quantity * rate_paise),
  // so a multi-continuous-unit-service order picks its dominant line rather
  // than an arbitrary match.
  let weightTargetLineId = null
  let previousWeightKg = null
  let proposedWeightKg = null
  if (confirmedWeightKg != null) {
    const continuousLines = lines.filter(l => CONTINUOUS_UNITS.has((l.unit || '').toLowerCase()))
    if (continuousLines.length > 0) {
      const target = continuousLines.reduce((best, l) => {
        const value = (l.estimated_quantity || 0) * (l.rate_paise || 0)
        const bestValue = (best.estimated_quantity || 0) * (best.rate_paise || 0)
        return value > bestValue ? l : best
      }, continuousLines[0])
      weightTargetLineId = target.id
      previousWeightKg = target.confirmed_quantity ?? target.estimated_quantity ?? null
      proposedWeightKg = confirmedWeightKg
    }
  }

  const lineChanges = []
  let proposedSubtotalPaise = 0

  for (const line of lines) {
    const previousQuantity = line.confirmed_quantity ?? line.estimated_quantity ?? 0
    const previousTotalPaise = Math.round((line.rate_paise || 0) * previousQuantity)
    const isWeightAdjustment = line.id === weightTargetLineId
    let proposedQuantity = previousQuantity

    if (confirmedByLineId.has(line.id)) {
      proposedQuantity = confirmedByLineId.get(line.id)
    } else if (isWeightAdjustment) {
      proposedQuantity = confirmedWeightKg
    }

    const reclass = reclassifications?.get(line.id)
    const isReclassified = !!reclass
    const proposedGarmentTypeId = reclass?.garmentTypeId ?? line.garment_type_id
    const proposedName = reclass?.name ?? line.name
    const proposedUnit = reclass?.unit ?? line.unit
    const proposedRatePaise = reclass?.ratePaise ?? line.rate_paise ?? 0

    const proposedTotalPaise = Math.round(proposedRatePaise * proposedQuantity)
    proposedSubtotalPaise += proposedTotalPaise

    if (proposedQuantity !== previousQuantity || isReclassified) {
      lineChanges.push({
        order_line_id: line.id,
        previous_garment_type_id: line.garment_type_id,
        proposed_garment_type_id: proposedGarmentTypeId,
        previous_name: line.name,
        proposed_name: proposedName,
        previous_unit: line.unit,
        proposed_unit: proposedUnit,
        previous_rate_paise: line.rate_paise ?? 0,
        proposed_rate_paise: proposedRatePaise,
        previous_quantity: previousQuantity,
        proposed_quantity: proposedQuantity,
        previous_total_paise: previousTotalPaise,
        proposed_total_paise: proposedTotalPaise,
        is_weight_adjustment: isWeightAdjustment,
        is_reclassified: isReclassified,
        is_new: false,
      })
    }
  }

  for (const newLine of (newLines || [])) {
    const proposedTotalPaise = Math.round((newLine.ratePaise || 0) * newLine.quantity)
    proposedSubtotalPaise += proposedTotalPaise
    lineChanges.push({
      order_line_id: null,
      previous_garment_type_id: null,
      proposed_garment_type_id: newLine.garmentTypeId,
      previous_name: null,
      proposed_name: newLine.name,
      previous_unit: null,
      proposed_unit: newLine.unit,
      previous_rate_paise: 0,
      proposed_rate_paise: newLine.ratePaise || 0,
      previous_quantity: 0,
      proposed_quantity: newLine.quantity,
      previous_total_paise: 0,
      proposed_total_paise: proposedTotalPaise,
      // A new line can itself be continuous-unit (e.g. moved to a different
      // kg-priced service) — same INTEGER-column sentinel treatment as an
      // existing line's weight adjustment applies on insert.
      is_weight_adjustment: CONTINUOUS_UNITS.has((newLine.unit || '').toLowerCase()),
      is_reclassified: false,
      is_new: true,
    })
  }

  const deliveryFeePaise = feeBreakdown.delivery_fee_paise ?? 2900
  const platformFeePaise = feeBreakdown.platform_fee_paise ?? 500
  const proposedPayableAmountPaise = proposedSubtotalPaise + deliveryFeePaise + platformFeePaise

  const newFeeBreakdown = {
    ...feeBreakdown,
    subtotal_paise: proposedSubtotalPaise,
    original_subtotal_paise: previousSubtotalPaise,
  }

  return {
    previousSubtotalPaise,
    proposedSubtotalPaise,
    previousPayableAmountPaise,
    proposedPayableAmountPaise,
    previousWeightKg,
    proposedWeightKg,
    newFeeBreakdown,
    lineChanges,
  }
}

/**
 * Writes a `computeRecalculatedTotals` result to `order_lines`/`orders`.
 * `confirmed_quantity`/`quantity` are INTEGER columns, so a weight/area
 * -adjusted line (fractional kg or sq ft) can't store the real measurement
 * there — it's recorded as the sentinel `confirmed_quantity=1`, `quantity`
 * left untouched, with `total_paise` carrying the real computed money value
 * (`rate_paise * decimal_quantity`, exact — never rounded to a whole unit).
 * The actual fractional measurement lives in
 * `order_reconciliations.proposed_weight_kg`, and the exact amount lets
 * both apps derive the true decimal quantity for display
 * (`total_paise / rate_paise`) without needing it in `order_lines` at all.
 * A piece-adjusted line stores its real integer count in both columns.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} orderId
 * @param {ReturnType<typeof computeRecalculatedTotals>} computed
 */
export async function applyRecalculatedTotals(client, orderId, computed) {
  for (const change of computed.lineChanges) {
    if (change.is_new) {
      // Continuous-unit (kg/sqft) new lines hit the same INTEGER-column
      // problem as an existing line's weight adjustment — quantity columns
      // get the sentinel `1`, with the real decimal value only recoverable
      // via total_paise/rate_paise (same convention as order_reconciliations
      // .proposed_weight_kg for existing lines).
      // Each of rate_paise/total_paise is passed twice (once plain, once
      // cast to numeric) rather than reused by placeholder number — same
      // 42P08 "indeterminate_datatype" trap as the weight-adjustment branch
      // below, just easier to miss inside a longer column list.
      const storedQuantity = change.is_weight_adjustment ? 1 : change.proposed_quantity
      await client.query(
        `INSERT INTO order_lines (
           order_id, garment_type_id, name, unit, rate_paise,
           estimated_quantity, confirmed_quantity, quantity, price, total_paise, total
         ) VALUES ($1, $2, $3, $4, $5, $6, $6, $6, ($7::numeric / 100), $8, ($9::numeric / 100))`,
        [
          orderId, change.proposed_garment_type_id, change.proposed_name, change.proposed_unit,
          change.proposed_rate_paise, storedQuantity, change.proposed_rate_paise,
          change.proposed_total_paise, change.proposed_total_paise,
        ]
      )
    } else if (change.is_weight_adjustment) {
      // $1 is passed twice (once plain, once cast to numeric) rather than
      // reused by placeholder number — reusing $1 in both a plain-integer
      // context and an explicit ::numeric cast leaves Postgres unable to
      // settle on one type for it, throwing 42P08 "indeterminate_datatype".
      await client.query(
        `UPDATE order_lines
         SET confirmed_quantity = 1, total_paise = $1, total = ($2::numeric / 100)
         WHERE id = $3`,
        [change.proposed_total_paise, change.proposed_total_paise, change.order_line_id]
      )
    } else {
      await client.query(
        `UPDATE order_lines
         SET confirmed_quantity = $1, quantity = $1, total_paise = $2, total = ($3::numeric / 100)
         WHERE id = $4`,
        [change.proposed_quantity, change.proposed_total_paise, change.proposed_total_paise, change.order_line_id]
      )
    }
  }

  await client.query(
    `UPDATE orders
     SET estimated_amount_paise = $1, payable_amount_paise = $2,
         subtotal = ($3::numeric / 100), total_amount = ($4::numeric / 100),
         fee_breakdown = $5, updated_at = NOW()
     WHERE id = $6`,
    [
      computed.proposedSubtotalPaise, computed.proposedPayableAmountPaise,
      computed.proposedSubtotalPaise, computed.proposedPayableAmountPaise,
      JSON.stringify(computed.newFeeBreakdown), orderId,
    ]
  )
}
