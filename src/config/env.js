import { z } from 'zod'
import dotenv from 'dotenv'

dotenv.config()

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', ''].includes(normalized)) return false
  }
  return value
}, z.boolean())

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4500),
  HOST: z.string().default('0.0.0.0'),
  API_VERSION: z.string().default('v1'),
  APP_NAME: z.string().default('LndryApp'),
  FRONTEND_URL: z.string().url().optional(),
  ADMIN_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:4501,http://localhost:3001,http://localhost:3002'),
  // When set, only these exact hostnames are trusted under the vercel.app
  // suffix (instead of trusting any *.vercel.app deployment). Optional —
  // unset preserves the broader suffix-match default.
  CORS_ALLOWED_VERCEL_HOSTS: z.string().optional(),
  // Which proxies may set X-Forwarded-For. Default trusts only private /
  // loopback addresses (nginx, cloudflared, an AWS load balancer on the VPC),
  // so the client IP is whatever the last PUBLIC hop reported and a client can
  // never forge it with its own X-Forwarded-For header. Accepts proxy-addr
  // syntax ("loopback,uniquelocal"), a hop count ("2"), or "true" (trust all —
  // only safe if the origin is unreachable except through your proxy).
  TRUST_PROXY: z.string().default('loopback,linklocal,uniquelocal'),
  // EMERGENCY ROLLBACK ONLY. Restores the old behaviour where a shop employee's
  // token counts as platform ADMIN (see utils/actor-role.js).
  LEGACY_SHOP_STAFF_ADMIN_ROLE: booleanFromEnv.default(false),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('365d'),
  COOKIE_SECRET: z.string().min(16).optional(),
  // Encrypts credentials saved from the dashboard (Razorpay / 2Factor). Required in production before
  // any secret can be saved there; changing it makes already-saved secrets unreadable (re-enter them).
  SETTINGS_ENCRYPTION_KEY: z.string().min(32).optional(),

  // PostgreSQL
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_NAME: z.string(),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_POOL_MIN: z.coerce.number().default(5),
  DB_POOL_MAX: z.coerce.number().default(20),
  DB_IDLE_TIMEOUT: z.coerce.number().default(30000),
  // How long a request may WAIT for a free pooled connection. 2s was far too
  // tight for a burst (hundreds of simultaneous orders queue on a 20-conn
  // pool); a queued request should wait, not 500.
  DB_CONNECTION_TIMEOUT: z.coerce.number().default(10000),
  // Server-side guards so one runaway query / abandoned transaction can never
  // hold a pooled connection (and its row locks) forever.
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().default(60000),
  DB_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().default(60000),
  DB_CONNECT_RETRIES: z.coerce.number().default(20),
  DB_CONNECT_RETRY_DELAY: z.coerce.number().default(1000),
  DB_SSL: booleanFromEnv.default(false),
  DB_SSL_CA_PATH: z.string().optional(),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DB: z.coerce.number().default(0),
  REDIS_TTL_DEFAULT: z.coerce.number().default(600),

  // OTP
  OTP_EXPIRY_SECONDS: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_LOCKOUT_SECONDS: z.coerce.number().default(1800),
  OTP_LENGTH: z.coerce.number().default(6),
  ALLOW_DEMO_OTP: booleanFromEnv.default(false),
  DEMO_OTP_PHONE: z.string().optional(),
  DEMO_OTP_CODE: z.string().regex(/^\d{4,8}$/).default('123456'),
  // Narrow, NODE_ENV-independent bypass for testing phone numbers on a
  // production deployment that has no SMS provider configured yet.
  // Unlike ALLOW_DEMO_OTP (hard-blocked whenever NODE_ENV=production), this
  // only affects the exact phone numbers listed here — every other
  // production safety guard stays intact. Comma-separated, e.g.
  // "9876543210,9123456789" — or the literal "*" to bypass for any phone
  // (pre-launch dev/testing only; clear this once a real SMS provider,
  // TWO_FACTOR_API_KEY, is configured). Empty/unset = no effect anywhere.
  TEST_BYPASS_OTP_PHONES: z.string().optional(),
  ALLOW_ALL_PINCODES: booleanFromEnv.default(false),

  // Razorpay
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_CURRENCY: z.string().default('INR'),
  ALLOW_MOCK_PAYMENT: booleanFromEnv.default(false),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_UPLOAD_PRESET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('laundry-app'),

  // Rate Limiting
  RATE_LIMIT_ENABLED: booleanFromEnv.default(true),
  // Authenticator-app (TOTP) two-factor for the admin dashboard: sign-in code and
  // step-up before high-risk actions. Off by default; set true to bring it back.
  ADMIN_2FA_ENABLED: booleanFromEnv.default(false),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW: z.coerce.number().default(60000),
  // Per-IP cap on /send-otp. The strict control is the per-PHONE limit in the
  // auth service (5 per 10 min); this per-IP cap only stops one address from
  // spraying many numbers, so it must be generous enough for carrier-grade NAT
  // where thousands of real users share a handful of public IPs.
  OTP_RATE_LIMIT_MAX: z.coerce.number().default(30),
  OTP_RATE_LIMIT_WINDOW: z.coerce.number().default(300000),
  // Blanket limits applied to EVERY route (the per-route limits above stay in
  // force on top). Per client IP, and per bearer token (so one logged-in user
  // cannot hog the API from many IPs, and many users behind one NAT do not
  // starve each other).
  RATE_LIMIT_GLOBAL_IP_MAX: z.coerce.number().default(1800),
  RATE_LIMIT_GLOBAL_TOKEN_MAX: z.coerce.number().default(900),
  RATE_LIMIT_GLOBAL_WINDOW: z.coerce.number().default(60000),

  // File Upload
  MAX_FILE_SIZE: z.coerce.number().default(5242880),
  ALLOWED_IMAGE_TYPES: z.string().default('image/jpeg,image/png,image/webp'),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: booleanFromEnv.default(false),
  ENABLE_SWAGGER: booleanFromEnv.optional(),
  // Error tracking — optional. Sentry stays fully uninitialized (no-op)
  // when unset, in dev and in prod alike.
  SENTRY_DSN: z.string().optional(),
  // Shared only by the website server and this backend to authenticate the
  // partner-lead handoff. Never expose through NEXT_PUBLIC_* or mobile apps.
  WEBSITE_PARTNER_LEAD_HMAC_SECRET: z.string().min(32).optional(),

  // Boot-time guards
  // STRICT_PERMISSION_AUDIT — when true, fail boot (exit 1) if any
  // protected dashboard route lacks a canonical Permission_String per
  // R17 AC#9 (multi-vendor design §4.5, task 2.7). Default false until
  // Phase C tasks (3.x – 11.x) wire `requiredPermission` onto every
  // protected route; flip to true once that work is complete.
  STRICT_PERMISSION_AUDIT: booleanFromEnv.default(false),

  // STRICT_SESSION_VERSION_CHECK — when true, the auth plugin (task 3.7)
  // rejects any JWT that does not carry a `session_version` claim with
  // 401 SESSION_INVALID per R20.8 (multi-vendor design §5.5). Default
  // false so legacy in-flight tokens minted before migration 047 are
  // accepted (the row-vs-claim comparison still runs whenever the claim
  // IS present). Flip to true once all live tokens have rotated through
  // the `session_version`-aware /login, /select-shop, and
  // /change-password flows (tasks 3.2 / 3.3 / 3.5).
  STRICT_SESSION_VERSION_CHECK: booleanFromEnv.default(false),

  // MULTI_VENDOR_PRODUCT_APPROVAL — opt-in HQ approval workflow for
  // newly created Shop_Products (R23.10, R23.11, R23.22, R23.23 /
  // multi-vendor design §3.2.3 + §17.3). Default false preserves
  // backward-compatible "born APPROVED" behaviour. When true:
  //   1. The manual-create path persists Shop_Products with
  //      `approval_status='PENDING'`.
  //   2. The HQ approve/reject endpoints under
  //      `/api/v1/admin/shop-garment_rates/:id/{approve,reject}` are
  //      ENABLED. While the flag is OFF those endpoints reply
  //      503 FEATURE_DISABLED so callers can detect the gate without
  //      probing route existence.
  //   3. Customer-facing product queries gain
  //      `approval_status='APPROVED'` to the existing visibility filter
  //      (design §17.3).
  MULTI_VENDOR_PRODUCT_APPROVAL: booleanFromEnv.default(false),

  // 2Factor.in SMS OTP
  TWO_FACTOR_API_KEY: z.string().optional(),
  // Template name registered on 2Factor.in dashboard.
  // Accepts both TWO_FACTOR_TEMPLATE (preferred) and legacy TWO_FACTOR_SENDER alias.
  TWO_FACTOR_TEMPLATE: z.string().default('LndryAppOTP'),
  TWO_FACTOR_SENDER: z.string().optional(),        // alias — used if TEMPLATE unset
  // TWO_FACTOR_BASE_URL is not needed — the URL is hardcoded in sms.js to
  // https://2factor.in/API/V1 which is the stable, non-configurable endpoint.
  SMS_PROVIDER: z.enum(['2factor', 'none']).default('none'),

  // Firebase FCM
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FCM_ENABLED: booleanFromEnv.default(false),

  // Demo delivery flow
  ALLOW_DEMO_DELIVERY_ACTIONS: booleanFromEnv.default(false),

  // ALLOW_AUTO_APPROVE_VENDOR — dev/local-only shortcut so a developer can
  // spin up multiple test vendor accounts (one per phone number) without a
  // human admin manually approving each application from the HQ dashboard.
  // When true, submitApplication() immediately promotes the application to
  // an active vendor instead of parking it at WAITING_FOR_APPROVAL. Hard-
  // blocked in production regardless of the flag (see
  // VendorsService._isAutoApproveVendorEnabled), matching the ALLOW_DEMO_OTP
  // / ALLOW_MOCK_PAYMENT pattern.
  ALLOW_AUTO_APPROVE_VENDOR: booleanFromEnv.default(false),

  // ENFORCE_OFFERING — when true, a vendor's `offering` (MARKETPLACE | POS | BOTH, migration 152)
  // is enforced on the POS and marketplace route groups (403 POS_NOT_ENABLED /
  // MARKETPLACE_NOT_ENABLED). Default false: the guard only logs what it would block, so the
  // Epic desktop/website POS keeps working untouched. Turn on only after reviewing those logs.
  ENFORCE_OFFERING: booleanFromEnv.default(false),

  // Delivery
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  DELIVERY_RADIUS_KM: z.coerce.number().default(10),
  EXPRESS_DELIVERY_MINUTES: z.coerce.number().default(30),
  PLATFORM_FEE: z.coerce.number().default(5),
  FREE_DELIVERY_ABOVE: z.coerce.number().default(499),
  DELIVERY_FEE: z.coerce.number().default(25),

  // BullMQ
  BULL_REDIS_HOST: z.string().default('localhost'),
  BULL_REDIS_PORT: z.coerce.number().default(6379),
  BULL_REDIS_PASSWORD: z.string().optional(),
  BULL_CONCURRENCY: z.coerce.number().default(5),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

