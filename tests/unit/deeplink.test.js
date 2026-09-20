import { describe, it, expect } from 'vitest'
import {
  resolveLink, validateLink, inferLink, buildLinkData, isSafeRoute,
} from '../../src/utils/deeplink.js'

describe('notification deep-link contract', () => {
  const order = { type: 'order_details', params: { orderId: 'abc123' } }

  it('sends each recipient to the right screen for their app and role', () => {
    expect(resolveLink(order, { app: 'customer' }).route).toBe('/orders/details/abc123')
    expect(resolveLink(order, { app: 'partner', shopRole: 'VENDOR_OWNER' }).route).toBe('/orders/details/abc123')
    expect(resolveLink(order, { app: 'partner', shopRole: 'VENDOR_RIDER' }).route).toBe('/rider/jobs/abc123')
  })

  it('falls back to a sensible screen instead of a dead link', () => {
    expect(resolveLink({ type: 'wallet' }, { app: 'partner', shopRole: 'VENDOR_RIDER' }).route).toBe('/profile/notifications')
    expect(resolveLink({ type: 'order_details', params: {} }, { app: 'customer' }).route).toBe('/orders')
  })

  it('only allows plain in-app custom routes', () => {
    expect(isSafeRoute('/profile/wallet')).toBe(true)
    for (const bad of ['https://evil.example', '//evil.com', '/a/../b', 'profile', '/a b', '/<script>']) {
      expect(isSafeRoute(bad)).toBe(false)
    }
    expect(resolveLink({ type: 'route', params: { route: 'https://evil.example' } })).toBeNull()
  })

  it('validates admin input', () => {
    expect(validateLink(null)).toEqual({ ok: true, link: null })
    expect(validateLink({ type: 'order_details', params: {} }).ok).toBe(false)
    expect(validateLink({ type: 'bogus' }).ok).toBe(false)
    expect(validateLink({ type: 'order_details', params: { orderId: 'o 1;drop' } }).ok).toBe(false)
    expect(validateLink(order)).toEqual({ ok: true, link: order })
  })

  it('infers a destination for transactional notifications that predate the contract', () => {
    expect(inferLink('order_vendor_accepted', { orderId: 'o1' })).toEqual({ type: 'order_details', params: { orderId: 'o1' } })
    expect(inferLink('WALLET_REDEMPTION_REQUESTED', { requestId: 'r' }).type).toBe('wallet')
    expect(inferLink('something_else', {}).type).toBe('notifications')
  })

  it('produces an all-string data block', () => {
    const data = buildLinkData(resolveLink(order, { app: 'customer' }))
    expect(data).toEqual({ type: 'order_details', deepLink: '/orders/details/abc123', orderId: 'abc123' })
    expect(Object.values(data).every((v) => typeof v === 'string')).toBe(true)
  })
})
