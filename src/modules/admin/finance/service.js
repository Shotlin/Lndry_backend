import { logger } from '../../../config/logger.js'
import { AdminFinanceRepository } from './repository.js'

/**
 * Admin Finance service — HQ-scoped finance operations (task 8.9).
 * Handles HQ finance reads. Payout disbursement is owned by a configured
 * provider workflow; this service intentionally refuses any legacy
 * administrator-only "mark paid" shortcut.
 */
export class AdminFinanceService {
  /**
   * @param {AdminFinanceRepository} repository
   */
  constructor(repository) {
    if (!repository) {
      throw new TypeError('AdminFinanceService requires a repository')
    }
    this.repo = repository
  }

  async listShops(filters) {
    return this.repo.findShops(filters)
  }

  async listShopTransactions(shopId, filters) {
    return this.repo.findShopTransactions({ shopId, ...filters })
  }

  async listShopFinancials(shopId, filters) {
    return this.repo.findShopFinancials({ shopId, ...filters })
  }

  /**
   * Legacy compatibility surface for the former manual PAID transition.
   * It must never bypass the provider receipt/evidence requirement.
   */
  async markPaid(shopId, periodId, actorId) {
    void shopId
    void periodId
    void actorId
    return {
      ok: false,
      code: 'PAYOUT_PROVIDER_EVIDENCE_REQUIRED',
      message:
        'A payout cannot be marked paid manually. Configure a provider workflow that records external payment evidence.',
    }
  }

  async getPayoutReport(filters) {
    const rows = await this.repo.findPayoutReport(filters)
    logger.info(
      { rowCount: rows.length, action: 'admin_payout_report_export' },
      'Admin payout report CSV export'
    )
    return rows
  }

  async getComparison(filters) {
    return this.repo.findComparison(filters)
  }
}
