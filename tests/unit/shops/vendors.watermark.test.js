import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorsService } from '../../../src/modules/vendors/vendors.service.js'
import { WatermarkService } from '../../../src/modules/watermark/watermark.service.js'
import * as auditLog from '../../../src/utils/audit-log.js'

vi.spyOn(auditLog, 'emit').mockImplementation(() => {})

function createRepositoryMock() {
  return {
    getDocumentById: vi.fn(),
    findById: vi.fn(),
    findByUserId: vi.fn(),
    getWatermarkSettings: vi.fn(),
  }
}

describe('VendorsService KYC Watermarking', () => {
  let repository
  let service
  const userAdmin = { id: 'admin-1', role: 'ADMIN' }
  const userVendorOwner = { id: 'owner-1', role: 'VENDOR_OWNER' }
  const docId = 'doc-123'
  const vendorId = 'vendor-456'

  beforeEach(() => {
    repository = createRepositoryMock()
    service = new VendorsService(repository)
    // Stub processKycPreview to return mock buffer directly instead of performing real HTTP/Sharp actions
    service.watermarkService.processKycPreview = vi.fn().mockResolvedValue({
      buffer: Buffer.from('watermarked-image'),
      contentType: 'image/jpeg',
    })
    vi.clearAllMocks()
  })

  describe('previewKycDocument', () => {
    it('successfully processes and returns watermarked KYC preview for admin', async () => {
      const document = {
        id: docId,
        vendor_id: vendorId,
        document_type: 'gst_certificate',
        file_url: 'https://cloudinary.com/private/gst.jpg',
      }

      repository.getDocumentById.mockResolvedValue(document)
      repository.findById.mockResolvedValue({
        id: vendorId,
        branch_code: 'VND-ABCD',
      })
      repository.getWatermarkSettings.mockResolvedValue({
        enabled: true,
        text: 'For LNDRY Verification Only',
      })

      const result = await service.previewKycDocument(docId, userAdmin)

      expect(repository.getDocumentById).toHaveBeenCalledWith(docId)
      expect(repository.findById).toHaveBeenCalledWith(vendorId)
      expect(service.watermarkService.processKycPreview).toHaveBeenCalledWith(
        document.file_url,
        'VND-ABCD',
        expect.objectContaining({ enabled: true })
      )
      expect(auditLog.emit).toHaveBeenCalledWith('kyc_document_viewed', expect.any(Object))
      expect(result.buffer.toString()).toBe('watermarked-image')
    })

    it('denies access if logged in user is vendor staff but not the owner of this document', async () => {
      const document = {
        id: docId,
        vendor_id: vendorId,
      }

      repository.getDocumentById.mockResolvedValue(document)
      // findByUserId returns profile belonging to another vendor
      repository.findByUserId.mockResolvedValue({
        id: 'vendor-789',
      })

      await expect(
        service.previewKycDocument(docId, userVendorOwner)
      ).rejects.toEqual({
        statusCode: 403,
        message: 'Forbidden',
      })
    })

    it('allows access to the document if logged in user is the owner of the document', async () => {
      const document = {
        id: docId,
        vendor_id: vendorId,
        file_url: 'http://foo.bar',
      }

      repository.getDocumentById.mockResolvedValue(document)
      repository.findByUserId.mockResolvedValue({
        id: vendorId,
      })
      repository.findById.mockResolvedValue({
        id: vendorId,
        branch_code: 'VND-ABCD',
      })

      const result = await service.previewKycDocument(docId, userVendorOwner)
      expect(result.buffer.toString()).toBe('watermarked-image')
    })
  })
})
