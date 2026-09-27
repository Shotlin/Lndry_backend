import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { logger } from '../../../config/logger.js'

const VALID_APPS = ['CUSTOMER', 'VENDOR']

// Reuses the same persisted volume every other on-disk upload in this
// backend already writes to (see uploads.controller.js#uploadDocumentPrivate
// and docker-compose.prod.yml's DOCUMENTS_DATA_DIR mount) — no new Docker
// volume needed, just a subdirectory inside the one that already survives
// container rebuilds.
const STORAGE_ROOT = path.join(process.cwd(), 'storage', 'documents', 'app-releases')

function storageDirFor(app) {
  return path.join(STORAGE_ROOT, app.toLowerCase())
}

/**
 * App Releases service — validates and stores an uploaded APK on disk,
 * mirroring what Play Console's own "rollout" does but self-hosted: the
 * admin uploads a build for either app, it immediately becomes the one
 * `GET /api/v1/app-releases/download/:app` serves.
 */
export class AppReleasesService {
  constructor(repository) {
    this.repo = repository
  }

  async listForApp(app) {
    if (!VALID_APPS.includes(app)) {
      return { success: false, message: 'app must be CUSTOMER or VENDOR' }
    }
    return { success: true, releases: await this.repo.findAllForApp(app) }
  }

  async getActive(app) {
    if (!VALID_APPS.includes(app)) {
      return { success: false, message: 'app must be CUSTOMER or VENDOR' }
    }
    const release = await this.repo.findActiveForApp(app)
    return { success: true, release }
  }

  async getAllActive() {
    const releases = await this.repo.findAllActive()
    const byApp = {}
    for (const r of releases) byApp[r.app] = r
    return byApp
  }

  /**
   * @param {{ app: string, versionName: string, versionCode: number, releaseNotes?: string, uploadedBy?: string }} meta
   * @param {NodeJS.ReadableStream} fileStream
   * @param {string} originalFileName
   */
  async uploadRelease(meta, fileStream, originalFileName) {
    const app = `${meta.app || ''}`.toUpperCase()
    if (!VALID_APPS.includes(app)) {
      return { success: false, message: 'app must be CUSTOMER or VENDOR' }
    }
    if (!meta.versionName || !`${meta.versionName}`.trim()) {
      return { success: false, message: 'versionName is required' }
    }
    const versionCode = Number.parseInt(meta.versionCode, 10)
    if (!Number.isFinite(versionCode) || versionCode <= 0) {
      return { success: false, message: 'versionCode must be a positive integer' }
    }
    if (!originalFileName || !originalFileName.toLowerCase().endsWith('.apk')) {
      return { success: false, message: 'File must be a .apk' }
    }

    const dir = storageDirFor(app)
    fs.mkdirSync(dir, { recursive: true })

    const fileName = `${crypto.randomUUID()}.apk`
    const filePath = path.join(dir, fileName)
    const hash = crypto.createHash('sha256')
    let bytesWritten = 0

    try {
      await new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(filePath)
        fileStream.on('data', (chunk) => {
          hash.update(chunk)
          bytesWritten += chunk.length
        })
        fileStream.on('error', reject)
        writeStream.on('error', reject)
        writeStream.on('finish', resolve)
        fileStream.pipe(writeStream)
      })
    } catch (err) {
      logger.error({ err }, 'App release file write failed')
      try { fs.unlinkSync(filePath) } catch { /* best effort */ }
      return { success: false, message: 'Failed to save the uploaded file' }
    }

    // A truncated/aborted multipart stream (e.g. client gave up mid-upload)
    // still fires 'finish' once the write stream flushes what it got —
    // guard against silently activating a corrupt, tiny "APK".
    if (bytesWritten < 1024) {
      try { fs.unlinkSync(filePath) } catch { /* best effort */ }
      return { success: false, message: 'Upload appears incomplete — try again' }
    }

    const release = await this.repo.createAndActivate({
      app,
      versionName: `${meta.versionName}`.trim(),
      versionCode,
      releaseNotes: meta.releaseNotes ? `${meta.releaseNotes}`.trim() : null,
      fileName,
      originalFileName,
      fileSizeBytes: bytesWritten,
      sha256: hash.digest('hex'),
      uploadedBy: meta.uploadedBy ?? null,
    })

    logger.info({ app, versionName: release.versionName, bytesWritten }, 'App release uploaded and activated')
    return { success: true, release }
  }

  /**
   * Resolves the active release for `app` to a real, verified-existing
   * file path for the controller to stream — never trusts the DB row alone
   * (the file could theoretically be missing after a disk issue).
   */
  async resolveDownload(app) {
    const normalizedApp = `${app || ''}`.toUpperCase()
    if (!VALID_APPS.includes(normalizedApp)) {
      return { success: false, message: 'app must be CUSTOMER or VENDOR' }
    }
    const release = await this.repo.findActiveForApp(normalizedApp)
    if (!release) {
      return { success: false, message: 'No release uploaded yet for this app' }
    }
    const filePath = path.join(storageDirFor(normalizedApp), release.fileName)
    if (!fs.existsSync(filePath)) {
      logger.error({ app: normalizedApp, filePath }, 'Active app release row has no matching file on disk')
      return { success: false, message: 'Release file is missing on the server' }
    }
    return { success: true, release, filePath }
  }

  async deleteHistoricalRelease(id) {
    const release = await this.repo.findById(id)
    if (!release) return { success: false, message: 'Release not found' }
    if (release.isActive) {
      return { success: false, message: 'Cannot delete the currently active release — upload a new one to replace it first' }
    }
    const deleted = await this.repo.delete(id)
    if (deleted) {
      const filePath = path.join(storageDirFor(release.app), release.fileName)
      try { fs.unlinkSync(filePath) } catch { /* already gone, fine */ }
    }
    return { success: deleted, message: deleted ? undefined : 'Release not found' }
  }
}
