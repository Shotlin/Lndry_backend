import Razorpay from 'razorpay'
import { env } from './env.js'
import { logger } from './logger.js'

let razorpay = null

if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: env.RAZORPAY_KEY_ID,
    key_secret: env.RAZORPAY_KEY_SECRET,
  })
  logger.info('✅ Razorpay configured')
} else {
  logger.warn('⚠️  Razorpay not configured — payment features will fail')
}

export { razorpay }
