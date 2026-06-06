import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { getYdnImageProfilePatch } from './ydnCompatibility'

describe('YDN compatibility', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('enables the API proxy for YDN when a same-origin proxy is available', () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')

    const patch = getYdnImageProfilePatch(createDefaultOpenAIProfile({
      baseUrl: 'https://www.ydn99.com/v1',
      apiMode: 'responses',
      model: 'gpt-4.1',
      timeout: 60,
      apiProxy: false,
      streamImages: true,
      streamPartialImages: 3,
      responseFormatB64Json: true,
    }))

    expect(patch).toMatchObject({
      baseUrl: 'https://www.ydn99.com',
      apiMode: 'images',
      model: 'gpt-image-2',
      timeout: 600,
      apiProxy: true,
      streamImages: false,
      streamPartialImages: 0,
      responseFormatB64Json: false,
    })
  })

  it('disables the API proxy for YDN when no same-origin proxy is available', () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'false')

    const patch = getYdnImageProfilePatch(createDefaultOpenAIProfile({
      baseUrl: 'https://www.ydn99.com',
      apiProxy: true,
    }))

    expect(patch).toMatchObject({
      apiProxy: false,
    })
  })
})
