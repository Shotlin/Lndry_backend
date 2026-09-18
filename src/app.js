import Fastify from 'fastify'
import { env } from './config/env.js'
import { query } from './config/database.js'
import { redis } from './config/redis.js'
import { sanitize } from './middlewares/sanitize.js'
import { installRouteCollector } from './utils/permission-audit.js'
import { captureRawBody } from './utils/rawBody.js'

/**
 * Build and configure the Fastify application
 * Registers plugins, hooks, and routes in the correct order
 */
export const buildApp = async () => {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: {
        paths: [
          'req.body.otp',
          'req.body.pickup_otp',
          'req.body.delivery_otp',
          'otp',
          'pickup_otp',
          'delivery_otp',
          'otp_hash',
          'otp_code'
        ],
        censor: '[REDACTED]'
      },
      ...(env.LOG_PRETTY && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }),
    },
    trustProxy: true,
    ajv: {
      customOptions: {
        removeAdditional: 'all',
        useDefaults: true,
        coerceTypes: 'array',
      },
    },
  })

  // ─── PLUGINS (order matters) ────────────────────────────
  await app.register(import('./plugins/errorHandler.plugin.js'))
  await app.register(import('./plugins/cors.plugin.js'))
  await app.register(import('./plugins/helmet.plugin.js'))
  await app.register(import('./plugins/rateLimit.plugin.js'))
  await app.register(import('./plugins/auth.plugin.js'))
  await app.register(import('./plugins/idempotency.plugin.js'))
  await app.register(import('./plugins/swagger.plugin.js'))
  await app.register(import('./plugins/multipart.plugin.js'))
  await app.register(import('./plugins/compress.plugin.js'))
  await app.register(import('./plugins/socketio.plugin.js'))

  // ─── GLOBAL HOOKS ──────────────────────────────────────
  // Registered on preHandler (not onRequest): request.body doesn't exist
  // until after Fastify's body parser runs, and onRequest fires before
  // parsing. preHandler runs after parsing *and* after AJV schema
  // validation/coercion, so this sanitizes already-validated string fields.
  app.addHook('preHandler', sanitize)

  // PHASE 7 FIX (mobile-network stale-UI bug):
  // Never allow an intermediary (Cloudflare, a mobile-carrier transparent
  // proxy, or an on-device HTTP cache) to serve a stale copy of a
  // *user-scoped* API response. Any request that resolved an authenticated
  // user (request.user populated by the JWT preHandler / optionalAuth) is
  // marked no-store. This is the server-side guarantee that complements the
  // Flutter AppCacheManager: a logged-in user's cart / wallet / orders /
  // shop-scoped catalog can never be cached and replayed to a different
  // network or a different user.
  //
  // Anonymous public responses (master catalog, theme, banners) are left
  // untouched so their existing ETag/Cache-Control behaviour and
  // Cloudflare edge caching keep working.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.user && request.user.id) {
      reply.header(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, private'
      )
      reply.header('Pragma', 'no-cache')
      reply.header('Expires', '0')
    }
    return payload
  })

  // ─── PERMISSION AUDIT ROUTE COLLECTOR (R17 AC#9, design §4.5) ────
  // Install BEFORE any module routes register so the `onRoute` hook fires
  // for every dashboard endpoint. The collected array is exposed via
  // `app.permissionAuditRoutes` so `src/server.js` can run the audit
  // after `app.ready()` and decide whether to abort boot per task 2.7.
  app.decorate('permissionAuditRoutes', installRouteCollector(app))

  // ─── MODULE ROUTES ─────────────────────────────────────

  // Auth — fully implemented
  await app.register(import('./modules/auth/auth.routes.js'), {
    prefix: '/api/v1/auth',
  })

  // Users — fully implemented
  await app.register(import('./modules/users/users.routes.js'), {
    prefix: '/api/v1/users',
  })

  // Customers — dedicated customer profile routes (LNDRY-API-001 canonical)
  await app.register(import('./modules/customers/customers.routes.js'), {
    prefix: '/api/v1/customer',
  })
  // DEPRECATED ALIAS — remove after frontend migration
  await app.register(async (subApp) => {
    subApp.addHook('preHandler', async (request, reply) => {
      reply.header('Deprecation', 'true')
      const canonicalUrl = request.raw.url.replace('/api/v1/customers', '/api/v1/customer')
      reply.header('Link', `<${canonicalUrl}>; rel="successor-version"`)
    })
    await subApp.register(import('./modules/customers/customers.routes.js'))
  }, { prefix: '/api/v1/customers' })

  // Devices — FCM token registration
  await app.register(import('./modules/devices/devices.routes.js'), {
    prefix: '/api/v1/devices',
  })

  // Service Categories — fully implemented
  await app.register(import('./modules/service-categories/service-categories.routes.js'), {
    prefix: '/api/v1/service-categories',
  })
  await app.register(import('./modules/service-categories/service-categories.routes.js'), {
    prefix: '/api/v1/laundry/categories',
  })

  // Garment Types — fully implemented
  await app.register(import('./modules/garment-types/garment-types.routes.js'), {
    prefix: '/api/v1/garment-types',
  })
  await app.register(import('./modules/garment-types/garment-types.routes.js'), {
    prefix: '/api/v1/garment_rates',
  })
  await app.register(import('./modules/garment-types/garment-types.routes.js'), {
    prefix: '/api/v1/products',
  })

  // Discovery — Home and vendor listings
  await app.register(import('./modules/discovery/discovery.routes.js'), {
    prefix: '/api/v1/discovery',
  })
  // Search alias under /api/v1
  await app.register(import('./modules/discovery/discovery.routes.js'), {
    prefix: '/api/v1',
  })
  // Quotes — laundry quotes generator
  await app.register(import('./modules/quotes/quotes.routes.js'), {
    prefix: '/api/v1/quotes',
  })
  // URL alias fix — Flutter mobile app has a doubled /api/v1/ prefix bug
  // where it constructs product URLs as /api/v1/api/v1/garment_rates/:id instead
  // of /api/v1/garment_rates/:id. This alias transparently handles those requests
  // so garment_rates load correctly without requiring a mobile app release.
  await app.register(import('./modules/garment-types/garment-types.routes.js'), {
    prefix: '/api/v1/api/v1/garment_rates',
  })

  // Uploads — fully implemented
  await app.register(import('./modules/uploads/uploads.routes.js'), {
    prefix: '/api/v1/uploads',
  })

  // Cart — fully implemented
  // await app.register(import('./modules/cart/cart.routes.js'), {
  //   prefix: '/api/v1/cart',
  // })

  // Orders — fully implemented
  await app.register(import('./modules/orders/orders.routes.js'), {
    prefix: '/api/v1/orders',
  })

  // Payments — fully implemented
  await app.register(import('./modules/payments/payments.routes.js'), {
    prefix: '/api/v1/payments',
  })

  // Wallet — fully implemented
  await app.register(import('./modules/wallet/wallet.routes.js'), {
    prefix: '/api/v1/wallet',
  })

  // Coupons — fully implemented
  // await app.register(import('./modules/coupons/coupons.routes.js'), {
  //   prefix: '/api/v1/coupons',
  // })

  // Addresses — fully implemented
  await app.register(import('./modules/addresses/addresses.routes.js'), {
    prefix: '/api/v1/addresses',
  })

  // Maps — Google Places Autocomplete & Details proxy
  await app.register(import('./modules/maps/maps.routes.js'), {
    prefix: '/api/v1/maps',
  })

  // Admin — fully implemented
  await app.register(import('./modules/admin/admin.routes.js'), {
    prefix: '/api/v1/admin',
  })

  // Banners (public) — active banners for mobile/web
  await app.register(import('./modules/banners/banners.routes.js'), {
    prefix: '/api/v1/banners',
  })

  // Theme (public) — active theme for mobile/web app
  await app.register(import('./modules/themes/public.routes.js'), {
    prefix: '/api/v1/theme',
  })

  // Wishlist — fully implemented
  // await app.register(import('./modules/wishlist/wishlist.routes.js'), {
  //   prefix: '/api/v1/wishlist',
  // })

  // Reviews — fully implemented
  await app.register(import('./modules/reviews/reviews.routes.js'), {
    prefix: '/api/v1/reviews',
  })

  // Rider Assignments — delivery partner / rider operations (LNDRY-API-001 canonical)
  await app.register(import('./modules/delivery/delivery.routes.js'), {
    prefix: '/api/v1/rider',
  })
  // DEPRECATED ALIAS — remove after frontend migration
  await app.register(async (subApp) => {
    subApp.addHook('preHandler', async (request, reply) => {
      reply.header('Deprecation', 'true')
      const canonicalUrl = request.raw.url.replace('/api/v1/delivery', '/api/v1/rider/assignments')
      reply.header('Link', `<${canonicalUrl}>; rel="successor-version"`)
    })
    await subApp.register(import('./modules/delivery/delivery.routes.js'))
  }, { prefix: '/api/v1/delivery' })

  // Vendor Orders — vendor-side order management (LNDRY-API-001 canonical)
  await app.register(import('./modules/vendor-orders/vendor-orders.routes.js'), {
    prefix: '/api/v1/vendor/orders',
  })
  // DEPRECATED ALIAS — remove after frontend migration
  await app.register(async (subApp) => {
    subApp.addHook('preHandler', async (request, reply) => {
      reply.header('Deprecation', 'true')
      const canonicalUrl = request.raw.url.replace('/api/v1/vendor-orders', '/api/v1/vendor/orders')
      reply.header('Link', `<${canonicalUrl}>; rel="successor-version"`)
    })
    await subApp.register(import('./modules/vendor-orders/vendor-orders.routes.js'))
  }, { prefix: '/api/v1/vendor-orders' })

  // Vendor Rider — restricted job-fulfillment surface for a vendor's own
  // delivery riders (VENDOR_RIDER role), separate from full order management.
  await app.register(import('./modules/vendor-rider/vendor-rider.routes.js'), {
    prefix: '/api/v1/vendor/rider',
  })

  // Pickup Slots — slot capacity holds and availability
  await app.register(import('./modules/pickup-slots/pickup-slots.routes.js'), {
    prefix: '/api/v1',
  })

  // Shops/Vendors CRUD and Admin review plugins
  await app.register(import('./modules/shops/shops.routes.js'), {
    prefix: '/api/v1/shops',
  })
  await app.register(import('./modules/vendors/vendors.routes.js'), {
    prefix: '/api/v1/vendors',
  })

  // Vendor applications & profiles onboarding (Section 8)
  await app.register(import('./modules/vendors/vendor-applications.routes.js'), {
    prefix: '/api/v1/vendor-applications',
  })
  await app.register(import('./modules/vendors/vendor-applications.routes.js'), {
    prefix: '/api/v1/vendor',
  })

  // Website partner enquiries enter canonical staging through a signed
  // server-to-server boundary. This deliberately does not create a vendor
  // application or bypass KYC/onboarding.
  await app.register(import('./modules/partner-leads/partner-leads.routes.js'), {
    prefix: '/api/v1/integrations',
  })
  await app.register(import('./modules/partner-leads/partner-leads.admin.routes.js'), {
    prefix: '/api/v1/admin',
  })

  // Secure KYC documents streaming (Section 15)
  await app.register(async function secureDocumentsRoutes(fastify) {
    const { VendorsRepository } = await import('./modules/vendors/vendors.repository.js')
    const { VendorsService } = await import('./modules/vendors/vendors.service.js')
    const { VendorsController } = await import('./modules/vendors/vendors.controller.js')
    
    const repo = new VendorsRepository()
    const service = new VendorsService(repo)
    const controller = new VendorsController(service)
    
    fastify.get('/:documentId', {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['Secure Documents'],
        summary: 'Stream private secure document with watermark',
        params: {
          type: 'object',
          required: ['documentId'],
          properties: {
            documentId: { type: 'string', format: 'uuid' }
          }
        }
      }
    }, controller.previewKycDocument.bind(controller))
  }, { prefix: '/api/v1/secure-documents' })


  // Vendor Employees — role-based access management (LNDRY-API-001 canonical)
  await app.register(import('./modules/vendor-employees/vendor-employees.routes.js'), {
    prefix: '/api/v1/vendor/employees',
  })
  
  // Vendor Analytics — Flutter app compatibility layer
  await app.register(import('./modules/shop-reports/vendor-analytics.routes.js'), {
    prefix: '/api/v1/vendor/analytics',
  })

  // Vendor Support Tickets — Help & Support feature
  await app.register(import('./modules/vendors/support-tickets.routes.js'), {
    prefix: '/api/v1/vendor/support-tickets',
  })
  // Admin side of the same feature — review/reply/close across all vendors
  await app.register(
    (await import('./modules/vendors/support-tickets.routes.js')).adminSupportTicketsRoutes,
    { prefix: '/api/v1/admin/support-tickets' }
  )
  // Backward-compatible alias — old path, will be removed after mobile app migration
  await app.register(import('./modules/vendor-employees/vendor-employees.routes.js'), {
    prefix: '/api/v1/shop-staff',
  })

  // Alias mount at /vendors/:shopId/staff so the dashboard's canonical URL
  // pattern (see lndry-dashboard/src/services/shop-staff.service.ts and
  // design.md §6 "Shop_Staff_UI") resolves without a separate URL rewrite
  // layer. The controller's resolveShopId() prefers `request.params.shopId`
  // when present, so all role-check + scope semantics stay identical to the
  // /shop-staff prefix; this is a pure URL alias, not a behavioural fork.
  await app.register(import('./modules/vendor-employees/vendor-employees.routes.js'), {
    prefix: '/api/v1/vendors/:shopId/staff',
  })

  // Shop Products — per-shop inventory and pricing (catalogue/pricing/
  // availability/capacity). Built but never mounted since the initial
  // commit; its repository still joined the pre-migration-062 table names
  // (garment_rates/categories) and manual-create still tried to write
  // price/description columns that only ever lived on the per-vendor
  // vendor_services row — both fixed against the live schema before
  // mounting (see shop-garment_rates.repository.js / manual-create.service.js).
  await app.register(import('./modules/shop-garment_rates/shop-garment_rates.routes.js'), {
    prefix: '/api/v1/shop-garment_rates',
  })

  // Shop Products — nested per-shop write surface (R23.8, R23.12)
  // adjust-stock + bulk-price-update mounted at /api/v1/vendors/:shopId/garment_rates
  // so the dashboard's canonical Store_Mode URL pattern resolves without a
  // separate URL rewrite layer (design §6.4). Same controller and service
  // as the /api/v1/shop-garment_rates mount; permission gating lives on each
  // route via requirePermission().
  {
    const { shopProductsNestedRoutes, shopStockMovementsRoutes, shopProductsAdminRoutes } =
      await import('./modules/shop-garment_rates/shop-garment_rates.routes.js')
    await app.register(shopProductsNestedRoutes, {
      prefix: '/api/v1/vendors/:shopId/garment_rates',
    })
    // Stock-movements ledger reader (R23.5)
    await app.register(shopStockMovementsRoutes, {
      prefix: '/api/v1/vendors/:shopId/stock-movements',
    })
    // HQ-only admin approve/reject (R23.10, R23.11) — feature-flagged;
    // replies 503 FEATURE_DISABLED while MULTI_VENDOR_PRODUCT_APPROVAL=false.
    await app.register(shopProductsAdminRoutes, {
      prefix: '/api/v1/admin/shop-garment_rates',
    })
  }

  // Shop Orders — store-scoped order operations (multi-vendor R22)
  // await app.register(import('./modules/shop-orders/routes.js'), {
  //   prefix: '/api/v1/shop-orders',
  // })

  // Shop Transactions — read-only append-only ledger
  // (write side is exposed as LedgerWriteService for orders/refunds/payouts)
  await app.register(
    import('./modules/shop-transactions/shop-transactions.routes.js'),
    {
      prefix: '/api/v1/shop-transactions',
    }
  )

  // Product Families — option grouping for multi-option garment_rates
  // await app.register(import('./modules/product-families/product-families.routes.js'), {
  //   prefix: '/api/v1/admin/product-families',
  // })

  // Allocation — user-shop allocation (pincode + haversine)
  // await app.register(import('./modules/allocation/allocation.routes.js'), {
  //   prefix: '/api/v1/allocation',
  // })

  // Shop Financials — read-only paginated financials per period
  await app.register(
    import('./modules/shop-financials/shop-financials.routes.js'),
    {
      prefix: '/api/v1/shop-financials',
    }
  )

  // Shop Finance — store-scoped finance endpoints (task 8.8)
  // await app.register(
  //   import('./modules/shop-finance/routes.js'),
  //   {
  //     prefix: '/api/v1/shop-finance',
  //   }
  // )

  // Admin Finance — HQ-scoped finance endpoints (task 8.9)
  await app.register(
    import('./modules/admin/finance/routes.js'),
    {
      prefix: '/api/v1/admin/finance',
    }
  )

  // Bulk Orders — large multi-vendor scheduled-delivery orders
  // (registered after shop-financials; scheduled-orders comes online in 10.2)
  // await app.register(import('./modules/bulk-orders/bulk-orders.routes.js'), {
  //   prefix: '/api/v1/bulk-orders',
  // })

  // Scheduled Orders — customer-side future / recurring orders (task 10.2)
  // (Worker that fires the orders at scheduled_for lives in task 10.3.)
  // await app.register(
  //   import('./modules/scheduled-orders/scheduled-orders.routes.js'),
  //   {
  //     prefix: '/api/v1/scheduled-orders',
  //   }
  // )

  // Audit Logs — read-only endpoints (tasks 10.2, 10.3)
  {
    const { adminAuditLogsRoutes, shopAuditLogsRoutes } =
      await import('./modules/audit-logs/audit-logs.routes.js')
    // HQ-only reader (task 10.2)
    await app.register(adminAuditLogsRoutes, {
      prefix: '/api/v1/admin/audit-logs',
    })
    // Shop-scoped reader (task 10.3)
    await app.register(shopAuditLogsRoutes, {
      prefix: '/api/v1/shop-audit-logs',
    })
  }

  // Admin Reports — HQ-scoped global reports (task 11.1)
  await app.register(
    import('./modules/admin/reports/routes.js'),
    {
      prefix: '/api/v1/admin/reports',
    }
  )

  // Shop Reports — shop-scoped reports (task 11.2)
  await app.register(
    import('./modules/shop-reports/routes.js'),
    {
      prefix: '/api/v1/shop-reports',
    }
  )

  // Notifications — fully implemented
  await app.register(import('./modules/notifications/notifications.routes.js'), {
    prefix: '/api/v1/notifications',
  })

  // ─── CART ENHANCEMENT MODULES ──────────────────────────

  // Tip Presets (public)
  await app.register(import('./modules/tip-presets/tip-presets.routes.js'), {
    prefix: '/api/v1/tip-presets',
  })
  
  // Payment Offers (public)
  await app.register(import('./modules/payment-offers/payment-offers.routes.js'), {
    prefix: '/api/v1/payment-offers',
  })

  // Fee Config (admin) — legacy row-per-type config (kept for backward compat)
  await app.register(import('./modules/fee-config/fee-config.routes.js'), {
    prefix: '/api/v1/admin/fee-config',
  })

  // Fee Settings (admin) — canonical dynamic fee + distance-based delivery engine
  await app.register(import('./modules/fee-settings/fee-settings.routes.js'), {
    prefix: '/api/v1/admin/fee-settings',
  })

  // Rider Assignment Settings (admin) — Phase 5 of the rider-assignment
  // initiative (see CLAUDE.md); the broadcast-timeout duration
  await app.register(import('./modules/rider-assignment-settings/rider-assignment-settings.routes.js'), {
    prefix: '/api/v1/admin/rider-assignment-settings',
  })

  // Coupons — customer validate/available + HQ/shop-staff CRUD (scope-enforced in service layer)
  await app.register(import('./modules/coupons/coupons.routes.js'), {
    prefix: '/api/v1/coupons',
  })

  // First-Time Offers — customer-facing active tiers (admin CRUD is under /api/v1/admin/first-time-offers)
  const { customerFirstTimeOffersRoutes } = await import('./modules/admin/first-time-offers/first-time-offers.routes.js')
  await app.register(customerFirstTimeOffersRoutes, {
    prefix: '/api/v1/first-time-offers',
  })

  // Cart Milestones — customer-facing active tiers (admin CRUD is under /api/v1/admin/cart-milestones)
  const { customerCartMilestonesRoutes } = await import('./modules/admin/cart-milestones/cart-milestones.routes.js')
  await app.register(customerCartMilestonesRoutes, {
    prefix: '/api/v1/cart-milestones',
  })

  // Referrals — customer-facing "Refer & Earn" (admin CRUD of programs is under /api/v1/admin/referral-programs)
  const { default: referralsRoutes } = await import('./modules/referrals/referrals.routes.js')
  await app.register(referralsRoutes, {
    prefix: '/api/v1/referrals',
  })

  // Reconciliation Problem Types — vendor-facing active list for the
  // reconcile-sheet picker (admin CRUD is under /api/v1/admin/reconciliation-problem-types)
  const { vendorReconciliationProblemTypesRoutes } = await import('./modules/admin/reconciliation-problem-types/reconciliation-problem-types.routes.js')
  await app.register(vendorReconciliationProblemTypesRoutes, {
    prefix: '/api/v1/reconciliation-problem-types',
  })

  // Store Orders — walk-in/counter sales pushed by a vendor's own POS
  // desktop app when a customer's phone matches a real LNDRY account.
  // Customer-facing "my Laundry Store history" is its own prefix; the
  // vendor-facing lookup/push endpoints share /api/v1/vendor with
  // vendor-applications.routes.js and others already registered there.
  const { default: storeOrdersRoutes, vendorStoreOrdersRoutes } = await import('./modules/store-orders/store-orders.routes.js')
  await app.register(storeOrdersRoutes, {
    prefix: '/api/v1/store-orders',
  })
  await app.register(vendorStoreOrdersRoutes, {
    prefix: '/api/v1/vendor',
  })

  // Wallet Redemption — vendor-facing POS-counter wallet redemption
  // (lookup/create/confirm/cancel). The customer-facing pending-check is
  // added directly onto the existing /api/v1/wallet prefix instead
  // (see wallet.routes.js), not registered here.
  const { default: vendorWalletRedemptionRoutes } = await import('./modules/vendors/vendor-wallet-redemption.routes.js')
  await app.register(vendorWalletRedemptionRoutes, {
    prefix: '/api/v1/vendor',
  })

  // Tip Presets (admin)
  const { adminTipPresetsRoutes } = await import('./modules/tip-presets/tip-presets.routes.js')
  await app.register(adminTipPresetsRoutes, {
    prefix: '/api/v1/admin/tip-presets',
  })
  
  // Payment Offers (admin)
  const { adminPaymentOffersRoutes } = await import('./modules/payment-offers/payment-offers.routes.js')
  await app.register(adminPaymentOffersRoutes, {
    prefix: '/api/v1/admin/payment-offers',
  })

  // ─── RAZORPAY WEBHOOK (outside /api/v1 — no auth, no rate-limit) ──
  await app.register(async function razorpayWebhook(fastify) {
    // Lazy-load payments dependencies only for this route
    const { PaymentsRepository } = await import('./modules/payments/payments.repository.js')
    const { PaymentsService } = await import('./modules/payments/payments.service.js')
    const { PaymentsController } = await import('./modules/payments/payments.controller.js')

    const repo = new PaymentsRepository()
    const service = new PaymentsService(repo)
    const controller = new PaymentsController(service)

    fastify.post('/razorpay', {
      preParsing: captureRawBody,
      schema: {
        tags: ['Payments'],
        summary: 'Razorpay webhook handler',
      },
      config: {
        rawBody: true,
        rateLimit: false,   // Razorpay retries failed webhooks — don't rate-limit
      },
    }, controller.webhook.bind(controller))
  }, { prefix: '/api/webhook' })

  // ─── HEALTH CHECKS ─────────────────────────────────────
  app.get('/', {
    schema: {
      tags: ['Health'],
      summary: 'Root status endpoint',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            service: { type: 'string' },
            timestamp: { type: 'string' },
            uptime: { type: 'number' },
            health: { type: 'string' },
          },
        },
      },
    },
    config: {
      rateLimit: false,
    },
  }, async () => ({
    status: 'OK',
    service: 'lndry-backend',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    health: '/health/ready',
  }))

  app.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Liveness health check',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string' },
            uptime: { type: 'number' },
          },
        },
      },
    },
  }, async () => ({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }))

  app.get('/health/ready', {
    schema: {
      tags: ['Health'],
      summary: 'Readiness health check',
    },
  }, async (request, reply) => {
    const [postgresResult, redisResult] = await Promise.allSettled([
      query('SELECT 1'),
      redis.ping(),
    ])

    const dependencies = {
      postgres: postgresResult.status === 'fulfilled'
        ? { status: 'up' }
        : {
            status: 'down',
            error: postgresResult.reason?.message || 'Unknown PostgreSQL error',
          },
      redis: redisResult.status === 'fulfilled'
        ? { status: 'up' }
        : {
            status: 'down',
            error: redisResult.reason?.message || 'Unknown Redis error',
          },
    }

    const ready = Object.values(dependencies).every(
      (dependency) => dependency.status === 'up'
    )

    if (!ready) {
      request.log.error({ dependencies }, 'Readiness check failed')
      return reply.code(503).send({
        status: 'NOT_READY',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        dependencies,
      })
    }

    return {
      status: 'READY',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dependencies,
    }
  })

  // Temporary diagnostic checkpoint for the vendor app's splash-hang
  // investigation (2026-09-16) — the affected tester device is remote
  // (different city, no physical/USB access), so the vendor app pings this
  // at each step of its startup/session-restore sequence instead of
  // guessing blind. No auth — it must work before any token exists.
  // Read results with: docker compose logs api | grep VENDOR_SPLASH_DIAG
  // Safe to delete this route once that investigation is closed.
  app.post('/health/diag', {
    schema: {
      tags: ['Health'],
      summary: 'Temporary client startup checkpoint logger (vendor app splash-hang investigation)',
      body: {
        type: 'object',
        properties: {
          app: { type: 'string' },
          sessionId: { type: 'string' },
          step: { type: 'string' },
          extra: { type: 'object', additionalProperties: true },
        },
      },
    },
  }, async (request, reply) => {
    request.log.info(
      { tag: 'VENDOR_SPLASH_DIAG', ...request.body, ip: request.ip },
      'VENDOR_SPLASH_DIAG'
    )
    return reply.code(204).send()
  })

  return app
}
