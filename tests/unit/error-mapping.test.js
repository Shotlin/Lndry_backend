import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'

// env.js validates required settings at import time; give it throwaway test values (no real secrets).
process.env.JWT_ACCESS_SECRET ??= 'unit-test-access-secret-0123456789abcdef'
process.env.JWT_REFRESH_SECRET ??= 'unit-test-refresh-secret-0123456789abcdef'
process.env.LOG_LEVEL ??= 'error'
const { default: errorHandlerPlugin, mapKnownError } = await import('../../src/plugins/errorHandler.plugin.js')

const pgError = (code, extra = {}) => Object.assign(new Error('raw pg message: relation "x" violates ...'), { code, ...extra })

describe('mapKnownError — client mistakes that used to be 500s', () => {
  it('malformed uuid / number / enum -> 400 INVALID_INPUT', () => {
    for (const c of ['22P02', '22003', '22001', '22007', '22008', '22023', '23514']) {
      expect(mapKnownError(pgError(c))).toMatchObject({ status: 400, code: 'INVALID_INPUT' })
    }
  })
  it('missing required column -> 400 VALIDATION_ERROR', () => {
    expect(mapKnownError(pgError('23502'))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' })
  })
  it('foreign key to a record that does not exist -> 404', () => {
    expect(mapKnownError(pgError('23503', { detail: 'Key (user_id)=(abc) is not present in table "users".' }))).toMatchObject({ status: 404, code: 'NOT_FOUND' })
  })
  it('foreign key that is still referenced -> 409', () => {
    expect(mapKnownError(pgError('23503', { detail: 'Key (id)=(abc) is still referenced from table "orders".' }))).toMatchObject({ status: 409, code: 'CONFLICT' })
  })
  it('unique violation and business DUPLICATE -> 409', () => {
    expect(mapKnownError(pgError('23505'))).toMatchObject({ status: 409, code: 'DUPLICATE' })
    expect(mapKnownError({ code: 'DUPLICATE', message: 'Coupon code already exists' })).toMatchObject({ status: 409, message: 'Coupon code already exists' })
  })
  it('real server bugs stay unmapped (missing table / column, plain errors)', () => {
    expect(mapKnownError(pgError('42P01'))).toBeNull()
    expect(mapKnownError(pgError('42703'))).toBeNull()
    expect(mapKnownError(new Error('boom'))).toBeNull()
  })
  it('errors that already carry an HTTP status are left alone', () => {
    expect(mapKnownError({ statusCode: 404, code: 'ORDER_NOT_FOUND' })).toBeNull()
  })
})

describe('error handler plugin', () => {
  async function app(thrown) {
    const f = Fastify()
    await f.register(errorHandlerPlugin)
    f.get('/boom', async () => { throw thrown })
    return f
  }
  it('answers 400 and never leaks the SQL text for a malformed id', async () => {
    const f = await app(pgError('22P02'))
    const r = await f.inject({ url: '/boom' })
    expect(r.statusCode).toBe(400)
    expect(r.body).not.toMatch(/raw pg message|relation|violates/)
    expect(r.json()).toMatchObject({ success: false, code: 'INVALID_INPUT' })
  })
  it('answers 404 for an unknown parent record', async () => {
    const f = await app(pgError('23503', { detail: 'Key (user_id)=(x) is not present in table "users".' }))
    expect((await f.inject({ url: '/boom' })).statusCode).toBe(404)
  })
  it('answers 409 for a duplicate coupon code thrown as a plain object', async () => {
    const f = await app({ code: 'DUPLICATE', message: 'Coupon code already exists' })
    const r = await f.inject({ url: '/boom' })
    expect(r.statusCode).toBe(409)
    expect(r.json().code).toBe('DUPLICATE')
  })
  it('still answers 500 for a genuinely broken query', async () => {
    const f = await app(pgError('42P01'))
    const r = await f.inject({ url: '/boom' })
    expect(r.statusCode).toBe(500)
    expect(r.json().code).toBe('INTERNAL_ERROR')
  })
  it('keeps answering the HTTP status of errors that carry one', async () => {
    const f = await app({ statusCode: 404, message: 'Review not found', code: 'REVIEW_NOT_FOUND' })
    const r = await f.inject({ url: '/boom' })
    expect(r.statusCode).toBe(404)
    expect(r.json().code).toBe('REVIEW_NOT_FOUND')
  })
})
