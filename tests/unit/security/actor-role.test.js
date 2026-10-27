import { describe, it, expect, afterEach } from 'vitest'
import { normalizeActorRole } from '../../../src/utils/actor-role.js'

describe('normalizeActorRole — shop staff must never read as platform ADMIN', () => {
  afterEach(() => { delete process.env.LEGACY_SHOP_STAFF_ADMIN_ROLE })

  it('downgrades a vendor-employee token (role ADMIN + shopRole)', () => {
    const out = normalizeActorRole({ id: 'u', role: 'ADMIN', shopId: 's1', shopRole: 'VENDOR_STAFF' })
    expect(out.role).toBe('SHOP_STAFF')
    expect(out.account_role).toBe('ADMIN')
    expect(out.shopId).toBe('s1')
  })

  it('downgrades when only shopId is present', () => {
    expect(normalizeActorRole({ id: 'u', role: 'ADMIN', shopId: 's1' }).role).toBe('SHOP_STAFF')
  })

  it('also covers SUPER_ADMIN / FINANCE_ADMIN labels on shop tokens', () => {
    expect(normalizeActorRole({ role: 'SUPER_ADMIN', shopRole: 'VENDOR_OWNER' }).role).toBe('SHOP_STAFF')
    expect(normalizeActorRole({ role: 'FINANCE_ADMIN', shopId: 's' }).role).toBe('SHOP_STAFF')
  })

  it('keeps genuine HQ tokens (platform_role present) as ADMIN', () => {
    const t = { id: 'u', role: 'ADMIN', platform_role: 'SUPER_ADMIN' }
    expect(normalizeActorRole(t)).toEqual(t)
  })

  it('keeps unscoped legacy admin tokens', () => {
    const t = { id: 'u', role: 'ADMIN' }
    expect(normalizeActorRole(t)).toEqual(t)
  })

  it('leaves customers, riders and shop-scoped customers alone', () => {
    expect(normalizeActorRole({ role: 'CUSTOMER' }).role).toBe('CUSTOMER')
    expect(normalizeActorRole({ role: 'RIDER' }).role).toBe('RIDER')
    expect(normalizeActorRole({ role: 'CUSTOMER', shopId: 's', shopRole: 'VENDOR_STAFF' }).role).toBe('CUSTOMER')
  })

  it('does not mutate its input and tolerates junk', () => {
    const t = { role: 'ADMIN', shopId: 's' }
    normalizeActorRole(t)
    expect(t.role).toBe('ADMIN')
    expect(normalizeActorRole(null)).toBeNull()
    expect(normalizeActorRole('x')).toBe('x')
  })

  it('honours the emergency rollback flag', () => {
    process.env.LEGACY_SHOP_STAFF_ADMIN_ROLE = 'true'
    expect(normalizeActorRole({ role: 'ADMIN', shopId: 's' }).role).toBe('ADMIN')
  })
})
