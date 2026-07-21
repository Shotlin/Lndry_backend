import { Readable } from 'stream'

import { cloudinary } from '../config/cloudinary.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

function isInvalidSignatureError(error) {
  return error?.http_code === 401 && /Invalid Signature/i.test(error?.message || '')
}

async function streamToBuffer(fileStream) {
  const chunks = []
  for await (const chunk of fileStream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function uploadBufferSigned(buffer, options) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) {
        reject(error)
        return
      }
      resolve(result)
    })

    Readable.from(buffer).pipe(uploadStream)
  })
}

function uploadBufferUnsigned(buffer, options) {
  return new Promise((resolve, reject) => {
    const unsignedOptions = {
      ...options,
    }

    delete unsignedOptions.public_id
    delete unsignedOptions.overwrite

    const uploadStream = cloudinary.uploader.unsigned_upload_stream(
      env.CLOUDINARY_UPLOAD_PRESET,
      (error, result) => {
        if (error) {
          reject(error)
          return
        }
        resolve(result)
      },
      unsignedOptions
    )

    Readable.from(buffer).pipe(uploadStream)
  })
}

export async function uploadImageWithCloudinaryFallback(fileStream, options) {
  const buffer = await streamToBuffer(fileStream)

  try {
    return await uploadBufferSigned(buffer, options)
  } catch (error) {
    if (!isInvalidSignatureError(error) || !env.CLOUDINARY_UPLOAD_PRESET) {
      throw error
    }

    logger.warn(
      {
        folder: options.folder,
        uploadPreset: env.CLOUDINARY_UPLOAD_PRESET,
      },
      'Cloudinary signed upload failed with invalid signature. Retrying with unsigned preset.'
    )

    return uploadBufferUnsigned(buffer, options)
  }
}

