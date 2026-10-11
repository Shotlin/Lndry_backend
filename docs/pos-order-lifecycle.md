# POS counter: order list filters + vendor invoice PDFs (Phase 3)

Used by the Vendor App's POS **Orders** and **Order detail** screens. Everything is additive: Epic desktop / website
send none of the new parameters and get exactly the old answers.

## `GET /api/v1/vendor/counter/orders` — new query parameters

| Param | Meaning |
|---|---|
| `status` | One status **or a comma list** — `BOOKED,PICKED_UP` is the app's *Booked* tab. Case-insensitive; empty items are ignored. |
| `offset` | Skip this many orders (with `limit`, max 500) to page through a long list. Negative / non-numeric = 0. |
| `paymentDue=true` | Only orders that still owe money (`total > paid`). A cancelled order owes nothing, so it never matches. |

| `tile` | Exactly the orders a POS Home tile counts: `bookingsToday`, `deliveriesToday`, `upcomingDeliveries`, `deliveredToday`, `pendingOrders`, `unassignedPickups`, `unassignedDeliveries`, `expressOrders`, `collectionDue`. The definitions live once in `vendor-pos-dashboard/home-tile-filters.js` and the dashboard counts with the same ones, so a tile and the list behind it cannot disagree (tested). An unknown tile is `400`. |

Order is `placed_at DESC, id DESC` (stable across pages). The answer is still a plain array; a page shorter than `limit` is the last one.
Existing filters (`search`, `from`, `to`, `deliveryMode`, `express`, `customerId`) are unchanged and combine with the new ones.

## `GET /api/v1/vendor/counter/orders/:id/invoice` — the order's PDF

Bearer-authenticated vendor route, rate-limited to 60/min. Another shop's order (or a pickup-delivery order) is `404`.

| Query | Result |
|---|---|
| `format=full` (default) | The **issued A4 invoice** — the same stored file the customer gets, issued once. Only a `DELIVERED` order has one; before that `409 INVOICE_NOT_AVAILABLE` ("The invoice is created when the order is delivered. Use the mini bill until then."). |
| `format=mini&paper=80` or `paper=58` | A narrow counter **bill** for 58 / 80 mm thermal paper, built from the same invoice data (so numbers always agree with the A4 invoice). Available at every stage **except `CANCELLED`** (`409`). Before delivery it is headed `BILL`; once an invoice exists it is headed with its number. Any other paper value falls back to 80. Nothing is stored. |

Both answer `application/pdf`, `Cache-Control: private, no-store`. The mini template is `src/modules/invoices/templates/mini-v1.js`
(drawn once to measure and once for real, so the page is exactly as tall as the bill). No totals are computed in it.

## Not changed (and why)

* **Wallet at Pay Now:** `POST /orders/:id/payments` still rejects `WALLET`. The existing OTP-confirmed redemption
  (`/vendor/wallet/redemption-requests`) is only wired into *booking*; paying an already-booked order from the wallet would be new
  money logic, which this phase does not add.
* `READY` still needs `allowIncomplete: true` and `DELIVERED` with a balance needs `allowUnpaid: true` (see PHASE-3.md).

## Tests

`tests/integration/counter-order-lifecycle.test.js` (real Postgres, mutation-checked; includes the tile-equals-list parity test) and
`node scripts/pos-smoke.mjs --lifecycle` (58 checks against the running API, end to end).
