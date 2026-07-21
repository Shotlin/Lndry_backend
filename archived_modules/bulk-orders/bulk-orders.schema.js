import { z } from 'zod'

/**
 * Bulk Orders module — Zod validation schemas
 *
 * Mirrors columns and constraints from migration 037_bulk_orders.sql.
 *
 * Validates: Requirements 9.1, 9.2, 9.6, 9.8, 9.9
 *
 * Numeric ranges:
 *   - subtotal / total_amount: DECIMAL(12,2), total_amount in [0.01, 999999.99]
 *   - discount_amount, delivery_fee: DECIMAL(10,2), >= 0
 *   - total_items: INTEGER >= 5 (Req 9.2)
 *   - items: array with >= 3 distinct product_ids (Req 9.2)
 *
 * Delivery date (Req 9.6): >= now + 24h AND <= now + 30d.
 * The schema only enforces ISO parseability — the now-relative window check
 * lives in the service so tests can travel time deterministically.
 */

const TOTAL_AMOUNT_MIN = 0.01
const TOTAL_AMOUNT_MAX = 999999.99
const SUBTOTAL_MIN = 0
const SUBTOTAL_MAX = 999999.99
const FEE_MIN = 0
const FEE_MAX = 99999999.99

const PAYMENT_METHODS = ['COD', 'ONLINE', 'WALLET', 'UPI', 'CARD']
const PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAILED', 'REFUNDED']

const BULK_ORDER_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'CONFIRMED',
  'PROCESSING',
  'READY',
  'DELIVERED',
  'CANCELLED',
]

// ─── Items array ─────────────────────────────────────────
// Each item: { garment_rate_id, quantity, price (per-unit), name?, unit? }
// quantity must be >= 1, price >= 0.
const itemSchema = z.object({
  garment_rate_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(10000),
  price: z.number().min(0).max(FEE_MAX),
  name: z.string().max(255).optional(),
  unit: z.string().max(50).optional(),
})

// ─── Delivery address ────────────────────────────────────
// Reused on every order — keep the contract narrow but tolerant of extras.
const deliveryAddressSchema = z
  .object({
    line1: z.string().min(1).max(500),
    line2: z.string().max(500).optional().nullable(),
    city: z.string().min(1).max(100),
    state: z.string().min(1).max(100),
    pincode: z.string().min(4).max(10),
    lat: z.number().optional().nullable(),
    lng: z.number().optional().nullable(),
  })
  .passthrough()

// ─── CREATE BULK ORDER ───────────────────────────────────
// Customer-supplied; user_id comes from the JWT in the controller.
// order_number is server-generated (Req 9.8).
export const createBulkOrderSchema = z
  .object({
    vendor_id: z.string().uuid(),
    items: z
      .array(itemSchema)
      .min(1, 'At least one item is required')
      .max(500, 'Too many items'),
    total_items: z.number().int().min(5).max(2147483647),
    subtotal: z.number().min(SUBTOTAL_MIN).max(SUBTOTAL_MAX),
    discount_amount: z.number().min(FEE_MIN).max(FEE_MAX).default(0),
    delivery_fee: z.number().min(FEE_MIN).max(FEE_MAX).default(0),
    total_amount: z.number().min(TOTAL_AMOUNT_MIN).max(TOTAL_AMOUNT_MAX),
    delivery_date: z
      .string()
      .refine(
        (v) => !Number.isNaN(Date.parse(v)),
        'delivery_date must be a valid ISO date'
      ),
    delivery_slot: z.string().max(50).optional().nullable(),
    delivery_address: deliveryAddressSchema,
    payment_method: z.enum(PAYMENT_METHODS).optional().nullable(),
    payment_status: z.enum(PAYMENT_STATUSES).optional().default('PENDING'),
  })
  .superRefine((data, ctx) => {
    // Req 9.2 — items must contain at least 3 distinct product_ids
    const distinctProducts = new Set(data.items.map((i) => i.garment_rate_id))
    if (distinctProducts.size < 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'items must contain at least 3 distinct garment_rates',
      })
    }

    // Req 9.2 — total_items cannot exceed the sum of quantities across items
    // (sanity check; total_items >= 5 is already enforced by .min(5) above).
    const sumQty = data.items.reduce(
      (acc, i) => acc + Number(i.quantity || 0),
      0
    )
    if (data.total_items > sumQty) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total_items'],
        message:
          'total_items cannot exceed the sum of quantities across items',
      })
    }
  })

// ─── UPDATE STATUS ───────────────────────────────────────
// Used by Shop Manager+ to advance state and by Customer to cancel a DRAFT.
export const updateStatusSchema = z.object({
  status: z.enum(BULK_ORDER_STATUSES),
  note: z.string().max(500).optional(),
})

// ─── LIST QUERY ──────────────────────────────────────────
// Filters supported (Req 9.9): status, vendor_id (Super Admin scoping).
// Pagination defaults: page=1, limit=20, hard cap 100.
export const listBulkOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(BULK_ORDER_STATUSES).optional(),
  vendor_id: z.string().uuid().optional(),
})

// ─── PARAMS ──────────────────────────────────────────────
export const bulkOrderIdParamSchema = z.object({
  id: z.string().uuid(),
})

// ─── Exports for the rest of the module ──────────────────
export { BULK_ORDER_STATUSES }
