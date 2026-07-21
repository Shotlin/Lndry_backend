export const ACTIVE_THEME_CACHE_KEY = 'lndry:active_theme'
export const LEGACY_TAB_CACHE_KEY = 'lndry:tab_themes'
export const ADMIN_TAB_THEMES_CACHE_PREFIX = 'lndry:admin_theme_tabs'
export const SECTION_CACHE_PREFIX = 'lndry:sections'
export const SECTION_PUBLIC_CACHE_PREFIX = 'lndry:sections:public'
export const TAB_MANIFEST_CACHE_PREFIX = 'lndry:tab_manifest'
export const TAB_HOME_CACHE_PREFIX = 'lndry:tab_home'

export function getAdminTabThemesCacheKey(storeKey = 'all', status = 'all') {
  return `${ADMIN_TAB_THEMES_CACHE_PREFIX}:${storeKey}:${status}`
}

export function getTabManifestCacheKey(storeKey = 'zepto') {
  return `${TAB_MANIFEST_CACHE_PREFIX}:${storeKey}`
}

export function getSectionCacheKey(tabId) {
  return `${SECTION_CACHE_PREFIX}:${tabId}`
}

export function getSectionPublicCacheKey(storeKey = 'zepto', tabKey = 'all') {
  return `${SECTION_PUBLIC_CACHE_PREFIX}:${storeKey}:${tabKey}`
}

export function getTabHomeCacheKey(storeKey = 'zepto', key = 'all') {
  return `${TAB_HOME_CACHE_PREFIX}:${storeKey}:${key}`
}
