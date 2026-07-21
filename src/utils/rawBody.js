import { Readable } from 'node:stream'

/**
 * Route-level `preParsing` hook: captures the exact request bytes onto
 * `request.rawBody` before Fastify's body parser consumes the stream, then
 * re-emits the same bytes so normal JSON parsing still populates
 * `request.body` as usual. Needed for signature-verified webhooks (e.g.
 * Razorpay), where the signature must be computed over the exact bytes the
 * sender signed — not a re-serialization of the parsed JSON.
 */
export async function captureRawBody(request, reply, payload) {
  const chunks = []
  for await (const chunk of payload) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  request.rawBody = buffer
  return Readable.from(buffer)
}
