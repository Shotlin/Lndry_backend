import { logger } from '../../config/logger.js'
import { env } from '../../config/env.js'
import { buildCloudinaryUrl, normalizeCloudinaryDeliveryUrl } from '../../config/cloudinary.js'
import { uploadImageWithCloudinaryFallback } from '../../utils/cloudinary-upload.js'
import { ReferralsRepository } from '../referrals/referrals.repository.js'
import { ReferralsService } from '../referrals/referrals.service.js'

/**
 * Users service — business logic for user management
 */
export class UsersService {
  constructor(repository, options = {}) {
    this.repo = repository
    this.referralsService = options.referralsService || new ReferralsService(new ReferralsRepository())
  }

  /**
   * Get user profile
   */
  async getProfile(userId) {
    const user = await this.repo.findById(userId)
    if (!user) return null
    return this._normalizeUserMedia(user)
  }

  /**
   * Update user profile (name, email, birthday)
   */
  async updateProfile(userId, data) {
    // Blank email = not provided. Storing "" would collide on the unique
    // email column across customers and would wipe an existing email.
    if (typeof data.email === 'string' && !data.email.trim()) {
      const { email: _blank, ...rest } = data
      data = rest
    }

    // Check email uniqueness if email is being updated
    if (data.email) {
      const taken = await this.repo.isEmailTaken(data.email, userId)
      if (taken) {
        return { success: false, message: 'Email is already in use' }
      }
    }

    const updated = await this.repo.updateProfile(userId, data)

    // Referral code redemption — an optional field on this same endpoint
    // (the onboarding "complete your profile" screen is the only client
    // caller that ever populates it) rather than a dedicated endpoint.
    // redeemCode itself is a safe no-op for a blank code, and the service
    // layer's own `referred_by IS NULL` check inside it means this stays
    // safe even if called again later from an ordinary profile edit.
    let referral
    if (data.referralCode) {
      referral = await this.referralsService.redeemCode(userId, data.referralCode)
    }

    return { success: true, user: this._normalizeUserMedia(updated), referral }
  }

  /**
   * Upload avatar to Cloudinary and update user
   */
  async uploadAvatar(userId, fileStream) {
    try {
      const result = await uploadImageWithCloudinaryFallback(fileStream, {
        folder: `${env.CLOUDINARY_FOLDER}/avatars`,
        public_id: `user_${userId}`,
        overwrite: true,
        transformation: [
          { width: 300, height: 300, crop: 'fill', gravity: 'face' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      })

      const avatarUrl = buildCloudinaryUrl(
        {
          publicId: result.public_id,
          version: result.version,
        },
        'default'
      )

      const user = await this.repo.updateAvatar(userId, avatarUrl)
      return { success: true, avatar_url: this._normalizeUserMedia(user).avatar_url }
    } catch (error) {
      logger.error({ err: error }, 'Avatar upload to Cloudinary failed')
      throw error
    }
  }

  /**
   * Get user stats
   */
  async getStats(userId) {
    return this.repo.getStats(userId)
  }

  _normalizeUserMedia(user) {
    if (!user) return user

    return {
      ...user,
      avatar_url: normalizeCloudinaryDeliveryUrl(user.avatar_url, 'default'),
    }
  }
}
