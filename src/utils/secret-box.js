import crypto from 'node:crypto'
import { env } from '../config/env.js'

/**
 * Small AES-256-GCM wrapper for credentials stored in the database
 * (Razorpay secrets, 2Factor API key). Format: "v1:<iv>:<tag>:<ciphertext>"
 * (base64). The key comes from SETTINGS_ENCRYPTION_KEY; outside production it
 * falls back to JWT_ACCESS_SECRET so local dev works with no extra setup, but
 * production refuses to store a secret without a dedicated key.
 */
function keyBytes() {
  const material = env.SETTINGS_ENCRYPTION_KEY || (env.NODE_ENV !== 'production' ? env.JWT_ACCESS_SECRET : null)
  if (!material) {
    throw { statusCode: 500, message: 'SETTINGS_ENCRYPTION_KEY is not configured on the server', code: 'ENCRYPTION_KEY_MISSING' }
  }
  return crypto.createHash('sha256').update(String(material)).digest()
}

export function encryptSecret(plain) {
  if (plain === null || plain === undefined || plain === '') return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv)
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

export function decryptSecret(blob) {
  if (!blob) return null
  const [version, iv, tag, ct] = String(blob).split(':')
  if (version !== 'v1' || !iv || !tag || !ct) {
    throw new Error('Stored secret has an unknown format')
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Could not decrypt a stored secret (was SETTINGS_ENCRYPTION_KEY changed?)')
  }
}

/** "••••1234" preview — never reveals more than the last 4 characters. */
export function maskSecret(plain) {
  return plain ? `••••${String(plain).slice(-4)}` : null
}
