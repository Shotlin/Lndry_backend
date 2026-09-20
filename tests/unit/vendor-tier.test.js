import { describe, it, expect } from 'vitest'
import {
  VENDOR_TYPES, normalizeVendorType, capabilitiesFor, getVendorCapabilities,
  requireWalletAccess, requireAppSync, TIER_RESTRICTED,
} from '../../src/modules/vendors/vendor-tier.js'

const dbReturning = (vendor_type) => ({ query: async () => ({ rows: vendor_type === undefined ? [] : [{ vendor_type }] }) })

describe('vendor tier capabilities', () => {
  it('knows exactly three types', () => {
    expect(VENDOR_TYPES).toEqual(['STANDARD', 'PARTNER', 'EXCLUSIVE'])
  })

  it('normalizes case/whitespace and rejects anything else', () => {
    expect(normalizeVendorType(' partner ')).toBe('PARTNER')
    expect(normalizeVendorType('exclusive')).toBe('EXCLUSIVE')
    expect(normalizeVendorType('GOLD')).toBeNull()
    expect(normalizeVendorType(undefined)).toBeNull()
  })

  it('STANDARD is POS-only; PARTNER and EXCLUSIVE are fully connected', () => {
    expect(capabilitiesFor('STANDARD')).toEqual({ vendorType: 'STANDARD', appSync: false, walletAccess: false })
    expect(capabilitiesFor('PARTNER')).toEqual({ vendorType: 'PARTNER', appSync: true, walletAccess: true })
    expect(capabilitiesFor('EXCLUSIVE')).toEqual({ vendorType: 'EXCLUSIVE', appSync: true, walletAccess: true })
  })

  it('reads the current type and fails closed for an unknown or missing vendor', async () => {
    expect((await getVendorCapabilities('v1', dbReturning('EXCLUSIVE'))).walletAccess).toBe(true)
    expect((await getVendorCapabilities('v1', dbReturning(undefined))).vendorType).toBe('STANDARD')
    expect((await getVendorCapabilities('v1', dbReturning('garbage'))).appSync).toBe(false)
    expect((await getVendorCapabilities(null)).vendorType).toBe('STANDARD')
  })

  it('exposes a stable error code for refusals', () => {
    expect(TIER_RESTRICTED).toBe('VENDOR_TIER_RESTRICTED')
    expect(typeof requireWalletAccess).toBe('function')
    expect(typeof requireAppSync).toBe('function')
  })
})
