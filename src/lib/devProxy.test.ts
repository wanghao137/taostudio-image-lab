import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApiUrl, normalizeDevProxyConfig } from './devProxy'

describe('buildApiUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the same-origin proxy prefix when API proxy is enabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'images/edits', null, true)).toBe(
      '/api-proxy/images/edits',
    )
  })

  it('leaves API versioning to the proxy target when proxying', () => {
    expect(buildApiUrl('http://api.example.com', 'images/generations', null, true)).toBe(
      '/api-proxy/images/generations',
    )
  })

  it('uses a configured proxy prefix when one is available', () => {
    expect(
      buildApiUrl(
        'http://api.example.com/v1',
        'responses',
        {
          enabled: true,
          prefix: '/openai-proxy',
          target: 'http://api.example.com/v1',
          changeOrigin: true,
          secure: false,
        },
        true,
      ),
    ).toBe('/openai-proxy/responses')
  })

  it('supports an absolute configured proxy prefix', () => {
    const proxyConfig = normalizeDevProxyConfig({
      enabled: true,
      prefix: 'https://image-proxy.taostudioai.com/api-proxy/',
      target: 'https://api.example.com/v1',
    })

    expect(proxyConfig?.prefix).toBe('https://image-proxy.taostudioai.com/api-proxy')
    expect(buildApiUrl('https://api.example.com/v1', 'responses', proxyConfig, true)).toBe(
      'https://image-proxy.taostudioai.com/api-proxy/responses',
    )
  })

  it('uses the build-time proxy prefix when proxying in production', () => {
    vi.stubEnv('VITE_API_PROXY_PREFIX', 'https://image-proxy.taostudioai.com/api-proxy/')

    expect(buildApiUrl('https://api.example.com/v1', 'responses', null, true)).toBe(
      'https://image-proxy.taostudioai.com/api-proxy/responses',
    )
  })

  it('uses the configured API URL directly when API proxy is disabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'responses', null, false)).toBe(
      'http://api.example.com/v1/responses',
    )
  })
})
