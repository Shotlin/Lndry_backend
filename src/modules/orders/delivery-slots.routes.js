/**
 * Delivery Slots API
 * GET /api/v1/delivery/slots
 *
 * Returns available delivery slots for today + next 6 days (IST).
 * Slots are fixed 2-hour windows from 7 AM to 9 PM IST.
 * Past slots (current time already in or past the window) are disabled.
 * No store-hours logic yet — uses default windows.
 *
 * Prefix: /api/v1/delivery (registered alongside delivery.routes.js)
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000 // UTC+5:30

/**
 * Pre-defined 2-hour slot windows (start hour, end hour, display label)
 * in IST. 24-hour format.
 */
const SLOT_WINDOWS = [
  { startH: 7,  endH: 9,  label: '7:00 AM – 9:00 AM'   },
  { startH: 9,  endH: 11, label: '9:00 AM – 11:00 AM'  },
  { startH: 11, endH: 13, label: '11:00 AM – 1:00 PM'  },
  { startH: 13, endH: 15, label: '1:00 PM – 3:00 PM'   },
  { startH: 15, endH: 17, label: '3:00 PM – 5:00 PM'   },
  { startH: 17, endH: 19, label: '5:00 PM – 7:00 PM'   },
  { startH: 19, endH: 21, label: '7:00 PM – 9:00 PM'   },
]

const DAY_LABELS = ['Today', 'Tomorrow']

/**
 * Build the slots response for the next `numDays` days (default 7).
 *
 * @param {Date} now - Current time (UTC)
 * @param {number} [numDays=7]
 * @returns {object[]}
 */
function buildSlots(now, numDays = 7) {
  const nowMs = now.getTime()
  const days = []

  for (let dayOffset = 0; dayOffset < numDays; dayOffset++) {
    // Compute midnight of (today + dayOffset) in IST
    const istNowMs = nowMs + IST_OFFSET_MS
    const istDate = new Date(istNowMs)
    // Zero out to midnight IST
    const istMidnightMs =
      Date.UTC(
        istDate.getUTCFullYear(),
        istDate.getUTCMonth(),
        istDate.getUTCDate() + dayOffset,
        0, 0, 0, 0
      ) - IST_OFFSET_MS // back to UTC

    const dateObj = new Date(istMidnightMs + IST_OFFSET_MS) // midnight IST as UTC
    const dateLabel = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObj.getUTCDate()).padStart(2, '0')}`
    const dayLabel = DAY_LABELS[dayOffset] ?? dateObj.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' })

    const slots = []
    for (const win of SLOT_WINDOWS) {
      // Slot start in UTC
      const slotStartUtcMs = istMidnightMs + win.startH * 60 * 60 * 1000
      const slotEndUtcMs   = istMidnightMs + win.endH   * 60 * 60 * 1000

      const slotStart = new Date(slotStartUtcMs)
      const slotEnd   = new Date(slotEndUtcMs)

      // A slot is available only if its start is at least 30 minutes from now
      const cutoffMs = nowMs + 30 * 60 * 1000
      const available = slotStartUtcMs > cutoffMs

      slots.push({
        id: `${slotStart.toISOString()}_${slotEnd.toISOString()}`,
        label: win.label,
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
        available,
        reason: available ? null : 'This time slot has passed',
      })
    }

    days.push({
      date: dateLabel,
      label: dayLabel,
      slots,
    })
  }

  return days
}

export default async function deliverySlotsRoutes(fastify) {
  /**
   * GET /api/v1/delivery/slots
   * Returns available delivery slots for the next 7 days.
   * Requires auth (any logged-in user).
   */
  fastify.get('/slots', {
    schema: {
      tags: ['Delivery'],
      summary: 'Get available delivery time slots',
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 7, default: 7 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                timezone: { type: 'string' },
                days: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      date: { type: 'string' },
                      label: { type: 'string' },
                      slots: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            label: { type: 'string' },
                            start: { type: 'string' },
                            end: { type: 'string' },
                            available: { type: 'boolean' },
                            reason: { type: ['string', 'null'] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const numDays = Math.min(7, Math.max(1, Number(request.query.days) || 7))
    const now = new Date()
    const days = buildSlots(now, numDays)

    return reply.send({
      success: true,
      data: {
        timezone: 'Asia/Kolkata',
        days,
      },
    })
  })
}
