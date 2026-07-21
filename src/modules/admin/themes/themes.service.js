import { ThemesRepository } from './themes.repository.js'
import { logAdminActivity } from '../../../utils/activityLogger.js'
import { redis } from '../../../config/redis.js'
import { themeQueue } from '../../../config/bullmq.js'
import { getSocketIo } from '../../../plugins/socketio.plugin.js'
import { logger } from '../../../config/logger.js'
import { cacheDeletePattern } from '../../../utils/cache.js'
import {
  ACTIVE_THEME_CACHE_KEY,
  LEGACY_TAB_CACHE_KEY,
  getAdminTabThemesCacheKey,
} from '../../themes/theme-cache.js'

const repo = new ThemesRepository()
const CACHE_TTL = 300

async function invalidateThemeCaches() {
  await redis.del(ACTIVE_THEME_CACHE_KEY)
  await redis.del(LEGACY_TAB_CACHE_KEY)
  await redis.del(getAdminTabThemesCacheKey())
  await cacheDeletePattern('lndry:admin_theme_tabs:*')
  await cacheDeletePattern('lndry:tab_manifest:*')
  await cacheDeletePattern('lndry:tab_home:*')
}

function broadcastThemeUpdate(theme, themeId) {
  const io = getSocketIo()
  const tabKey = theme?.tab_key
  if (!io || !tabKey) {
    return
  }

  const storeKey = theme.store_key || 'zepto'
  io.to('themes:live').emit('theme:update', {
    tabKey,
    storeKey,
    themeId,
    timestamp: new Date().toISOString(),
  })
  logger.info({ tabKey, storeKey, themeId }, 'Theme update broadcasted to all users')
}

export class ThemesService {
  async list() {
    return repo.findAll()
  }

  async getById(id) {
    return repo.findById(id)
  }

  async getActive() {
    const cached = await redis.get(ACTIVE_THEME_CACHE_KEY)
    if (cached) return JSON.parse(cached)

    const theme = await repo.findActive()
    if (theme) {
      await redis.set(ACTIVE_THEME_CACHE_KEY, JSON.stringify(theme.theme_data), 'EX', CACHE_TTL)
    }
    return theme?.theme_data ?? null
  }

  async getTabThemes() {
    const cacheKey = getAdminTabThemesCacheKey()
    const cached = await redis.get(cacheKey)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (Array.isArray(parsed)) return parsed
    }

    const themes = await repo.findAllTabThemes({ status: 'active' })
    if (themes.length) {
      await redis.set(cacheKey, JSON.stringify(themes), 'EX', CACHE_TTL)
    }
    return themes
  }

  async create(data, adminId, ip) {
    if (data.tab_id) {
      const tab = await repo.findTabMeta(data.tab_id)
      if (!tab) {
        return null
      }
    }

    const theme = await repo.create(data)
    if (theme) {
      await invalidateThemeCaches()
    }
    logAdminActivity(adminId, 'CREATE_THEME', 'theme', theme.id, null, null, ip)
    return theme
  }

  async update(id, data, adminId, ip) {
    const existing = await repo.findById(id)
    if (!existing) return null

    if (data.tab_id) {
      const tab = await repo.findTabMeta(data.tab_id)
      if (!tab) {
        return null
      }
    }

    if (existing?.theme_data && data.theme_data) {
      await repo.createVersion(id, existing.theme_data, adminId)
      data.theme_data = mergeThemeData(existing.theme_data, data.theme_data)
      data.version = (existing.version || 1) + 1
    }

    const theme = await repo.update(id, data)
    logAdminActivity(adminId, 'UPDATE_THEME', 'theme', id, null, null, ip)
    if (existing?.is_active || existing?.tab_id || theme?.is_active || theme?.tab_id) {
      await invalidateThemeCaches()
      broadcastThemeUpdate(theme || existing, id)
    }
    return theme
  }

  async activate(id, adminId, ip) {
    const theme = await repo.activate(id)
    if (!theme) return null

    await invalidateThemeCaches()
    logAdminActivity(adminId, 'ACTIVATE_THEME', 'theme', id, null, null, ip)

    broadcastThemeUpdate(theme, id)

    return theme
  }

  async scheduleTheme(id, scheduledAt, adminId, ip) {
    const scheduledDate = new Date(scheduledAt)
    const delay = Math.max(0, scheduledDate.getTime() - Date.now())

    const theme = await repo.update(id, { status: 'scheduled', scheduled_at: scheduledAt })
    if (!theme) return null

    try {
      const existingJob = await themeQueue.getJob(`theme-schedule-${id}`)
      if (existingJob) await existingJob.remove()
    } catch {}

    await themeQueue.add(
      'scheduled-activation',
      { type: 'scheduled-activation', themeId: id },
      {
        jobId: `theme-schedule-${id}`,
        delay,
        removeOnComplete: true,
      }
    )

    logAdminActivity(adminId, 'SCHEDULE_THEME', 'theme', id, null, null, ip)
    await invalidateThemeCaches()
    return theme
  }

  async cancelSchedule(id, adminId, ip) {
    const theme = await repo.update(id, { status: 'draft', scheduled_at: null })
    if (!theme) return null

    try {
      const job = await themeQueue.getJob(`theme-schedule-${id}`)
      if (job) await job.remove()
    } catch {
      // Job might not exist — safe to ignore
    }

    logAdminActivity(adminId, 'CANCEL_SCHEDULE_THEME', 'theme', id, null, null, ip)
    await invalidateThemeCaches()
    return theme
  }

  async getVersions(id) {
    return repo.getVersions(id)
  }

  async rollbackToVersion(themeId, versionId, adminId, ip) {
    const theme = await repo.rollbackToVersion(themeId, versionId)
    if (theme) {
      await invalidateThemeCaches()
      logAdminActivity(adminId, 'ROLLBACK_THEME', 'theme', themeId, null, null, ip)
      broadcastThemeUpdate(theme, themeId)
    }
    return theme
  }

  async remove(id, adminId, ip) {
    const ok = await repo.remove(id)
    if (ok) {
      await invalidateThemeCaches()
      logAdminActivity(adminId, 'DELETE_THEME', 'theme', id, null, null, ip)
    }
    return ok
  }
}

function mergeThemeData(currentValue, nextValue) {
  if (Array.isArray(nextValue)) {
    return nextValue
  }

  if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
    const merged = { ...currentValue }
    for (const [key, value] of Object.entries(nextValue)) {
      merged[key] = mergeThemeData(currentValue[key], value)
    }
    return merged
  }

  return nextValue
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
