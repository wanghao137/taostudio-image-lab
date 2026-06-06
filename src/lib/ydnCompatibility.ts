import type { ApiProfile } from '../types'
import { isApiProxyAvailable, normalizeBaseUrl } from './devProxy'

export const YDN_API_BASE_URL = 'https://www.ydn99.com'
export const YDN_IMAGE_MODEL = 'gpt-image-2'
export const YDN_IMAGE_TIMEOUT_SECONDS = 600

export function isYdnApiUrl(value: string | undefined) {
  const input = (value ?? '').trim()
  if (!input) return false

  try {
    const url = new URL(normalizeBaseUrl(input))
    return url.hostname.replace(/^www\./i, '').toLowerCase() === 'ydn99.com'
  } catch {
    return /(^|\/\/)(www\.)?ydn99\.com/i.test(input)
  }
}

export function getYdnImageProfilePatch(profile: Pick<ApiProfile, 'provider' | 'baseUrl' | 'apiMode' | 'model' | 'timeout' | 'apiProxy' | 'streamImages' | 'streamPartialImages' | 'responseFormatB64Json'>): Partial<ApiProfile> | null {
  if (profile.provider !== 'openai' || !isYdnApiUrl(profile.baseUrl)) return null

  const patch: Partial<ApiProfile> = {}
  if (normalizeBaseUrl(profile.baseUrl) !== YDN_API_BASE_URL) patch.baseUrl = YDN_API_BASE_URL
  if (profile.apiMode !== 'images') patch.apiMode = 'images'
  if (profile.model.trim() !== YDN_IMAGE_MODEL) patch.model = YDN_IMAGE_MODEL
  if (profile.timeout !== YDN_IMAGE_TIMEOUT_SECONDS) patch.timeout = YDN_IMAGE_TIMEOUT_SECONDS
  if (isApiProxyAvailable()) {
    if (!profile.apiProxy) patch.apiProxy = true
  } else if (profile.apiProxy) {
    patch.apiProxy = false
  }
  if (profile.streamImages) patch.streamImages = false
  if ((profile.streamPartialImages ?? 0) !== 0) patch.streamPartialImages = 0
  if (profile.responseFormatB64Json) patch.responseFormatB64Json = false

  return Object.keys(patch).length ? patch : null
}

export function getYdnRecommendedImageProfilePatch(profile: Parameters<typeof getYdnImageProfilePatch>[0] & Pick<ApiProfile, 'codexCli'>): Partial<ApiProfile> | null {
  const patch = getYdnImageProfilePatch(profile) ?? {}
  if (!profile.codexCli) patch.codexCli = true
  return Object.keys(patch).length ? patch : null
}