/**
 * Production safety gate. Each of these flags exists for local development or
 * pre-launch testing and is dangerous live; a production process refuses to
 * start rather than quietly run with the door open.
 */
export function findProductionConfigProblems(cfg) {
  const fatal = []
  const warn = []
  if (cfg.NODE_ENV !== 'production') return { fatal, warn }

  if ((cfg.TEST_BYPASS_OTP_PHONES || '').split(',').some((p) => p.trim() === '*')) {
    fatal.push('TEST_BYPASS_OTP_PHONES="*" lets anyone log in as any phone number. List specific review/test numbers or leave it empty.')
  }
  if (cfg.ALLOW_DEMO_OTP) fatal.push('ALLOW_DEMO_OTP must be false in production.')
  if (cfg.ALLOW_MOCK_PAYMENT) fatal.push('ALLOW_MOCK_PAYMENT must be false in production.')
  if (cfg.ALLOW_ALL_PINCODES) fatal.push('ALLOW_ALL_PINCODES must be false in production.')
  if (cfg.ALLOW_DEMO_DELIVERY_ACTIONS) fatal.push('ALLOW_DEMO_DELIVERY_ACTIONS must be false in production.')
  if (cfg.ALLOW_AUTO_APPROVE_VENDOR) fatal.push('ALLOW_AUTO_APPROVE_VENDOR must be false in production.')
  if (!cfg.RATE_LIMIT_ENABLED) fatal.push('RATE_LIMIT_ENABLED must be true in production.')
  if (cfg.JWT_ACCESS_SECRET === cfg.JWT_REFRESH_SECRET) {
    fatal.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.')
  }
  const placeholder = /replace|change[-_ ]?me|example|your[-_ ]|secret123|password123/i
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'DB_PASSWORD']) {
    if (placeholder.test(cfg[key] || '')) fatal.push(`${key} still looks like a placeholder value.`)
  }
  if (cfg.RAZORPAY_KEY_ID && !cfg.RAZORPAY_WEBHOOK_SECRET) {
    warn.push('RAZORPAY_KEY_ID is set without RAZORPAY_WEBHOOK_SECRET — payments that complete after the app closes can only be recovered by the polling safety-net, not by webhook (unless keys are saved in the dashboard).')
  }
  if (cfg.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) {
    warn.push('Razorpay is using TEST keys in production.')
  }
  if (!cfg.CORS_ALLOWED_VERCEL_HOSTS) {
    warn.push('CORS trusts every *.vercel.app origin. Set CORS_ALLOWED_VERCEL_HOSTS to your exact hostnames.')
  }
  if (!cfg.DB_SSL && cfg.DB_HOST && !['localhost', '127.0.0.1', 'postgres', 'db'].includes(cfg.DB_HOST)) {
    warn.push('DB_SSL is off while DB_HOST is remote — database traffic is unencrypted.')
  }
  if (!cfg.FCM_ENABLED || !cfg.FIREBASE_PROJECT_ID) {
    warn.push('Push notifications are OFF (FCM_ENABLED=false or no Firebase project) — customers and laundries will not receive order / payment push messages.')
  }
  if (cfg.SMS_PROVIDER === 'none' && !cfg.TWO_FACTOR_API_KEY) {
    warn.push('No SMS provider in the environment (SMS_PROVIDER=none, no TWO_FACTOR_API_KEY). Login works only if an SMS provider is saved in the dashboard settings; otherwise send-otp returns 503.')
  }
  if (!cfg.REDIS_PASSWORD) warn.push('REDIS_PASSWORD is empty.')
  if (!cfg.SENTRY_DSN) warn.push('SENTRY_DSN is not set — production errors will not be reported.')
  if (cfg.STRICT_SESSION_VERSION_CHECK === false) {
    warn.push('STRICT_SESSION_VERSION_CHECK is off — tokens without a session_version claim are accepted.')
  }
  return { fatal, warn }
}

{
  const { fatal, warn } = findProductionConfigProblems(parsed.data)
  for (const w of warn) console.warn(`⚠️  production config: ${w}`)
  if (fatal.length > 0) {
    console.error('❌ Refusing to start in production with an unsafe configuration:')
    for (const f of fatal) console.error(`   - ${f}`)
    process.exit(1)
  }
}

export const env = {
  ...parsed.data,
  ENABLE_SWAGGER:
    parsed.data.ENABLE_SWAGGER ?? parsed.data.NODE_ENV !== 'production',
}
