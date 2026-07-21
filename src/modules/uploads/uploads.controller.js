import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import { success, error } from '../../utils/apiResponse.js'
import { env } from '../../config/env.js'
import { extractCloudinaryAssetInfo } from '../../config/cloudinary.js'


/**
 * Uploads controller
 */
export class UploadsController {
  constructor(service) {
    this.service = service
  }

  /**
   * POST /image — Upload single image
   *
   * Accepts an optional `folder` form field (e.g. "categories",
   * "garment-types") so different admin surfaces don't all dump into the
   * same Cloudinary folder. Sanitized to a safe slug; falls back to the
   * generic default folder when absent or invalid.
   */
  async uploadImage(request, reply) {
    const file = await request.file()

    if (!file) {
      return reply.code(400).send(error('No file uploaded', 'NO_FILE'))
    }

    const allowed = env.ALLOWED_IMAGE_TYPES.split(',')
    if (!allowed.includes(file.mimetype)) {
      return reply.code(400).send(error('Invalid file type. Allowed: JPEG, PNG, WebP', 'INVALID_FILE_TYPE'))
    }

    const rawFolder = file.fields?.folder?.value
    const folder = typeof rawFolder === 'string' && /^[a-z0-9-]{1,40}$/i.test(rawFolder)
      ? `${env.CLOUDINARY_FOLDER}/${rawFolder}`
      : undefined

    try {
      const result = await this.service.uploadImage(file.file, { folder })
      return reply.code(200).send(success(result, 'Image uploaded'))
    } catch (err) {
      request.log.error({ err }, 'Image upload failed in controller')
      return reply.code(400).send(error('Failed to upload image. Check cloud provider credentials.', 'UPLOAD_FAILED'))
    }
  }

  /**
   * POST /images — Upload multiple images [ADMIN]
   */
  async uploadMultipleImages(request, reply) {
    const parts = request.files()
    const files = []
    const allowed = env.ALLOWED_IMAGE_TYPES.split(',')

    for await (const part of parts) {
      if (!allowed.includes(part.mimetype)) {
        return reply.code(400).send(error(`Invalid file type: ${part.filename}`, 'INVALID_FILE_TYPE'))
      }
      files.push(part)
    }

    if (files.length === 0) {
      return reply.code(400).send(error('No files uploaded', 'NO_FILE'))
    }

    try {
      const results = await this.service.uploadMultipleImages(files)
      return reply.code(200).send(success(results, `${results.length} image(s) uploaded`))
    } catch (err) {
      request.log.error({ err }, 'Multiple image upload failed in controller')
      return reply.code(400).send(error('Failed to upload images. Check cloud provider credentials.', 'UPLOAD_FAILED'))
    }
  }

  async uploadFile(request, reply) {
    const data = await request.file()
    if (!data) {
      return reply.code(400).send(error('No file provided'))
    }
    const buffer = await data.toBuffer()
    const result = await this.service.uploadFile(buffer, data.filename)
    return reply.code(200).send(success(result, 'File uploaded'))
  }

  /**
   * GET /proxy — Proxy a Cloudinary raw file (for emulator/mobile clients
   * that may have DNS issues reaching res.cloudinary.com directly).
   * Only allows proxying from Cloudinary domains.
   */
  async proxyFile(request, reply) {
    const { url, encoding } = request.query

    if (!url) {
      return reply.code(400).send(error('Missing "url" query parameter', 'MISSING_URL'))
    }

    // Security: only proxy from Cloudinary
    try {
      const parsed = new URL(url)
      if (!parsed.hostname.endsWith('cloudinary.com')) {
        return reply.code(403).send(error('Only Cloudinary URLs are allowed', 'FORBIDDEN_DOMAIN'))
      }
    } catch {
      return reply.code(400).send(error('Invalid URL', 'INVALID_URL'))
    }

    try {
      const candidates = buildProxyCandidates(url)
      let lastStatus = null

      for (const candidateUrl of candidates) {
        try {
          const response = await downloadProxyCandidate(candidateUrl)
          lastStatus = response.statusCode
          if (response.statusCode < 200 || response.statusCode >= 300) {
            continue
          }

          const contentType = response.headers['content-type'] || 'application/octet-stream'
          const buffer = response.buffer

          if (buffer.length === 0) {
            request.log.warn({ candidateUrl }, 'Proxy candidate returned empty body')
            continue
          }

          if (`${encoding || ''}`.toLowerCase() === 'base64') {
            return reply.code(200).send(
              success(
                {
                  contentType,
                  base64: buffer.toString('base64'),
                },
                'Proxy file'
              )
            )
          }

          reply
            .code(200)
            .header('Content-Type', contentType)
            .header('Cache-Control', 'public, max-age=86400, immutable')
            .send(buffer)
          return
        } catch (fetchError) {
          request.log.warn({ err: fetchError, candidateUrl }, 'Proxy candidate fetch failed')
          continue
        }
      }

      return reply.code(502).send(
        error(
          lastStatus ? `Upstream returned ${lastStatus}` : 'Failed to fetch upstream file',
          'UPSTREAM_ERROR'
        )
      )
    } catch (err) {
      request.log.error({ err, url }, 'Proxy fetch failed')
      return reply.code(502).send(error('Failed to fetch upstream file', 'PROXY_FAILED'))
    }
  }

