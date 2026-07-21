import pino from 'pino'
import { env } from './env.js'

const options = {
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.body.otp',
      'req.body.pickup_otp',
      'req.body.delivery_otp',
      'otp',
      'pickup_otp',
      'delivery_otp',
      'otp_hash',
      'otp_code'
    ],
    censor: '[REDACTED]'
  }
}

if (env.LOG_PRETTY) {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
    },
  }
}

export const logger = pino(options)
