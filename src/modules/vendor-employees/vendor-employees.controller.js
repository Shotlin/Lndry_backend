import { success, error } from '../../utils/apiResponse.js'
import { loadVendorActor } from '../../middlewares/vendor-permission.js'
import { VENDOR_APP_PERMISSION_MODULES } from '../../utils/permissions.js'
import {
  createVendorEmployeeSchema,
  updateVendorEmployeeSchema,
  listVendorEmployeeQuerySchema,
  vendorEmployeeIdParamSchema,
} from './vendor-employees.schema.js'

/**
 * Resolve vendor_id for shop-scoped operations (list/get/update/delete).
 *
 * Resolution order:
 *   1. URL param `:shopId` — set when routes are mounted under
 *      `/vendors/:shopId/staff` (the dashboard's canonical pattern, see
 *      lndry-dashboard/src/services/shop-staff.service.ts). Wins over
 *      headers/JWT so a Super Admin operating on shop A can't accidentally
 *      hit shop B by leaving a stale X-Shop-Id header set.
 *   2. JWT vendor_id (request.user.shopId or request.user.vendor_id) — set after
 *      staff selects a shop
 *   3. X-Shop-Id header — used by Super Admin (platform ADMIN) when
 *      impersonating a shop
 *
 * Returns null when no vendor_id is available.
 *
 * NOTE: Task 2.3 will replace this helper with dedicated shop-scope middleware.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {string|null}
 */
function resolveShopId(request) {
  return (
    request.params?.shopId ||
    request.user?.shopId ||
    request.user?.vendor_id ||
    request.headers['x-shop-id'] ||
    null
  )
}

/**
 * Shop Staff controller — thin HTTP layer.
 * Handles request/response shape only and delegates to the service.
 */
/** Service refusals that are a rule violation (409), not bad input (400). */
const ROLE_RULE_CODES = new Set(['ROLE_CHANGE_NOT_ALLOWED', 'OWNER_PERMISSIONS_FIXED'])

export class VendorEmployeesController {
  constructor(service) {
    this.service = service
  }

  /**
   * POST / — Assign a staff member to a shop.
   * Body: { vendor_id, user_id, role, permissions[] }
   * Response: 201 Created
   */
  async create(request, reply) {
    const parsed = createVendorEmployeeSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(
        error(
          parsed.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
          'VALIDATION_ERROR'
        )
      )
    }

    // NOTE: this was previously missing — vendor_id was never resolved
    // here (unlike every other method below), so create() always 400'd
    // with SHOP_SCOPE_REQUIRED unless the caller happened to pass
    // vendor_id explicitly in the body. Fixed to match the doc comment's
    // intended resolution order (URL param / JWT / X-Shop-Id header).
    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('vendor_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    const result = await this.service.create(
      { ...parsed.data, vendor_id: shopId },
      {
        actorUserId: request.user?.id ?? null,
        actorRole: request.user?.shopRole ?? request.user?.shop_role ?? null,
        actorPlatformRole:
          request.user?.platform_role ?? request.user?.platformRole ?? null,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      }
    )

    if (!result.success) {
      const statusCode = result.code === 'STAFF_NOT_FOUND' ? 404 : 400
      return reply.code(statusCode).send(error(result.message, result.code))
    }

