import sharp from 'sharp'
import axios from 'axios'
import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../../config/logger.js'

export class WatermarkService {
  /**
   * Apply watermark to an image buffer based on settings.
   *
   * @param {Buffer} imageBuffer - original image buffer
   * @param {string} text - dynamic watermark text
   * @param {object} settings - { enabled, position, scale, opacity }
   * @returns {Promise<Buffer>} - watermarked image buffer
   */
  async applyWatermark(imageBuffer, text, settings = {}) {
    if (settings.enabled === false) {
      return imageBuffer
    }

    try {
      const metadata = await sharp(imageBuffer).metadata()
      const width = metadata.width || 800
      const height = metadata.height || 600

      const opacity = settings.opacity !== undefined ? Number(settings.opacity) : 0.4
      const scale = settings.scale !== undefined ? Number(settings.scale) : 1.0
      
      // Calculate font size relative to image size
      const fontSize = Math.round(Math.min(width, height) * 0.05 * scale)
      
      // Handle simple position mapping
      let x = width / 2
      let y = height / 2
      let angle = -30
      
      if (settings.position === 'top-left') {
        x = width * 0.25
        y = height * 0.15
        angle = 0
      } else if (settings.position === 'top-right') {
        x = width * 0.75
        y = height * 0.15
        angle = 0
      } else if (settings.position === 'bottom-left') {
        x = width * 0.25
        y = height * 0.85
        angle = 0
      } else if (settings.position === 'bottom-right') {
        x = width * 0.75
        y = height * 0.85
        angle = 0
      }

      // Generate SVG with watermarked text
      const svgText = `
        <svg width="${width}" height="${height}">
          <style>
            .wm-text {
              fill: rgba(255, 255, 255, ${opacity});
              font-size: ${fontSize}px;
              font-family: sans-serif;
              font-weight: bold;
              text-anchor: middle;
              dominant-baseline: middle;
            }
          </style>
          <text x="${x}" y="${y}" class="wm-text" transform="rotate(${angle} ${x} ${y})">${text}</text>
        </svg>
      `

      return await sharp(imageBuffer)
        .composite([{ input: Buffer.from(svgText), blend: 'over' }])
        .toBuffer()
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to apply watermark using Sharp')
      return imageBuffer
    }
  }

  /**
   * Process and fetch file with dynamic watermark.
   *
   * @param {string} fileUrl - direct private file URL (could be Cloudinary or elsewhere)
   * @param {string} vendorRef - Vendor Ref / Branch Code
   * @param {object} settings - Watermark settings from db
   * @returns {Promise<{ buffer: Buffer, contentType: string }>}
   */
  async processKycPreview(fileUrl, vendorRef, settings = {}) {
    const today = new Date().toISOString().split('T')[0]
    const baseText = settings.text || 'For LNDRY Verification Only'
    const watermarkText = `${baseText} - ${vendorRef} - ${today}`

    try {
      let buffer
      let contentType = 'image/jpeg'

      // 1. Fetch file contents from local file system or URL
      if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' })
        buffer = Buffer.from(response.data)
        contentType = response.headers['content-type'] || 'image/jpeg'
      } else {
        let localPath = fileUrl
        if (fileUrl.startsWith('private://')) {
          const parts = fileUrl.replace('private://', '').split('/')
          const filename = parts[parts.length - 1]
          localPath = path.join(process.cwd(), 'storage', 'documents', filename)
        }
        buffer = await fs.promises.readFile(localPath)
        if (localPath.endsWith('.pdf')) {
          contentType = 'application/pdf'
        } else if (localPath.endsWith('.png')) {
          contentType = 'image/png'
        } else if (localPath.endsWith('.webp')) {
          contentType = 'image/webp'
        }
      }

      // Only apply Sharp watermark if it's an image
      if (contentType.startsWith('image/')) {
        const watermarkedBuffer = await this.applyWatermark(buffer, watermarkText, settings)
        return { buffer: watermarkedBuffer, contentType }
      }

      // If it is PDF or other formats, we stream it back
      return { buffer, contentType }
    } catch (err) {
      logger.error({ err: err.message, fileUrl }, 'Failed to fetch and watermark KYC document')
      throw err
    }
  }
}

