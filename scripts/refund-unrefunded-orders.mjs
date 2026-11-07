// One-off repair: advances still PAID on orders that were rejected / auto-rejected / cancelled (the bug fixed in
// branch fix/d1-d8-errors-reports). DRY RUN by default — it only lists. Add --apply to actually refund
// (wallet payments are credited to the wallet, gateway payments are refunded through Razorpay).
//   docker compose exec api node scripts/refund-unrefunded-orders.mjs            # list
//   docker compose exec api node scripts/refund-unrefunded-orders.mjs --apply    # refund
// Review the list first: some of these may be internal test orders you do not want to refund.
import { query } from '../src/config/database.js'
import { refundOrderPayments } from '../src/modules/orders/order-refund.js'

const apply = process.argv.includes('--apply')
const { rows } = await query(
  `SELECT o.id, o.status::text AS status, o.created_at, p.id AS payment_id, p.amount, p.method
     FROM orders o JOIN payments p ON (p.order_id = o.id OR p.order_draft_id = o.id)
    WHERE o.status::text IN ('VENDOR_REJECTED','AUTO_REJECTED','CUSTOMER_CANCELLED','ADMIN_CANCELLED') AND p.status = 'PAID'
    ORDER BY o.created_at`
)
console.log(`${rows.length} PAID payment(s) on rejected/cancelled orders, total ₹${rows.reduce((s, r) => s + Number(r.amount), 0)}`)
for (const r of rows) console.log(`  ${r.id}  ${r.status.padEnd(18)} ₹${r.amount}  ${r.method || '-'}  ${new Date(r.created_at).toISOString().slice(0, 10)}`)
if (!apply) { console.log('\nDry run. Re-run with --apply to refund.'); process.exit(0) }
for (const id of [...new Set(rows.map((r) => r.id))]) console.log(id, await refundOrderPayments(id, { reason: 'Refund for order that was not fulfilled' }))
process.exit(0)
