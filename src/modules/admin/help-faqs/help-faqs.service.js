import { emit as emitAudit } from '../../../utils/audit-log.js'
import { HelpFaqsRepository } from './help-faqs.repository.js'

export class HelpFaqsService {
  constructor(repository = new HelpFaqsRepository()) {
    this.repo = repository
  }

  listAll() {
    return this.repo.findAll()
  }

  /** What the customer app's Help & FAQs screen fetches. */
  listActive() {
    return this.repo.findAllActive()
  }

  _audit(action, actor, id, before, after) {
    emitAudit(action, {
      actor_user_id: actor.userId,
      actor_role: actor.platformRole || actor.role,
      target_type: 'help_faq',
      target_id: id,
      before,
      after,
      ip_address: actor.ip,
      user_agent: actor.userAgent,
    })
  }

  async create(data, actor) {
    const question = data.question?.trim()
    const answer = data.answer?.trim()
    if (!question) return { success: false, message: 'question is required' }
    if (!answer) return { success: false, message: 'answer is required' }
    const faq = await this.repo.create({ ...data, question, answer, createdBy: actor.userId })
    this._audit('help_faq_created', actor, faq.id, null, faq)
    return { success: true, faq }
  }

  async update(id, data, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'FAQ not found' }
    const patch = { ...data }
    if (patch.question !== undefined) {
      patch.question = patch.question.trim()
      if (!patch.question) return { success: false, message: 'question cannot be empty' }
    }
    if (patch.answer !== undefined) {
      patch.answer = patch.answer.trim()
      if (!patch.answer) return { success: false, message: 'answer cannot be empty' }
    }
    const faq = await this.repo.update(id, patch)
    this._audit('help_faq_updated', actor, id, existing, faq)
    return { success: true, faq }
  }

  async delete(id, actor) {
    const existing = await this.repo.findById(id)
    if (!existing) return { success: false, message: 'FAQ not found' }
    await this.repo.delete(id)
    this._audit('help_faq_deleted', actor, id, existing, null)
    return { success: true }
  }
}
