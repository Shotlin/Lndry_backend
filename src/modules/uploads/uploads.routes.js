import { UploadsController } from './uploads.controller.js'
import { UploadsService } from './uploads.service.js'

/**
 * Uploads routes plugin
 * Prefix: /api/v1/uploads
 */
export default async function uploadsRoutes(fastify) {
  const service = new UploadsService()
  const controller = new UploadsController(service)

  // POST /image — Upload single image [AUTH]
  fastify.post('/image', {
    schema: {
      tags: ['Uploads'],
      summary: 'Upload single image to Cloudinary',
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
    },
    preHandler: [fastify.authenticate],
  }, controller.uploadImage.bind(controller))

  // POST /images — Upload multiple images [ADMIN]
  fastify.post('/images', {
    schema: {
      tags: ['Uploads'],
      summary: 'Upload multiple images [ADMIN]',
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
    },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.uploadMultipleImages.bind(controller))

  // POST /file — Upload any file (Lottie, etc.) [ADMIN]
  fastify.post('/file', {
    schema: {
      tags: ['Uploads'],
      summary: 'Upload file to Cloudinary (Lottie, etc.) [ADMIN]',
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
    },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.uploadFile.bind(controller))

  // POST /document — Upload private secure KYC document [VENDOR | ADMIN]
  fastify.post('/document', {
    schema: {
      tags: ['Uploads'],
      summary: 'Upload private secure KYC document',
      security: [{ bearerAuth: [] }],
    },
    preHandler: [fastify.authenticate],
  }, controller.uploadDocumentPrivate.bind(controller))

  // GET /proxy — Proxy a Cloudinary file for mobile clients
  fastify.get('/proxy', {
    schema: {
      tags: ['Uploads'],
      summary: 'Proxy a Cloudinary file download',
      querystring: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string' },
          encoding: { type: 'string' },
        },
      },
    },
  }, controller.proxyFile.bind(controller))

  // DELETE /image — Delete image from Cloudinary [ADMIN]
  fastify.delete('/image', {
    schema: {
      tags: ['Uploads'],
      summary: 'Delete image from Cloudinary [ADMIN]',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['publicId'],
        properties: {
          publicId: { type: 'string' },
        },
      },
    },
    preHandler: [fastify.authenticate, fastify.authorize(['ADMIN'])],
  }, controller.deleteImage.bind(controller))

  // DELETE /:assetId — Delete asset (Cloudinary image or private document) [AUTH]
  fastify.delete('/:assetId', {
    schema: {
      tags: ['Uploads'],
      summary: 'Delete uploaded asset (private document or Cloudinary image)',
      params: {
        type: 'object',
        required: ['assetId'],
        properties: {
          assetId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
    },
    preHandler: [fastify.authenticate],
  }, controller.deleteUpload.bind(controller))
}

