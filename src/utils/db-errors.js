/**
 * Client mistakes that surface as database errors must be 4xx, not 500 (and must not leak SQL text).
 * Only constraint / value errors are mapped; a broken query (missing table or column: 42P01, 42703, ...) stays a
 * 500 on purpose, because that is a server bug that must alert someone.
 */
export function mapKnownError(error) {
  if (!error || error.statusCode) return null
  const pg = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null
  switch (pg) {
    case '22P02': // invalid_text_representation: malformed uuid / number / enum value
    case '22003': // numeric_value_out_of_range
    case '22001': // string_data_right_truncation
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
    case '22023': // invalid_parameter_value
    case '23514': // check_violation
      return { status: 400, code: 'INVALID_INPUT', message: 'One of the values sent is invalid' }
    case '23502': // not_null_violation
      return { status: 400, code: 'VALIDATION_ERROR', message: 'A required field is missing' }
    case '23503': // foreign_key_violation
      return /is not present in table/i.test(error.detail || '')
        ? { status: 404, code: 'NOT_FOUND', message: 'A referenced record was not found' }
        : { status: 409, code: 'CONFLICT', message: 'This record is still in use and cannot be changed' }
    case '23505': // unique_violation
      return { status: 409, code: 'DUPLICATE', message: 'A record with these details already exists' }
    default:
  }
  // Business errors thrown as plain objects with a code but no HTTP status
  if (error.code === 'DUPLICATE') return { status: 409, code: 'DUPLICATE', message: error.message || 'Already exists' }
  if (error.code === 'NOT_FOUND') return { status: 404, code: 'NOT_FOUND', message: error.message || 'Not found' }
  return null
}

/**
 * For controllers that catch errors themselves: send the right 4xx for client mistakes (bad id, missing
 * field, unknown parent, duplicate), keep the HTTP status of errors that carry one, and never put raw
 * server / SQL text in a 500 response.
 */
export function sendCaughtError(reply, err, fallbackMessage = 'Request failed') {
  const mapped = mapKnownError(err)
  const body = (message, code = 'ERROR') => ({ success: false, message, code, error: { code, message } })
  if (mapped) return reply.code(mapped.status).send(body(mapped.message, mapped.code))
  const status = err?.statusCode || 500
  if (status >= 500) {
    reply.log?.error?.({ err }, fallbackMessage)
    return reply.code(status).send(body(fallbackMessage, 'INTERNAL_ERROR'))
  }
  return reply.code(status).send(body(err?.message || fallbackMessage))
}
