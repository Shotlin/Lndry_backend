import { error } from '../../../utils/apiResponse.js'

/**
 * The canonical LNDRY lifecycle is enforced by the vendor-orders and rider
 * flows. Two historical admin route families still carry a shorter lifecycle
 * and can create orphaned orders or bypass pickup, OTP, payment, and rider
 * assignment rules. Until their writes are reimplemented over the canonical
 * state machine, fail closed rather than mutating an order into an
 * untraceable state.
 *
 * Read-only administration (list/detail/export/invoice/packing slip) stays
 * available. This is deliberately a 409: the caller is authenticated and
 * understood, but its requested action conflicts with the current
 * authoritative workflow.
 */
export const LEGACY_ADMIN_ORDER_WRITES_BLOCKED = 'ORDER_LIFECYCLE_CONVERGENCE_REQUIRED'

export async function blockLegacyAdminOrderMutation(_request, reply) {
  return reply.code(409).send(error(
    'Legacy admin order mutations are unavailable while they are converged with the vendor and rider lifecycle. Use the canonical vendor/rider workflow.',
    LEGACY_ADMIN_ORDER_WRITES_BLOCKED,
  ))
}
