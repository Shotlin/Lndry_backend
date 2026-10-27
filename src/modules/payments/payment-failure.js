/**
 * Turns a gateway failure (Razorpay's error_code / error_reason /
 * error_description) into a sentence a customer can act on, plus a stable
 * short code the app can switch on.
 *
 * The raw gateway text is kept in `payments.failure_code` for support; only
 * the friendly message is shown in the app.
 */
const RULES = [
  [/insufficient|low[_ ]balance|not enough/i, 'INSUFFICIENT_FUNDS', 'Your bank reported insufficient balance. Please use another card/UPI or top up and try again.'],
  [/cancel|dismiss|user[_ ]closed/i, 'CANCELLED', 'The payment was cancelled before it was completed. No money has been taken.'],
  [/time[_ ]?out|timed out|expired|no response/i, 'TIMED_OUT', 'The payment timed out. If money was deducted it will be confirmed or refunded automatically within a few hours.'],
  [/otp|3ds|3d[_ ]secure|authenticat|password|pin\b|verification failed/i, 'AUTH_FAILED', 'Your bank could not verify the payment (OTP / authentication failed). Please try again.'],
  [/international|cross[_ ]border/i, 'INTERNATIONAL_BLOCKED', 'This card is not enabled for the payment. Please use another card or UPI.'],
  [/limit|exceed/i, 'LIMIT_EXCEEDED', 'A transaction limit on your card/account was exceeded. Please use another method.'],
  [/upi|vpa|collect|intent/i, 'UPI_FAILED', 'The UPI payment failed or was not approved in your UPI app. Please try again.'],
  [/declin|issuer|bank|card[_ ]not|invalid[_ ]card|blocked|restricted/i, 'BANK_DECLINED', 'Your bank declined the payment. Please try another card/UPI or contact your bank.'],
  [/network|gateway|server|technical|unavailable|internal/i, 'GATEWAY_ERROR', 'The payment gateway had a technical problem. Please try again in a moment.'],
]

export const DEFAULT_FAILURE_MESSAGE =
  'The payment could not be completed. Please try again or use a different payment method.'

/**
 * @param {{ code?: string, reason?: string, description?: string, source?: string, step?: string }} f
 * @returns {{ code: string, message: string, rawCode: string|null, source: string|null }}
 */
export function friendlyPaymentFailure(f = {}) {
  const haystack = [f.code, f.reason, f.description].filter(Boolean).join(' ')
  for (const [pattern, code, message] of RULES) {
    if (pattern.test(haystack)) {
      return { code, message, rawCode: f.code || f.reason || null, source: f.source || null }
    }
  }
  return {
    code: 'UNKNOWN',
    message: DEFAULT_FAILURE_MESSAGE,
    rawCode: f.code || f.reason || null,
    source: f.source || null,
  }
}

/** Pull the failure fields out of a Razorpay payment entity (webhook or API). */
export function failureFromGatewayPayment(entity = {}) {
  return friendlyPaymentFailure({
    code: entity.error_code,
    reason: entity.error_reason,
    description: entity.error_description,
    source: entity.error_source,
    step: entity.error_step,
  })
}
