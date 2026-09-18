import { emit as emitAudit } from '../../utils/audit-log.js'
import { VendorRackProfilesRepository } from './vendor-rack-profiles.repository.js'

export class VendorRackProfilesService {
  constructor(repository = new VendorRackProfilesRepository()) {
    this.repo = repository
  }

  async list(vendorId, includeInactive) {
    return this.repo.list(vendorId, includeInactive)
  }

  async create(vendorId, actor, input) {
    const name = String(input.name || '').trim()
    if (name.length < 2) return { success: false, message: 'name is required' }
    const capacity = Math.floor(Number(input.capacity))
    if (!Number.isFinite(capacity) || capacity < 1 || capacity > 100000) return { success: false, message: 'capacity must be between 1 and 100000' }
    const code = String(input.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '')
    const profile = await this.repo.create(vendorId, { name, code, capacity, active: input.active, notes: input.notes })
    emitAudit('vendor_rack_profile_created', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_rack_profile', target_id: profile.id,
      before: null, after: profile, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, profile }
  }

  async update(vendorId, actor, id, input) {
    const existing = await this.repo.findById(vendorId, id)
    if (!existing) return { success: false, message: 'Rack profile not found', code: 'NOT_FOUND' }
    const name = input.name === undefined ? existing.name : String(input.name).trim()
    if (name.length < 2) return { success: false, message: 'name is required' }
    const capacity = input.capacity === undefined ? existing.capacity : Math.floor(Number(input.capacity))
    if (!Number.isFinite(capacity) || capacity < 1 || capacity > 100000) return { success: false, message: 'capacity must be between 1 and 100000' }
    const code = input.code === undefined ? existing.code : String(input.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '')
    const profile = await this.repo.update(id, {
      name, code, capacity,
      active: input.active === undefined ? existing.active : Boolean(input.active),
      notes: input.notes === undefined ? existing.notes : input.notes,
    })
    emitAudit('vendor_rack_profile_updated', {
      actor_user_id: actor.userId, actor_role: actor.role, target_type: 'vendor_rack_profile', target_id: id,
      before: existing, after: profile, ip_address: actor.ip, user_agent: actor.userAgent,
    })
    return { success: true, profile }
  }
}
