import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildApiUrl,
  normalizeApiProxyTargetUrl,
  normalizeDevProxyConfig,
  resolveDevProxyTarget,
} from './devProxy'

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
          allowBrowserTarget: true,
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

describe('normalizeApiProxyTargetUrl', () => {
  it('normalizes a root API host into an OpenAI-compatible /v1 proxy target', () => {
    expect(normalizeApiProxyTargetUrl('http://127.0.0.1:8317')).toBe('http://127.0.0.1:8317/v1')
  })

  it('preserves an existing /v1 proxy target and removes extra path after it', () => {
    expect(normalizeApiProxyTargetUrl('https://api.example.com/openai/v1/images/generations')).toBe(
      'https://api.example.com/openai/v1',
    )
  })

  it('appends /v1 after custom base paths', () => {
    expect(normalizeApiProxyTargetUrl('https://gateway.example.com/openai')).toBe(
      'https://gateway.example.com/openai/v1',
    )
  })

  it('rejects invalid proxy targets', () => {
    expect(normalizeApiProxyTargetUrl('http://')).toBe('')
  })
})

describe('resolveDevProxyTarget', () => {
  it('uses the browser-selected API URL header when local proxy dynamic targets are allowed', () => {
    expect(resolveDevProxyTarget('http://127.0.0.1:8317', 'https://fallback.example.com/v1')).toBe(
      'http://127.0.0.1:8317/v1',
    )
  })

  it('falls back to the configured target when the browser-selected target is invalid', () => {
    expect(resolveDevProxyTarget('http://', 'https://fallback.example.com')).toBe(
      'https://fallback.example.com/v1',
    )
  })

  it('normalizes the static dev proxy target the same way as dynamic targets', () => {
    const proxyConfig = normalizeDevProxyConfig({
      enabled: true,
      prefix: '/api-proxy',
      target: 'http://127.0.0.1:8317',
    })

    expect(proxyConfig?.target).toBe('http://127.0.0.1:8317/v1')
    expect(proxyConfig?.allowBrowserTarget).toBe(true)
  })

  it('keeps static-only dev proxy mode available for locked local setups', () => {
    const proxyConfig = normalizeDevProxyConfig({
      enabled: true,
      prefix: '/api-proxy',
      target: 'https://fallback.example.com/v1',
      allowBrowserTarget: false,
    })

    expect(proxyConfig?.allowBrowserTarget).toBe(false)
  })
})
