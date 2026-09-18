import { query } from '../../config/database.js'
import { VendorAttendanceController } from './vendor-attendance.controller.js'
import { VendorAttendanceService } from './vendor-attendance.service.js'
import { VendorAttendanceRepository } from './vendor-attendance.repository.js'
import { markAttendanceSchema, attendanceRosterSchema } from './vendor-attendance.schema.js'

/**
 * Vendor-facing staff attendance routes — mounted at /api/v1/vendor/attendance.
 */
export default async function vendorAttendanceRoutes(fastify) {
  const service = new VendorAttendanceService(new VendorAttendanceRepository())
  const controller = new VendorAttendanceController(service)

  fastify.addHook('preHandler', fastify.authenticate)

  fastify.addHook('preHandler', async (request, reply) => {
    const shopRole = request.user?.shopRole || request.user?.shop_role
    if (shopRole === 'VENDOR_RIDER') {
      return reply.code(403).send({ success: false, message: 'Riders do not have access to attendance', code: 'FORBIDDEN' })
    }
  })

  fastify.addHook('preHandler', async (request, reply) => {
    const { rows } = await query(
      `SELECT vendor_id FROM vendor_employees WHERE user_id = $1 AND is_active = true LIMIT 1`,
      [request.user.id]
    )
    if (!rows.length) {
      return reply.code(403).send({ success: false, message: 'Not a vendor', code: 'NOT_VENDOR' })
    }
    request.vendorId = rows[0].vendor_id
  })

  fastify.post('/mark', { schema: markAttendanceSchema }, controller.mark.bind(controller))
  fastify.get('/roster', { schema: attendanceRosterSchema }, controller.roster.bind(controller))
}
