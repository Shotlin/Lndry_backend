import { VendorsController } from './vendors.controller.js'
import { VendorsService } from './vendors.service.js'
import { VendorsRepository } from './vendors.repository.js'

/**
 * Vendor onboarding applications & profiles routes
 * Prefix: /api/v1/vendor
 */
export default async function vendorApplicationsRoutes(fastify) {
  const repository = new VendorsRepository()
  const service = new VendorsService(repository)
  const controller = new VendorsController(service)

  const commonPreHandlers = [fastify.authenticate]

  // ─── Applications (Onboarding Wizard) ────────────────────
  
  // POST /applications or / — Create draft application
  const createApplicationOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Create draft onboarding application',
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 200 }
        }
      }
    }
  }
  fastify.post('/applications', createApplicationOpts, controller.createApplication.bind(controller))
  fastify.post('/', createApplicationOpts, controller.createApplication.bind(controller))

  // GET /applications/me or /me — Get current application details
  const getApplicationMeOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Get current onboarding application and missing steps'
    }
  }
  fastify.get('/applications/me', getApplicationMeOpts, controller.getApplicationMe.bind(controller))
  fastify.get('/me', getApplicationMeOpts, controller.getApplicationMe.bind(controller))

  // PATCH /applications/:id/owner or /:id/owner — Update owner profile & contacts
  const updateApplicationOwnerOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Update application owner details',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        // phone is intentionally not accepted here — it's copied from the
        // authenticated user's account at application creation and is not
        // vendor-editable (it's the same number used to log in).
        type: 'object',
        properties: {
          owner_name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          bank_account_number: { type: 'string' },
          bank_ifsc: { type: 'string' },
          bank_name: { type: 'string' },
          bank_holder_name: { type: 'string' }
        }
      }
    }
  }
  fastify.patch('/applications/:id/owner', updateApplicationOwnerOpts, controller.updateApplicationOwner.bind(controller))
  fastify.patch('/:id/owner', updateApplicationOwnerOpts, controller.updateApplicationOwner.bind(controller))

  // PATCH /applications/:id/business or /:id/business — Update business details (laundry info, description, hours)
  const updateApplicationBusinessOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Update application business details',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 200 },
          description: { type: 'string' },
          operating_hours: { type: 'object' },
          gst_number: { type: 'string' },
          pan_number: { type: 'string' }
        }
      }
    }
  }
  fastify.patch('/applications/:id/business', updateApplicationBusinessOpts, controller.updateApplicationBusiness.bind(controller))
  fastify.patch('/:id/business', updateApplicationBusinessOpts, controller.updateApplicationBusiness.bind(controller))

  // PATCH /applications/:id/location or /:id/location — Update location details
  const updateApplicationLocationOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Update application location details',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        properties: {
          address_line1: { type: 'string' },
          address_line2: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          pincode: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' }
        }
      }
    }
  }
  fastify.patch('/applications/:id/location', updateApplicationLocationOpts, controller.updateApplicationLocation.bind(controller))
  fastify.patch('/:id/location', updateApplicationLocationOpts, controller.updateApplicationLocation.bind(controller))

  // PATCH /applications/:id/radius or /:id/radius — Update delivery radius
  const updateApplicationRadiusOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Update application delivery radius',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      },
      body: {
        type: 'object',
        required: ['requested_radius_km'],
        properties: {
          requested_radius_km: { type: 'number', minimum: 0.1 }
        }
      }
    }
  }
  fastify.patch('/applications/:id/radius', updateApplicationRadiusOpts, controller.updateApplicationRadius.bind(controller))
  fastify.patch('/:id/radius', updateApplicationRadiusOpts, controller.updateApplicationRadius.bind(controller))

  // POST /applications/:id/documents or /:id/documents — Upload document (multipart)
  const uploadApplicationDocumentOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Upload onboarding document file',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      }
    }
  }
  fastify.post('/applications/:id/documents', uploadApplicationDocumentOpts, controller.uploadApplicationDocument.bind(controller))
  fastify.post('/:id/documents', uploadApplicationDocumentOpts, controller.uploadApplicationDocument.bind(controller))

  // DELETE /applications/:id/documents/:documentId or /:id/documents/:documentId — Delete document
  const deleteApplicationDocumentOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Delete onboarding document file',
      params: {
        type: 'object',
        required: ['id', 'documentId'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          documentId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }
  fastify.delete('/applications/:id/documents/:documentId', deleteApplicationDocumentOpts, controller.deleteApplicationDocument.bind(controller))
  fastify.delete('/:id/documents/:documentId', deleteApplicationDocumentOpts, controller.deleteApplicationDocument.bind(controller))

  // POST /applications/:id/submit or /:id/submit — Submit application for review
  const submitApplicationOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Submit application for review',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      }
    }
  }
  fastify.post('/applications/:id/submit', submitApplicationOpts, controller.submitApplication.bind(controller))
  fastify.post('/:id/submit', submitApplicationOpts, controller.submitApplication.bind(controller))

  // POST /applications/:id/resubmit or /:id/resubmit — Resubmit correction
  const resubmitApplicationOpts = {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Onboarding'],
      summary: 'Resubmit application after corrections',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } }
      }
    }
  }
  fastify.post('/applications/:id/resubmit', resubmitApplicationOpts, controller.resubmitApplication.bind(controller))
  fastify.post('/:id/resubmit', resubmitApplicationOpts, controller.resubmitApplication.bind(controller))

  // ─── Profile Management (Approved Vendors) ───────────────

  // GET /profile — Get approved profile + operational flags
  fastify.get('/profile', {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Profile'],
      summary: 'Get approved vendor profile and status'
    }
  }, controller.getProfileLndry.bind(controller))

  // PATCH /profile — Update approved profile
  fastify.patch('/profile', {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Profile'],
      summary: 'Update approved vendor profile',
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 200 },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string' },
          description: { type: 'string' },
          logo_url: { type: 'string' },
          banner_url: { type: 'string' },
          is_open: { type: 'boolean' },
          // Fastify strips any body field not declared here (ajv
          // removeAdditional) — operating_hours was missing, so every
          // working-hours edit from the vendor app was silently dropped
          // before it ever reached the service/repository layer.
          operating_hours: { type: 'object' }
        }
      }
    }
  }, controller.updateProfileLndry.bind(controller))

  // PATCH /profile/location — Update location (triggers review)
  fastify.patch('/profile/location', {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Profile'],
      summary: 'Update approved vendor location (requires admin re-review)',
      body: {
        type: 'object',
        required: ['address_line1', 'city', 'state', 'pincode', 'lat', 'lng'],
        properties: {
          address_line1: { type: 'string' },
          address_line2: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          pincode: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' }
        }
      }
    }
  }, controller.updateProfileLocation.bind(controller))

  // GET /profile/public-preview — Public preview details
  fastify.get('/profile/public-preview', {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Profile'],
      summary: 'Get public preview details of the vendor'
    }
  }, controller.getProfileLndry.bind(controller))

  // POST /profile/publish — Publish vendor profile
  fastify.post('/profile/publish', {
    preHandler: commonPreHandlers,
    schema: {
      tags: ['Vendor Profile'],
      summary: 'Publish vendor profile to marketplace'
    }
  }, controller.publishProfile.bind(controller))

  // ─── Catalogue Management (Section 9) ────────────────────
  
  // GET /categories — List laundry categories
  fastify.get('/categories', {
    preHandler: commonPreHandlers,
  }, controller.getVendorCategories.bind(controller))

  // GET /services — List services
  fastify.get('/services', {
    preHandler: commonPreHandlers,
  }, controller.getVendorServices.bind(controller))

  // POST /services — Create draft service
  fastify.post('/services', {
    preHandler: commonPreHandlers,
  }, controller.createVendorServiceDraft.bind(controller))

  // GET /services/catalogue — Flat garment-type list across all this
  // vendor's active services, for the reconciliation move/add-service picker
  fastify.get('/services/catalogue', {
    preHandler: commonPreHandlers,
  }, controller.getReconciliationCatalogue.bind(controller))

  // GET /services/:serviceId — Full service details (with garment rates)
  fastify.get('/services/:serviceId', {
    preHandler: commonPreHandlers,
  }, controller.getVendorServiceDetails.bind(controller))

  // PATCH /services/:serviceId — Update service availability
  fastify.patch('/services/:serviceId', {
    preHandler: commonPreHandlers,
  }, controller.updateVendorService.bind(controller))

  // DELETE /services/:serviceId — Soft delete service
  fastify.delete('/services/:serviceId', {
    preHandler: commonPreHandlers,
  }, controller.deleteVendorService.bind(controller))

  // POST /services/:serviceId/garment-rates — Create and link a garment rate
  fastify.post('/services/:serviceId/garment-rates', {
    preHandler: commonPreHandlers,
  }, controller.addGarmentRate.bind(controller))

  // PATCH /services/:serviceId/garment-rates/:id — Update garment rate price/availability
  fastify.patch('/services/:serviceId/garment-rates/:id', {
    preHandler: commonPreHandlers,
  }, controller.updateGarmentRate.bind(controller))

  // DELETE /services/:serviceId/garment-rates/:id — Deactivate/soft-delete garment rate
  fastify.delete('/services/:serviceId/garment-rates/:id', {
    preHandler: commonPreHandlers,
  }, controller.deleteGarmentRate.bind(controller))

  // POST /services/:serviceId/garment-rates/bulk — Bulk upsert garment rates
  fastify.post('/services/:serviceId/garment-rates/bulk', {
    preHandler: commonPreHandlers,
  }, controller.bulkUpsertGarmentRates.bind(controller))

  // POST /services/:serviceId/publish — Publish service
  fastify.post('/services/:serviceId/publish', {
    preHandler: commonPreHandlers,
  }, controller.publishService.bind(controller))

  // POST /services/:serviceId/unpublish — Unpublish service
  fastify.post('/services/:serviceId/unpublish', {
    preHandler: commonPreHandlers,
  }, controller.unpublishService.bind(controller))

  // ─── Capacity & Slots (Section 9) ────────────────────────
  
  // GET /capacity — Get daily limit & slots availability
  fastify.get('/capacity', {
    preHandler: commonPreHandlers,
  }, controller.getCapacity.bind(controller))

  // PUT /capacity/daily-limit — Update daily limit
  fastify.put('/capacity/daily-limit', {
    preHandler: commonPreHandlers,
  }, controller.updateDailyLimit.bind(controller))

  // GET /pickup-slots — Get slots
  fastify.get('/pickup-slots', {
    preHandler: commonPreHandlers,
  }, controller.getPickupSlots.bind(controller))

  // POST /pickup-slots — Create slot
  fastify.post('/pickup-slots', {
    preHandler: commonPreHandlers,
  }, controller.createPickupSlot.bind(controller))

  // PATCH /pickup-slots/:slotId — Update slot
  fastify.patch('/pickup-slots/:slotId', {
    preHandler: commonPreHandlers,
  }, controller.updatePickupSlot.bind(controller))

  // DELETE /pickup-slots/:slotId — Delete slot
  fastify.delete('/pickup-slots/:slotId', {
    preHandler: commonPreHandlers,
  }, controller.deletePickupSlot.bind(controller))

  // POST /capacity/exceptions — Create capacity exception
  fastify.post('/capacity/exceptions', {
    preHandler: commonPreHandlers,
  }, controller.createCapacityException.bind(controller))

  // DELETE /capacity/exceptions/:id — Delete capacity exception
  fastify.delete('/capacity/exceptions/:id', {
    preHandler: commonPreHandlers,
  }, controller.deleteCapacityException.bind(controller))
}

