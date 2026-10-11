/**
 * The definition of every POS Home tile, written ONCE as a SQL condition over `store_orders`.
 * The dashboard counts with it (FILTER clauses) and `GET /vendor/counter/orders?tile=…` lists with it, so
 * tapping a tile can never show a different number of orders than the tile said.
 *
 * `a` is the table alias (`store_orders` in the dashboard, `so` in the list); `d` is the SQL for "today"
 * (a date parameter, the server's date).
 */
const OPEN = (a) => `${a}.status NOT IN ('DELIVERED','CANCELLED')`

export const HOME_TILE_CONDITIONS = {
  bookingsToday: (a, d) => `${a}.placed_at::date = ${d} AND ${a}.status <> 'CANCELLED'`,
  deliveriesToday: (a, d) => `${OPEN(a)} AND ${a}.expected_delivery_date = ${d}`,
  upcomingDeliveries: (a, d) => `${OPEN(a)} AND ${a}.expected_delivery_date <= ${d}`,
  deliveredToday: (a, d) => `${a}.status = 'DELIVERED' AND EXISTS (
    SELECT 1 FROM store_order_status_events e
    WHERE e.store_order_id = ${a}.id AND e.to_status = 'DELIVERED' AND e.created_at::date = ${d})`,
  pendingOrders: (a) => OPEN(a),
  unassignedPickups: (a) => `${a}.delivery_mode = 'PICKUP' AND ${a}.status = 'BOOKED' AND ${a}.pickup_rider_employee_id IS NULL`,
  unassignedDeliveries: (a) => `${a}.delivery_mode = 'HOME_DELIVERY' AND ${a}.status IN ('READY','OUT_FOR_DELIVERY') AND ${a}.delivery_rider_employee_id IS NULL`,
  expressOrders: (a) => `${a}.is_express AND ${OPEN(a)}`,
  collectionDue: (a) => `${a}.status <> 'CANCELLED' AND ${a}.total_paise > ${a}.amount_paid_paise`,
}

export const HOME_TILE_KEYS = Object.keys(HOME_TILE_CONDITIONS)

/** The server's "today" (UTC date) — the same one the dashboard reports as `asOf`. */
export const serverToday = () => new Date().toISOString().slice(0, 10)
