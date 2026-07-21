import { describe, expect, it } from 'vitest'
import { query } from '../../src/config/database.js'

describe('Migration Database Integrity Check', () => {
  it('should verify all required Phase 1 tables exist in the database', async () => {
    const requiredTables = [
      'vendors',
      'vendor_slots',
      'slot_holds',
      'vendor_documents',
      'otp_challenges',
      'order_events',
      'quotes',
      'payments',
      'order_otps',
      'vendor_employees',
      'vendor_services',
      'vendor_service_rates',
      'vendor_applications',
      'order_assignments',
      'order_lines',
      'order_drafts',
      'service_categories',
      'garment_types'
    ]

    for (const tbl of requiredTables) {
      const res = await query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        [tbl]
      )
      expect(res.rows.length).toBe(1)
    }
  })
})
