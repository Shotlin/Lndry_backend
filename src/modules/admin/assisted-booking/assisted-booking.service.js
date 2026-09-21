import { emit as emitAudit } from '../../../utils/audit-log.js'
import { AssistedBookingRepository } from './assisted-booking.repository.js'

// Built-in wording, used only if the settings row is somehow missing —
// mirrors the migration's defaults.
const FALLBACK = {
  enabled: false,
  scope: 'ALL',
  title: 'Not sure what service you need?',
  subtitle: "Book now — we'll inspect your garments and confirm the right service & price.",
  buttonText: 'Book With Expert Check',
  iconUrl: null,
  checkoutNote: 'Service & final price will be confirmed after garment inspection.',
  assessmentTitle: 'Laundry Assessment Required',
  assessmentMessage: 'Vendor will inspect your garments and confirm services, quantity/weight and final price.',
  priceLabel: 'Price after inspection',
}

const TEXT_LIMITS = {
  title: 120,
  subtitle: 300,
  buttonText: 60,
  checkoutNote: 300,
  assessmentTitle: 120,
  assessmentMessage: 400,
  priceLabel: 80,
}
const TEXT_LABELS = {
  title: 'Display title',
  subtitle: 'Display subtitle',
  buttonText: 'Button text',
  checkoutNote: 'Checkout note',
  assessmentTitle: 'Assessment title',
  assessmentMessage: 'Assessment message',
  priceLabel: 'Price placeholder',
}

export class AssistedBookingService {
  constructor(repository = new AssistedBookingRepository()) {
    this.repo = repository
  }

  async _settings() {
    return (await this.repo.getSettings()) || FALLBACK
  }

  /** Full view for the dashboard. */
  async getAdminView() {
    const [settings, selectedVendors] = await Promise.all([
      this._settings(),
      this.repo.listSelectedVendors(),
    ])
    return { ...settings, selectedVendors }
  }

  /**
   * Is the "Book With Expert Check" option offered for this vendor right now?
   * The one rule used by BOTH the customer-facing config and the quote
   * endpoint, so the button can never appear for a vendor the backend would
   * then refuse.
   */
  async isAvailableForVendor(vendorId) {
    const settings = await this._settings()
    if (!settings.enabled) return false
    if (settings.scope === 'ALL') return true
    return this.repo.isVendorSelected(vendorId)
  }

  /** What the customer app renders (vendor page CTA, checkout, order screen). */
  async getPublicConfig(vendorId) {
    const settings = await this._settings()
    const available = vendorId ? await this.isAvailableForVendor(vendorId) : false
    return {
      available,
      title: settings.title,
      subtitle: settings.subtitle,
      buttonText: settings.buttonText,
      iconUrl: settings.iconUrl || null,
      checkoutNote: settings.checkoutNote,
      assessmentTitle: settings.assessmentTitle,
      assessmentMessage: settings.assessmentMessage,
      priceLabel: settings.priceLabel,
    }
  }

  async update(body, actor) {
    const current = await this._settings()
    const next = { ...current }

    if (body.enabled !== undefined) next.enabled = !!body.enabled
    if (body.scope !== undefined) {
      if (!['ALL', 'SELECTED'].includes(body.scope)) {
        return { success: false, message: 'scope must be ALL or SELECTED' }
      }
      next.scope = body.scope
    }

    for (const [key, max] of Object.entries(TEXT_LIMITS)) {
      if (body[key] === undefined) continue
      const value = String(body[key]).trim()
      if (!value) return { success: false, message: `${TEXT_LABELS[key]} cannot be empty` }
      if (value.length > max) return { success: false, message: `${TEXT_LABELS[key]} must be at most ${max} characters` }
      next[key] = value
    }

    if (body.iconUrl !== undefined) {
      const url = body.iconUrl == null ? '' : String(body.iconUrl).trim()
      if (url && !/^https:\/\/\S+$/i.test(url)) {
        return { success: false, message: 'Icon / image must be an https link' }
      }
      next.iconUrl = url || null
    }

    let vendorIds
    if (body.vendorIds !== undefined) {
      vendorIds = [...new Set(body.vendorIds)]
      const existing = await this.repo.findExistingVendorIds(vendorIds)
      if (existing.length !== vendorIds.length) {
        return { success: false, message: 'One or more selected vendors do not exist' }
      }
    }

    if (next.enabled && next.scope === 'SELECTED') {
      const count = vendorIds !== undefined
        ? vendorIds.length
        : (await this.repo.listSelectedVendors()).length
      if (count === 0) {
        return { success: false, message: 'Select at least one vendor, or make it available to all vendors' }
      }
    }

    await this.repo.save(next, vendorIds, actor.userId)
    emitAudit('assisted_booking_updated', {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'assisted_booking_settings',
      // A single global settings row: audit_logs.target_id is a UUID column,
      // so there is no id to record (a non-UUID here made the insert fail).
      target_id: null,
      before: current,
      after: { ...next, vendorCount: vendorIds?.length },
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
    return { success: true, settings: await this.getAdminView() }
  }
}