  /**
   * DELETE /image — Delete image from Cloudinary [ADMIN]
   */
  async deleteImage(request, reply) {
    const { publicId: rawPublicId } = request.body

    if (!rawPublicId) {
      return reply.code(400).send(error('publicId is required', 'MISSING_FIELD'))
    }

    // Callers may pass either a raw Cloudinary publicId or a full delivery
    // URL (all we persist on category/garment_type rows is the URL) —
    // normalize either shape to the actual publicId before destroying it.
    const asset = extractCloudinaryAssetInfo(rawPublicId)
    const publicId = asset?.publicId || rawPublicId

    const result = await this.service.deleteImage(publicId)

    if (!result.success) {
      return reply.code(400).send(error('Image not found or already deleted', 'DELETE_FAILED'))
    }

    return reply.code(200).send(success(null, 'Image deleted'))
  }

  async uploadDocumentPrivate(request, reply) {
    const data = await request.file()
    if (!data) {
      return reply.code(400).send(error('No file provided'))
    }

    const documentType = data.fields.document_type?.value || 'owner_identity'

    // Retrieve vendor profile for current user
    const { query } = await import('../../config/database.js')
    const { rows } = await query(
      'SELECT id FROM vendors WHERE created_by = $1 LIMIT 1',
      [request.user.id]
    )

    const vendor = rows[0]
    if (!vendor) {
      return reply.code(404).send(error('Vendor profile not found', 'NOT_FOUND'))
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
      const docResult = await query(
        `INSERT INTO vendor_documents (vendor_id, document_type, file_url)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [vendor.id, documentType, fileUrl]
      )
      
      return reply.code(201).send(success({ document_id: docResult.rows[0].id }, 'Document uploaded successfully'))
    } catch (err) {
      request.log.error({ err }, 'Private document upload failed')
      return reply.code(500).send(error(err.message || 'Upload failed'))
    }
  }

  async deleteUpload(request, reply) {
    const { assetId } = request.params
    const { reason } = request.body || {}

    // Check if assetId is a UUID (likely a private document)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assetId)

    if (isUuid) {
      const { query } = await import('../../config/database.js')
      const { rows } = await query(
        'SELECT id, vendor_id, file_url FROM vendor_documents WHERE id = $1',
        [assetId]
      )
      const doc = rows[0]
      if (!doc) {
        return reply.code(404).send(error('Asset not found'))
      }

      // Check access: user must be ADMIN, or must be owner/staff of the vendor
      const isAdmin = request.user.role === 'ADMIN'
      if (!isAdmin) {
        const vendorRows = await query(
          'SELECT 1 FROM vendors WHERE id = $1 AND created_by = $2',
          [doc.vendor_id, request.user.id]
        )
        if (vendorRows.rows.length === 0) {
          return reply.code(403).send(error('Forbidden'))
        }
      }

      // Perform deletion
      await query('DELETE FROM vendor_documents WHERE id = $1', [assetId])
      
      // Attempt to delete physical local file if it's local
      if (doc.file_url.startsWith('private://')) {
        const filename = doc.file_url.replace('private://documents/', '')
        const filePath = path.join(process.cwd(), 'storage', 'documents', filename)
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
          }
        } catch (err) {
          request.log.warn({ err }, 'Failed to delete physical file from disk')
        }
      }

      return reply.send(success(null, 'Private document deleted successfully'))
    } else {
      // Cloudinary image deletion
      const result = await this.service.deleteImage(assetId)
      if (!result.success) {
        return reply.code(400).send(error('Failed to delete image'))
      }
      return reply.send(success(null, 'Image deleted successfully'))
    }
  }
}


function buildProxyCandidates(rawUrl) {
  const candidates = new Set([rawUrl])

  try {
    const parsed = new URL(rawUrl)
    const pathname = parsed.pathname.toLowerCase()
    const isCloudinaryRaw = pathname.includes('/raw/upload/')
    const hasKnownExtension =
      pathname.endsWith('.lottie') || pathname.endsWith('.json')

    if (isCloudinaryRaw && !hasKnownExtension) {
      candidates.add(`${rawUrl}.lottie`)
      candidates.add(`${rawUrl}.json`)
    }
  } catch {
    return [rawUrl]
  }

  return Array.from(candidates)
}

function downloadProxyCandidate(rawUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(rawUrl)
    } catch (error) {
      reject(error)
      return
    }

    const client = parsed.protocol === 'http:' ? http : https
    const request = client.get(
      parsed,
      {
        headers: {
          'User-Agent': 'LNDRYProxy/1.0',
        },
      },
      (response) => {
        const statusCode = response.statusCode ?? 0
        const location = response.headers.location

        if (statusCode >= 300 && statusCode < 400 && location) {
          response.resume()
          if (redirectCount >= 5) {
            reject(new Error(`Too many redirects while fetching ${rawUrl}`))
            return
          }

          const nextUrl = new URL(location, parsed).toString()
          downloadProxyCandidate(nextUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject)
          return
        }

        const chunks = []
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        response.on('end', () => {
          resolve({
            statusCode,
            headers: response.headers,
            buffer: Buffer.concat(chunks),
          })
        })
        response.on('error', reject)
      }
    )

    request.setTimeout(8000, () => {
      request.destroy(new Error(`Timed out while fetching ${rawUrl}`))
    })

    request.on('error', reject)
  })
}
