# Vendor App modes & POS onboarding (migration 152)

A vendor has an **offering** — which LNDRY products it may use in the Vendor App:

| `vendors.offering` | Meaning |
|---|---|
| `MARKETPLACE` | Customers book through the LNDRY customer app (default for every existing vendor that does not use POS) |
| `POS` | Counter billing + CRM only. Not listed in the customer app; no marketplace KYC / radius / review |
| `BOTH` | Either; the app lets the owner switch mode in Settings |

`offering` is a **different axis** from `vendors.vendor_type` (STANDARD / PARTNER / EXCLUSIVE, migration 143), which only
controls whether walk-in POS sales sync to the customer's LNDRY app and whether the LNDRY wallet works at the counter.
A POS-only vendor is created as `STANDARD`.

Other columns: `pos_onboarding_status` (`NOT_STARTED` | `IN_PROGRESS` | `COMPLETED`), `pos_plan_name`, `pos_valid_to`
(shown on the POS Home plan card; set by an admin, no billing), `pos_onboarding_data` (wizard answers, JSONB).

**Backfill:** a vendor that already uses the POS — any `store_orders` row (COUNTER *or* `DESKTOP_PUSH` from the Epic POS),
a POS catalogue, a cash shift or saved POS settings — becomes `BOTH` + `COMPLETED`. Everyone else stays `MARKETPLACE`.

## Endpoints (all `Authorization: Bearer <access token>`, responses `{ success, message, data }`)

### `GET /api/v1/vendor/app-mode`
Works for any signed-in user, including one with no vendor yet. `Cache-Control: no-store`.
```json
{ "appMode": {
  "hasVendor": true, "vendorId": "…", "shopName": "Sparkle Laundry", "role": "VENDOR_OWNER",
  "offering": "BOTH", "posOnboardingStatus": "COMPLETED", "posPlanName": "Enterprise 5 Store", "posValidTo": "2026-11-03",
  "allowedModes": ["MARKETPLACE", "POS"],
  "needsPosOnboarding": false, "canStartPos": false,
  "vendorType": "STANDARD", "appSync": false, "walletAccess": false } }
```
* No vendor yet → `hasVendor:false, offering:null, allowedModes:[], canStartPos:true`.
* `allowedModes` includes `POS` **only** when `posOnboardingStatus = COMPLETED`.
* `needsPosOnboarding` = offering is POS/BOTH but setup is unfinished. `canStartPos` = marketplace-only vendor may add POS.

### `POST /api/v1/vendor/pos-onboarding/start`
Idempotent. Any signed-in user.
* Brand-new user → creates a **POS-only shop** (`offering=POS`, `status=APPROVED`, `vendor_approved=false`,
  `marketplace_published=false`, `vendor_type=STANDARD`) + the user as `VENDOR_OWNER`. `201`, `created:true`.
  Address columns get placeholders until the *shop* step. Safe against double-taps (advisory lock per user).
* Marketplace owner → `offering` becomes `BOTH`, onboarding `IN_PROGRESS`.
* Staff / captain → `403 NOT_OWNER`. User with a marketplace *application* → `409 MARKETPLACE_APPLICATION_EXISTS`
  (a second shop would make login ambiguous; ask support).
* `needsTokenRefresh:true` after a shop was created: **the app must call `/auth/refresh-token`** — the access token issued at
  login has no vendor/shop claims until it is refreshed.

### `GET /api/v1/vendor/pos-onboarding` (owner)
`{ onboarding: { status, offering, data, missingSteps, nextStep } }` — resume point for the wizard.

### `PATCH /api/v1/vendor/pos-onboarding` (owner) — body `{ "step": "shop|tax|counter|pricelist", "data": {…} }`
| step | fields (validated server-side) |
|---|---|
| `shop` | `name` 2–200, `ownerName` 2–120, `addressLine1` 3–255, `city` 2–100 (required); `state`, `pincode` (6 digits) optional → also written to the vendor's real columns |
| `tax` | `gstEnabled` (must be `true` literally), `gstin` (required if GST on; 15-char format) → `vendors.gst_number`; `upiId` (`name@bank`), `currency` (`INR` only), `invoicePrefix` (1–6 A-Z0-9, default `INV`) |
| `counter` | `printerProfile` (`none`/`system-default`/`thermal-58mm`/`thermal-80mm`), `orderSeriesPrefix` (default `LN`), `defaultDeliveryDays` 0–30 (default 3) |
| `pricelist` | `choice`: `starter` or `own` |

Errors: `400 VALIDATION_ERROR` (plain-language message), `400 UNKNOWN_STEP`, `409 POS_NOT_STARTED`, `403 NOT_OWNER`.
The wizard answers are stored on the vendor; they are **not** pushed into `vendor_pos_settings` (those keys have Epic-defined shapes) —
the POS settings screens map them when they need them.

### `POST /api/v1/vendor/pos-onboarding/complete` (owner)
Requires all four steps (`400 ONBOARDING_INCOMPLETE` + `missing_steps`). If `pricelist.choice = starter` it creates a **sample**
price list through the normal POS catalogue service (3 categories, 4 services, 13 garments, 36 prices — round sample rates the owner
must review; see `starter-pricelist.js`). Idempotent; a failure leaves the shop NOT completed and is safe to retry (`500 STARTER_PRICELIST_FAILED`).

### `PUT /api/v1/vendors/admin/:id/offering` (ADMIN)
Body `{ "offering": "MARKETPLACE|POS|BOTH", "pos_plan_name": "…"|null, "pos_valid_to": "YYYY-MM-DD"|null }`.
Real calendar dates only. Audited (`vendor_offering_changed`). The vendor's own profile update cannot change any of these columns.

## Enforcement (`ENFORCE_OFFERING`, default **false**)
`middlewares/offering-guard.js` is a root `preHandler`. Prefix lists live in `modules/vendor-app-mode/offering.js`:
* POS: `/api/v1/vendor/{counter,counter-sales,pos,pos-catalogue,pos-settings,cash-shifts,customer-profiles,customer-ledger,order-holds,imports}`
* Marketplace: `/api/v1/vendor/{orders,rider}`, `/api/v1/vendor-orders`
* `false` → only logs `ENFORCE_OFFERING=false: request would be blocked`; nothing changes for any client (including the Epic POS).
* `true` → `403 POS_NOT_ENABLED` / `403 MARKETPLACE_NOT_ENABLED` for a vendor without that product. Never applies to `/vendor/app-mode`,
  `/vendor/pos-onboarding`, profile, employees, auth.

**Rollout:** deploy with the flag off → review the "would be blocked" log lines for a while → anything legitimate (e.g. an Epic shop
not yet backfilled) gets `BOTH` via the admin endpoint → set `ENFORCE_OFFERING=true`. Rollback = set it back to `false`.
The offering is cached in Redis for 60 s and dropped on every change.

## Not in scope here
Marketplace application for a user who already has a POS-only shop (needs support/admin), billing for POS plans, multi-store.
