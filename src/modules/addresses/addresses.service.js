import { logger } from '../../config/logger.js'
import { query } from '../../config/database.js'
import { env } from '../../config/env.js'
import { AllocationService } from '../allocation/allocation.service.js'
import { AllocationRepository } from '../allocation/allocation.repository.js'

const MAX_ADDRESSES = 10

// ─── Serviceable pincodes — aggregated from active vendors ─────────────
// The old implementation read from app_settings (a global static list),
// which missed pincodes added to individual vendors. This version queries
// the vendors table directly so any pincode in any active shop's
// serviceable_pincodes array is immediately available to customers.
let cachedPincodes = null
let pincodesCacheTime = 0
const PINCODE_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

async function getServiceablePincodes() {
  const now = Date.now()
  if (cachedPincodes && (now - pincodesCacheTime) < PINCODE_CACHE_TTL) {
    return cachedPincodes
  }

  try {
    // Flatten all serviceable_pincodes arrays from every active, non-deleted shop
    const { rows } = await query(
      `SELECT DISTINCT unnest(serviceable_pincodes) AS pincode
         FROM vendors
        WHERE is_active = true
          AND deleted_at IS NULL
          AND array_length(serviceable_pincodes, 1) > 0`
    )

    if (rows.length > 0) {
      cachedPincodes = new Set(rows.map((r) => String(r.pincode)))
    } else {
      // No vendors configured yet — allow all pincodes so the app isn't blocked
      cachedPincodes = null
    }

    pincodesCacheTime = now
    logger.info(
      { count: cachedPincodes ? cachedPincodes.size : 'all' },
      'Serviceable pincodes loaded from active vendors'
    )
    return cachedPincodes
  } catch (err) {
    logger.error({ err }, 'Failed to load serviceable pincodes from vendors — allowing all')
    return null // null = allow all, so the app never gets stuck
  }
}

/**
 * Addresses service — business logic for delivery addresses
 */
export class AddressesService {
  constructor(repository) {
    this.repo = repository
  }

  /**
   * Get all addresses for a user
   */
  async list(userId) {
    return this.repo.findByUser(userId)
  }

  /**
   * Create a new address
   */
  async create(userId, data) {
    if (!this._hasValidCoordinates(data.lat, data.lng)) {
      return {
        success: false,
        message: 'Map pin is required. Please select your exact location.',
        code: 'ADDRESS_COORDINATES_REQUIRED',
      }
    }

    const count = await this.repo.countByUser(userId)
    if (count >= MAX_ADDRESSES) {
      return { success: false, message: `Maximum ${MAX_ADDRESSES} addresses allowed` }
    }

    // First address or explicitly default
    if (data.isDefault || count === 0) {
      data.isDefault = true
    }

    const address = await this.repo.create(userId, data)

    // If set as default, unset others
    if (data.isDefault && count > 0) {
      await this.repo.setDefault(address.id, userId)
    }

    logger.info({ userId, addressId: address.id }, 'Address created')

    // FIX: Automatically recompute shop allocation when an address is created.
    // This ensures that a real user who adds their first delivery address
    // immediately gets an allocated shop and can view product details.
    // Fire-and-forget — do not block the address creation response.
    if (this._hasValidCoordinates(data.lat, data.lng) && data.pincode) {
      setImmediate(() => {
        this._triggerAllocationRecompute(userId, {
          lat: Number(data.lat),
          lng: Number(data.lng),
          pincode: String(data.pincode),
        }).catch((err) => {
          logger.warn(
            { userId, err: err.message, action: 'address_create.allocation_recompute_failed' },
            'Background allocation recompute failed after address creation'
          )
        })
      })
    }

    return { success: true, address }
  }

  /**
   * Update an address
   */
  async update(userId, id, data) {
    const existing = await this.repo.findByIdAndUser(id, userId)
    if (!existing) {
      return { success: false, message: 'Address not found' }
    }

    const hasLat = Object.prototype.hasOwnProperty.call(data, 'lat')
    const hasLng = Object.prototype.hasOwnProperty.call(data, 'lng')
    if (hasLat !== hasLng) {
      return {
        success: false,
        message: 'Latitude and longitude must be updated together.',
        code: 'ADDRESS_COORDINATES_INCOMPLETE',
      }
    }
    if (hasLat && !this._hasValidCoordinates(data.lat, data.lng)) {
      return {
        success: false,
        message: 'Map pin is invalid. Please select your location again.',
        code: 'ADDRESS_COORDINATES_INVALID',
      }
    }
    if (!hasLat && !this._hasValidCoordinates(existing.lat, existing.lng)) {
      return {
        success: false,
        message: 'Map pin is required. Please update this address location.',
        code: 'ADDRESS_COORDINATES_REQUIRED',
      }
    }

    const address = await this.repo.update(id, userId, data)
    logger.info({ userId, addressId: id }, 'Address updated')

    // FIX: Recompute allocation when a default address coordinates/pincode change.
    // Use updated coords if provided, fall back to existing.
    const effectiveLat = hasLat ? Number(data.lat) : Number(existing.lat)
    const effectiveLng = hasLng ? Number(data.lng) : Number(existing.lng)
    const effectivePincode = data.pincode ?? existing.pincode
    if (
      this._hasValidCoordinates(effectiveLat, effectiveLng) &&
      effectivePincode
    ) {
      setImmediate(() => {
        this._triggerAllocationRecompute(userId, {
          lat: effectiveLat,
          lng: effectiveLng,
          pincode: String(effectivePincode),
        }).catch((err) => {
          logger.warn(
            { userId, err: err.message, action: 'address_update.allocation_recompute_failed' },
            'Background allocation recompute failed after address update'
          )
        })
      })
    }

    return { success: true, address }
  }

