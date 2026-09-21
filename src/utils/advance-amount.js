import { query } from '../config/database.js'
import { logger } from '../config/logger.js'

const DEFAULT_ADVANCE_PAISE = 5000

/**
 * The fixed online advance charged at checkout (default ₹50), read from
 * app_settings so it stays admin-adjustable. Shared by payments (what is
 * actually charged) and order preparation (what the checkout screen tells
 * the customer) so the two can never disagree.
 */
export async function getAdvanceAmountPaise() {
  try {
    const { rows } = await query(`SELECT value FROM app_settings WHERE key = 'order_advance_amount_paise'`)
    const parsed = Number(rows[0]?.value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ADVANCE_PAISE
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to read configurable advance amount, using default')
    return DEFAULT_ADVANCE_PAISE
  }
}
