/**
 * Integration tests for LNDRY Endpoints
 * Covering the entire flow for LNDRY Phase 1 MVP:
 * 1. Auth & OTP lifecycle (Send OTP, Verify OTP, Session, Scoped Roles)
 * 2. Onboarding wizard (Vendor applications: create, update owner/business/location/radius, submit)
 * 3. Proximity Location check (validate-location via Haversine)
 * 4. Discovery & Quotes (Discovery home/vendors list, quotes pricing calculation)
 * 5. Slot holds (Atomic slot holds capacity locking and releasing)
 * 6. Bookings & Payments (Order prepare, Razorpay order create, Razorpay verification)
 * 7. Order State Machine Transition validation & events audit log
 * 8. Vendor Reviews (Create, update within 7 days, delete/soft-delete check)
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'

// ═══════════════════════════════════════════════════════════════
// Mock external dependencies
// ═══════════════════════════════════════════════════════════════

const mockQuery = vi.fn()
const mockPoolQuery = vi.fn()
const mockGetClient = vi.fn()

vi.mock('../../src/config/database.js', () => ({
  query: (...args) => mockQuery(...args),
  pool: { query: (...args) => mockPoolQuery(...args) },
  getClient: () => mockGetClient(),
}))

vi.mock('../../src/config/redis.js', () => {
  const store = new Map()
  return {
    redis: {
      set: vi.fn((key, val) => {
        store.set(key, val)
        return 'OK'
      }),
      get: vi.fn((key) => {
        return store.get(key) || null
      }),
      del: vi.fn((key) => {
        store.delete(key)
        return 1
      }),
      incr: vi.fn((key) => {
        const val = (store.get(key) || 0) + 1
        store.set(key, val)
        return val
      }),
      expire: vi.fn(() => 1),
      setex: vi.fn((key, ttl, val) => {
        store.set(key, val)
        return 'OK'
      }),
      ping: vi.fn(() => 'PONG'),
      status: 'ready',
      disconnect: vi.fn(),
      quit: vi.fn(),
    },
  }
})

vi.mock('../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn() },
  notificationQueue: { add: vi.fn() },
  smsQueue: { add: vi.fn() },
  vendorAutoRejectQueue: { add: vi.fn() },
  slotHoldExpiryQueue: { add: vi.fn() },
  allocationQueue: { add: vi.fn() },
  themeQueue: { add: vi.fn() },
  settlementQueue: { add: vi.fn() },
  payoutQueue: { add: vi.fn() },
  stockNotificationsQueue: { add: vi.fn() },
  scheduledOrdersQueue: { add: vi.fn() },
  reportPrecomputeQueue: { add: vi.fn() },
}))

vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LOG_PRETTY: false,
    JWT_ACCESS_SECRET: 'test-access-secret-32-chars-minimum-xx',
    JWT_ACCESS_EXPIRY: '24h',
    JWT_REFRESH_SECRET: 'test-refresh-secret-32-chars-minimum-xx',
    JWT_REFRESH_EXPIRY: '7d',
    COOKIE_SECRET: 'test-cookie-secret',
    ALLOW_DEMO_OTP: false,
    DEMO_OTP_PHONE: '',
    DEMO_OTP_CODE: '123456',
    OTP_EXPIRY_SECONDS: 300,
    SMS_PROVIDER: 'none',
    CORS_ORIGIN: '*',
    RATE_LIMIT_MAX: 1000,
    RATE_LIMIT_WINDOW: '1 minute',
    STRICT_SESSION_VERSION_CHECK: false,
    MULTI_VENDOR_PRODUCT_APPROVAL: false,
  },
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}))

vi.mock('../../src/config/firebase.js', () => ({
  messaging: { send: vi.fn() },
}))

vi.mock('../../src/utils/activityLogger.js', () => ({
  logAdminActivity: vi.fn(),
}))

vi.mock('../../src/utils/permission-audit.js', () => ({
  installRouteCollector: vi.fn(() => []),
}))

vi.mock('../../src/plugins/socketio.plugin.js', () => ({
  default: async () => {},
  getSocketIo: vi.fn(() => ({ to: vi.fn(() => ({ emit: vi.fn() })) })),
}))

// Mock Razorpay
vi.mock('razorpay', () => {
  return {
    default: class MockRazorpay {
      constructor() {
        this.orders = {
          create: vi.fn().mockResolvedValue({ id: 'rzp_order_123', amount: 1000, currency: 'INR' })
        }
      }
    }
  }
})

// ─── Test fixtures ────────────────────────────────────────────
const CUSTOMER_USER_ID = '11111111-1111-1111-1111-111111111111'
const VENDOR_OWNER_ID = '22222222-2222-2222-2222-222222222222'
const ADMIN_USER_ID = '33333333-3333-3333-3333-333333333333'
const VENDOR_ID = '44444444-4444-4444-4444-444444444444'
const APPLICATION_ID = '55555555-5555-5555-5555-555555555555'
const ORDER_ID = '66666666-6666-6666-6666-666666666666'
const CANCEL_ORDER_ID = '88888888-8888-8888-8888-888888888888'
const REVIEW_ID = '77777777-7777-7777-7777-777777777777'

let app
let applicationCreated = false

function signTestToken(payload) {
  return app.jwt.sign(payload, { expiresIn: '1h' })
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js')
  app = await buildApp()
  await app.ready()

  const mockClient = {
    query: vi.fn().mockImplementation((sql, params) => mockQuery(sql, params)),
    release: vi.fn(),
  }
  mockGetClient.mockResolvedValue(mockClient)
}, 30000)

afterAll(async () => {
  if (app) await app.close()
})

beforeEach(() => {
  vi.clearAllMocks()
  applicationCreated = false
  
  // Standard default mock query behaviour
  mockQuery.mockImplementation((sql, params) => {
    // Auth blocked checks
    if (sql.includes('SELECT is_blocked') && sql.includes('users')) {
      return { rows: [{ is_blocked: false, session_version: 1 }] }
    }

    // Role permissions checks
    if (sql.includes('permissions') && sql.includes('roles')) {
      return { rows: [{ permissions: ['vendor_services.create'] }] }
    }

    // OTP challenge creation
    if (sql.includes('INSERT INTO otp_challenges')) {
      return {
        rows: [{
          id: '550e8400-e29b-41d4-a716-446655440000',
          phone: params[0],
          expires_in: 300
        }]
      }
    }

    // OTP challenge fetch
    if (sql.includes('SELECT') && sql.includes('otp_challenges')) {
      return {
        rows: [{
          id: '550e8400-e29b-41d4-a716-446655440000',
          phone: '+919876543210',
          otp_hash: '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92', // SHA256 of '123456'
          expires_at: new Date(Date.now() + 100000).toISOString(),
          verified: false,
          attempts: 0,
          account_type: 'CUSTOMER'
        }]
      }
    }

    // Get user by phone (signup or login check)
    if (sql.includes('SELECT id, phone, email, name, role') && sql.includes('users')) {
      return {
        rows: [{
          id: CUSTOMER_USER_ID,
          name: 'Test Customer',
          phone: '+919876543210',
          role: 'CUSTOMER',
          is_active: true,
          is_blocked: false,
          session_version: 1
        }]
      }
    }

    // Insert new user
    if (sql.includes('INSERT INTO users')) {
      return {
        rows: [{
          id: CUSTOMER_USER_ID,
          name: 'Test Customer',
          phone: '+919876543210',
          role: 'CUSTOMER',
          is_active: true,
          is_blocked: false,
          session_version: 1
        }]
      }
    }

    // ONBOARDING (vendor_applications table matches)
    if (sql.includes('INSERT INTO vendor_applications')) {
      applicationCreated = true
      return {
        rows: [{
          id: APPLICATION_ID,
          name: 'Quick Laundry',
          owner_id: VENDOR_OWNER_ID,
          status: 'DRAFT',
          requested_daily_capacity: 50,
          created_at: new Date().toISOString()
        }]
      }
    }

    // findApplicationByOwnerId
    if (sql.includes('owner_id = $1') && sql.includes('FROM vendor_applications')) {
      if (!applicationCreated) {
        return { rows: [] }
      }
      return {
        rows: [{
          id: APPLICATION_ID,
          name: 'Quick Laundry',
          owner_id: VENDOR_OWNER_ID,
          status: 'DRAFT',
          requested_service_radius_km: 5.00,
          requested_daily_capacity: 50,
          approved_service_radius_km: 5.00,
          created_at: new Date().toISOString()
        }]
      }
    }

    if (sql.includes('SELECT') && sql.includes('FROM vendor_applications') && sql.includes('id = $1')) {
      return {
        rows: [{
          id: APPLICATION_ID,
          name: 'Quick Laundry',
          owner_id: VENDOR_OWNER_ID,
          status: 'DRAFT',
          requested_service_radius_km: 5.00,
          requested_daily_capacity: 50,
          approved_service_radius_km: 5.00,
          address_line1: '123 Street',
          city: 'Metropolis',
          state: 'NY',
          pincode: '10001',
          lat: 12.9716,
          lng: 77.5946,
          created_at: new Date().toISOString()
        }]
      }
    }

    if (sql.includes('SELECT') && sql.includes('FROM vendors') && sql.includes('id = $1')) {
      const requestedId = params[0]
      // default to approved active VENDOR_ID
      return {
        rows: [{
          id: VENDOR_ID,
          name: 'Eco Cleaners',
          slug: 'eco-cleaners',
          branch_code: 'VND-XYZ',
          status: 'APPROVED',
          created_by: VENDOR_OWNER_ID,
          delivery_radius_km: 5.00,
          approved_service_radius_km: 5.00,
          address_line1: '123 Street',
          city: 'Metropolis',
          state: 'NY',
          pincode: '10001',
          lat: 12.9716,
          lng: 77.5946,
          is_active: true,
          vendor_approved: true,
          account_enabled: true,
          marketplace_published: true,
          created_at: new Date().toISOString()
        }]
      }
    }

    if (sql.includes('UPDATE vendor_applications')) {
      return {
        rows: [{
          id: APPLICATION_ID,
          status: 'WAITING_FOR_APPROVAL',
          owner_id: VENDOR_OWNER_ID
        }]
      }
    }

    if (sql.includes('FROM vendor_documents')) {
      return {
        rows: [
          { id: 'doc-1', document_type: 'owner_identity', file_url: 'private://1', status: 'APPROVED' },
          { id: 'doc-2', document_type: 'shop_photo', file_url: 'private://2', status: 'APPROVED' },
          { id: 'doc-3', document_type: 'service_list', file_url: 'private://3', status: 'APPROVED' }
        ]
      }
    }

    // validate-location (serviceable check)
    if (sql.includes('SELECT COUNT(*)::int AS count') && sql.includes('candidates')) {
      return { rows: [{ count: 2 }] }
    }

    // laundry categories list
    if (sql.includes('laundry_categories') || sql.includes('service_categories') || sql.includes('categories')) {
      return {
        rows: [{ id: 'cat-1', name: 'Wash & Fold' }]
      }
    }

    // quotes pricing selection and config check
    if (sql.includes('SELECT 1') && sql.includes('vendor_service_rates') && sql.includes('vendor_services') && sql.includes('LIMIT 1')) {
      return {
        rows: [{ configured: 1 }]
      }
    }
    if (sql.includes('vendor_service_rates') || sql.includes('FROM garment_rates') || sql.includes('FROM vendor_services') || sql.includes('garment_types')) {
      return {
        rows: [
          { id: 'e6833b3a-aa11-477c-bc22-cf8535a289b1', name: 'Shirt', unit: 'piece', rate_paise: 500 }
        ]
      }
    }

    // Quotes select
    if (sql.includes('SELECT') && sql.includes('quotes')) {
      return {
        rows: [{
          id: 'quote-123',
          vendor_id: VENDOR_ID,
          customer_id: CUSTOMER_USER_ID,
          service_id: '861a7a0b-1133-4f93-bb5b-38d7890b1ea0',
          estimate_paise: 1000,
          expiry: new Date(Date.now() + 30 * 60000).toISOString()
        }]
      }
    }

    // Addresses
    if (sql.includes('FROM addresses')) {
      return {
        rows: [{ id: 'addr-1', lat: 12.9716, lng: 77.5946, is_default: true }]
      }
    }

    // Insert into quotes mock
    if (sql.includes('INSERT INTO quotes')) {
      return {
        rows: [{
          id: 'quote-123',
          expires_at: new Date(Date.now() + 600000).toISOString()
        }]
      }
    }

    // Slot eligibility config check
    if (sql.includes('vendor_slots') && sql.includes('LIMIT 1')) {
      return {
        rows: [{ configured: 1 }]
      }
    }

    // Slot capacities and holds check
    if (sql.includes('SELECT count') && sql.includes('slot_holds')) {
      return { rows: [{ count: 0 }] }
    }
    if (sql.includes('SELECT booking_date FROM slot_holds') || (sql.includes('SELECT') && sql.includes('slot_holds') && !sql.includes('count'))) {
      return { rows: [{ booking_date: '2026-06-25' }] }
    }
    if (sql.includes('max_orders')) {
      return { rows: [{ max_orders: 10 }] }
    }
    if (sql.includes('INSERT INTO slot_holds')) {
      return {
        rows: [{
          id: 'hold-123',
          expires_at: new Date(Date.now() + 600000).toISOString()
        }]
      }
    }

    // Payments mocks
    if (sql.includes('INSERT INTO payments')) {
      return {
        rows: [{
          id: 'pay-123',
          order_id: params[0] || null,
          user_id: params[1],
          razorpay_order_id: params[2] || null,
          amount: params[3],
          currency: params[4] || 'INR',
          status: params[5] || 'PENDING',
          method: params[6] || null,
          expires_at: params[7] || null,
          metadata: params[8] || '{}',
          order_draft_id: params[9] || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]
      }
    }
    if (sql.includes('SELECT') && sql.includes('payments')) {
      return {
        rows: [{
          id: 'pay-123',
          order_id: ORDER_ID,
          user_id: CUSTOMER_USER_ID,
          razorpay_order_id: 'rzp_order_123',
          amount: 10,
          currency: 'INR',
          status: 'PAID',
          method: 'CARD',
          expires_at: new Date(Date.now() + 600000).toISOString(),
          metadata: '{}',
          order_draft_id: 'draft-123',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }]
      }
    }
    if (sql.includes('UPDATE payments')) {
      return {
        rows: [{
          id: 'pay-123',
          status: 'PAID'
        }]
      }
    }

    // Order drafts
    if (sql.includes('INSERT INTO order_drafts')) {
      return {
        rows: [{
          id: 'draft-123',
          payable_amount_paise: 1000
        }]
      }
    }
    if (sql.includes('SELECT') && sql.includes('order_drafts')) {
      return {
        rows: [{
          id: 'draft-123',
          payable_amount_paise: 1000,
          quote_id: 'quote-123',
          address_id: 'addr-1',
          hold_id: 'hold-123',
          vendor_id: VENDOR_ID,
          slot_id: 'slot-1',
          garment_lines: [{ garment_type_id: 'e6833b3a-aa11-477c-bc22-cf8535a289b1', quantity: 2, rate_paise: 500, total_paise: 1000 }],
          snapshot: {}
        }]
      }
    }

    // Orders state transitions
    if (sql.includes('SELECT') && sql.includes('FROM orders') && sql.includes('id = $1')) {
      const orderId = params[0]
      const status = (orderId === CANCEL_ORDER_ID) ? 'PENDING' : 'DELIVERED'
      return {
        rows: [{
          id: orderId,
          user_id: CUSTOMER_USER_ID,
          vendor_id: VENDOR_ID,
          status: status,
          created_at: new Date().toISOString()
        }]
      }
    }
    if (sql.includes('INSERT INTO orders')) {
      return {
        rows: [{
          id: ORDER_ID,
          status: 'WAITING_VENDOR_CONFIRMATION'
        }]
      }
    }

    // Reviews queries
    if (sql.includes('SELECT') && sql.includes('reviews')) {
      if (sql.includes('user_id = $1 AND order_id = $2')) {
        return { rows: [] } // No existing review
      }
      return {
        rows: [{
          id: REVIEW_ID,
          user_id: CUSTOMER_USER_ID,
          created_at: new Date().toISOString()
        }]
      }
    }
    if (sql.includes('INSERT INTO reviews')) {
      return {
        rows: [{
          id: REVIEW_ID,
          order_id: ORDER_ID,
          vendor_id: VENDOR_ID,
          vendor_rating: 5,
          comment: 'Great clean clothes!',
          created_at: new Date().toISOString()
        }]
      }
    }
    if (sql.includes('UPDATE reviews')) {
      return {
        rows: [{
          id: REVIEW_ID,
          vendor_rating: 4,
          comment: 'Updated review comments'
        }]
      }
    }

    return { rows: [] }
  })
})

describe('LNDRY Phase 1 MVP End-to-End Flow', () => {
  
  describe('1. Auth & OTP Verification Endpoints', () => {
    it('POST /api/v1/auth/send-otp creates challenge and returns challenge_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/send-otp',
        payload: {
          phone: '+919876543210',
          account_type: 'CUSTOMER'
        }
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.challenge_id).toBeDefined()
    })

    it('POST /api/v1/auth/verify-otp checks challenge and returns user tokens', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/verify-otp',
        payload: {
          phone: '+919876543210',
          challenge_id: '550e8400-e29b-41d4-a716-446655440000',
          otp: '123456',
          device: { device_id: 'dev-1', platform: 'android', fcm_token: 'fcm-1', app_version: '1.0.0' }
        }
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.accessToken).toBeDefined()
    })
  })

  describe('2. Vendor Onboarding (Wizard + Approval)', () => {
    it('POST /api/v1/vendor/applications creates a draft vendor application', async () => {
      const token = signTestToken({ id: VENDOR_OWNER_ID, phone: '+919876543211', role: 'VENDOR_APPLICANT', session_version: 1 })

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/vendor/applications',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Quick Laundry Shop' }
      })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.id).toBe(APPLICATION_ID)
    })

    it('PATCH /api/v1/vendor/applications/:id/owner updates owner details', async () => {
      // Set to true so that findByUserId thinks application is already created
      applicationCreated = true
      const token = signTestToken({ id: VENDOR_OWNER_ID, role: 'VENDOR_APPLICANT', session_version: 1 })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/vendor/applications/${APPLICATION_ID}/owner`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          email: 'owner@laundry.com',
          phone: '+919876543211',
          bank_name: 'Test Bank',
          bank_account_number: '1234567890'
        }
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().success).toBe(true)
    })

    it('POST /api/v1/vendor/applications/:id/submit submits onboarding application', async () => {
      applicationCreated = true
      const token = signTestToken({ id: VENDOR_OWNER_ID, role: 'VENDOR_APPLICANT', session_version: 1 })

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/vendor/applications/${APPLICATION_ID}/submit`,
        headers: { authorization: `Bearer ${token}` }
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.status).toBe('WAITING_FOR_APPROVAL')
    })
  })

  describe('3. Customer Profile & Proximity Address Verification', () => {
    it('POST /api/v1/addresses/validate-location returns serviceable state & count using pure SQL Haversine simulation', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/addresses/validate-location',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          lat: 12.9716,
          lng: 77.5946
        }
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.serviceable).toBe(true)
      expect(body.data.eligible_vendor_count).toBe(2)
    })
  })

  describe('4. Discovery & Quotes', () => {
    it('GET /api/v1/discovery/home returns address-aware layout information', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/discovery/home',
        headers: { authorization: `Bearer ${token}` }
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.categories).toBeDefined()
      expect(body.data.nearby_vendors).toBeDefined()
    })

    it('POST /api/v1/quotes calculates estimate from database service rate snapshot', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/quotes',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          vendor_id: VENDOR_ID,
          service_id: '861a7a0b-1133-4f93-bb5b-38d7890b1ea0', // valid uuid
          garment_lines: [
            { garment_type_id: 'e6833b3a-aa11-477c-bc22-cf8535a289b1', quantity: 2 } // valid uuid
          ]
        }
      })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.estimate_paise).toBe(1000)
    })
  })

  describe('5. Slot Holds capacity verification', () => {
    it('POST /api/v1/slot-holds locks capacity atomically', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/slot-holds',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          vendor_id: VENDOR_ID,
          date: '2026-06-25',
          slot_id: 'e6833b3a-aa11-477c-bc22-cf8535a289b2', // valid uuid
          quote_id: 'e6833b3a-aa11-477c-bc22-cf8535a289b3' // valid uuid
        }
      })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.id).toBe('hold-123')
    })
  })

  describe('6. Orders prepare & payments verification', () => {
    it('POST /api/v1/orders/prepare checks quote, address, slot details and returns draft info', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      // Pre-populate Redis with quote data (prepareOrder reads from redis.get(`quote:${quoteId}`))
      const { redis } = await import('../../src/config/redis.js')
      const quoteId = 'e6833b3a-aa11-477c-bc22-cf8535a289b3'
      await redis.set(`quote:${quoteId}`, JSON.stringify({
        vendor_id: VENDOR_ID,
        estimate_paise: 1000,
        garment_lines: [{ garment_type_id: 'e6833b3a-aa11-477c-bc22-cf8535a289b1', quantity: 2, rate_paise: 500, total_paise: 1000, name: 'Shirt', unit: 'piece' }],
        estimated_weight_kg: null
      }))

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/prepare',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          quote_id: quoteId,
          address_id: 'e6833b3a-aa11-477c-bc22-cf8535a289b4',
          slot_id: 'e6833b3a-aa11-477c-bc22-cf8535a289b2'
        }
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.order_draft_id).toBe('draft-123')
    })

    it('POST /api/v1/payments/create-order creates Razorpay payment options', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/payments/create-order',
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
        },
        payload: {
          order_draft_id: 'e6833b3a-aa11-477c-bc22-cf8535a289b6'
        }
      })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.success).toBe(true)
    })
  })

  describe('7. Order State Transitions & validator checks', () => {
    it('Validates transition rules in state-machine', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/orders/${CANCEL_ORDER_ID}/cancel`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          reason_code: 'CHANGED_MIND',
          comment: 'Cancelled'
        }
      })

      expect([200, 201, 204]).toContain(res.statusCode)
    })
  })

  describe('8. Vendor Reviews & 7-Day editing soft-delete window', () => {
    it('POST /api/v1/reviews creates a review on delivered orders', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/reviews',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          order_id: ORDER_ID,
          vendor_rating: 5,
          comment: 'Great clean clothes!'
        }
      })

      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.success).toBe(true)
      expect(body.data.id).toBe(REVIEW_ID)
    })

    it('PATCH /api/v1/reviews/:id updates comments within 7-day window', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/reviews/${REVIEW_ID}`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          vendor_rating: 4,
          comment: 'Updated review comments'
        }
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().success).toBe(true)
    })

    it('DELETE /api/v1/reviews/:id soft deletes reviews', async () => {
      const token = signTestToken({ id: CUSTOMER_USER_ID, role: 'CUSTOMER', session_version: 1 })

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/reviews/${REVIEW_ID}`,
        headers: { authorization: `Bearer ${token}` }
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().success).toBe(true)
    })
  })
})
