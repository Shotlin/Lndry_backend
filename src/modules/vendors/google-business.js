/**
 * Optional Google Business Profile connection for a vendor — an external
 * trust signal shown alongside (never instead of) the existing LNDRY
 * reviews system.
 *
 * Deliberately NOT automated: a real, reliable free way to pull a live
 * rating off a Google listing doesn't exist (no API key allowed here, and
 * a plain server-side fetch of a Google Maps/Search page returns no
 * rating data at all — verified directly, it's not a "format changed"
 * problem, the data simply isn't in the HTML a script can fetch). So the
 * admin/vendor pastes the Google Maps/Business link AND types in the
 * rating/review count they see on their own Google listing, exactly like
 * updating a phone number — no scraping, no third-party API, no
 * background sync job. This module is just validation + the setter.
 */

const SHORT_LINK_HOSTS = new Set(['goo.gl', 'maps.app.goo.gl', 'g.co', 'share.google'])

/** A plausible Google Maps/Business/share link — not a guarantee it's real. */
export function isPlausibleGoogleMapsUrl(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    return host.includes('google.') || SHORT_LINK_HOSTS.has(host)
  } catch {
    return false
  }
}

/**
 * Validates and normalizes the four admin/vendor-typed fields. Throws a
 * `{statusCode, message, code}` object (matching this codebase's error
 * convention) on anything malformed. An empty/blank url clears the whole
 * connection — rating/reviewCount/businessName only ever mean something
 * alongside a real link.
 */
export function validateGoogleBusinessInput({ url, rating, reviewCount, businessName }) {
  const cleanUrl = (url ?? '').toString().trim() || null

  if (!cleanUrl) {
    return { url: null, rating: null, reviewCount: null, businessName: null }
  }

  if (!isPlausibleGoogleMapsUrl(cleanUrl)) {
    throw { statusCode: 400, message: 'Enter a valid Google Maps / Business Profile link.', code: 'INVALID_GOOGLE_URL' }
  }

  let cleanRating = null
  if (rating !== undefined && rating !== null && rating !== '') {
    cleanRating = Number(rating)
    if (!Number.isFinite(cleanRating) || cleanRating < 0 || cleanRating > 5) {
      throw { statusCode: 400, message: 'Rating must be a number between 0 and 5.', code: 'INVALID_GOOGLE_RATING' }
    }
    cleanRating = Math.round(cleanRating * 10) / 10
  }

  let cleanReviewCount = null
  if (reviewCount !== undefined && reviewCount !== null && reviewCount !== '') {
    cleanReviewCount = Number(reviewCount)
    if (!Number.isInteger(cleanReviewCount) || cleanReviewCount < 0) {
      throw { statusCode: 400, message: 'Review count must be a whole number, 0 or more.', code: 'INVALID_GOOGLE_REVIEW_COUNT' }
    }
  }

  const cleanBusinessName = (businessName ?? '').toString().trim() || null

  return { url: cleanUrl, rating: cleanRating, reviewCount: cleanReviewCount, businessName: cleanBusinessName }
}

/**
 * Saves the vendor's Google Business link + admin-entered rating/review
 * count. `cleared` is true when the link was removed (blank url).
 */
export async function setGoogleBusinessForVendor(vendorsRepo, vendorId, input) {
  const clean = validateGoogleBusinessInput(input)
  const vendor = await vendorsRepo.setGoogleBusiness(vendorId, clean)
  return { vendor, cleared: !clean.url }
}
