import { describe, it, expect } from 'vitest'
import { buildOriginChecker, parseCookieHeader } from '../../../src/utils/origin-allowlist.js'

const base = { CORS_ORIGINS: 'https://dash.lndry.shotlin.in,http://localhost:4501', CORS_ALLOWED_VERCEL_HOSTS: 'lndry-web.vercel.app' }

describe('browser origin allow-list (REST CORS + WebSocket handshake)', () => {
  const ok = buildOriginChecker(base)

  it('accepts no Origin at all (mobile apps, curl, server-to-server)', () => {
    expect(ok(undefined)).toBe(true)
    expect(ok('')).toBe(true)
  })
  it('accepts the configured dashboard and its localhost twin', () => {
    expect(ok('https://dash.lndry.shotlin.in')).toBe(true)
    expect(ok('http://localhost:4501')).toBe(true)
    expect(ok('http://127.0.0.1:4501')).toBe(true)
  })
  it('accepts company sub-domains', () => {
    expect(ok('https://www.lndry.in')).toBe(true)
    expect(ok('https://dash.shotlin.in')).toBe(true)
  })
  it('rejects look-alike hosts and foreign sites', () => {
    expect(ok('https://evil.example')).toBe(false)
    expect(ok('https://lndry.in.evil.example')).toBe(false)
    expect(ok('https://notlndry.in')).toBe(false)
    expect(ok('https://shotlin.in.attacker.io')).toBe(false)
  })
  it('rejects non-http schemes and garbage', () => {
    expect(ok('file:///etc/passwd')).toBe(false)
    expect(ok('null')).toBe(false)
    expect(ok('javascript:alert(1)')).toBe(false)
  })
  it('with an explicit Vercel allow-list only those hosts pass', () => {
    expect(ok('https://lndry-web.vercel.app')).toBe(true)
    expect(ok('https://attacker.vercel.app')).toBe(false)
  })
  it('without one, any *.vercel.app is trusted (documented default — set CORS_ALLOWED_VERCEL_HOSTS)', () => {
    const open = buildOriginChecker({ CORS_ORIGINS: 'https://a.example' })
    expect(open('https://anything.vercel.app')).toBe(true)
  })
})

describe('parseCookieHeader', () => {
  it('reads the session cookie among others', () => {
    expect(parseCookieHeader('a=1; accessToken=abc.def.ghi; auth_session=1').accessToken).toBe('abc.def.ghi')
  })
  it('first occurrence wins (a later duplicate cannot override)', () => {
    expect(parseCookieHeader('accessToken=good; accessToken=evil').accessToken).toBe('good')
  })
  it('tolerates junk and non-strings', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
    expect(parseCookieHeader('novalue; =x; %E0%A4=%')).toBeTypeOf('object')
  })
})
