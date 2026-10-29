/**
 * Input sanitization onRequest hook
 * Recursively trims strings and strips potential XSS from request body
 */
export async function sanitize(request) {
  if (request.body && typeof request.body === 'object') {
    // A route that accepts rich text (the blog's article body) names those
    // top-level fields in `config.rawBodyFields`. They skip the blanket
    // tag-stripping below — otherwise every heading, list and link is deleted
    // before the route can see it — and that route MUST sanitize them itself
    // with an allowlist sanitizer (the blog service does: sanitizeBlogHtml).
    const raw = request.routeOptions?.config?.rawBodyFields
    request.body = sanitizeObject(request.body, Array.isArray(raw) ? raw : null)
  }
}

/**
 * Recursively sanitize an object's string values
 */
function sanitizeObject(obj, rawFields = null) {
  if (Array.isArray(obj)) {
    return obj.map(sanitizeValue)
  }

  if (obj !== null && typeof obj === 'object') {
    const cleaned = {}
    for (const [key, value] of Object.entries(obj)) {
      cleaned[key] = rawFields?.includes(key) && typeof value === 'string' ? value : sanitizeValue(value)
    }
    return cleaned
  }

  return sanitizeValue(obj)
}

function sanitizeValue(value) {
  if (typeof value === 'string') {
    return value
      .trim()
      // Strip HTML tags
      .replace(/<[^>]*>/g, '')
      // Strip script-related patterns
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '')
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue)
  }

  if (value !== null && typeof value === 'object') {
    return sanitizeObject(value)
  }

  return value
}
