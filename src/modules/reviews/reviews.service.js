/**
 * Reviews service — business logic for reviews
 */
export class ReviewsService {
  constructor(repository) {
    this.repository = repository
  }

  async getVendorReviews(vendorId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getVendorReviews(vendorId, { offset, limit })
  }

  async checkOrderReviewEligibility(userId, orderId) {
    const order = await this.repository.getOrderById(orderId)
    if (!order) {
      return { eligible: false, reason: 'Order not found' }
    }
    if (order.user_id !== userId) {
      return { eligible: false, reason: 'Unauthorized' }
    }
    if (order.status !== 'DELIVERED') {
      return { eligible: false, reason: 'Order not delivered' }
    }

    const existingReview = await this.repository.getVendorReviewByOrder(userId, orderId)
    if (existingReview) {
      return { eligible: false, reason: 'Already reviewed' }
    }

    return { eligible: true }
  }

  async createVendorReview(userId, { orderId, vendorRating, riderRating, comment }) {
    if (vendorRating < 1 || vendorRating > 5) {
      throw new Error('Vendor rating must be between 1 and 5')
    }
    if (riderRating !== undefined && riderRating !== null && (riderRating < 1 || riderRating > 5)) {
      throw new Error('Rider rating must be between 1 and 5')
    }

    // Check if user owned the order and order is in DELIVERED state
    const order = await this.repository.getOrderById(orderId)
    if (!order) {
      throw new Error('Order not found')
    }
    if (order.user_id !== userId) {
      throw new Error('You can only review your own orders')
    }
    if (order.status !== 'DELIVERED') {
      throw new Error('You can only review completed orders')
    }

    // Check if already reviewed
    const existingReview = await this.repository.getVendorReviewByOrder(userId, orderId)
    if (existingReview) {
      throw new Error('You have already reviewed this order')
    }

    return await this.repository.createVendorReview(userId, {
      orderId,
      vendorId: order.vendor_id,
      vendorRating,
      riderRating,
      comment,
    })
  }

  async getProductReviews(productId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getProductReviews(productId, { offset, limit })
  }

  async checkReviewEligibility(userId, productId) {
    return await this.repository.checkReviewEligibility(userId, productId)
  }

  async checkEligibility(userId, id) {
    const order = await this.repository.getOrderById(id)
    if (order) {
      return await this.checkOrderReviewEligibility(userId, id)
    }
    return await this.repository.checkReviewEligibility(userId, id)
  }

  async createReview(userId, { productId, orderId, rating, comment }) {
    // Validate rating
    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5')
    }

    // Check if user has purchased this product in the order
    const hasOrder = await this.repository.checkUserOrder(userId, orderId, productId)
    if (!hasOrder) {
      throw new Error('You can only review garment_rates you have ordered')
    }

    // Check if already reviewed
    const existingReview = await this.repository.getReviewByOrder(userId, orderId, productId)
    if (existingReview) {
      throw new Error('You have already reviewed this product for this order')
    }

    return await this.repository.createReview(userId, { productId, orderId, rating, comment })
  }

  async updateReview(userId, reviewId, { rating, comment, vendor_rating, rider_rating }) {
    if (rating && (rating < 1 || rating > 5)) {
      throw new Error('Rating must be between 1 and 5')
    }
    if (vendor_rating && (vendor_rating < 1 || vendor_rating > 5)) {
      throw new Error('Vendor rating must be between 1 and 5')
    }
    if (rider_rating && (rider_rating < 1 || rider_rating > 5)) {
      throw new Error('Rider rating must be between 1 and 5')
    }

    const review = await this.repository.getReviewById(reviewId)
    if (!review) {
      throw new Error('Review not found')
    }

    if (review.user_id !== userId) {
      throw new Error('You can only update your own reviews')
    }

    // Check if within allowed window (7 days)
    const allowedWindow = 7 * 24 * 60 * 60 * 1000 // 7 days
    const createdTime = new Date(review.created_at).getTime()
    if (Date.now() - createdTime > allowedWindow) {
      throw new Error('Review update period has expired (7 days max)')
    }

    return await this.repository.updateReview(reviewId, {
      rating,
      comment,
      vendor_rating,
      rider_rating,
    })
  }

  async deleteReview(userId, reviewId) {
    const review = await this.repository.getReviewById(reviewId)
    if (!review) {
      throw new Error('Review not found')
    }

    if (review.user_id !== userId) {
      throw new Error('You can only delete your own reviews')
    }

    return await this.repository.deleteReview(reviewId)
  }

  async getUserReviews(userId, { page, limit }) {
    const offset = (page - 1) * limit
    return await this.repository.getUserReviews(userId, { offset, limit })
  }
}

