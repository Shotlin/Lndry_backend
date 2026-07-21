import { VendorsRepository } from './vendors.repository.js'

const VALID_CATEGORIES = ['Order Issue', 'Payout', 'Technical', 'Account', 'Other']

/**
 * Business logic for vendor support tickets.
 */
export class SupportTicketsService {
  /**
   * @param {import('./support-tickets.repository.js').SupportTicketsRepository} repo
   * @param {VendorsRepository} vendorsRepo
   */
  constructor(repo, vendorsRepo) {
    this.repo = repo
    this.vendorsRepo = vendorsRepo
  }

  /**
   * Create a ticket on behalf of the authenticated vendor user.
   * @param {string} userId  - JWT user id
   * @param {{ title, description, category }} data
   */
  async create(userId, data) {
    const vendor = await this.vendorsRepo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    const category = VALID_CATEGORIES.includes(data.category) ? data.category : 'Other'

    if (!data.title || data.title.trim().length < 3) {
      throw { statusCode: 400, message: 'Title must be at least 3 characters' }
    }
    if (!data.description || data.description.trim().length < 10) {
      throw { statusCode: 400, message: 'Description must be at least 10 characters' }
    }

    return this.repo.create({
      vendorId: vendor.id,
      userId,
      title: data.title.trim(),
      description: data.description.trim(),
      category,
    })
  }

  /**
   * List tickets for the authenticated vendor user.
   * @param {string} userId
   * @param {{ page?: number, limit?: number }} opts
   */
  async list(userId, { page = 1, limit = 20 } = {}) {
    const vendor = await this.vendorsRepo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    const offset = (page - 1) * limit
    const [tickets, total] = await Promise.all([
      this.repo.listByVendor(vendor.id, { limit, offset }),
      this.repo.countByVendor(vendor.id),
    ])

    return { tickets, total, page, limit }
  }

  /** Single ticket detail for the authenticated vendor. */
  async getOne(userId, ticketId) {
    const vendor = await this.vendorsRepo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    const ticket = await this.repo.findById(ticketId, vendor.id)
    if (!ticket) throw { statusCode: 404, message: 'Ticket not found' }
    return ticket
  }

  /** Vendor says "I'm satisfied" — rates (1-5) and closes in one step. */
  async rate(userId, ticketId, rating) {
    const vendor = await this.vendorsRepo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    const numericRating = Number(rating)
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      throw { statusCode: 400, message: 'Rating must be an integer from 1 to 5' }
    }

    const existing = await this.repo.findById(ticketId, vendor.id)
    if (!existing) throw { statusCode: 404, message: 'Ticket not found' }
    if (existing.status !== 'REPLIED') {
      throw { statusCode: 400, message: 'Only a replied ticket can be rated' }
    }

    return this.repo.rate(ticketId, vendor.id, numericRating)
  }

  /** Vendor says "not satisfied" — sends a follow-up message, reopens the ticket. */
  async followUp(userId, ticketId, message) {
    const vendor = await this.vendorsRepo.findByUserId(userId)
    if (!vendor) throw { statusCode: 404, message: 'Vendor profile not found' }

    if (!message || message.trim().length < 3) {
      throw { statusCode: 400, message: 'Message must be at least 3 characters' }
    }

    const existing = await this.repo.findById(ticketId, vendor.id)
    if (!existing) throw { statusCode: 404, message: 'Ticket not found' }
    if (existing.status !== 'REPLIED') {
      throw { statusCode: 400, message: 'You can only follow up on a replied ticket' }
    }

    return this.repo.vendorFollowUp(ticketId, vendor.id, message.trim())
  }

  // ─── Admin ───────────────────────────────────────────────────────────

  async adminList({ status, page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit
    const { tickets, total } = await this.repo.listAll({ status, limit, offset })
    return { tickets, total, page, limit }
  }

  async adminGetOne(ticketId) {
    const ticket = await this.repo.findById(ticketId)
    if (!ticket) throw { statusCode: 404, message: 'Ticket not found' }
    return ticket
  }

  async adminReply(ticketId, adminUserId, replyText) {
    if (!replyText || replyText.trim().length < 3) {
      throw { statusCode: 400, message: 'Reply must be at least 3 characters' }
    }
    const ticket = await this.repo.reply(ticketId, { adminReply: replyText.trim(), repliedBy: adminUserId })
    if (!ticket) throw { statusCode: 404, message: 'Ticket not found' }
    return ticket
  }

  async adminClose(ticketId) {
    const ticket = await this.repo.close(ticketId)
    if (!ticket) throw { statusCode: 404, message: 'Ticket not found' }
    return ticket
  }
}
