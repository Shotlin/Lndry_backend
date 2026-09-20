/**
 * A captain belongs to exactly one vendor, so a login must never dead-end on
 * "select a shop" because of captain records. With more than one active
 * record, that answer makes the Partner app end on "Unauthorized — invalid
 * or expired token" (it cannot show a shop picker).
 *   • other roles alongside a captain record → the captain record is ignored
 *     (an owner/staff account is the person's real identity);
 *   • only captain records (legacy duplicates from before one-vendor-per-
 *     captain was enforced) → the earliest, i.e. the vendor they were first
 *     registered with.
 * Anyone without a captain record keeps the existing behaviour (one shop →
 * that shop; several → the selection flow).
 */
export function resolveShopAssignments(assignments) {
  const captains = assignments.filter((a) => a.role === 'VENDOR_RIDER')
  if (captains.length === 0) return assignments
  const others = assignments.filter((a) => a.role !== 'VENDOR_RIDER')
  if (others.length > 0) return others
  const earliest = [...captains].sort(
    (a, b) => new Date(a.assigned_at || 0) - new Date(b.assigned_at || 0)
  )[0]
  return [earliest]
}
