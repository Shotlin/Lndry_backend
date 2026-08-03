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
 *      just the kg-priced one.
 *   2. When `confirmed_lines` was supplied, the old subtotal was summed only
 *      over the lines explicitly mentioned — any other line on the order
 *      silently dropped out of the total. This version always recomputes
 *      the full subtotal over every line on the order.
 *   3. kg-priced lines are now whole-number quantities, exactly like
 *      piece-priced lines — no separate fractional-weight code path. A
 *      rider/vendor corrects a kg line the same way as a piece line: pick
 *      a new whole count via +/-, e.g. "Wash & Steam Iron: 1 kg → 2 kg".
 *      This also means `confirmed_quantity`/`quantity` never need the old
 *      sentinel-value=1 workaround — every line always stores its real
 *      confirmed count.
 *
 * Reclassification (vendor-only — the rider never reclassifies, only
 * corrects quantity): `reclassifications` lets a line's service change
 * entirely (e.g. a customer picked "Wash & Fold" per-kg for a garment the
 * vendor determines is actually a delicate dry-clean item priced
 * per-piece). The caller resolves the new rate/unit/name against this
 * vendor's own `vendor_service_rates` *before* calling this function —
 * kept here as a plain data lookup so this function stays a pure sync
 * calculation with no DB access.
 */

/**
 * @param {object} params
 * @param {object} params.orderRow - { fee_breakdown, estimated_amount_paise, payable_amount_paise }
 * @param {Array}  params.lines - order_lines rows: { id, garment_type_id, name, unit, rate_paise, estimated_quantity, confirmed_quantity }
 * @param {Array}  [params.confirmedLines] - [{ order_line_id, confirmed_quantity }] — confirmed_quantity is a whole
 *   number for every line regardless of unit (kg lines count whole kilograms, piece lines count items).
 * @param {Map<string, {garmentTypeId: string, name: string, unit: string, ratePaise: number}>} [params.reclassifications] - keyed by order_line_id
 * @returns {{
 *   previousSubtotalPaise: number, proposedSubtotalPaise: number,
 *   previousPayableAmountPaise: number, proposedPayableAmountPaise: number,
 *   newFeeBreakdown: object, lineChanges: Array
 * }}
 */
export function computeRecalculatedTotals({ orderRow, lines, confirmedLines, reclassifications }) {
  if ((!confirmedLines || confirmedLines.length === 0) && (!reclassifications || reclassifications.size === 0)) {
    throw { statusCode: 400, message: 'Either confirmed_lines or a reclassification is required', code: 'INVALID_INPUT' }
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

  const lineChanges = []
  let proposedSubtotalPaise = 0

  for (const line of lines) {
    const previousQuantity = line.confirmed_quantity ?? line.estimated_quantity ?? 0
    const previousTotalPaise = Math.round((line.rate_paise || 0) * previousQuantity)
    const proposedQuantity = confirmedByLineId.has(line.id)
      ? confirmedByLineId.get(line.id)
      : previousQuantity

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
        is_reclassified: isReclassified,
      })
    }
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
    newFeeBreakdown,
    lineChanges,
  }
}

/**
 * Writes a `computeRecalculatedTotals` result to `order_lines`/`orders`.
 * Every changed line stores its real confirmed count in both
 * `confirmed_quantity` and `quantity` — kg lines included, since weight is
 * now always a whole number just like a piece count.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} orderId
 * @param {ReturnType<typeof computeRecalculatedTotals>} computed
 */
export async function applyRecalculatedTotals(client, orderId, computed) {
  for (const change of computed.lineChanges) {
    // The paise value is passed twice (once plain, once for the ::numeric
    // cast) rather than reused by placeholder number — reusing one $N in
    // both a plain-integer context and an explicit ::numeric cast leaves
    // Postgres unable to settle on a single type for it, throwing 42P08
    // "indeterminate_datatype".
    await client.query(
      `UPDATE order_lines
       SET confirmed_quantity = $1, quantity = $1, total_paise = $2, total = ($3::numeric / 100)
       WHERE id = $4`,
      [change.proposed_quantity, change.proposed_total_paise, change.proposed_total_paise, change.order_line_id]
    )
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
