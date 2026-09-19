import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing service ──
// The service imports invalidateStaffActiveCache from the shop-scope
// middleware. We mock it so we don't need a real Redis connection and
// can assert on its invocation.
vi.mock('../../src/middlewares/shop-scope.js', () => ({
  invalidateStaffActiveCache: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// `audit-log` opens a pg pool when imported — replace it with a no-op
// mock so unit tests do not require a live database connection.
vi.mock('../../src/utils/audit-log.js', () => ({
  emit: vi.fn(),
  emitInTx: vi.fn(),
}))

// `getClient()` is called by `deactivate()` and `resetPassword()` to
// run an atomic tx around the soft-delete / password update + audit
// emit (task 5.4 / 5.5 / R28 AC#6). We hand back a fake pg client whose
// `query` accepts `BEGIN` / `COMMIT` / `ROLLBACK` plus arbitrary
// repository SQL so the transaction wrapper resolves without a real
// connection. The fake exposes a `__queries` log for tests that need
// to assert tx ordering, but the existing tests only need it to not
// throw.
vi.mock('../../src/config/database.js', () => {
  const makeFakeClient = () => {
    const calls = []
    return {
      query: vi.fn(async (sql) => {
        calls.push(sql)
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
      __queries: calls,
    }
  }
  return {
    pool: { query: vi.fn() },
    query: vi.fn(),
    getClient: vi.fn(async () => makeFakeClient()),
    closePool: vi.fn(),
  }
})

import { VendorEmployeesService } from '../../src/modules/vendor-employees/vendor-employees.service.js'
import {
  createVendorEmployeeSchema,
  updateVendorEmployeeSchema,
  PERMISSION_ENUM,
  VALID_ROLES,
} from '../../src/modules/vendor-employees/vendor-employees.schema.js'
import { invalidateStaffActiveCache } from '../../src/middlewares/shop-scope.js'

// ─── Test fixtures ────────────────────────────────────────────
const SHOP_ID = '550e8400-e29b-41d4-a716-446655440000'
const SHOP_ID_2 = '550e8400-e29b-41d4-a716-446655440001'
const TARGET_USER_ID = '11111111-1111-1111-1111-111111111111'
const REQUESTER_ID = '22222222-2222-2222-2222-222222222222'
const STAFF_ID = '99999999-9999-9999-9999-999999999999'

function makeRepoMock() {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByUserAndShop: vi.fn(),
    countActiveByShop: vi.fn(),
    countActiveByUser: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    findUserByEmailCI: vi.fn(),
    createUserAndAssign: vi.fn(),
  }
}

const VALID_CREATE_PAYLOAD = {
  vendor_id: SHOP_ID,
  user_id: TARGET_USER_ID,
  role: 'VENDOR_STAFF',
  permissions: ['shop_orders.view', 'vendor_services.view'],
}

const MOCK_STAFF_RECORD = {
  id: STAFF_ID,
  user_id: TARGET_USER_ID,
  vendor_id: SHOP_ID,
  role: 'VENDOR_STAFF',
  permissions: ['shop_orders.view', 'vendor_services.view'],
  is_active: true,
  invited_by: REQUESTER_ID,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// VendorEmployeesService.create()
// Validates Requirements 2.2, 2.3, 2.5
// Error response shape: { success: false, message, code } (Req 13.4 spirit)
// ═══════════════════════════════════════════════════════════════
describe('VendorEmployeesService.create() — limits and constraints', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new VendorEmployeesService(repo)
  })

  // ─── UNIQUE(user_id, vendor_id) — Requirement 2.3 ──────────────
  it('rejects with STAFF_ALREADY_ASSIGNED when an active assignment already exists', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(MOCK_STAFF_RECORD)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)

    expect(result).toEqual({
      success: false,
      message: 'User is already assigned to this shop',
      code: 'STAFF_ALREADY_ASSIGNED',
    })
    // No further checks should run after duplicate detection
    expect(repo.countActiveByShop).not.toHaveBeenCalled()
    expect(repo.countActiveByUser).not.toHaveBeenCalled()
    expect(repo.create).not.toHaveBeenCalled()
  })

  // ─── max 50 staff per shop — Requirement 2.5 ─────────────────
  it('rejects with STAFF_LIMIT_REACHED when the shop already has 50 active staff', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(50)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_LIMIT_REACHED')
    expect(result.message).toContain('50')
    expect(repo.countActiveByUser).not.toHaveBeenCalled()
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('rejects when staff count exceeds 50 (defensive — value > limit)', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(75)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)
    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_LIMIT_REACHED')
  })

  it('admits the 50th staff (count = 49 before insert, hard limit is 50)', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(49)
    repo.countActiveByUser.mockResolvedValueOnce(0)
    repo.create.mockResolvedValueOnce(MOCK_STAFF_RECORD)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)
    expect(result.success).toBe(true)
    expect(repo.create).toHaveBeenCalledOnce()
  })

  // ─── max 10 vendors per user — Requirement 2.2 ─────────────────
  it('rejects with STAFF_SHOP_LIMIT when user is already in 10 active vendors', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.countActiveByUser.mockResolvedValueOnce(10)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)

    expect(result.success).toBe(false)
    expect(result.code).toBe('STAFF_SHOP_LIMIT')
    expect(result.message).toContain('10')
    expect(repo.create).not.toHaveBeenCalled()
  })

  it('admits the 10th shop assignment for a user (count = 9 before insert)', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.countActiveByUser.mockResolvedValueOnce(9)
    repo.create.mockResolvedValueOnce({
      ...MOCK_STAFF_RECORD,
      vendor_id: SHOP_ID_2,
    })

    const result = await service.create(
      { ...VALID_CREATE_PAYLOAD, vendor_id: SHOP_ID_2 },
      REQUESTER_ID
    )
    expect(result.success).toBe(true)
  })

  // ─── Happy paths ─────────────────────────────────────────────
  it('persists the record with provided permissions and returns success', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.countActiveByUser.mockResolvedValueOnce(0)
    repo.create.mockResolvedValueOnce(MOCK_STAFF_RECORD)

    const result = await service.create(VALID_CREATE_PAYLOAD, REQUESTER_ID)

    expect(result).toEqual({ success: true, data: MOCK_STAFF_RECORD })
    expect(repo.create).toHaveBeenCalledWith({
      user_id: TARGET_USER_ID,
      vendor_id: SHOP_ID,
      role: 'VENDOR_STAFF',
      permissions: ['shop_orders.view', 'vendor_services.view'],
      invited_by: REQUESTER_ID,
    })
  })

  it('defaults permissions to the VENDOR_STAFF default set when caller provides none', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.countActiveByUser.mockResolvedValueOnce(0)
    repo.create.mockResolvedValueOnce({ ...MOCK_STAFF_RECORD, permissions: [] })

    await service.create(
      { vendor_id: SHOP_ID, user_id: TARGET_USER_ID, role: 'VENDOR_STAFF' },
      REQUESTER_ID
    )

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: expect.arrayContaining([
          'shop_orders.view',
          'shop_orders.update_status',
        ]),
      })
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// VendorEmployeesService.create() — R20 / R16 extensions
// New-user provisioning + Temp_Password + role-creation rules.
// ═══════════════════════════════════════════════════════════════
describe('VendorEmployeesService.create() — R20 new-user shape', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new VendorEmployeesService(repo)
  })

  it('provisions a new user with Temp_Password and returns it exactly once', async () => {
    repo.findUserByEmailCI.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.createUserAndAssign.mockResolvedValueOnce({
      user: { id: TARGET_USER_ID, email: 'sam@example.com' },
      staff: MOCK_STAFF_RECORD,
    })

    const result = await service.create(
      {
        vendor_id: SHOP_ID,
        email: 'sam@example.com',
        name: 'Sam',
        role: 'VENDOR_STAFF',
        generate_temp_password: true,
      },
      { invitedBy: REQUESTER_ID, invitedByPlatformRole: 'ADMIN' }
    )

    expect(result.success).toBe(true)
    // The returned data carries the Temp_Password exactly once.
    const pw = result.data.temp_password
    expect(pw).toMatch(/^.{12}$/) // exactly 12 chars
    // Verify each character class is represented (R20.3 complexity).
    expect(pw).toMatch(/[a-z]/)
    expect(pw).toMatch(/[A-Z]/)
    expect(pw).toMatch(/\d/)
    expect(pw).toMatch(/[!@#$%^&*()_=+\-]/)
    expect(repo.createUserAndAssign).toHaveBeenCalledWith(
      expect.objectContaining({
        forcePasswordChange: true,
        // bcrypt hashes start with $2a$/$2b$/$2y$ at cost 12.
        passwordHash: expect.stringMatching(/^\$2[aby]\$12\$/),
      })
    )
  })

  it('rejects with EMAIL_TAKEN when email already exists', async () => {
    repo.findUserByEmailCI.mockResolvedValueOnce({
      id: 'existing-user',
      email: 'taken@example.com',
    })

    await expect(
      service.create(
        {
          vendor_id: SHOP_ID,
          email: 'taken@example.com',
          name: 'Sam',
          role: 'VENDOR_STAFF',
          generate_temp_password: true,
        },
        { invitedBy: REQUESTER_ID, invitedByPlatformRole: 'ADMIN' }
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'EMAIL_TAKEN' })
    expect(repo.createUserAndAssign).not.toHaveBeenCalled()
  })

  it('rejects when caller-supplied permissions include unknown strings', async () => {
    await expect(
      service.create(
        {
          vendor_id: SHOP_ID,
          email: 'sam2@example.com',
          name: 'Sam',
          role: 'VENDOR_STAFF',
          permissions: ['vendor_services.view', 'made.up.permission'],
          generate_temp_password: true,
        },
        { invitedBy: REQUESTER_ID, invitedByPlatformRole: 'ADMIN' }
      )
    ).rejects.toMatchObject({ statusCode: 400, code: 'PERMISSION_INVALID' })
  })
})

