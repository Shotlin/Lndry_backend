import { z } from 'zod'

/**
 * Scheduled Orders module — Zod validation schemas
 * Mirrors columns and constraints from migration 036_scheduled_orders.sql.
 *
 * Validates: Requirements 10.1, 10.7, 10.8, 10.9, 10.10
 *
 * Note on the 2-hour-in-the-future rule (Req 10.7): the schema enforces a
 * generic "scheduled_for must be parseable" check; the precise 2-hour check
 * lives in `ScheduledOrdersService.validateScheduledFor(input, now)` so that
 * unit tests can travel time deterministically. Both run on every request.
 */

// Valid recurrence values mirror the DB CHECK constraint (Req 10.1, 10.10).
const REPEAT_TYPES = ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY']

// Status filter values for list endpoint mirror the DB CHECK constraint.
const STATUS_VALUES = ['SCHEDULED', 'PROCESSING', 'PLACED', 'FAILED', 'CANCELLED']

// Items in the JSONB cart snapshot — `{ garment_rate_id, quantity }`.
// quantity is bounded so a malformed scheduled order can never deplete a
// shop's stock at fire-time (Req 10.1).
const SCHEDULED_ITEM_QTY_MIN = 1
const SCHEDULED_ITEM_QTY_MAX = 10000

const SUBTOTAL_MIN = 0
const SUBTOTAL_MAX = 99999999.99

const scheduledItemSchema = z.object({
  garment_rate_id: z.string().uuid(),
  quantity: z
    .number()
    .int()
    .min(SCHEDULED_ITEM_QTY_MIN)
    .max(SCHEDULED_ITEM_QTY_MAX),
})

// Delivery address snapshot — must carry coordinates so the worker can
// place a real order without re-resolving the user's address book.
const deliveryAddressSchema = z
  .object({
    line1: z.string().min(1).max(255).optional(),
    line2: z.string().max(255).optional().nullable(),
    city: z.string().max(100).optional(),
    state: z.string().max(100).optional(),
    pincode: z.string().min(1).max(10).optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    notes: z.string().max(500).optional().nullable(),
  })
  .passthrough() // tolerate non-critical extra fields

// ─── CREATE ──────────────────────────────────────────────
// vendor_id allocation check is enforced in the service (Req 10.8). The 2-hour
// future check is a service-side static helper so tests can stub `now`.
export const createScheduledOrderSchema = z
  .object({
    vendor_id: z.string().uuid(),
    items: z.array(scheduledItemSchema).min(1).max(50),
    subtotal: z.number().min(SUBTOTAL_MIN).max(SUBTOTAL_MAX),
    delivery_address: deliveryAddressSchema,
    payment_method: z.string().min(1).max(50).default('COD'),
    scheduled_for: z.coerce.date(),
    repeat_type: z.enum(REPEAT_TYPES).default('ONCE'),
    repeat_until: z.coerce.date().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    // Req 10.10 — repeat_until is only meaningful for recurring schedules
    // and, when present, must be at or after scheduled_for.
    if (
      data.repeat_until &&
      data.scheduled_for &&
      data.repeat_until.getTime() < data.scheduled_for.getTime()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repeat_until'],
        message: 'repeat_until must be on or after scheduled_for',
      })
    }
    // ONCE schedules cannot carry a repeat_until value — forbid it instead
    // of silently ignoring it.
    if (data.repeat_until && data.repeat_type === 'ONCE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repeat_until'],
        message: 'repeat_until is only valid for recurring schedules',
      })
    }
  })

// ─── LIST QUERY ──────────────────────────────────────────
export const listScheduledOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(STATUS_VALUES).optional(),
})

// ─── PARAMS ──────────────────────────────────────────────
export const scheduledOrderIdParamSchema = z.object({
  id: z.string().uuid(),
})
// Alias used by the spec doc and external callers.
export const idParamSchema = scheduledOrderIdParamSchema

// ─── EXPORTED CONSTANTS ─────────────────────────────────
export const SCHEDULED_ORDERS_CONSTANTS = {
  REPEAT_TYPES,
  STATUS_VALUES,
  MAX_ACTIVE_PER_CUSTOMER: 20, // Req 10.9
  MIN_FUTURE_HOURS: 2, // Req 10.7
}

export { REPEAT_TYPES, STATUS_VALUES }
