import { logger } from '../config/logger.js'

/**
 * Best-effort ping to the public website so a blog change shows up immediately
 * instead of after its normal cache window. Entirely optional: does nothing
 * unless WEBSITE_REVALIDATE_URL and WEBSITE_REVALIDATE_SECRET are both set,
 * and never throws.
 */
export function notifyWebsiteBlogChanged(slugs = []) {
  const url = process.env.WEBSITE_REVALIDATE_URL
  const secret = process.env.WEBSITE_REVALIDATE_SECRET
  if (!url || !secret) return

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-revalidate-secret': secret },
    body: JSON.stringify({ slugs: slugs.filter(Boolean) }),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => logger.warn({ err: err?.message }, 'Website blog revalidation ping failed'))
}