    return reply.code(201).send(success(result.data, 'Staff member assigned'))
  }

  /**
   * GET / — List staff for the authenticated shop.
   * Scoped via JWT vendor_id or X-Shop-Id header (super admin).
   */
  async list(request, reply) {
    const parsed = listVendorEmployeeQuerySchema.safeParse(request.query)
    if (!parsed.success) {
      return reply.code(400).send(
        error(
          parsed.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
          'VALIDATION_ERROR'
        )
      )
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('vendor_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    const result = await this.service.list(shopId, parsed.data)
    return reply.code(200).send(success(result, 'Staff list fetched'))
  }

  /**
   * GET /:id — Get a single staff record (scoped to vendor_id).
   */
  async getOne(request, reply) {
    const paramsParsed = vendorEmployeeIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid staff ID format', 'VALIDATION_ERROR'))
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('vendor_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    const record = await this.service.getById(paramsParsed.data.id, shopId)
    if (!record) {
      return reply.code(404).send(error('Staff record not found', 'STAFF_NOT_FOUND'))
    }

    return reply.code(200).send(success(record, 'Staff record fetched'))
  }

  /**
   * PATCH /:id — Update staff role, permissions, or is_active flag.
   *
   * PATCH semantics (R29 AC#2): only the fields present in the body are
   * applied; absent fields are unchanged. R29 AC#8 — empty body is
   * rejected with 400 VALIDATION_ERROR by the schema's `.refine` rule.
   *
   * Forwards `ip` and `request.user-agent` to the service so the
   * `staff_updated` audit row carries request metadata (R28 AC#4).
   */
  async update(request, reply) {
    const paramsParsed = vendorEmployeeIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid staff ID format', 'VALIDATION_ERROR'))
    }

    const bodyParsed = updateVendorEmployeeSchema.safeParse(request.body)
    if (!bodyParsed.success) {
      return reply.code(400).send(
        error(
          bodyParsed.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
          'VALIDATION_ERROR'
        )
      )
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('vendor_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    let result
    try {
      result = await this.service.update(
        paramsParsed.data.id,
        bodyParsed.data,
        shopId,
        request.user.id,
        {
          ip: request.ip ?? null,
          userAgent: request.headers['user-agent'] ?? null,
        },
      )
    } catch (err) {
      // Service throws `{ statusCode, code, message }` for the
      // empty-body and PERMISSION_INVALID branches (mirrors the
      // pattern used by the admin/auth controller's mapError).
      if (err && err.statusCode && err.code) {
        return reply
          .code(err.statusCode)
          .send(error(err.message || 'Validation failed', err.code))
      }
      throw err
    }

    if (!result.success) {
      const statusCode =
        result.code === 'STAFF_NOT_FOUND'
          ? 404
          : ROLE_RULE_CODES.has(result.code)
            ? 409
            : 400
      return reply.code(statusCode).send(error(result.message, result.code))
    }

    return reply.code(200).send(success(result.data, 'Staff record updated'))
  }

  /**
   * DELETE /:id — Soft-delete (deactivate) a staff member.
   */
  async delete(request, reply) {
    const paramsParsed = vendorEmployeeIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid staff ID format', 'VALIDATION_ERROR'))
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('vendor_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    const result = await this.service.delete(paramsParsed.data.id, shopId, request.user.id)

    if (!result.success) {
      const statusCode =
        result.code === 'STAFF_NOT_FOUND'
          ? 404
          : ROLE_RULE_CODES.has(result.code)
            ? 409
            : 400
      return reply.code(statusCode).send(error(result.message, result.code))
    }

    return reply.code(200).send(success(null, 'Staff member deactivated'))
  }

  /**
   * POST /:id/reset-password — Reset a staff member's password (R20 AC#9).
   *
   * Generates a fresh 12-char Temp_Password, bcrypt-hashes it (cost 12),
   * sets `users.force_password_change=true`, and bumps `session_version`
   * to invalidate every previously issued JWT for the User. Emits a
   * `staff_password_reset` audit row inside the same transaction.
   *
   * Returns the plaintext Temp_Password EXACTLY ONCE (R20 AC#9). UI
   * surfaces are responsible for displaying it to the operator and
   * never persisting it client-side.
   *
   * Authorization: the route's preHandlers gate this with
   * `requirePermission('vendor_employees.reset_password')`. HQ_Users with the
   * canonical permission and SHOP_ADMIN with the same string both clear
   * the gate (HQ_ROLE_PERMISSIONS / SHOP_ROLE_DEFAULT_PERMISSIONS).
   */
  async resetPassword(request, reply) {
    const paramsParsed = vendorEmployeeIdParamSchema.safeParse(request.params)
    if (!paramsParsed.success) {
      return reply.code(400).send(error('Invalid staff ID format', 'VALIDATION_ERROR'))
    }

    const shopId = resolveShopId(request)
    if (!shopId) {
      return reply
        .code(400)
        .send(error('vendor_id is required (JWT or X-Shop-Id header)', 'SHOP_ID_REQUIRED'))
    }

    const result = await this.service.resetPassword(
      paramsParsed.data.id,
      shopId,
      {
        actorUserId: request.user?.id ?? null,
        actorRole: request.user?.shopRole ?? request.user?.shop_role ?? null,
        actorPlatformRole:
          request.user?.platform_role ?? request.user?.platformRole ?? null,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
    )

    if (!result.success) {
      const statusCode = result.code === 'STAFF_NOT_FOUND' ? 404 : 400
      return reply.code(statusCode).send(error(result.message, result.code))
    }

    // R20 AC#9 — return the Temp_Password exactly once. The caller is
    // responsible for showing it to the operator without echoing it to
    // logs / analytics. No additional fields are returned to keep the
    // response surface minimal.
    return reply.code(200).send(
      success(
        { temp_password: result.temp_password },
        'Staff password reset — temp password shown exactly once'
      )
    )
  }

  /**
   * GET /permission-catalog — what an owner can grant a staff member, straight
   * from the backend so the app renders exactly (and only) what is enforced.
   */
  async permissionCatalog(request, reply) {
    return reply.code(200).send(success({ modules: VENDOR_APP_PERMISSION_MODULES }, 'Permission catalog fetched'))
  }

  /**
   * GET /me — the caller's own role and CURRENT access, read from the roster
   * (not the JWT), so a staff session picks up changes the owner just made
   * without signing out. `allowed_modules` / `allowed_items` are worked out
   * here from the catalog; the app only shows or hides screens by them.
   */
  async me(request, reply) {
    const actor = await loadVendorActor(request.user.id, request.user.shopId || request.user.vendor_id || null)
    if (!actor) {
      return reply.code(404).send(error('Not on a vendor roster', 'NOT_VENDOR'))
    }

    const isOwner = actor.role === 'VENDOR_OWNER'
    const held = new Set(actor.permissions)
    const allowedItems = []
    const allowedModules = []
    if (actor.role !== 'VENDOR_RIDER') {
      for (const mod of VENDOR_APP_PERMISSION_MODULES) {
        let any = false
        for (const item of mod.items) {
          if (isOwner || item.permissions.every((p) => held.has(p))) {
            allowedItems.push(item.key)
            any = true
          }
        }
        if (any) allowedModules.push(mod.key)
      }
    }

    return reply.code(200).send(
      success(
        {
          vendor_id: actor.vendorId,
          role: actor.role,
          is_owner: isOwner,
          permissions: isOwner ? undefined : actor.permissions,
          allowed_modules: allowedModules,
          allowed_items: allowedItems,
        },
        'Access fetched',
      ),
    )
  }
}
