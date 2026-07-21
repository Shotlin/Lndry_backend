import { logger } from '../../../config/logger.js'
import { getClient } from '../../../config/database.js'
import { emitInTx } from '../../../utils/audit-log.js'
import { AdminFinanceRepository } from './repository.js'

/**
 * Admin Finance service — HQ-scoped finance operations (task 8.9).
 * Handles mark-paid transitions and delegates reads to repository.
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
   * Mark a shop_financials period as PAID (task 8.9).
   * Requires shop_financials.mark_paid permission.
   * Emits payout_marked_paid audit (task 8.11).
   */
  async markPaid(shopId, periodId, actorId) {
    const row = await this.repo.findFinancialByIdAndShop(periodId, shopId)
    if (!row) {
      return { ok: false, code: 'NOT_FOUND', message: 'Financial period not found' }
    }

    if (row.payout_status === 'PAID') {
      return { ok: false, code: 'ALREADY_PAID', message: 'Period already marked as paid' }
    }

    if (row.payout_status !== 'PENDING' && row.payout_status !== 'PROCESSING') {
      return {
        ok: false,
        code: 'INVALID_STATE',
        message: `Cannot mark as paid from status: ${row.payout_status}`,
      }
    }

    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows } = await client.query(
        `UPDATE shop_financials
            SET payout_status = 'PAID',
                paid_at = NOW(),
                updated_at = NOW()
          WHERE id = $1
            AND vendor_id = $2
            AND payout_status IN ('PENDING', 'PROCESSING')
          RETURNING id, vendor_id, payout_status, payout_amount, period_start, period_end`,
        [periodId, shopId]
      )

      if (rows.length === 0) {
        await client.query('ROLLBACK')
        return { ok: false, code: 'INVALID_STATE', message: 'State transition failed' }
      }

      // Task 8.11: emit payout_marked_paid audit
      await emitInTx(client, 'payout_marked_paid', {
        actor_user_id: actorId,
        actor_role: 'ADMIN',
        actor_shop_id: null,
        target_type: 'shop_financial',
        target_id: periodId,
        before: { payout_status: row.payout_status },
        after: { payout_status: 'PAID', vendor_id: shopId },
      })

      await client.query('COMMIT')

      logger.info(
        { shopId, periodId, actorId, action: 'payout_marked_paid' },
        'Payout marked as paid by admin'
      )

      return { ok: true, row: rows[0] }
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      throw err
    } finally {
      client.release()
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
