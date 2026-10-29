import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(() => {
    throw new Error('no database should be touched when validation fails')
  }),
}))

const { VendorsService } = await import('../../src/modules/vendors/vendors.service.js')

const valid = {
  phone: '9800011122',
  name: 'Shine Laundry',
  owner_name: 'Ravi',
  address_line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'KA',
  pincode: '560001',
  lat: 12.97,
  lng: 77.59,
}

describe('VendorsService.adminCreateVendor — input checks', () => {
  const svc = new VendorsService({})
  const rejects = (patch, message) =>
    expect(svc.adminCreateVendor('admin-1', { ...valid, ...patch })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(message),
    })

  it('rejects a phone that is not an Indian mobile', () => rejects({ phone: '1234567890' }, 'valid 10-digit'))
  it('rejects a short business name', () => rejects({ name: 'A' }, 'Business name'))
  it('rejects a missing owner name', () => rejects({ owner_name: ' ' }, 'Owner name'))
  it('rejects a missing address', () => rejects({ address_line1: '' }, 'Address'))
  it('rejects a missing pincode', () => rejects({ pincode: undefined }, 'Pincode'))
  it('rejects a missing map position', () => rejects({ lat: undefined }, 'location'))
})
