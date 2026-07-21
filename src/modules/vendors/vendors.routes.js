import { VendorsController } from './vendors.controller.js'
import { VendorsService } from './vendors.service.js'
import { VendorsRepository } from './vendors.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'

export default async function vendorRoutes(fastify) {
  const repository = new VendorsRepository()
  const notificationsService = new NotificationsService(new NotificationsRepository(), fastify)
  const service = new VendorsService(repository, { notificationsService })
  const controller = new VendorsController(service)

  // Public/Onboarding routes (COMMENTED OUT - USE canonical /vendor-applications instead)
  // fastify.post('/apply', {
  //   preHandler: [fastify.authenticate],
  //   schema: {
  //     tags: ['Vendors'],
  //     summary: 'Apply for a new vendor onboarding application',
  //     body: {
  //       type: 'object',
  //       required: ['name', 'address_line1', 'city', 'state', 'pincode', 'lat', 'lng'],
  //       properties: {
  //         name: { type: 'string', minLength: 2, maxLength: 200 },
  //         description: { type: 'string' },
  //         logo_url: { type: 'string' },
  //         banner_url: { type: 'string' },
  //         phone: { type: 'string' },
  //         email: { type: 'string', format: 'email' },
  //         address_line1: { type: 'string' },
  //         address_line2: { type: 'string' },
  //         city: { type: 'string' },
  //         state: { type: 'string' },
  //         pincode: { type: 'string' },
  //         lat: { type: 'number' },
  //         lng: { type: 'number' },
  //         delivery_radius_km: { type: 'number', minimum: 0.5 },
  //         gst_number: { type: 'string' },
  //         pan_number: { type: 'string' },
  //         operating_hours: { type: 'object' }
  //       }
  //     }
  //   }
  // }, controller.apply.bind(controller))

  // fastify.get('/me', {
  //   preHandler: [fastify.authenticate],
  //   schema: {
  //     tags: ['Vendors'],
  //     summary: 'Get current vendor profile'
  //   }
  // }, controller.getProfile.bind(controller))

  // fastify.put('/me', {
  //   preHandler: [fastify.authenticate],
  //   schema: {
  //     tags: ['Vendors'],
  //     summary: 'Update current vendor profile'
  //   }
  // }, controller.updateProfile.bind(controller))

  // fastify.post('/me/documents', {
  //   preHandler: [fastify.authenticate],
  //   schema: {
  //     tags: ['Vendors'],
  //     summary: 'Upload onboarding KYC document',
  //     body: {
  //       type: 'object',
  //       required: ['documentType', 'fileUrl'],
  //       properties: {
  //         documentType: { type: 'string', enum: ['owner_identity', 'shop_photo', 'registration_document', 'gst_certificate'] },
  //         fileUrl: { type: 'string' }
  //       }
  //     }
  //   }
  // }, controller.uploadDocument.bind(controller))

  // Admin approval/review routes
  const adminPreHandlers = [fastify.authenticate, fastify.authorize(['ADMIN'])]

  fastify.get('/admin/list', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'List vendor applications [Admin]',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
          city: { type: 'string' },
          status: { type: 'string' },
          search: { type: 'string' }
        }
      }
    }
  }, controller.adminList.bind(controller))

  fastify.get('/admin/:id', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Get vendor application details [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, controller.adminGetDetails.bind(controller))

  fastify.patch('/admin/:id', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Edit application owner/business details [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        // phone is deliberately not editable here — see vendors.service.js adminUpdateDetails.
        type: 'object',
        properties: {
          owner_name: { type: 'string' },
          name: { type: 'string', minLength: 2, maxLength: 200 },
          description: { type: 'string' },
          email: { type: 'string', format: 'email' },
          gst_number: { type: 'string' },
          pan_number: { type: 'string' },
          bank_account_number: { type: 'string' },
          bank_ifsc: { type: 'string' },
          bank_name: { type: 'string' },
          bank_holder_name: { type: 'string' }
        }
      }
    }
  }, controller.adminUpdateDetails.bind(controller))

  fastify.post('/admin/:id/review', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Review vendor application [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['APPROVED', 'REJECTED', 'CORRECTION_REQUIRED', 'SUSPENDED'] },
          approvedRadius: { type: 'number' },
          rejectionReason: { type: 'string' },
          correctionSections: {
            type: 'array',
            items: { type: 'string', enum: ['business', 'owner_bank', 'location', 'radius', 'documents'] }
          },
          documentReviews: {
            type: 'array',
            items: {
              type: 'object',
              required: ['documentId', 'status'],
              properties: {
                documentId: { type: 'string', format: 'uuid' },
                status: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
                rejectionReason: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }, controller.adminReview.bind(controller))

  // ─── Admin review of vendor-created catalogue services ─────────────────
  // A vendor picking subcategories + setting prices under a category
  // creates a `vendor_services` row that needs sign-off before it's
  // customer-visible (see discovery.routes.js's approval_status gate).

  fastify.get('/admin/services', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'List vendor-created services awaiting/under review [Admin]',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 }
        }
      }
    }
  }, controller.listServicesForReview.bind(controller))

  fastify.post('/admin/services/:id/approve', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Approve a vendor-created service [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      }
    }
  }, controller.approveService.bind(controller))

  fastify.post('/admin/services/:id/reject', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Reject a vendor-created service [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } }
      }
    }
  }, controller.rejectService.bind(controller))

  fastify.patch('/admin/services/rates/:rateId', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Recalculate (override) a vendor\'s subcategory rate [Admin]',
      params: {
        type: 'object',
        required: ['rateId'],
        properties: { rateId: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        required: ['rate_paise'],
        properties: {
          rate_paise: { type: 'integer', minimum: 0 },
          reason: { type: 'string', maxLength: 500 }
        }
      }
    }
  }, controller.recalculateServiceRate.bind(controller))

  fastify.get('/admin/documents/:documentId/preview', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Get secure watermarked preview of KYC document [Admin]',
      params: {
        type: 'object',
        required: ['documentId'],
        properties: {
          documentId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, controller.previewKycDocument.bind(controller))

  // GET /admin/watermark/settings
  fastify.get('/admin/watermark/settings', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Get watermark settings'
    }
  }, async (request, reply) => {
    const { query: dbQuery } = await import('../../config/database.js')
    const { rows } = await dbQuery('SELECT enabled, text, logo_url, position, scale, opacity FROM watermark_settings LIMIT 1')
    return { status: 'success', data: rows[0] || { enabled: true, text: 'For LNDRY Verification Only', position: 'center', scale: 1.0, opacity: 0.4 } }
  })

  // PUT /admin/watermark/settings
  fastify.put('/admin/watermark/settings', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Update watermark settings',
      body: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          text: { type: 'string' },
          position: { type: 'string' },
          scale: { type: 'number' },
          opacity: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { query: dbQuery } = await import('../../config/database.js')
    const { enabled, text, position, scale, opacity } = request.body
    await dbQuery(
      `UPDATE watermark_settings 
       SET enabled = $1, text = $2, position = $3, scale = $4, opacity = $5`,
      [enabled, text, position, scale, opacity]
    )
    return { status: 'success', message: 'Watermark settings updated' }
  })

  // GET /admin/watermark/jobs
  fastify.get('/admin/watermark/jobs', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'List watermark jobs'
    }
  }, async (request, reply) => {
    const { query: dbQuery } = await import('../../config/database.js')
    const { rows } = await dbQuery('SELECT id, asset_id, status, error_message, created_at, updated_at FROM watermark_jobs ORDER BY created_at DESC')
    return { status: 'success', data: rows }
  })

  // POST /admin/watermark/jobs
  fastify.post('/admin/watermark/jobs', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Create a new watermark batch job',
      body: {
        type: 'object',
        required: ['asset_id'],
        properties: {
          asset_id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { query: dbQuery } = await import('../../config/database.js')
    const { asset_id } = request.body
    const { rows } = await dbQuery(
      `INSERT INTO watermark_jobs (asset_id, status)
       VALUES ($1, 'PENDING')
       RETURNING *`,
      [asset_id]
    )

    // Simulate background worker processing
    setTimeout(async () => {
      try {
        await dbQuery(`UPDATE watermark_jobs SET status = 'PROCESSING' WHERE id = $1`, [rows[0].id])
        await new Promise(r => setTimeout(r, 4000))
        await dbQuery(`UPDATE watermark_jobs SET status = 'COMPLETED' WHERE id = $1`, [rows[0].id])
      } catch (err) {
        await dbQuery(`UPDATE watermark_jobs SET status = 'FAILED', error_message = $2 WHERE id = $1`, [rows[0].id, err.message])
      }
    }, 1000)

    return reply.code(201).send({ status: 'success', data: rows[0], message: 'Watermark job scheduled successfully' })
  })
}
