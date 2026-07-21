import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { env } from '../config/env.js'

async function swaggerPlugin(fastify) {
  if (!env.ENABLE_SWAGGER) {
    fastify.log.info('Swagger UI disabled for this environment')
    return
  }

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'LNDRY Laundry Service API',
        description: 'LNDRY laundry service booking and fulfilment platform — Fastify API',
        version: '1.0.0',
      },
      servers: [
        { url: 'http://localhost:3000', description: 'Development' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      tags: [
        { name: 'Health', description: 'Health check' },
        { name: 'Auth', description: 'Authentication — OTP, JWT, OAuth' },
        { name: 'Users', description: 'User profile management' },
        { name: 'Customer Profile', description: 'Customer self-profile management' },
        { name: 'Service Categories', description: 'Laundry service categories' },
        { name: 'Garment Types', description: 'Garment type catalog and rates' },
        { name: 'Discovery', description: 'Home and vendor listings' },
        { name: 'Quotes', description: 'Laundry quotation generator' },
        { name: 'Addresses', description: 'Delivery addresses' },
        { name: 'Orders', description: 'Order management' },
        { name: 'Vendor Orders', description: 'Vendor-side order management' },
        { name: 'Payments', description: 'Payment processing (Razorpay)' },
        { name: 'Pickup Slots', description: 'Vendor slot capacity and holds' },
        { name: 'Vendors', description: 'Multi-vendor laundry marketplace' },
        { name: 'Vendor Employees', description: 'Vendor employee / staff management' },
        { name: 'Delivery', description: 'Rider delivery management' },
        { name: 'Rider Internal', description: 'Internal rider-only endpoints (not customer-facing)' },
        { name: 'Notifications', description: 'Push notifications' },
        { name: 'Reviews', description: 'Vendor reviews' },
        { name: 'Uploads', description: 'File uploads' },
        { name: 'Secure Documents', description: 'KYC document streaming' },
        { name: 'Admin', description: 'Admin dashboard & management' },
        { name: 'Banners', description: 'Promotional banners' },
      ],
    },
  })

  await fastify.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  })
}

export default fp(swaggerPlugin, { name: 'swagger' })
