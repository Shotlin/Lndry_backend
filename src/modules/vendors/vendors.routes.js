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
          approvedDailyCapacity: { type: 'integer', minimum: 1 },
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

  // ─── Admin review of ongoing (post-approval) capacity-change requests ──
  // Static paths ('/admin/capacity-requests') are matched ahead of the
  // parametric '/admin/:id' by Fastify's router regardless of registration
  // order, so no collision with the generic details route above.

  fastify.get('/admin/capacity-requests', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'List capacity change requests [Admin]',
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 }
        }
      }
    }
  }, controller.adminListCapacityRequests.bind(controller))

  fastify.get('/admin/:id/capacity', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Get a vendor (or application)\'s capacity — daily limit, slots, and request history [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      }
    }
  }, controller.adminGetVendorCapacity.bind(controller))

  fastify.post('/admin/capacity-requests/:id/approve', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Approve a pending capacity change request [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        properties: { adminNote: { type: 'string', maxLength: 500 } }
      }
    }
  }, controller.approveCapacityRequest.bind(controller))

  fastify.post('/admin/capacity-requests/:id/reject', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Reject a pending capacity change request [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        properties: { adminNote: { type: 'string', maxLength: 500 } }
      }
    }
  }, controller.rejectCapacityRequest.bind(controller))

  // ─── Admin direct capacity/slot management for an approved vendor ──────
  // Reuses vendors.service.js's vendorId-first slot core (shared with the
  // vendor's own self-service /vendor/pickup-slots endpoints).

  fastify.put('/admin/:id/capacity', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Directly set a vendor\'s daily capacity [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        required: ['max_orders_per_day'],
        properties: { max_orders_per_day: { type: 'integer', minimum: 1 } }
      }
    }
  }, controller.adminSetDailyCapacity.bind(controller))

  fastify.put('/admin/:id/vendor-type', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Set a vendor\'s type — STANDARD / PARTNER / EXCLUSIVE. Controls only how deeply their POS walk-in sales connect to LNDRY (order sync + wallet); never limits marketplace access [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        required: ['vendor_type'],
        properties: { vendor_type: { type: 'string', enum: ['STANDARD', 'PARTNER', 'EXCLUSIVE'] } }
      }
    }
  }, controller.adminSetVendorType.bind(controller))

  fastify.put('/admin/:id/google-business', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Connect/update/remove a vendor\'s optional Google Business Profile link [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        properties: {
          google_business_url: { type: ['string', 'null'] },
          google_rating: { type: ['number', 'null'] },
          google_review_count: { type: ['integer', 'null'] },
          google_business_name: { type: ['string', 'null'] }
        }
      }
    }
  }, controller.adminSetGoogleBusiness.bind(controller))

  fastify.put('/admin/:id/express-pickup', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Turn 60-min express pickup on/off for a vendor [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        required: ['available'],
        properties: { available: { type: 'boolean' } }
      }
    }
  }, controller.adminSetExpressPickup.bind(controller))

  fastify.post('/admin/:id/slots', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Create a pickup/delivery slot for a vendor [Admin]',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        required: ['day_of_week', 'start', 'end'],
        properties: {
          day_of_week: { type: 'integer', minimum: 0, maximum: 6 },
          start: { type: 'string' },
          end: { type: 'string' },
          max_orders: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, controller.adminCreatePickupSlot.bind(controller))

  fastify.patch('/admin/:id/slots/:slotId', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Update a vendor\'s pickup/delivery slot [Admin]',
      params: {
        type: 'object',
        required: ['id', 'slotId'],
        properties: { id: { type: 'string', format: 'uuid' }, slotId: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        properties: {
          max_orders: { type: 'integer', minimum: 1 },
          is_active: { type: 'boolean' },
          start: { type: 'string' },
          end: { type: 'string' }
        }
      }
    }
  }, controller.adminUpdatePickupSlot.bind(controller))

  fastify.delete('/admin/:id/slots/:slotId', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Delete a vendor\'s pickup/delivery slot [Admin]',
      params: {
        type: 'object',
        required: ['id', 'slotId'],
        properties: { id: { type: 'string', format: 'uuid' }, slotId: { type: 'string', format: 'uuid' } }
      }
    }
  }, controller.adminDeletePickupSlot.bind(controller))

  // ─── Admin — manage a vendor's own services & garment rates ────────────
  // Reuses the same vendorId-first core the vendor's own self-service
  // /vendor/services endpoints use (see vendors.service.js).

  fastify.get('/admin/:id/services', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'List a vendor\'s services [Admin]',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          category_id: { type: 'string', format: 'uuid' },
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 }
        }
      }
    }
  }, controller.adminGetVendorServices.bind(controller))

  fastify.post('/admin/:id/services', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Create a service for a vendor [Admin]',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }
    }
  }, controller.adminCreateVendorService.bind(controller))

  fastify.get('/admin/:id/services/:serviceId', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Get a vendor service\'s full details with garment rates [Admin]',
      params: {
        type: 'object', required: ['id', 'serviceId'],
        properties: { id: { type: 'string', format: 'uuid' }, serviceId: { type: 'string', format: 'uuid' } }
      }
    }
  }, controller.adminGetVendorServiceDetails.bind(controller))

  fastify.patch('/admin/:id/services/:serviceId', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Update a vendor\'s service [Admin]',
      params: {
        type: 'object', required: ['id', 'serviceId'],
        properties: { id: { type: 'string', format: 'uuid' }, serviceId: { type: 'string', format: 'uuid' } }
      }
    }
  }, controller.adminUpdateVendorService.bind(controller))

  fastify.delete('/admin/:id/services/:serviceId', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Delete a vendor\'s service [Admin]',
      params: {
        type: 'object', required: ['id', 'serviceId'],
        properties: { id: { type: 'string', format: 'uuid' }, serviceId: { type: 'string', format: 'uuid' } }
      }
    }
  }, controller.adminDeleteVendorService.bind(controller))

  fastify.post('/admin/:id/services/:serviceId/garment-rates', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Add/link a garment rate to a vendor\'s service [Admin]',
      params: {
        type: 'object', required: ['id', 'serviceId'],
        properties: { id: { type: 'string', format: 'uuid' }, serviceId: { type: 'string', format: 'uuid' } }
      }
    }
  }, controller.adminAddGarmentRate.bind(controller))

  fastify.patch('/admin/:id/services/:serviceId/garment-rates/:garmentTypeId', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Update a vendor service\'s garment rate [Admin]',
      params: {
        type: 'object', required: ['id', 'serviceId', 'garmentTypeId'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          serviceId: { type: 'string', format: 'uuid' },
          garmentTypeId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, controller.adminUpdateGarmentRate.bind(controller))

  fastify.delete('/admin/:id/services/:serviceId/garment-rates/:garmentTypeId', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Deactivate a vendor service\'s garment rate [Admin]',
      params: {
        type: 'object', required: ['id', 'serviceId', 'garmentTypeId'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          serviceId: { type: 'string', format: 'uuid' },
          garmentTypeId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, controller.adminDeleteGarmentRate.bind(controller))

  fastify.post('/admin/:id/services/:serviceId/garment-rates/bulk', {
    preHandler: adminPreHandlers,
    schema: {
      tags: ['Admin Vendors'],
      summary: 'Bulk upsert garment rates for a vendor\'s service [Admin]',
      params: {
        type: 'object', required: ['id', 'serviceId'],
        properties: { id: { type: 'string', format: 'uuid' }, serviceId: { type: 'string', format: 'uuid' } }
      }
    }
  }, controller.adminBulkUpsertGarmentRates.bind(controller))

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
