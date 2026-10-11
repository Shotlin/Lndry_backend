# POS counter: delivery flags + Home tiles (migration 153)

Used by the Vendor App's POS mode (Book Order toggles and POS Home). Epic desktop / website are unaffected: both new
fields are optional and default to the old behaviour.

## Counter order fields — `store_orders.delivery_mode`, `store_orders.is_express`

| Field | Values | Default |
|---|---|---|
| `deliveryMode` | `WALK_IN` (customer collects at the counter) · `HOME_DELIVERY` (shop delivers) · `PICKUP` (shop picks up from the customer) | `WALK_IN` |
| `isExpress` | `true` / `false` (a real boolean — strings are rejected) | `false` |

* `POST /api/v1/vendor/counter/orders` and `PATCH /api/v1/vendor/counter/orders/:id` accept both. On PATCH an absent field is left unchanged.
  `deliveryMode` is case-insensitive (`home_delivery` works); anything else → `400 VALIDATION_ERROR`.
* Every order object (`GET /orders`, `/orders/:id`, booking response) now carries `deliveryMode` and `isExpress`.
* `GET /orders?deliveryMode=HOME_DELIVERY` and `GET /orders?express=true` filter the list.
* `isExpress` is a flag only. It does **not** add a charge: an express surcharge stays a normal charge rule (`chargeRuleIds`) the
  operator picks, exactly as in Epic. Nothing is invented server-side.
* Existing rows: `WALK_IN` / `false`. The migration is idempotent and adds a partial index for open orders.

## `GET /api/v1/vendor/pos/dashboard` → `data.home`

All integers (paise for `*Paise`). **Never null**: an empty vendor gets zeros. Vendor-scoped. All order counts use the same set as the
Orders list (counter orders, excluding the `DESKTOP_PUSH` mirror rows), so a tile and the list behind it always agree.
"Active" = status not `DELIVERED` / `CANCELLED`. "Today" = the server date (UTC) — the same day boundary the existing `counterSalesToday` uses.

| Field | Meaning |
|---|---|
| `todayRevenuePaise` | Sum of `total_paise` of orders placed today, excluding cancelled |
| `todayCollectionPaise` | Payments recorded today on those orders (cash, UPI, card, bank, wallet) |
| `collectionDuePaise` | Sum of unpaid balance on all non-cancelled orders |
| `bookingsToday` | Orders placed today, excluding cancelled |
| `deliveriesToday` | Active orders whose expected delivery date is today |
| `deliveredToday` | Orders that moved to `DELIVERED` today (from the status history) |
| `pendingOrders` | Active orders |
| `upcomingDeliveries` | Active orders due today or earlier (as Epic's "delivery-due") |
| `unassignedPickups` | `deliveryMode=PICKUP`, status `BOOKED`, no pickup captain |
| `unassignedDeliveries` | `deliveryMode=HOME_DELIVERY`, status `READY`/`OUT_FOR_DELIVERY`, no delivery captain (walk-in orders never need one) |
| `expressOrders` | Active orders with `isExpress` |
| `onlineOrderRequests` | LNDRY marketplace orders in `WAITING_VENDOR_CONFIRMATION` for this vendor (0 for a POS-only shop) |
| `washingToStore` | Garments in state `ASSEMBLY` (washing finished, waiting to be racked in the store) |

The older top-level fields (`counterSalesToday`, `cashShift`, …) are unchanged.
