import { VendorEmployeesController } from './vendor-employees.controller.js'
import { VendorEmployeesService } from './vendor-employees.service.js'
import { VendorEmployeesRepository } from './vendor-employees.repository.js'

/**
 * Vendor Employee routes plugin
 * Prefix: /api/v1/vendor/employees (canonical) or /api/v1/shop-staff (legacy alias)
 *
 * Authorization (current state — task 2.2):
 *   - All routes require a valid JWT (fastify.authenticate)
 *   - Platform ADMIN (super admin) is always allowed
 *   - Shop staff role checks (SHOP_ADMIN can write, SHOP_MANAGER read-only) will
 *     be fully enforced once shop-scoped JWTs land in task 2.3
 *
 * Shop scope is currently derived in the controller from:
 *   1. JWT vendor_id (will exist after task 2.3)
 *   2. X-Shop-Id header (super admin)
 *   3. request body vendor_id (POST only — for create)
 */
export default async function vendorEmployeesRoutes(fastify) {
  const repository = new VendorEmployeesRepository()
  const service = new VendorEmployeesService(repository)
  const controller = new VendorEmployeesController(service)

  /**
   * Allow platform ADMIN or vendor employee with VENDOR_OWNER role for write ops.
   */
  const canWrite = async function requireVendorOwnerOrPlatformAdmin(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    // `users.role` is hard-coded to 'ADMIN' for EVERY vendor-employee login
    // (createUserWithPassword), not just genuine platform Super Admins — so
    // the ADMIN bypass must only apply when there's no shop context at all.
    // Otherwise a VENDOR_STAFF/VENDOR_RIDER session would incorrectly clear
    // this gate via the coincidental `role==='ADMIN'` value.
    if (role === 'ADMIN' && !shopRole) return
    if (shopRole === 'VENDOR_OWNER') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — Vendor Owner or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  /**
   * Allow platform ADMIN or vendor employee with VENDOR_OWNER/VENDOR_STAFF role for reads.
   */
  const canRead = async function requireVendorStaffOrPlatformAdmin(request, reply) {
    const role = request.user?.role
    const shopRole = request.user?.shopRole || request.user?.shop_role
    // See canWrite above — ADMIN bypass only applies with no shop context.
    if (role === 'ADMIN' && !shopRole) return
    if (shopRole === 'VENDOR_OWNER' || shopRole === 'VENDOR_STAFF') return
    return reply.code(403).send({
      success: false,
      message: 'Forbidden — Vendor Owner/Staff or Super Admin access required',
      code: 'FORBIDDEN',
    })
  }

  const writePreHandlers = [fastify.authenticate, canWrite]
  const readPreHandlers = [fastify.authenticate, canRead]

  // POST / — Assign staff to shop (Shop Admin / Super Admin)
  // Rate limited to prevent abuse of staff invitation endpoint
  fastify.post('/', {
    schema: {
      tags: ['Vendor Employees'],
      summary: 'Assign staff to shop [Shop Admin]',
      security: [{ bearerAuth: [] }],
    },
    preHandler: writePreHandlers,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  }, controller.create.bind(controller))

  // GET / — List staff (Shop Admin/Manager / Super Admin)
  fastify.get('/', {
    schema: {
      tags: ['Vendor Employees'],
      summary: 'List shop staff [Shop Admin/Manager]',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          role: { type: 'string', enum: ['VENDOR_OWNER', 'VENDOR_STAFF', 'VENDOR_RIDER'] },
          is_active: { type: 'string', enum: ['true', 'false'] },
          include_deleted: { type: 'string', enum: ['true', 'false'] },
        },
      },
    },
    preHandler: readPreHandlers,
  }, controller.list.bind(controller))

  // GET /:id — Get a single staff record (Shop Admin/Manager / Super Admin)
  fastify.get('/:id', {
    schema: {
      tags: ['Vendor Employees'],
      summary: 'Get staff record by ID [Shop Admin/Manager]',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: readPreHandlers,
  }, controller.getOne.bind(controller))

  // PATCH /:id — Update staff role/permissions/is_active (Shop Admin / Super Admin)
  // Canonical update method per design §6.3 / R29 AC#1.
  fastify.patch('/:id', {
    schema: {
      tags: ['Vendor Employees'],
      summary: 'Update staff role/permissions [Shop Admin]',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: writePreHandlers,
  }, controller.update.bind(controller))

  // PUT /:id — Explicitly NOT supported. Returns 405 Method Not Allowed with
  // `Allow: PATCH` header per R29 AC#7 / design §6.3. Wrapped in the same
  // auth + write preHandlers as PATCH so unauthenticated callers still see
  // 401/403 first (don't leak method support to unauthorized clients).
  fastify.put('/:id', {
    schema: {
      tags: ['Vendor Employees'],
      summary: 'Use PATCH instead — PUT is not supported',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: writePreHandlers,
  }, async (request, reply) => {
    return reply
      .code(405)
      .header('Allow', 'PATCH')
      .send({
        success: false,
        message: 'Use PATCH /api/v1/vendors/:shopId/staff/:staffId',
        code: 'METHOD_NOT_ALLOWED',
      })
  })

  // DELETE /:id — Soft-delete (deactivate) staff (Shop Admin / Super Admin)
  fastify.delete('/:id', {
    schema: {
      tags: ['Vendor Employees'],
      summary: 'Deactivate staff member [Shop Admin]',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: writePreHandlers,
  }, controller.delete.bind(controller))

  // POST /:id/reset-password — Reset staff password (Shop Admin / HQ User)
  //
  // Per design §6.3 / R20 AC#9: generates a new 12-char Temp_Password,
  // sets `users.force_password_change=true`, bumps `session_version`
  // (invalidating every previously issued JWT for the User), and emits
  // a `staff_password_reset` audit row. The plaintext Temp_Password is
  // returned in the response body EXACTLY ONCE.
  //
  // Rate-limited to the same 10/min/IP budget as the create-staff
  // route to bound brute-force exposure on the staff-id surface.
  // requirePermission('vendor_employees.reset_password') would normally gate
  // this; until the permission-check middleware is wired everywhere,
  // we reuse `canWrite` (Shop Admin / Super Admin) which is a strict
  // superset of the permission audience.
  fastify.post('/:id/reset-password', {
    schema: {
      tags: ['Vendor Employees'],
      summary: 'Reset staff password [Shop Admin]',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
    },
    preHandler: writePreHandlers,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  }, controller.resetPassword.bind(controller))
}
