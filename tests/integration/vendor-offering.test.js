/**
 * Integration tests for vendor offering + POS onboarding (migration 152, vendor-app-mode module).
 * These run against a REAL migrated Postgres (same DB the other integration tests use). If the
 * database is not reachable the whole file is skipped, never silently passed.
 *
 * Everything the tests create is removed again in afterAll. The migration backfill test runs
 * inside a transaction that is always rolled back.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/utils/audit-log.js', () => ({ emit: vi.fn() }))

const { pool, query, getClient } = await import('../../src/config/database.js')
const { VendorAppModeService } = await import('../../src/modules/vendor-app-mode/vendor-app-mode.service.js')
const { VendorsService } = await import('../../src/modules/vendors/vendors.service.js')
const { VendorsRepository } = await import('../../src/modules/vendors/vendors.repository.js')

let dbUp = false
try {
  await query('SELECT 1 FROM vendors WHERE false')
  await query('SELECT offering FROM vendors WHERE false')
  dbUp = true
} catch { /* skipped below */ }

const TAG = `t${Date.now().toString(36)}`
const phone = (n) => `97${String(Date.now()).slice(-6)}${n}`.slice(0, 10)
const created = { userIds: [], vendorIds: [] }

async function makeUser(n, name = `Tester ${n}`) {
  const { rows } = await query(`INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING id`, [phone(n), name])
  created.userIds.push(rows[0].id)
  return { id: rows[0].id }
}
async function vendorOf(userId) {
  const { rows } = await query(`SELECT v.* FROM vendors v JOIN vendor_employees e ON e.vendor_id = v.id WHERE e.user_id = $1`, [userId])
  rows.forEach((r) => created.vendorIds.push(r.id))
  return rows
}
async function makeMarketplaceVendor(ownerId, role = 'VENDOR_OWNER') {
  const { rows } = await query(
    `INSERT INTO vendors (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, created_by, status, vendor_approved)
     VALUES ($1, $2, $3, 'x', 'c', 's', '110001', 1, 1, $4, 'APPROVED', true) RETURNING id`,
    [`Mkt ${TAG}`, `mkt-${TAG}-${Math.random().toString(36).slice(2, 7)}`, `T-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, ownerId])
  await query(`INSERT INTO vendor_employees (vendor_id, user_id, role, is_active) VALUES ($1, $2, $3, true)`, [rows[0].id, ownerId, role])
  created.vendorIds.push(rows[0].id)
  return rows[0].id
}

// loadVendorActor reads Redis/DB; with no Redis it falls back to the DB. Use the real one.
const service = new VendorAppModeService()

describe.skipIf(!dbUp)('vendor offering + POS onboarding (real database)', () => {
  afterAll(async () => {
    if (!dbUp) return
    // Shops created through service.start() are not registered one by one — find them by owner.
    if (created.userIds.length) {
      const owned = await query(
        `SELECT id FROM vendors WHERE created_by = ANY($1::uuid[])
         UNION SELECT vendor_id FROM vendor_employees WHERE user_id = ANY($1::uuid[])`, [created.userIds]).catch(() => ({ rows: [] }))
      for (const row of owned.rows) if (!created.vendorIds.includes(row.id)) created.vendorIds.push(row.id)
    }
    for (const id of created.vendorIds) {
      await query(`DELETE FROM pos_prices WHERE vendor_id = $1`, [id]).catch(() => {})
      await query(`DELETE FROM pos_garments WHERE vendor_id = $1`, [id]).catch(() => {})
      await query(`DELETE FROM pos_categories WHERE vendor_id = $1`, [id]).catch(() => {})
      await query(`DELETE FROM pos_services WHERE vendor_id = $1`, [id]).catch(() => {})
      await query(`DELETE FROM vendor_employees WHERE vendor_id = $1`, [id]).catch(() => {})
      await query(`DELETE FROM vendors WHERE id = $1`, [id]).catch(() => {})
    }
    for (const id of created.userIds) await query(`DELETE FROM users WHERE id = $1`, [id]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('migration 152 adds the columns with safe defaults', async () => {
    const { rows } = await query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'vendors' AND column_name IN ('offering','pos_onboarding_status','pos_plan_name','pos_valid_to','pos_onboarding_data')`)
    const by = Object.fromEntries(rows.map((r) => [r.column_name, r]))
    expect(Object.keys(by).sort()).toEqual(['offering', 'pos_onboarding_data', 'pos_onboarding_status', 'pos_plan_name', 'pos_valid_to'])
    expect(by.offering.column_default).toContain('MARKETPLACE')
    expect(by.pos_onboarding_status.column_default).toContain('NOT_STARTED')
    await expect(query(`UPDATE vendors SET offering = 'EVERYTHING' WHERE false RETURNING 1`)).resolves.toBeTruthy() // no rows → CHECK not evaluated
    await expect(query(`INSERT INTO vendors (name, slug, branch_code, address_line1, city, state, pincode, lat, lng, offering)
                        VALUES ('x','bad-${TAG}','B-${TAG}','a','c','s','1',1,1,'EVERYTHING')`)).rejects.toThrow(/offering/)
  })

  it('migration 152 can be re-applied without error and without changing data', async () => {
    const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/database/migrations/152_vendor_offering.sql'), 'utf8')
    const ownerId = (await makeUser(1)).id
    const vid = await makeMarketplaceVendor(ownerId)
    await query(`UPDATE vendors SET offering = 'POS', pos_onboarding_status = 'IN_PROGRESS' WHERE id = $1`, [vid])
    await query(sql)
    await query(sql)
    const { rows } = await query(`SELECT offering, pos_onboarding_status FROM vendors WHERE id = $1`, [vid])
    expect(rows[0]).toEqual({ offering: 'POS', pos_onboarding_status: 'IN_PROGRESS' })
  })

  it('backfill: vendors already using the POS become BOTH/COMPLETED, others stay MARKETPLACE', async () => {
    const sql = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/database/migrations/152_vendor_offering.sql'), 'utf8')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      await client.query('DROP INDEX IF EXISTS idx_vendors_offering')
      for (const col of ['offering', 'pos_onboarding_status', 'pos_plan_name', 'pos_valid_to', 'pos_onboarding_data']) {
        await client.query(`ALTER TABLE vendors DROP COLUMN ${col}`)
      }
      const mk = async (slug) => (await client.query(
        `INSERT INTO vendors (name, slug, branch_code, address_line1, city, state, pincode, lat, lng)
         VALUES ($1, $2, $3, 'a','c','s','1',1,1) RETURNING id`, [slug, `${slug}-${TAG}`, `B-${Math.random().toString(36).slice(2, 8).toUpperCase()}`])).rows[0].id
      const withSettings = await mk('has-settings')
      const withCatalogue = await mk('has-catalogue')
      const withShift = await mk('has-shift')
      const withCounterOrder = await mk('has-counter-order')
      const withDesktopPushOrder = await mk('has-desktop-push-order')
      const plain = await mk('plain')
      const customer = (await client.query(`SELECT id FROM users LIMIT 1`)).rows[0]?.id
        ?? (await client.query(`INSERT INTO users (phone, name) VALUES ($1, 'bf') RETURNING id`, [phone(0)])).rows[0].id

      await client.query(`INSERT INTO vendor_pos_settings (vendor_id, setting_key, value, version) VALUES ($1, 'print-settings', '{}', 1)`, [withSettings])
      await client.query(`INSERT INTO pos_catalogue_state (vendor_id) VALUES ($1)`, [withCatalogue])
      await client.query(`INSERT INTO vendor_cash_shifts (vendor_id, opening_cash_paise, opened_by) VALUES ($1, 0, $2)`, [withShift, customer])
      await client.query(`INSERT INTO store_orders (vendor_id, customer_user_id, pos_order_id, total_paise, source) VALUES ($1, $2, 'bf-1', 100, 'COUNTER')`, [withCounterOrder, customer])
      await client.query(`INSERT INTO store_orders (vendor_id, customer_user_id, pos_order_id, total_paise, source) VALUES ($1, $2, 'bf-2', 100, 'DESKTOP_PUSH')`, [withDesktopPushOrder, customer])

      await client.query(sql)
      const ids = [withSettings, withCatalogue, withShift, withCounterOrder, withDesktopPushOrder, plain]
      const { rows } = await client.query(`SELECT id, offering, pos_onboarding_status FROM vendors WHERE id = ANY($1::uuid[])`, [ids])
      const by = Object.fromEntries(rows.map((r) => [r.id, r]))
      for (const id of [withSettings, withCatalogue, withShift, withCounterOrder, withDesktopPushOrder]) {
        expect(by[id]).toMatchObject({ offering: 'BOTH', pos_onboarding_status: 'COMPLETED' })
      }
      // The Epic desktop pushes orders as DESKTOP_PUSH — those shops must not lose POS when enforcement is turned on.
      expect(by[plain]).toMatchObject({ offering: 'MARKETPLACE', pos_onboarding_status: 'NOT_STARTED' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    // The rollback restored the real columns.
    const { rows } = await query(`SELECT 1 FROM information_schema.columns WHERE table_name='vendors' AND column_name='offering'`)
    expect(rows).toHaveLength(1)
  })

  it('a brand-new user gets a POS-only shop that is hidden from the marketplace', async () => {
    const user = await makeUser(2)
    const res = await service.start(user)
    expect(res).toMatchObject({ success: true, created: true, needsTokenRefresh: true })
    expect(res.appMode).toMatchObject({ hasVendor: true, offering: 'POS', posOnboardingStatus: 'IN_PROGRESS', vendorType: 'STANDARD', appSync: false, walletAccess: false, role: 'VENDOR_OWNER', allowedModes: [], needsPosOnboarding: true })
    const [vendor] = await vendorOf(user.id)
    expect(vendor).toMatchObject({ offering: 'POS', status: 'APPROVED', vendor_approved: false, marketplace_published: false, account_enabled: true, vendor_type: 'STANDARD' })
    const owner = await query(`SELECT role FROM vendor_employees WHERE vendor_id = $1 AND user_id = $2`, [vendor.id, user.id])
    expect(owner.rows[0].role).toBe('VENDOR_OWNER')
  })

  it('start is idempotent, even when fired 8 times at once (no duplicate shops)', async () => {
    const user = await makeUser(3)
    const results = await Promise.all(Array.from({ length: 8 }, () => service.start(user)))
    expect(results.every((r) => r.success)).toBe(true)
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(await vendorOf(user.id)).toHaveLength(1)
  })

  it('a user with a marketplace application cannot also create a POS-only shop (would make login ambiguous)', async () => {
    const user = await makeUser(4)
    await query(`INSERT INTO vendor_applications (owner_id, name) VALUES ($1, 'Pending Shop')`, [user.id])
    const res = await service.start(user)
    expect(res).toMatchObject({ success: false, status: 409, code: 'MARKETPLACE_APPLICATION_EXISTS' })
    expect(await vendorOf(user.id)).toHaveLength(0)
    await query(`DELETE FROM vendor_applications WHERE owner_id = $1`, [user.id])
  })

  it('an existing marketplace owner becomes BOTH; staff cannot', async () => {
    const owner = await makeUser(5)
    const vid = await makeMarketplaceVendor(owner.id)
    const res = await service.start(owner)
    expect(res).toMatchObject({ success: true, created: false, needsTokenRefresh: false })
    expect(res.appMode).toMatchObject({ offering: 'BOTH', posOnboardingStatus: 'IN_PROGRESS', allowedModes: ['MARKETPLACE'], needsPosOnboarding: true })
    const staff = await makeUser(6)
    await query(`INSERT INTO vendor_employees (vendor_id, user_id, role, is_active) VALUES ($1, $2, 'VENDOR_STAFF', true)`, [vid, staff.id])
    expect(await service.start(staff)).toMatchObject({ success: false, status: 403, code: 'NOT_OWNER' })
  })

  it('full onboarding: steps → complete with the starter price list; real profile columns follow', async () => {
    const user = await makeUser(7)
    const { appMode } = await service.start(user)
    const vendorId = appMode.vendorId
    const actor = { userId: user.id, role: 'VENDOR_OWNER', vendorId }

    expect((await service.getOnboarding(vendorId)).onboarding).toMatchObject({ nextStep: 'shop', missingSteps: ['shop', 'tax', 'counter', 'pricelist'] })
    expect(await service.complete(vendorId, actor)).toMatchObject({ success: false, code: 'ONBOARDING_INCOMPLETE' })

    await service.saveStep(vendorId, actor, 'shop', { name: 'Sparkle Laundry', ownerName: 'Ravi Kumar', addressLine1: '12 MG Road', city: 'Pune', pincode: '411001' })
    await service.saveStep(vendorId, actor, 'tax', { gstEnabled: true, gstin: '27ABCDE1234F1Z5', upiId: 'ravi@okbank', invoicePrefix: 'SPK' })
    await service.saveStep(vendorId, actor, 'counter', { printerProfile: 'thermal-58mm', orderSeriesPrefix: 'SP', defaultDeliveryDays: 2 })
    expect(await service.saveStep(vendorId, actor, 'tax', { gstEnabled: true, gstin: 'BAD' })).toMatchObject({ success: false })
    await service.saveStep(vendorId, actor, 'pricelist', { choice: 'starter' })

    const row = (await query(`SELECT name, owner_name, address_line1, city, pincode, gst_number, pos_onboarding_status FROM vendors WHERE id = $1`, [vendorId])).rows[0]
    expect(row).toMatchObject({ name: 'Sparkle Laundry', owner_name: 'Ravi Kumar', address_line1: '12 MG Road', city: 'Pune', pincode: '411001', gst_number: '27ABCDE1234F1Z5', pos_onboarding_status: 'IN_PROGRESS' })

    const done = await service.complete(vendorId, actor)
    expect(done.success).toBe(true)
    expect(done.appMode).toMatchObject({ posOnboardingStatus: 'COMPLETED', allowedModes: ['POS'], needsPosOnboarding: false })
    expect(done.starterPricelist).toEqual({ categories: 3, services: 4, garments: 13, prices: 36 })

    const counts = (await query(
      `SELECT (SELECT count(*) FROM pos_categories WHERE vendor_id=$1)::int c, (SELECT count(*) FROM pos_services WHERE vendor_id=$1)::int s,
              (SELECT count(*) FROM pos_garments WHERE vendor_id=$1)::int g, (SELECT count(*) FROM pos_prices WHERE vendor_id=$1)::int p`, [vendorId])).rows[0]
    expect(counts).toEqual({ c: 3, s: 4, g: 13, p: 36 })

    // Completing twice must not duplicate the starter data.
    const again = await service.complete(vendorId, actor)
    expect(again.success).toBe(true)
    expect(again.starterPricelist).toBeNull()
    expect((await query(`SELECT count(*)::int n FROM pos_prices WHERE vendor_id = $1`, [vendorId])).rows[0].n).toBe(36)
  })

  it('the starter price list never leaks into another vendor', async () => {
    const a = await makeUser(8)
    const b = await makeUser(9)
    const va = (await service.start(a)).appMode.vendorId
    const vb = (await service.start(b)).appMode.vendorId
    expect(va).not.toBe(vb)
    const actor = { userId: a.id, role: 'VENDOR_OWNER', vendorId: va }
    for (const [step, data] of [['shop', { name: 'A Shop', ownerName: 'Aa Aa', addressLine1: 'street 1', city: 'Delhi' }], ['tax', {}], ['counter', {}], ['pricelist', { choice: 'starter' }]]) {
      expect((await service.saveStep(va, actor, step, data)).success).toBe(true)
    }
    expect((await service.complete(va, actor)).success).toBe(true)
    expect((await query(`SELECT count(*)::int n FROM pos_garments WHERE vendor_id = $1`, [vb])).rows[0].n).toBe(0)
  })

  it('saveStep refuses a plain marketplace vendor', async () => {
    const owner = await makeUser(10)
    const vid = await makeMarketplaceVendor(owner.id)
    expect(await service.saveStep(vid, { userId: owner.id }, 'shop', {})).toMatchObject({ success: false, status: 409, code: 'POS_NOT_STARTED' })
  })

  it('admin can set the offering + plan, bad input is rejected, and a vendor cannot set it on themselves', async () => {
    const owner = await makeUser(11)
    const vid = await makeMarketplaceVendor(owner.id)
    const vendors = new VendorsService(new VendorsRepository())

    const res = await vendors.adminSetOffering(vid, { offering: 'both', pos_plan_name: ' Enterprise 5 Store ', pos_valid_to: '2026-11-03' }, 'admin-1')
    expect(res).toMatchObject({ offering: 'BOTH', pos_plan_name: 'Enterprise 5 Store', pos_valid_to: '2026-11-03', allowed_modes: ['MARKETPLACE'] })
    await expect(vendors.adminSetOffering(vid, { offering: 'NOPE' }, 'admin-1')).rejects.toMatchObject({ statusCode: 400 })
    await expect(vendors.adminSetOffering(vid, { offering: 'POS', pos_valid_to: '03-11-2026' }, 'admin-1')).rejects.toMatchObject({ statusCode: 400 })
    await expect(vendors.adminSetOffering(vid, { offering: 'POS', pos_valid_to: '2026-02-31' }, 'admin-1')).rejects.toMatchObject({ statusCode: 400 })
    await expect(vendors.adminSetOffering('00000000-0000-0000-0000-000000000000', { offering: 'POS' }, 'admin-1')).rejects.toMatchObject({ statusCode: 404 })

    // Clearing the plan works and the vendor's own profile update cannot touch any of these columns.
    await vendors.adminSetOffering(vid, { offering: 'BOTH', pos_plan_name: '', pos_valid_to: null }, 'admin-1')
    await vendors.updateProfile(owner.id, { name: `Renamed ${TAG}`, offering: 'POS', pos_onboarding_status: 'COMPLETED', pos_plan_name: 'Free forever', pos_valid_to: '2099-01-01' })
    const row = (await query(`SELECT name, offering, pos_onboarding_status, pos_plan_name, pos_valid_to FROM vendors WHERE id = $1`, [vid])).rows[0]
    expect(row).toMatchObject({ name: `Renamed ${TAG}`, offering: 'BOTH', pos_onboarding_status: 'NOT_STARTED', pos_plan_name: null, pos_valid_to: null })
  })
})

describe.skipIf(dbUp)('vendor offering integration (SKIPPED: database not reachable)', () => {
  it.skip('needs a migrated Postgres — run `npm run db:migrate` first', () => {})
})
