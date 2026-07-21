import { PaymentOffersRepository } from './payment-offers.repository.js'
import { mergeDemoPaymentOffers } from './demo-payment-offers.js'

/**
 * Payment offers service — public formatting + admin CRUD orchestration
 */
export class PaymentOffersService {
  constructor(repository = new PaymentOffersRepository()) {
    this.repo = repository
  }

  async getPublicOffers(cartTotal) {
    const normalizedCartTotal = Math.max(0, this._toNumber(cartTotal))
    const offers = mergeDemoPaymentOffers(await this.repo.getActive())

    return offers
      .map((offer) => {
        const minOrderAmount = this._toNumber(offer.min_order_amount)
        const lockThreshold = this._toNumber(
          offer.lock_threshold ?? offer.min_order_amount
        )
        const requiredThreshold = lockThreshold || minOrderAmount
        const isLocked = normalizedCartTotal < requiredThreshold
        const amountNeeded = isLocked
          ? Math.ceil(Math.max(0, requiredThreshold - normalizedCartTotal))
          : 0

        return {
          id: offer.id,
          title: offer.title,
          description: offer.description,
          provider: offer.provider,
          iconUrl: offer.icon_url,
          cashbackAmount: this._toNumber(offer.cashback_amount),
          minOrderAmount,
          isLocked,
          lockMessage: isLocked
            ? `Shop for ₹${amountNeeded} more to apply`
            : null,
          unlockProgress: Math.min(
            normalizedCartTotal / (requiredThreshold || 1),
            1
          ),
        }
      })
      .sort((left, right) => {
        if (left.isLocked != right.isLocked) {
          return Number(left.isLocked) - Number(right.isLocked)
        }
        return right.cashbackAmount - left.cashbackAmount
      })
  }

  async getAllAdmin() {
    return this.repo.getAll()
  }

  async create(data) {
    return this.repo.create(this._mapWriteData(data))
  }

  async update(id, data) {
    const existing = await this.repo.getById(id)
    if (!existing) {
      const error = new Error('Payment offer not found')
      error.statusCode = 404
      error.code = 'NOT_FOUND'
      throw error
    }

    const nextData = {
      title: this._hasOwn(data, 'title') ? data.title : existing.title,
      description: this._hasOwn(data, 'description') ? data.description : existing.description,
      provider: this._hasOwn(data, 'provider') ? data.provider : existing.provider,
      iconUrl: this._hasOwn(data, 'iconUrl') ? data.iconUrl : existing.icon_url,
      cashbackAmount: this._hasOwn(data, 'cashbackAmount') ? data.cashbackAmount : existing.cashback_amount,
      cashbackPercent: this._hasOwn(data, 'cashbackPercent') ? data.cashbackPercent : existing.cashback_percent,
      minOrderAmount: this._hasOwn(data, 'minOrderAmount') ? data.minOrderAmount : existing.min_order_amount,
      maxCashback: this._hasOwn(data, 'maxCashback') ? data.maxCashback : existing.max_cashback,
      lockThreshold: this._hasOwn(data, 'lockThreshold') ? data.lockThreshold : existing.lock_threshold,
      isActive: this._hasOwn(data, 'isActive') ? data.isActive : existing.is_active,
      validFrom: this._hasOwn(data, 'validFrom') ? data.validFrom : existing.valid_from,
      validUntil: this._hasOwn(data, 'validUntil') ? data.validUntil : existing.valid_until,
    }

    return this.repo.update(id, this._mapWriteData(nextData))
  }

  async delete(id) {
    const deleted = await this.repo.delete(id)
    if (!deleted) {
      const error = new Error('Payment offer not found')
      error.statusCode = 404
      error.code = 'NOT_FOUND'
      throw error
    }
  }

  _mapWriteData(data) {
    return {
      title: data.title,
      description: data.description ?? null,
      provider: data.provider,
      icon_url: data.iconUrl ?? null,
      cashback_amount: data.cashbackAmount ?? 0,
      cashback_percent: data.cashbackPercent ?? null,
      min_order_amount: data.minOrderAmount ?? 0,
      max_cashback: data.maxCashback ?? null,
      lock_threshold: data.lockThreshold ?? null,
      is_active: data.isActive ?? true,
      valid_from: data.validFrom ?? null,
      valid_until: data.validUntil ?? null,
    }
  }

  _hasOwn(data, key) {
    return Object.prototype.hasOwnProperty.call(data, key)
  }

  _toNumber(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
}
