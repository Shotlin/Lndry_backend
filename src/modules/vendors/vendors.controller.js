import { success, error } from '../../utils/apiResponse.js'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export class VendorsController {
  constructor(service) {
    this.service = service
  }

  async apply(request, reply) {
    try {
      const vendor = await this.service.apply(request.user.id, request.body)
      return reply.code(201).send(success(vendor, 'Application submitted successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Onboarding failed'))
    }
  }

  async getProfile(request, reply) {
    try {
      const profile = await this.service.getProfile(request.user.id)
      if (!profile) {
        return reply.code(404).send(error('Vendor profile not found', 'NOT_FOUND'))
      }
      return reply.send(success(profile, 'Vendor profile fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to load profile'))
    }
  }

  async updateProfile(request, reply) {
    try {
      const profile = await this.service.updateProfile(request.user.id, request.body)
      return reply.send(success(profile, 'Vendor profile updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Update failed'))
    }
  }

  async uploadDocument(request, reply) {
    const { documentType, fileUrl } = request.body
    try {
      const doc = await this.service.uploadDocument(request.user.id, documentType, fileUrl)
      return reply.code(201).send(success(doc, 'Document uploaded successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Upload failed'))
    }
  }

  async adminList(request, reply) {
    try {
      const { vendors, total } = await this.service.adminList(request.query)
      return reply.send(success(vendors, 'Vendors list fetched', { total }))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to list vendors'))
    }
  }

  async adminGetDetails(request, reply) {
    try {
      const details = await this.service.adminGetDetails(request.params.id)
      if (!details) {
        return reply.code(404).send(error('Vendor not found', 'NOT_FOUND'))
      }

      // Mask private file URLs with preview proxy URLs for admins
      if (details.documents && Array.isArray(details.documents)) {
        details.documents = details.documents.map(doc => ({
          ...doc,
          file_url: `/api/v1/vendors/admin/documents/${doc.id}/preview`
        }))
      }

      return reply.send(success(details, 'Vendor details fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to get vendor details'))
    }
  }

  async adminUpdateDetails(request, reply) {
    try {
      const vendor = await this.service.adminUpdateDetails(request.params.id, request.body)
      return reply.send(success(vendor, 'Application details updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update application details'))
    }
  }

  async adminReview(request, reply) {
    try {
      const vendor = await this.service.adminReview(request.params.id, request.body)
      return reply.send(success(vendor, 'Vendor application status updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Review action failed'))
    }
  }

  async previewKycDocument(request, reply) {
    const { documentId } = request.params
    try {
      const { buffer, contentType } = await this.service.previewKycDocument(documentId, request.user)
      return reply
        .code(200)
        .header('Content-Type', contentType)
        .send(buffer)
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to preview KYC document'))
    }
  }

  // ─── LNDRY MVP Application & Profile Endpoints ───────────

  async createApplication(request, reply) {
    try {
      const vendor = await this.service.createApplication(request.user.id, request.body)
      return reply.code(201).send(success(vendor, 'Draft application created successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to create application'))
    }
  }

  async getApplicationMe(request, reply) {
    try {
      const res = await this.service.getApplicationMe(request.user.id)
      return reply.send(success(res, 'Application loaded successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to load application'))
    }
  }

  async updateApplicationOwner(request, reply) {
    const { id } = request.params
    try {
      const vendor = await this.service.updateApplicationOwner(request.user.id, id, request.body)
      return reply.send(success(vendor, 'Application owner info updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update owner info'))
    }
  }

  async updateApplicationBusiness(request, reply) {
    const { id } = request.params
    try {
      const vendor = await this.service.updateApplicationBusiness(request.user.id, id, request.body)
      return reply.send(success(vendor, 'Application business info updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update business info'))
    }
  }

  async updateApplicationLocation(request, reply) {
    const { id } = request.params
    try {
      const vendor = await this.service.updateApplicationLocation(request.user.id, id, request.body)
      return reply.send(success(vendor, 'Application location updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update location'))
    }
  }

  async updateApplicationRadius(request, reply) {
    const { id } = request.params
    try {
      const vendor = await this.service.updateApplicationRadius(request.user.id, id, request.body)
      return reply.send(success(vendor, 'Application radius updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update radius'))
    }
  }

  async uploadApplicationDocument(request, reply) {
    const { id } = request.params
    const data = await request.file()
    if (!data) {
      return reply.code(400).send(error('No file provided'))
    }

    const documentType = data.fields.document_type?.value
    if (!documentType) {
      return reply.code(400).send(error('document_type is required'))
    }

    try {
      const documentId = crypto.randomUUID()
      const extension = path.extname(data.filename)
      const filename = `${documentId}${extension}`
      
      const storageDir = path.join(process.cwd(), 'storage', 'documents')
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true })
      }
      
      const filePath = path.join(storageDir, filename)
      const writeStream = fs.createWriteStream(filePath)
      
      await new Promise((resolve, reject) => {
        data.file.pipe(writeStream)
        data.file.on('end', resolve)
        data.file.on('error', reject)
      })

      const fileUrl = `private://documents/${filename}`
      const doc = await this.service.addApplicationDocument(request.user.id, id, documentType, fileUrl)
      return reply.code(201).send(success({ document_id: doc.id }, 'Document uploaded successfully'))
    } catch (err) {
      request.log.error({ err }, 'Onboarding document upload failed')
      return reply.code(err.statusCode || 500).send(error(err.message || 'Upload failed'))
    }
  }

  async deleteApplicationDocument(request, reply) {
    const { id, documentId } = request.params
    try {
      await this.service.deleteApplicationDocument(request.user.id, id, documentId)
      return reply.send(success(null, 'Document removed successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to delete document'))
    }
  }

  async submitApplication(request, reply) {
    const { id } = request.params
    try {
      const vendor = await this.service.submitApplication(request.user.id, id)
      return reply.send(success(vendor, 'Application submitted for approval'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Submission failed'))
    }
  }

  async resubmitApplication(request, reply) {
    const { id } = request.params
    try {
      const vendor = await this.service.resubmitApplication(request.user.id, id)
      return reply.send(success(vendor, 'Application resubmitted for approval'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Resubmission failed'))
    }
  }

  async getProfileLndry(request, reply) {
    try {
      const profile = await this.service.getPublicPreview(request.user.id)
      return reply.send(success(profile, 'Profile fetched successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to load profile'))
    }
  }

  async updateProfileLndry(request, reply) {
    try {
      const profile = await this.service.updateProfile(request.user.id, request.body)
      return reply.send(success(profile, 'Profile updated successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update profile'))
    }
  }

  async updateProfileLocation(request, reply) {
    try {
      const profile = await this.service.updateProfileLocation(request.user.id, request.body)
      return reply.send(success(profile, 'Profile location updated, review triggered'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update location'))
    }
  }

  async publishProfile(request, reply) {
    try {
      const profile = await this.service.publishProfile(request.user.id)
      return reply.send(success(profile, 'Profile published successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to publish profile'))
    }
  }

  async getVendorCategories(request, reply) {
    try {
      const categories = await this.service.getVendorCategories()
      return reply.send(success(categories, 'Vendor categories fetched successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch categories'))
    }
  }

  async getVendorServices(request, reply) {
    try {
      const { status, category_id, page, limit } = request.query || {}
      const res = await this.service.getVendorServices(request.user.id, { status, categoryId: category_id, page: page ? +page : 1, limit: limit ? +limit : 20 })
      return reply.send(success(res.services, 'Vendor services fetched successfully', { total: res.total, page: res.page, limit: res.limit }))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch services'))
    }
  }

  async createVendorServiceDraft(request, reply) {
    try {
      const payload = request.body || {}
      const { category_id } = payload
      if (!category_id) return reply.code(400).send(error('category_id is required'))
      const res = await this.service.createVendorServiceDraft(request.user.id, payload)
      return reply.code(201).send(success(res, 'Service created successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to create service'))
    }
  }

  async getVendorServiceDetails(request, reply) {
    const { serviceId } = request.params
    try {
      const res = await this.service.getVendorServiceDetails(request.user.id, serviceId)
      return reply.send(success(res, 'Service details fetched successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch service details'))
    }
  }

  async updateVendorService(request, reply) {
    const { serviceId } = request.params
    try {
      const res = await this.service.updateVendorService(request.user.id, serviceId, request.body || {})
      return reply.send(success(res, 'Service updated successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update service'))
    }
  }

  async deleteVendorService(request, reply) {
    const { serviceId } = request.params
    try {
      await this.service.deleteVendorService(request.user.id, serviceId)
      return reply.send(success(null, 'Service deleted successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to delete service'))
    }
  }

  async addGarmentRate(request, reply) {
    const { serviceId } = request.params
    try {
      const res = await this.service.addGarmentRate(request.user.id, serviceId, request.body)
      return reply.code(201).send(success(res, 'Garment rate added successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to add garment rate'))
    }
  }

  async updateGarmentRate(request, reply) {
    const { serviceId, id } = request.params
    try {
      await this.service.updateGarmentRate(request.user.id, serviceId, id, request.body)
      return reply.send(success(null, 'Garment rate updated successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update garment rate'))
    }
  }

  async deleteGarmentRate(request, reply) {
    const { serviceId, id } = request.params
    try {
      await this.service.deleteGarmentRate(request.user.id, serviceId, id)
      return reply.send(success(null, 'Garment rate deleted successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to delete garment rate'))
    }
  }

  async bulkUpsertGarmentRates(request, reply) {
    const { serviceId } = request.params
    const { garment_rates } = request.body || {}
    if (!Array.isArray(garment_rates)) return reply.code(400).send(error('garment_rates array is required'))
    try {
      await this.service.bulkUpsertGarmentRates(request.user.id, serviceId, garment_rates)
      return reply.send(success(null, 'Garment rates bulk upsert completed'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to bulk upsert garment rates'))
    }
  }

  async publishService(request, reply) {
    const { serviceId } = request.params
    try {
      await this.service.publishService(request.user.id, serviceId)
      return reply.send(success(null, 'Service published successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to publish service'))
    }
  }

  async unpublishService(request, reply) {
    const { serviceId } = request.params
    const { reason } = request.body || {}
    try {
      await this.service.unpublishService(request.user.id, serviceId, reason)
      return reply.send(success(null, 'Service unpublished successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to unpublish service'))
    }
  }

  // ─── Admin review of vendor-created services ───────────────────────────

  async listServicesForReview(request, reply) {
    const { status, page, limit } = request.query || {}
    try {
      const res = await this.service.listServicesForReview({
        status,
        page: page ? +page : 1,
        limit: limit ? +limit : 20,
      })
      return reply.send(success(res, 'Vendor services fetched'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch vendor services'))
    }
  }

  async approveService(request, reply) {
    const { id } = request.params
    try {
      const res = await this.service.approveVendorServiceAdmin(id, request.user.id)
      return reply.send(success(res, 'Service approved'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to approve service'))
    }
  }

  async rejectService(request, reply) {
    const { id } = request.params
    const { reason } = request.body || {}
    try {
      const res = await this.service.rejectVendorServiceAdmin(id, request.user.id, reason)
      return reply.send(success(res, 'Service rejected'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to reject service'))
    }
  }

  async recalculateServiceRate(request, reply) {
    const { rateId } = request.params
    const { rate_paise, reason } = request.body || {}
    try {
      const res = await this.service.adminRecalculateServiceRate(rateId, parseInt(rate_paise, 10) || 0, reason)
      return reply.send(success(res, 'Rate updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update rate'))
    }
  }

  async getCapacity(request, reply) {
    try {
      const res = await this.service.getCapacity(request.user.id)
      return reply.send(success(res, 'Capacity settings fetched successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch capacity settings'))
    }
  }

  async updateDailyLimit(request, reply) {
    const { max_orders_per_day } = request.body || {}
    if (max_orders_per_day === undefined) return reply.code(400).send(error('max_orders_per_day is required'))
    try {
      const vendor = await this.service.updateDailyLimit(request.user.id, max_orders_per_day)
      return reply.send(success(vendor, 'Daily capacity limit updated'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update daily capacity limit'))
    }
  }

  async getPickupSlots(request, reply) {
    try {
      const slots = await this.service.getPickupSlots(request.user.id)
      return reply.send(success(slots, 'Pickup slots fetched successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to fetch pickup slots'))
    }
  }

  async createPickupSlot(request, reply) {
    try {
      const slot = await this.service.createPickupSlot(request.user.id, request.body)
      return reply.code(201).send(success(slot, 'Pickup slot created successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to create pickup slot'))
    }
  }

  async updatePickupSlot(request, reply) {
    const { slotId } = request.params
    try {
      const slot = await this.service.updatePickupSlot(request.user.id, slotId, request.body)
      return reply.send(success(slot, 'Pickup slot updated successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to update pickup slot'))
    }
  }

  async deletePickupSlot(request, reply) {
    const { slotId } = request.params
    try {
      await this.service.deletePickupSlot(request.user.id, slotId)
      return reply.send(success(null, 'Pickup slot deleted successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to delete pickup slot'))
    }
  }

  async createCapacityException(request, reply) {
    try {
      const exception = await this.service.createCapacityException(request.user.id, request.body)
      return reply.code(201).send(success(exception, 'Capacity exception created successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to create capacity exception'))
    }
  }

  async deleteCapacityException(request, reply) {
    const { id } = request.params
    try {
      await this.service.deleteCapacityException(request.user.id, id)
      return reply.send(success(null, 'Capacity exception deleted successfully'))
    } catch (err) {
      return reply.code(err.statusCode || 500).send(error(err.message || 'Failed to delete capacity exception'))
    }
  }
}


