import { LIFECYCLE_EVENTS, PLACEHOLDERS } from './catalog.js'

const TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g

/** Replace {{placeholders}}; an unknown or empty value renders as nothing. */
export function render(template, vars) {
  return String(template ?? '')
    .replace(TOKEN, (_, name) => {
      const v = vars?.[name]
      return v === undefined || v === null ? '' : String(v)
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim()
}

/** Placeholder names used in a template. */
export function placeholdersIn(template) {
  return [...String(template ?? '').matchAll(TOKEN)].map((m) => m[1])
}

/**
 * Problems with an admin-written template, in plain language (empty = fine).
 * A typo like {{custmerName}} would otherwise silently send a blank.
 */
export function templateProblems(eventKey, { title, body }) {
  const def = LIFECYCLE_EVENTS[eventKey]
  if (!def) return ['Unknown notification event.']
  const problems = []
  if (!String(title ?? '').trim()) problems.push('The title cannot be empty.')
  if (!String(body ?? '').trim()) problems.push('The message cannot be empty.')
  const allowed = new Set(def.placeholders)
  const unknown = new Set()
  for (const name of [...placeholdersIn(title), ...placeholdersIn(body)]) {
    if (!allowed.has(name)) unknown.add(name)
  }
  for (const name of unknown) {
    problems.push(PLACEHOLDERS[name]
      ? `{{${name}}} is not available for this notification.`
      : `{{${name}}} is not a known placeholder.`)
  }
  return problems
}

/** Realistic values for previews and test sends. */
export const SAMPLE_VARS = {
  customerName: 'Sayan',
  vendorName: 'Shotlin Laundry',
  captainName: 'Sanu',
  orderId: 'LNDR-20260920-7DE',
  pickupDate: '21 Sep',
  pickupSlot: '10:00 AM – 12:00 PM',
  amount: '250',
  remainingAmount: '150',
  otp: '482913',
  reason: 'The laundry is fully booked.',
}
