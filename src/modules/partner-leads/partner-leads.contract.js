import crypto from 'node:crypto'

export const PARTNER_LEAD_SOURCE = 'website-partners'
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

function stringHeader(value) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

export function verifyPartnerLeadSignature({ headers = {}, rawBody, secret, now = Date.now() }) {
  if (!secret) return { ok: false, code: 'PARTNER_LEAD_INTAKE_NOT_CONFIGURED' }
  const source = stringHeader(headers['x-lndry-source'])
  const timestamp = stringHeader(headers['x-lndry-timestamp'])
  const externalLeadId = stringHeader(headers['x-lndry-external-lead-id'])
  const signature = stringHeader(headers['x-lndry-signature'])
  if (source !== PARTNER_LEAD_SOURCE || !timestamp || !externalLeadId || !signature || !rawBody) {
    return { ok: false, code: 'PARTNER_LEAD_SIGNATURE_REQUIRED' }
  }
  const issuedAt = Date.parse(timestamp)
  if (!Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, code: 'PARTNER_LEAD_SIGNATURE_EXPIRED' }
  }
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex')
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${externalLeadId}.${digest}`).digest('hex')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  const suppliedBuffer = Buffer.from(signature, 'utf8')
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return { ok: false, code: 'PARTNER_LEAD_SIGNATURE_INVALID' }
  }
  return { ok: true, externalLeadId }
}