  /**
   * Delete an address
   */
  async delete(userId, id) {
    const existing = await this.repo.findByIdAndUser(id, userId)
    if (!existing) {
      return { success: false, message: 'Address not found' }
    }

    await this.repo.delete(id, userId)

    // If deleted the default, promote newest remaining
    if (existing.isDefault) {
      const remaining = await this.repo.findByUser(userId)
      if (remaining.length > 0) {
        const promoted = remaining[0]
        await this.repo.setDefault(promoted.id, userId)
        // FIX: the promoted address is now the delivery context — recompute
        // allocation so cart/product availability tracks the new default.
        this._recomputeForAddress(userId, promoted, 'address_delete')
      }
    }

    logger.info({ userId, addressId: id }, 'Address deleted')
    return { success: true }
  }

  /**
   * Set as default address
   */
  async setDefault(userId, id) {
    const existing = await this.repo.findByIdAndUser(id, userId)
    if (!existing) {
      return { success: false, message: 'Address not found' }
    }

    const address = await this.repo.setDefault(id, userId)
    logger.info({ userId, addressId: id }, 'Default address set')

    // FIX (root cause of stale allocation): switching the default delivery
    // address must recompute the user's shop allocation. Previously only
    // create/update recomputed, so selecting an existing address as default
    // left the allocation pointing at the OLD address's vendors — making
    // garment_rates from the new area's stores appear yet fail cart validation.
    this._recomputeForAddress(userId, address ?? existing, 'address_set_default')

    return { success: true, address }
  }

  /**
   * Get address by ID
   */
  async get(userId, id) {
    return this.repo.findByIdAndUser(id, userId)
  }

  /**
   * Validate coordinates to check serviceability and eligible vendor count
   */
  async validateLocation(lat, lng) {
    if (!this._hasValidCoordinates(lat, lng)) {
      return { serviceable: false, eligible_vendor_count: 0 }
    }
    const count = await this.repo.countServiceableVendorsAtCoords(lat, lng)
    return {
      serviceable: count > 0,
      eligible_vendor_count: count
    }
  }

  /**
   * Validate pincode for delivery availability.
   * Checks against pincodes in active vendors' serviceable_pincodes arrays.
   * Returns available=true also when no vendors are configured yet (null set).
   */
  async validatePincode(pincode) {
    // Hard-blocked in production regardless of the flag — same
    // defense-in-depth pattern as the demo-OTP bypass.
    if (env.NODE_ENV !== 'production' && env.ALLOW_ALL_PINCODES) {
      return { available: true, deliveryFee: 29, estimatedMin: 30 }
    }

    const serviceablePincodes = await getServiceablePincodes()

    // null means no vendors configured — allow all so the app isn't blocked
    const available = serviceablePincodes === null || serviceablePincodes.has(String(pincode))
    return {
      available,
      deliveryFee: available ? 29 : 0,
      estimatedMin: available ? 30 : 0,
    }
  }

  _hasValidCoordinates(lat, lng) {
    const parsedLat = Number(lat)
    const parsedLng = Number(lng)
    return Number.isFinite(parsedLat) &&
      Number.isFinite(parsedLng) &&
      parsedLat >= -90 &&
      parsedLat <= 90 &&
      parsedLng >= -180 &&
      parsedLng <= 180
  }

  /**
   * Fire-and-forget allocation recompute for a full address row (used by
   * setDefault/delete where we already hold the address record). Validates
   * coordinates + pincode before triggering so we never push an invalid
   * recompute.
   * @private
   */
  _recomputeForAddress(userId, address, action) {
    if (!address) return
    const lat = Number(address.lat)
    const lng = Number(address.lng)
    const pincode = address.pincode
    if (!this._hasValidCoordinates(lat, lng) || !pincode) {
      return
    }
    setImmediate(() => {
      this._triggerAllocationRecompute(userId, {
        lat,
        lng,
        pincode: String(pincode),
      }).catch((err) => {
        logger.warn(
          { userId, err: err.message, action: `${action}.allocation_recompute_failed` },
          'Background allocation recompute failed'
        )
      })
    })
  }

  /**
   * Fire-and-forget allocation recompute helper.
   * Called after address create/update so the user gets a shop allocation
   * automatically without needing to call POST /allocation/recompute manually.
   * @private
   */
  async _triggerAllocationRecompute(userId, address) {
    const allocationService = new AllocationService(new AllocationRepository())
    const result = await allocationService.computeAndUpsertForUser(userId, address)
    if (result.success) {
      logger.info(
        {
          userId,
          shopCount: result.data?.vendors?.length ?? 0,
          action: 'address.allocation_recomputed',
        },
        'Allocation auto-recomputed after address change'
      )
    } else {
      logger.warn(
        { userId, code: result.code, message: result.message, action: 'address.allocation_recompute_failed' },
        'Allocation auto-recompute returned non-success'
      )
    }
  }
}
