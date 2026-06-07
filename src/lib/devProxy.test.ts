import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApiUrl } from './devProxy'

describe('buildApiUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the same-origin proxy prefix when API proxy is enabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'images/edits', null, true)).toBe(
      '/api-proxy?path=images%2Fedits',
    )
  })

  it('leaves API versioning to the proxy target when proxying', () => {
    expect(buildApiUrl('http://api.example.com', 'images/generations', null, true)).toBe(
      '/api-proxy?path=images%2Fgenerations',
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

  it('uses the production proxy prefix from Vite env when configured', () => {
    vi.stubEnv('VITE_API_PROXY_PREFIX', 'https://image-proxy.taostudioai.com/api-proxy')

    expect(buildApiUrl('https://www.ydn99.com', 'images/generations', null, true)).toBe(
      'https://image-proxy.taostudioai.com/api-proxy?path=images%2Fgenerations',
    )
  })

  it('uses the configured API URL directly when API proxy is disabled', () => {
    expect(buildApiUrl('http://api.example.com/v1', 'responses', null, false)).toBe(
      'http://api.example.com/v1/responses',
    )
  })
})
