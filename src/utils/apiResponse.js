/**
 * Consistent API response helpers
 * Every API response follows the same shape
 */

/**
 * Success response
 * @param {*} data
 * @param {string} message
 * @param {object} meta - Additional metadata (pagination, etc.)
 * @returns {object}
 */
export function success(data, message = 'Success', meta = {}) {
  const requestId = meta.request_id || meta.requestId || undefined
  const page = meta.page !== undefined ? Number(meta.page) : undefined
  const total = meta.total !== undefined ? Number(meta.total) : undefined
  const totalPages = meta.totalPages !== undefined || meta.total_pages !== undefined
    ? Number(meta.totalPages || meta.total_pages)
    : undefined

  const metaObj = {
    request_id: requestId,
    page,
    total,
    total_pages: totalPages,
  }

  // Merge rest of meta fields
  for (const [k, v] of Object.entries(meta)) {
    if (k !== 'request_id' && k !== 'requestId' && k !== 'page' && k !== 'total' && k !== 'totalPages' && k !== 'total_pages') {
      metaObj[k] = v
    }
  }

  // Remove undefined fields
  Object.keys(metaObj).forEach(key => {
    if (metaObj[key] === undefined) {
      delete metaObj[key]
    }
  })

  return {
    success: true,
    message,
    data,
    meta: Object.keys(metaObj).length > 0 ? metaObj : undefined,
    ...meta
  }
}

export function error(message, code = 'ERROR', fieldErrors = undefined, requestId = undefined) {
  return {
    success: false,
    message,
    code,
    error: {
      code,
      message,
      field_errors: fieldErrors,
      request_id: requestId
    }
  }
}
