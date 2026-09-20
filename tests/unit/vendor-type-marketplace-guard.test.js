import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Vendor Type (Standard / Partner / Exclusive) governs ONLY how deeply a vendor's POS walk-in sales
 * connect to LNDRY (order sync + wallet at the counter). Every type is a full marketplace vendor, so
 * marketplace code must never read it. If one of these files ever starts to, this test fails and
 * the change needs a deliberate decision.
 */
const MODULES = path.resolve(__dirname, '../../src/modules')
const MARKETPLACE = [
  'orders', 'payments', 'wallet', 'quotes', 'discovery', 'vendor-orders', 'vendor-rider', 'shop-orders',
  'pickup-slots', 'service-categories', 'garment-types', 'shop-garment_rates', 'coupons', 'reviews',
  'vendor-applications', 'referrals', 'invoices/invoices.routes.js', 'vendors/vendor-applications.routes.js',
]

function sourceFiles(entry) {
  const full = path.join(MODULES, entry)
  if (!fs.existsSync(full)) return []
  if (fs.statSync(full).isFile()) return [full]
  return fs.readdirSync(full, { recursive: true })
    .map((f) => path.join(full, String(f)))
    .filter((f) => f.endsWith('.js') && fs.statSync(f).isFile())
}

describe('vendor type never limits the LNDRY marketplace', () => {
  const files = MARKETPLACE.flatMap(sourceFiles)

  it('scans a meaningful number of marketplace files', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files.map((f) => [path.relative(MODULES, f), f]))('%s does not read the vendor type', (_name, file) => {
    const source = fs.readFileSync(file, 'utf8')
    expect(source).not.toMatch(/vendor-tier|vendor_type|vendorType|app_synced|VENDOR_TIER_RESTRICTED/)
  })
})
