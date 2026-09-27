import fs from 'node:fs'
import { success, error } from '../../../utils/apiResponse.js'

const APP_DISPLAY_NAME = {
  CUSTOMER: 'LNDRY',
  VENDOR: 'Lndry-Partner',
}

// Overrides the global multipart plugin's 5MB default for this one route
// only, via @fastify/multipart's per-call request.file(options) — see
// app-releases.routes.js for why the plugin itself isn't re-registered.
const APK_UPLOAD_LIMIT_BYTES = 250 * 1024 * 1024

export class AppReleasesController {
  constructor(service) {
    this.service = service
  }

  // ── Admin ────────────────────────────────────────────────────────────

  async listForApp(request, reply) {
    const app = `${request.query.app || ''}`.toUpperCase()
    const result = await this.service.listForApp(app)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    return reply.code(200).send(success(result.releases, 'App releases fetched'))
  }

  async upload(request, reply) {
    const file = await request.file({ limits: { fileSize: APK_UPLOAD_LIMIT_BYTES } })
    if (!file) {
      return reply.code(400).send(error('No file provided', 'NO_FILE'))
    }

    const fields = file.fields || {}
    const meta = {
      app: fields.app?.value,
      versionName: fields.versionName?.value,
      versionCode: fields.versionCode?.value,
      releaseNotes: fields.releaseNotes?.value,
      uploadedBy: request.user?.id ?? null,
    }

    const result = await this.service.uploadRelease(meta, file.file, file.filename)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'UPLOAD_FAILED'))
    }
    return reply.code(201).send(success(result.release, 'App release uploaded and rolled out'))
  }

  async delete(request, reply) {
    const result = await this.service.deleteHistoricalRelease(request.params.id)
    if (!result.success) {
      const code = result.message === 'Release not found' ? 404 : 409
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'CONFLICT'))
    }
    return reply.code(200).send(success(null, 'Release deleted'))
  }

  // ── Public ───────────────────────────────────────────────────────────

  async publicLatest(request, reply) {
    const app = `${request.query.app || ''}`.toUpperCase()
    const result = await this.service.getActive(app)
    if (!result.success) {
      return reply.code(400).send(error(result.message, 'VALIDATION_ERROR'))
    }
    if (!result.release) {
      return reply.code(404).send(error('No release uploaded yet for this app', 'NOT_FOUND'))
    }
    const r = result.release
    return reply.code(200).send(success({
      app: r.app,
      appName: APP_DISPLAY_NAME[r.app],
      versionName: r.versionName,
      versionCode: r.versionCode,
      releaseNotes: r.releaseNotes,
      fileSizeBytes: r.fileSizeBytes,
      downloadUrl: `https://api.lndry.in/api/v1/app-releases/download/${r.app.toLowerCase()}`,
      updatedAt: r.createdAt,
    }, 'Latest release fetched'))
  }

  async publicAll(request, reply) {
    const byApp = await this.service.getAllActive()
    const data = {}
    for (const key of ['CUSTOMER', 'VENDOR']) {
      const r = byApp[key]
      data[key.toLowerCase()] = r
        ? {
            app: r.app,
            appName: APP_DISPLAY_NAME[r.app],
            versionName: r.versionName,
            versionCode: r.versionCode,
            releaseNotes: r.releaseNotes,
            fileSizeBytes: r.fileSizeBytes,
            downloadUrl: `https://api.lndry.in/api/v1/app-releases/download/${r.app.toLowerCase()}`,
            updatedAt: r.createdAt,
          }
        : null
    }
    return reply.code(200).send(success(data, 'Latest releases fetched'))
  }

  async download(request, reply) {
    const result = await this.service.resolveDownload(request.params.app)
    if (!result.success) {
      const code = result.message === 'No release uploaded yet for this app' || result.message === 'app must be CUSTOMER or VENDOR' ? 404 : 500
      return reply.code(code).send(error(result.message, code === 404 ? 'NOT_FOUND' : 'FILE_MISSING'))
    }

    const { release, filePath } = result
    const displayName = `${APP_DISPLAY_NAME[release.app]}-v${release.versionName}.apk`

    reply
      .header('Content-Type', 'application/vnd.android.package-archive')
      .header('Content-Disposition', `attachment; filename="${displayName}"`)
      .header('Content-Length', release.fileSizeBytes)
      .header('Cache-Control', 'no-cache')

    return reply.send(fs.createReadStream(filePath))
  }
}
