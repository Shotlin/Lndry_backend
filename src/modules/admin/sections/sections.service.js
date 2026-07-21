import { themeQueue } from '../../../config/bullmq.js'
import { emitSectionUpdate, getSocketIo } from '../../../plugins/socketio.plugin.js'
import { cacheDeletePattern } from '../../../utils/cache.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { SectionsRepository } from './sections.repository.js'

const repo = new SectionsRepository()

async function invalidateSectionCaches() {
  await cacheDeletePattern('lndry:sections:*')
  await cacheDeletePattern('lndry:tab_home:*')
  await cacheDeletePattern('lndry:tab_manifest:*')
}

function broadcastSectionUpdate(tabKey) {
  if (!tabKey) return
  emitSectionUpdate(getSocketIo(), tabKey, 'update')
}

export class SectionsService {
  async getByTabId(tabId) {
    return repo.findByTabId(tabId)
  }

  async getById(id) {
    return repo.findById(id)
  }

  async create(tabId, data, adminId, ip) {
    const tab = await repo.findTabById(tabId)
    if (!tab) return null

    const section = await repo.create(tabId, {
      ...data,
      config: data.config || {},
    })

    const createdSection = await repo.findById(section.id)

    await invalidateSectionCaches()
    broadcastSectionUpdate(createdSection?.tab_key)
    logAdminActivity(adminId, 'CREATE_SECTION', 'section_manifest', section.id, null, null, ip)
    return createdSection
  }

  async update(id, data, adminId, ip) {
    const existing = await repo.findById(id)
    if (!existing) return null

    const nextData = { ...data }
    if (data.config !== undefined) {
      nextData.config = mergeSectionConfig(existing.config || {}, data.config)
    }

    const section = await repo.update(id, nextData)
    if (!section) return null

    await invalidateSectionCaches()
    broadcastSectionUpdate(existing.tab_key)
    logAdminActivity(adminId, 'UPDATE_SECTION', 'section_manifest', id, null, null, ip)
    return repo.findById(id)
  }

  async updateMerchBinding(id, binding, adminId, ip) {
    const existing = await repo.findById(id)
    if (!existing) return null

    const section = await repo.updateMerchBinding(id, binding)
    if (!section) return null

    await invalidateSectionCaches()
    broadcastSectionUpdate(existing.tab_key)
    logAdminActivity(adminId, 'UPDATE_SECTION_MERCH', 'section_manifest', id, null, null, ip)
    return repo.findById(id)
  }

  async remove(id, adminId, ip) {
    const section = await repo.delete(id)
    if (!section) return null

    await invalidateSectionCaches()
    broadcastSectionUpdate(section.tab_key)
    logAdminActivity(adminId, 'DELETE_SECTION', 'section_manifest', id, null, null, ip)
    return section
  }

  async reorder(tabId, orderedIds, adminId, ip) {
    const sections = await repo.reorder(tabId, orderedIds)
    const tab = await repo.findTabById(tabId)

    await invalidateSectionCaches()
    broadcastSectionUpdate(tab?.key)
    logAdminActivity(adminId, 'REORDER_SECTIONS', 'section_manifest', tabId, null, null, ip)
    return sections
  }

  async duplicate(id, adminId, ip) {
    const section = await repo.duplicate(id)
    if (!section) return null

    const duplicatedSection = await repo.findById(section.id)

    await invalidateSectionCaches()
    broadcastSectionUpdate(duplicatedSection?.tab_key)
    logAdminActivity(adminId, 'DUPLICATE_SECTION', 'section_manifest', section.id, null, null, ip)
    return duplicatedSection
  }

  async saveSnapshot(tabId, adminId) {
    const sections = await repo.findByTabId(tabId)
    return repo.createVersion(tabId, sections, adminId)
  }

  async getVersions(tabId) {
    return repo.getVersions(tabId)
  }

  async rollbackToVersion(tabId, versionId, adminId, ip) {
    const version = await repo.findVersionById(tabId, versionId)
    if (!version) return null

    const sections = await repo.restoreSnapshot(tabId, version.snapshot)
    const tab = await repo.findTabById(tabId)

    await invalidateSectionCaches()
    broadcastSectionUpdate(tab?.key)
    logAdminActivity(adminId, 'ROLLBACK_SECTIONS', 'section_manifest', tabId, null, null, ip)
    return sections
  }

  async scheduleLayout(tabId, scheduledAt, adminId, ip) {
    const tab = await repo.findTabById(tabId)
    if (!tab) return null

    const sections = await repo.findByTabId(tabId)
    await repo.expireScheduledVersions(tabId)

    const version = await repo.createVersion(tabId, sections, adminId, {
      scheduledAt,
      status: 'scheduled',
    })

    const delay = Math.max(0, new Date(scheduledAt).getTime() - Date.now())

    try {
      const existingJob = await themeQueue.getJob(`section-schedule-${tabId}`)
      if (existingJob) await existingJob.remove()
    } catch {}

    await themeQueue.add(
      'apply-section-layout',
      { type: 'apply-section-layout', versionId: version.id, tabId },
      {
        jobId: `section-schedule-${tabId}`,
        delay,
        removeOnComplete: true,
      }
    )

    logAdminActivity(adminId, 'SCHEDULE_SECTIONS', 'section_manifest', tabId, null, null, ip)
    return version
  }

  async cancelSchedule(tabId, adminId, ip) {
    const tab = await repo.findTabById(tabId)
    if (!tab) return null

    const cancelled = await repo.expireScheduledVersions(tabId)

    try {
      const job = await themeQueue.getJob(`section-schedule-${tabId}`)
      if (job) await job.remove()
    } catch {}

    logAdminActivity(adminId, 'CANCEL_SCHEDULE_SECTIONS', 'section_manifest', tabId, null, null, ip)
    return {
      tab_id: tabId,
      cancelled_count: cancelled.length,
    }
  }
}

function mergeSectionConfig(currentValue, nextValue) {
  if (Array.isArray(nextValue)) {
    return nextValue
  }

  if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
    const merged = { ...currentValue }
    for (const [key, value] of Object.entries(nextValue)) {
      merged[key] = mergeSectionConfig(currentValue[key], value)
    }
    return merged
  }

  return nextValue
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
