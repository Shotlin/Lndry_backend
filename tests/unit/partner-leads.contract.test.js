import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import test from 'node:test'
import { verifyPartnerLeadSignature } from '../../src/modules/partner-leads/partner-leads.contract.js'

const secret = 'partner-lead-test-secret-that-is-long-enough-for-hmac'
const externalLeadId = '8de546b3-4883-48cd-9bf9-735823faac14'
const now = Date.parse('2026-09-15T12:00:00.000Z')
const rawBody = Buffer.from('{"fullName":"Test Partner"}', 'utf8')

function headers(timestamp = new Date(now).toISOString(), body = rawBody) {
  const digest = crypto.createHash('sha256').update(body).digest('hex')
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${externalLeadId}.${digest}`).digest('hex')
  return {
    'x-lndry-source': 'website-partners',
    'x-lndry-timestamp': timestamp,
    'x-lndry-external-lead-id': externalLeadId,
    'x-lndry-signature': signature,
  }
}

test('accepts a current signed website lead', () => {
  assert.deepEqual(verifyPartnerLeadSignature({ headers: headers(), rawBody, secret, now }), { ok: true, externalLeadId })
})

test('rejects a replay outside the five-minute window', () => {
  assert.deepEqual(verifyPartnerLeadSignature({ headers: headers('2026-09-15T11:54:59.999Z'), rawBody, secret, now }), { ok: false, code: 'PARTNER_LEAD_SIGNATURE_EXPIRED' })
})

test('rejects a valid signature replayed with a changed body', () => {
  assert.deepEqual(verifyPartnerLeadSignature({ headers: headers(), rawBody: Buffer.from('{"fullName":"Tampered"}', 'utf8'), secret, now }), { ok: false, code: 'PARTNER_LEAD_SIGNATURE_INVALID' })
})

test('fails closed when the server-to-server secret is absent', () => {
  assert.deepEqual(verifyPartnerLeadSignature({ headers: headers(), rawBody, secret: '', now }), { ok: false, code: 'PARTNER_LEAD_INTAKE_NOT_CONFIGURED' })
})
