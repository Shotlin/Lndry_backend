import { getClient } from '../../config/database.js'

/**
 * The starter list every vendor's screen has always opened with. Created once
 * per vendor (on their first visit) so the screen looks the same as before —
 * the difference is that these are now real, saved rows.
 */
const STARTER_ITEMS = [
  { name: 'Liquid Detergent', quantity: 24, minThreshold: 5, unit: 'Liters' },
  { name: 'Fabric Softener', quantity: 15, minThreshold: 4, unit: 'Liters' },
  { name: 'Premium Bleach', quantity: 3, minThreshold: 5, unit: 'Liters' },
  { name: 'Metal Steam Hangers', quantity: 120, minThreshold: 30, unit: 'Pieces' },
  { name: 'Plastic Packing Bags', quantity: 450, minThreshold: 100, unit: 'Pieces' },
  { name: 'Starch Spray', quantity: 2, minThreshold: 3, unit: 'Cans' },
]

const NAME_TAKEN = 'You already have a supply with this name.'
const NOT_FOUND = 'This supply item was not found.'

export class VendorInventoryService {
  constructor(repo) {
    this.repo = repo
  }

  /** The vendor's supplies, creating their starter list the first time. */
  async list(vendorId) {
    await this._seedIfFirstVisit(vendorId)
    return this.repo.list(vendorId)
  }

  async create(vendorId, input) {
    try {
      const item = await this.repo.create(vendorId, {
        name: input.name.trim(),
        quantity: input.quantity,
        minThreshold: input.minThreshold,
        unit: input.unit.trim(),
      })
      return { success: true, item }
    } catch (err) {
      if (err?.code === '23505') return { success: false, code: 'ITEM_EXISTS', message: NAME_TAKEN }
      throw err
    }
  }

  async update(vendorId, id, patch) {
    const clean = { ...patch }
    if (typeof clean.name === 'string') clean.name = clean.name.trim()
    if (typeof clean.unit === 'string') clean.unit = clean.unit.trim()
    try {
      const item = await this.repo.update(vendorId, id, clean)
      if (!item) return { success: false, code: 'NOT_FOUND', message: NOT_FOUND }
      return { success: true, item }
    } catch (err) {
      if (err?.code === '23505') return { success: false, code: 'ITEM_EXISTS', message: NAME_TAKEN }
      throw err
    }
  }

  async adjust(vendorId, id, delta) {
    const item = await this.repo.adjust(vendorId, id, delta)
    if (!item) return { success: false, code: 'NOT_FOUND', message: NOT_FOUND }
    return { success: true, item }
  }

  async remove(vendorId, id) {
    const removed = await this.repo.remove(vendorId, id)
    if (!removed) return { success: false, code: 'NOT_FOUND', message: NOT_FOUND }
    return { success: true }
  }

  /**
   * Creates the starter list exactly once per vendor. The marker row and the
   * items are written in one transaction, and the marker's primary key means
   * two simultaneous first visits can't both seed.
   */
  async _seedIfFirstVisit(vendorId) {
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const marker = await client.query(
        'INSERT INTO vendor_inventory_state (vendor_id) VALUES ($1) ON CONFLICT (vendor_id) DO NOTHING RETURNING vendor_id',
        [vendorId]
      )
      if (marker.rowCount === 1) {
        for (const [index, item] of STARTER_ITEMS.entries()) {
          // NOW() is frozen for the whole transaction, which would give every starter
          // item the same time and lose the order they are meant to appear in — so each
          // one is offset by its position.
          await client.query(
            `INSERT INTO vendor_inventory_items (vendor_id, name, quantity, min_threshold, unit, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + ($6::int * INTERVAL '1 millisecond'))
             ON CONFLICT DO NOTHING`,
            [vendorId, item.name, item.quantity, item.minThreshold, item.unit, index]
          )
        }
      }
      await client.query('COMMIT')
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // the original error is the useful one
      }
      throw err
    } finally {
      client.release()
    }
  }
}
