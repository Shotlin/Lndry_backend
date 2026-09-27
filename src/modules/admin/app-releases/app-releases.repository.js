import { query, getClient } from '../../../config/database.js'

const COLUMNS = `
  id, app, version_name, version_code, release_notes, file_name,
  original_file_name, file_size_bytes, sha256, is_active, uploaded_by,
  created_at
`

/**
 * App Releases repository — self-hosted APK distribution metadata. The
 * file itself lives on disk (see app-releases.service.js); this table just
 * tracks which row is the currently-served ("active") build per app, plus
 * history.
 */
export class AppReleasesRepository {
  async findAllForApp(app) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM app_releases WHERE app = $1 ORDER BY created_at DESC`,
      [app]
    )
    return rows.map(this._format)
  }

  async findActiveForApp(app) {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM app_releases WHERE app = $1 AND is_active = true LIMIT 1`,
      [app]
    )
    return rows[0] ? this._format(rows[0]) : null
  }

  async findAllActive() {
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM app_releases WHERE is_active = true ORDER BY app ASC`
    )
    return rows.map(this._format)
  }

  async findById(id) {
    const { rows } = await query(`SELECT ${COLUMNS} FROM app_releases WHERE id = $1`, [id])
    return rows[0] ? this._format(rows[0]) : null
  }

  /**
   * Insert a new release for `app` and atomically make it the active one,
   * deactivating whatever was active before (kept as history, not deleted).
   */
  async createAndActivate(data) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      await client.query(
        `UPDATE app_releases SET is_active = false WHERE app = $1 AND is_active = true`,
        [data.app]
      )

      const { rows } = await client.query(
        `INSERT INTO app_releases
           (app, version_name, version_code, release_notes, file_name,
            original_file_name, file_size_bytes, sha256, is_active, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
         RETURNING ${COLUMNS}`,
        [
          data.app,
          data.versionName,
          data.versionCode,
          data.releaseNotes ?? null,
          data.fileName,
          data.originalFileName,
          data.fileSizeBytes,
          data.sha256,
          data.uploadedBy ?? null,
        ]
      )

      await client.query('COMMIT')
      return this._format(rows[0])
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async delete(id) {
    const result = await query(`DELETE FROM app_releases WHERE id = $1 AND is_active = false`, [id])
    return result.rowCount > 0
  }

  _format(row) {
    return {
      id: row.id,
      app: row.app,
      versionName: row.version_name,
      versionCode: row.version_code,
      releaseNotes: row.release_notes,
      fileName: row.file_name,
      originalFileName: row.original_file_name,
      fileSizeBytes: Number(row.file_size_bytes),
      sha256: row.sha256,
      isActive: row.is_active,
      uploadedBy: row.uploaded_by,
      createdAt: row.created_at,
    }
  }
}
