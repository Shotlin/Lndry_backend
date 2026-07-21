import { describe, expect, it, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'

// Mock external dependencies before importing middleware
const JWT_SECRET = 'test-access-secret-32-chars-min-xx'
vi.mock('../../src/config/env.js', () => ({
  env: {
    JWT_ACCESS_SECRET: 'test-access-secret-32-chars-min-xx',
  },
}))

import { requireStepUp, issueStepUpToken } from '../../src/middlewares/requireStepUp.js'

const USER_ID = '11111111-1111-1111-1111-111111111111'

function makeRequest({ user = { id: USER_ID }, headers = {} } = {}) {
  return {
    user,
    headers,
    stepUpClaims: undefined,
  }
}

function makeReply() {
  const reply = {
    statusCode: null,
    payload: null,
    code(c) {
      this.statusCode = c
      return this
    },
    send(p) {
      this.payload = p
      return this
    },
  }
  return reply
}

describe('requireStepUp Middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fails with 403 STEP_UP_REQUIRED if x-step-up-token header is missing', async () => {
    const req = makeRequest({ headers: {} })
    const reply = makeReply()

    await requireStepUp(req, reply)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toEqual({
      success: false,
      message: 'Step-up authentication required. Verify TOTP via POST /api/v1/admin/auth/step-up first.',
      code: 'STEP_UP_REQUIRED',
    })
  })

  it('fails with 403 STEP_UP_INVALID if token signature is invalid', async () => {
    const invalidToken = jwt.sign(
      { sub: USER_ID, purpose: 'step-up', totp_verified: true },
      'wrong-secret-key-12345678901234567890',
      { expiresIn: '300s' }
    )
    const req = makeRequest({ headers: { 'x-step-up-token': invalidToken } })
    const reply = makeReply()

    await requireStepUp(req, reply)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toEqual({
      success: false,
      message: 'Invalid step-up token',
      code: 'STEP_UP_INVALID',
    })
  })

  it('fails with 403 STEP_UP_EXPIRED if token has expired via JWT library expiration', async () => {
    const expiredToken = jwt.sign(
      { sub: USER_ID, purpose: 'step-up', totp_verified: true },
      JWT_SECRET,
      { expiresIn: '-1s' }
    )
    const req = makeRequest({ headers: { 'x-step-up-token': expiredToken } })
    const reply = makeReply()

    await requireStepUp(req, reply)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toEqual({
      success: false,
      message: 'Step-up token has expired. Re-verify TOTP.',
      code: 'STEP_UP_EXPIRED',
    })
  })

  it('fails with 403 STEP_UP_EXPIRED if token has expired via manual freshness check', async () => {
    // A token signed with iat, but simulated 10 minutes in the future during verification
    const token = issueStepUpToken(USER_ID)
    const req = makeRequest({ headers: { 'x-step-up-token': token } })
    const reply = makeReply()

    const originalNow = Date.now
    // Advance time by 10 minutes
    Date.now = () => originalNow() + 600 * 1000

    try {
      await requireStepUp(req, reply)
    } finally {
      Date.now = originalNow
    }

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toEqual({
      success: false,
      message: 'Step-up token has expired. Re-verify TOTP.',
      code: 'STEP_UP_EXPIRED',
    })
  })

  it('fails with 403 STEP_UP_INVALID if purpose is not step-up', async () => {
    const token = jwt.sign(
      { sub: USER_ID, purpose: 'access', totp_verified: true },
      JWT_SECRET,
      { expiresIn: '300s' }
    )
    const req = makeRequest({ headers: { 'x-step-up-token': token } })
    const reply = makeReply()

    await requireStepUp(req, reply)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toEqual({
      success: false,
      message: 'Invalid step-up token — wrong purpose',
      code: 'STEP_UP_INVALID',
    })
  })

  it('fails with 403 STEP_UP_INVALID if sub does not match authenticated user id', async () => {
    const token = jwt.sign(
      { sub: 'different-user-id', purpose: 'step-up', totp_verified: true },
      JWT_SECRET,
      { expiresIn: '300s' }
    )
    const req = makeRequest({ headers: { 'x-step-up-token': token } })
    const reply = makeReply()

    await requireStepUp(req, reply)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toEqual({
      success: false,
      message: 'Step-up token does not match authenticated user',
      code: 'STEP_UP_INVALID',
    })
  })

  it('fails with 403 STEP_UP_INVALID if totp_verified is not true', async () => {
    const token = jwt.sign(
      { sub: USER_ID, purpose: 'step-up', totp_verified: false },
      JWT_SECRET,
      { expiresIn: '300s' }
    )
    const req = makeRequest({ headers: { 'x-step-up-token': token } })
    const reply = makeReply()

    await requireStepUp(req, reply)

    expect(reply.statusCode).toBe(403)
    expect(reply.payload).toEqual({
      success: false,
      message: 'Step-up token was not TOTP-verified',
      code: 'STEP_UP_INVALID',
    })
  })

  it('passes and attaches claims to request.stepUpClaims when token is valid', async () => {
    const token = issueStepUpToken(USER_ID)
    const req = makeRequest({ headers: { 'x-step-up-token': token } })
    const reply = makeReply()

    await requireStepUp(req, reply)

    expect(reply.statusCode).toBeNull()
    expect(req.stepUpClaims).toBeDefined()
    expect(req.stepUpClaims.sub).toBe(USER_ID)
    expect(req.stepUpClaims.purpose).toBe('step-up')
    expect(req.stepUpClaims.totp_verified).toBe(true)
  })
})