describe('VendorEmployeesService.create() — role-creation rules (R16.9–R16.13, R16.20)', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new VendorEmployeesService(repo)
  })

  it('VENDOR_OWNER cannot create another VENDOR_OWNER', async () => {
    await expect(
      service.create(
        { ...VALID_CREATE_PAYLOAD, role: 'VENDOR_OWNER' },
        { invitedBy: REQUESTER_ID, invitedByRole: 'VENDOR_OWNER' }
      )
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'STAFF_ROLE_FORBIDDEN',
    })
  })

  it('VENDOR_STAFF cannot create VENDOR_OWNER or VENDOR_STAFF', async () => {
    for (const role of ['VENDOR_OWNER', 'VENDOR_STAFF']) {
      await expect(
        service.create(
          { ...VALID_CREATE_PAYLOAD, role },
          { invitedBy: REQUESTER_ID, invitedByRole: 'VENDOR_STAFF' }
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'STAFF_ROLE_FORBIDDEN',
      })
    }
  })

  it('ADMIN may create VENDOR_OWNER', async () => {
    repo.findByUserAndShop.mockResolvedValueOnce(null)
    repo.countActiveByShop.mockResolvedValueOnce(0)
    repo.countActiveByUser.mockResolvedValueOnce(0)
    repo.create.mockResolvedValueOnce({
      ...MOCK_STAFF_RECORD,
      role: 'VENDOR_OWNER',
    })

    const result = await service.create(
      { ...VALID_CREATE_PAYLOAD, role: 'VENDOR_OWNER' },
      { invitedBy: REQUESTER_ID, invitedByPlatformRole: 'ADMIN' }
    )
    expect(result.success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// VendorEmployeesService.list() — pagination/filter passthrough
// ═══════════════════════════════════════════════════════════════
describe('VendorEmployeesService.list()', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new VendorEmployeesService(repo)
  })

  it('forwards vendor_id and filters to repository, echoes page/limit', async () => {
    repo.findMany.mockResolvedValueOnce({
      staff: [MOCK_STAFF_RECORD],
      total: 1,
    })

    const result = await service.list(SHOP_ID, {
      page: 2,
      limit: 50,
      role: 'VENDOR_STAFF',
      is_active: 'true',
    })

    expect(repo.findMany).toHaveBeenCalledWith({
      shopId: SHOP_ID,
      page: 2,
      limit: 50,
      role: 'VENDOR_STAFF',
      is_active: 'true',
    })
    expect(result).toEqual({
      staff: [MOCK_STAFF_RECORD],
      total: 1,
      page: 2,
      limit: 50,
    })
  })

  it('returns an empty list with total=0 when no staff match', async () => {
    repo.findMany.mockResolvedValueOnce({ staff: [], total: 0 })

    const result = await service.list(SHOP_ID, { page: 1, limit: 20 })

    expect(result.staff).toEqual([])
    expect(result.total).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// VendorEmployeesService.getById() — shop-scope enforcement
// ═══════════════════════════════════════════════════════════════
describe('VendorEmployeesService.getById()', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new VendorEmployeesService(repo)
  })

  it('passes the vendor_id scope through to the repository', async () => {
    repo.findById.mockResolvedValueOnce(MOCK_STAFF_RECORD)

    const result = await service.getById(STAFF_ID, SHOP_ID)

    expect(repo.findById).toHaveBeenCalledWith(STAFF_ID, SHOP_ID)
    expect(result).toEqual(MOCK_STAFF_RECORD)
  })

  it('returns null when the record does not exist for that shop', async () => {
    repo.findById.mockResolvedValueOnce(null)
    expect(await service.getById(STAFF_ID, SHOP_ID)).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
// VendorEmployeesService.update() — error response shape + cache invalidation
// Requirements 2.4 (permissions), 2.11 (cache invalidation propagation)
// ═══════════════════════════════════════════════════════════════
describe('VendorEmployeesService.update()', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new VendorEmployeesService(repo)
  })

  it('returns STAFF_NOT_FOUND with consistent error shape when record missing', async () => {
    repo.findById.mockResolvedValueOnce(null)

    const result = await service.update(
      STAFF_ID,
      { is_active: false },
      SHOP_ID,
      REQUESTER_ID
    )

    expect(result).toEqual({
      success: false,
      message: 'Staff record not found',
      code: 'STAFF_NOT_FOUND',
    })
    expect(invalidateStaffActiveCache).not.toHaveBeenCalled()
  })

  it('returns success and triggers cache invalidation on permission update', async () => {
    repo.findById.mockResolvedValueOnce(MOCK_STAFF_RECORD)
    const updated = {
      ...MOCK_STAFF_RECORD,
      permissions: ['shop_financials.view'],
    }
    repo.update.mockResolvedValueOnce(updated)

    const result = await service.update(
      STAFF_ID,
      { permissions: ['shop_financials.view'] },
      SHOP_ID,
      REQUESTER_ID
    )

    expect(result).toEqual({ success: true, data: updated })
    expect(repo.update).toHaveBeenCalledWith(
      STAFF_ID,
      SHOP_ID,
      { permissions: ['shop_financials.view'] }
    )
    expect(invalidateStaffActiveCache).toHaveBeenCalledWith(
      TARGET_USER_ID,
      SHOP_ID
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// VendorEmployeesService.delete() — error response shape + scope
// ═══════════════════════════════════════════════════════════════
describe('VendorEmployeesService.delete()', () => {
  let repo
  let service

  beforeEach(() => {
    repo = makeRepoMock()
    service = new VendorEmployeesService(repo)
  })

  it('returns STAFF_NOT_FOUND with consistent error shape when record missing', async () => {
    repo.findById.mockResolvedValueOnce(null)

    const result = await service.delete(STAFF_ID, SHOP_ID, REQUESTER_ID)

    expect(result).toEqual({
      success: false,
      message: 'Staff record not found',
      code: 'STAFF_NOT_FOUND',
    })
    expect(repo.softDelete).not.toHaveBeenCalled()
  })

  it('returns simple { success: true } on successful soft-delete', async () => {
    repo.findById.mockResolvedValueOnce(MOCK_STAFF_RECORD)
    repo.softDelete.mockResolvedValueOnce(true)

    const result = await service.delete(STAFF_ID, SHOP_ID, REQUESTER_ID)

    expect(result).toEqual({ success: true })
    // softDelete is invoked from inside the deactivate() transaction,
    // so the third argument carries the pg client used for the BEGIN /
    // soft-delete / COMMIT sequence (R28 AC#6 — atomic with the audit
    // emit). We assert on the first two positional args only.
    expect(repo.softDelete).toHaveBeenCalledTimes(1)
    expect(repo.softDelete.mock.calls[0][0]).toBe(STAFF_ID)
    expect(repo.softDelete.mock.calls[0][1]).toBe(SHOP_ID)
  })
})

// ═══════════════════════════════════════════════════════════════
// shop-staff schema — Permission_String / role validation
// Validates R16.17 / R17.1 (canonical 37-string vocabulary) and
// Requirement 2.1 / R16.8 (4 staff roles)
// ═══════════════════════════════════════════════════════════════
describe('createVendorEmployeeSchema — permissions and role validation', () => {
  const VALID_BASE = {
    vendor_id: SHOP_ID,
    user_id: TARGET_USER_ID,
    role: 'VENDOR_STAFF',
  }

  it('lists exactly the canonical 43 Permission_Strings (37 original + 6 vendor-app additions)', () => {
    expect(PERMISSION_ENUM.length).toBe(43)
    // Added with per-module staff permissions: accept/reject and re-evaluation
    // as their own grants, plus pickup slots and inventory.
    for (const added of [
      'shop_orders.accept_reject',
      'shop_orders.reevaluate',
      'vendor_slots.view',
      'vendor_slots.manage',
      'vendor_inventory.view',
      'vendor_inventory.manage',
    ]) {
      expect(PERMISSION_ENUM).toContain(added)
    }
    expect(PERMISSION_ENUM).toContain('shop_orders.view')
    expect(PERMISSION_ENUM).toContain('vendor_employees.create')
    expect(PERMISSION_ENUM).toContain('reports.global_view')
  })

  it('lists the canonical owner, staff, and rider vendor roles', () => {
    expect(VALID_ROLES).toEqual([
      'VENDOR_OWNER',
      'VENDOR_STAFF',
      'VENDOR_RIDER',
    ])
  })

  it('accepts a payload with no permissions (omitted is allowed)', () => {
    const parsed = createVendorEmployeeSchema.safeParse(VALID_BASE)
    expect(parsed.success).toBe(true)
  })

  it('accepts every canonical permission individually', () => {
    for (const perm of PERMISSION_ENUM) {
      const parsed = createVendorEmployeeSchema.safeParse({
        ...VALID_BASE,
        permissions: [perm],
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('accepts the full canonical permission set', () => {
    const parsed = createVendorEmployeeSchema.safeParse({
      ...VALID_BASE,
      permissions: PERMISSION_ENUM,
    })
    expect(parsed.success).toBe(true)
  })

  it.each([
    'manage_everything',
    'admin',
    '',
    'SHOP_ORDERS.VIEW', // case-sensitive
    'manage garment_rates', // legacy R2 name no longer canonical
    'manage_orders',
  ])('rejects invalid permission "%s"', (badPerm) => {
    const parsed = createVendorEmployeeSchema.safeParse({
      ...VALID_BASE,
      permissions: [badPerm],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects when one entry in the permissions array is invalid', () => {
    const parsed = createVendorEmployeeSchema.safeParse({
      ...VALID_BASE,
      permissions: ['shop_orders.view', 'unknown_permission'],
    })
    expect(parsed.success).toBe(false)
  })

  it.each(['SHOP_OWNER', 'OWNER', 'shop_admin', '', 'ADMIN', 'SHOP_ADMIN', 'SHOP_MANAGER', 'SHOP_STAFF', 'SHOP_VIEWER'])(
    'rejects invalid role "%s"',
    (role) => {
      const parsed = createVendorEmployeeSchema.safeParse({ ...VALID_BASE, role })
      expect(parsed.success).toBe(false)
    }
  )

  it('rejects non-UUID vendor_id and user_id', () => {
    expect(
      createVendorEmployeeSchema.safeParse({ ...VALID_BASE, vendor_id: 'abc' }).success
    ).toBe(false)
    expect(
      createVendorEmployeeSchema.safeParse({ ...VALID_BASE, user_id: '12345' })
        .success
    ).toBe(false)
  })

  it('accepts the new-user shape with email + name', () => {
    const parsed = createVendorEmployeeSchema.safeParse({
      vendor_id: SHOP_ID,
      email: 'NewStaff@Example.com',
      name: 'New Staff',
      role: 'VENDOR_STAFF',
      generate_temp_password: true,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // Email should be lowercased by the schema transform.
      expect(parsed.data.email).toBe('newstaff@example.com')
    }
  })

  it('rejects new-user shape without email', () => {
    const parsed = createVendorEmployeeSchema.safeParse({
      vendor_id: SHOP_ID,
      name: 'New Staff',
      role: 'VENDOR_STAFF',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a password that lacks letter+digit complexity', () => {
    const parsed = createVendorEmployeeSchema.safeParse({
      vendor_id: SHOP_ID,
      email: 'a@b.com',
      name: 'A B',
      role: 'VENDOR_STAFF',
      generate_temp_password: false,
      password: 'aaaaaaaa', // letters only, no digit
    })
    expect(parsed.success).toBe(false)
  })
})

describe('updateVendorEmployeeSchema', () => {
  it('rejects an empty body (must update at least one field)', () => {
    expect(updateVendorEmployeeSchema.safeParse({}).success).toBe(false)
  })

  it('accepts is_active toggle alone', () => {
    expect(updateVendorEmployeeSchema.safeParse({ is_active: false }).success).toBe(
      true
    )
  })

  it('accepts a permissions update alone (canonical Permission_String)', () => {
    expect(
      updateVendorEmployeeSchema.safeParse({ permissions: ['shop_orders.view'] })
        .success
    ).toBe(true)
  })

  it('rejects an unknown permission inside permissions array', () => {
    expect(
      updateVendorEmployeeSchema.safeParse({ permissions: ['manage_universe'] })
        .success
    ).toBe(false)
  })
})
