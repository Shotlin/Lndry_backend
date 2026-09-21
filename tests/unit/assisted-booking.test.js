import { describe, it, expect, vi } from 'vitest'

// The service imports the audit emitter and (through the repository) the DB
// pool — neither is needed for the rules under test.
vi.mock('../../src/utils/audit-log.js', () => ({ emit: vi.fn() }))
vi.mock('../../src/config/database.js', () => ({ query: vi.fn(), getClient: vi.fn() }))

const { AssistedBookingService } = await import('../../src/modules/admin/assisted-booking/assisted-booking.service.js')

const BASE = {
  enabled: true,
  scope: 'ALL',
  title: 'Not sure what service you need?',
  subtitle: 'sub',
  buttonText: 'Book With Expert Check',
  iconUrl: null,
  checkoutNote: 'note',
  assessmentTitle: 'Laundry Assessment Required',
  assessmentMessage: 'msg',
  priceLabel: 'Price after inspection',
}

function fakeRepo(settings = BASE, { selected = [], existingVendors } = {}) {
  const state = { settings: settings && { ...settings }, selected: [...selected], saved: null }
  return {
    state,
    getSettings: async () => state.settings,
    listSelectedVendors: async () => state.selected.map((id) => ({ id, name: id })),
    isVendorSelected: async (id) => state.selected.includes(id),
    findExistingVendorIds: async (ids) => (existingVendors ?? ids),
    save: async (next, vendorIds) => {
      state.saved = { next, vendorIds }
      state.settings = next
      if (vendorIds) state.selected = [...vendorIds]
    },
  }
}

const actor = { userId: 'admin-1', role: 'ADMIN', ip: '1.1.1.1', userAgent: 'test' }

describe('assisted booking availability', () => {
  it('is off by default until an admin enables it', async () => {
    const svc = new AssistedBookingService(fakeRepo({ ...BASE, enabled: false }))
    expect(await svc.isAvailableForVendor('v1')).toBe(false)
    expect((await svc.getPublicConfig('v1')).available).toBe(false)
  })

  it('is offered to every vendor when the scope is ALL', async () => {
    const svc = new AssistedBookingService(fakeRepo({ ...BASE, scope: 'ALL' }))
    expect(await svc.isAvailableForVendor('any-vendor')).toBe(true)
  })

  it('is offered only to the selected vendors when the scope is SELECTED', async () => {
    const svc = new AssistedBookingService(fakeRepo({ ...BASE, scope: 'SELECTED' }, { selected: ['v1'] }))
    expect(await svc.isAvailableForVendor('v1')).toBe(true)
    expect(await svc.isAvailableForVendor('v2')).toBe(false)
  })

  it('reports unavailable when no vendor is given, but still returns the wording', async () => {
    const svc = new AssistedBookingService(fakeRepo())
    const cfg = await svc.getPublicConfig(null)
    expect(cfg.available).toBe(false)
    expect(cfg.buttonText).toBe('Book With Expert Check')
  })

  it('falls back to the built-in wording (disabled) if the settings row is missing', async () => {
    const svc = new AssistedBookingService(fakeRepo(null))
    const cfg = await svc.getPublicConfig('v1')
    expect(cfg.available).toBe(false)
    expect(cfg.title).toBe('Not sure what service you need?')
    expect(cfg.priceLabel).toBe('Price after inspection')
  })

  it('returns the admin-edited wording to the customer app', async () => {
    const svc = new AssistedBookingService(fakeRepo({ ...BASE, buttonText: 'Let the Laundry Decide', iconUrl: 'https://x/y.png' }))
    const cfg = await svc.getPublicConfig('v1')
    expect(cfg).toMatchObject({ available: true, buttonText: 'Let the Laundry Decide', iconUrl: 'https://x/y.png' })
  })
})

describe('assisted booking settings updates', () => {
  it('saves valid text and trims it', async () => {
    const repo = fakeRepo()
    const svc = new AssistedBookingService(repo)
    const res = await svc.update({ title: '  Need help choosing?  ', buttonText: 'Expert Check' }, actor)
    expect(res.success).toBe(true)
    expect(repo.state.saved.next.title).toBe('Need help choosing?')
    expect(repo.state.saved.next.buttonText).toBe('Expert Check')
  })

  it('refuses empty or over-long wording', async () => {
    const svc = new AssistedBookingService(fakeRepo())
    expect((await svc.update({ title: '   ' }, actor)).success).toBe(false)
    expect((await svc.update({ buttonText: 'x'.repeat(61) }, actor)).success).toBe(false)
  })

  it('accepts only an https link for the icon, and clears it with an empty value', async () => {
    const repo = fakeRepo()
    const svc = new AssistedBookingService(repo)
    expect((await svc.update({ iconUrl: 'http://insecure/x.png' }, actor)).success).toBe(false)
    expect((await svc.update({ iconUrl: 'javascript:alert(1)' }, actor)).success).toBe(false)
    expect((await svc.update({ iconUrl: 'https://cdn/x.png' }, actor)).success).toBe(true)
    expect(repo.state.settings.iconUrl).toBe('https://cdn/x.png')
    expect((await svc.update({ iconUrl: '' }, actor)).success).toBe(true)
    expect(repo.state.settings.iconUrl).toBeNull()
  })

  it('will not enable "selected vendors only" with nobody selected', async () => {
    const svc = new AssistedBookingService(fakeRepo({ ...BASE, enabled: false, scope: 'ALL' }))
    const res = await svc.update({ enabled: true, scope: 'SELECTED', vendorIds: [] }, actor)
    expect(res.success).toBe(false)
    expect(res.message).toMatch(/at least one vendor/i)
  })

  it('will not save a selection that names a vendor which does not exist', async () => {
    const svc = new AssistedBookingService(fakeRepo(BASE, { existingVendors: ['v1'] }))
    const res = await svc.update({ scope: 'SELECTED', vendorIds: ['v1', 'ghost'] }, actor)
    expect(res.success).toBe(false)
  })

  it('replaces the selected vendors and then offers the option only to them', async () => {
    const repo = fakeRepo({ ...BASE, scope: 'ALL' })
    const svc = new AssistedBookingService(repo)
    expect((await svc.update({ scope: 'SELECTED', vendorIds: ['v1', 'v1', 'v2'] }, actor)).success).toBe(true)
    expect(repo.state.saved.vendorIds).toEqual(['v1', 'v2'])
    expect(await svc.isAvailableForVendor('v2')).toBe(true)
    expect(await svc.isAvailableForVendor('v3')).toBe(false)
  })

  it('keeps the existing vendor selection when only wording changes', async () => {
    const repo = fakeRepo({ ...BASE, scope: 'SELECTED' }, { selected: ['v1'] })
    const svc = new AssistedBookingService(repo)
    expect((await svc.update({ title: 'New title' }, actor)).success).toBe(true)
    expect(repo.state.saved.vendorIds).toBeUndefined()
    expect(repo.state.selected).toEqual(['v1'])
  })

  it('rejects an unknown scope', async () => {
    const svc = new AssistedBookingService(fakeRepo())
    expect((await svc.update({ scope: 'EVERYONE' }, actor)).success).toBe(false)
  })
})
