import { afterEach, describe, expect, it, vi } from 'vitest'
// workers/api-proxy.js is a Cloudflare Worker module tested directly here.
import worker from './api-proxy.js'

function createWorkerRequest({
  method = 'GET',
  url = 'https://image-proxy.taostudioai.com/api-proxy/models',
  headers = {},
  body,
} = {}) {
  return new Request(url, {
    method,
    headers,
    ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
  })
}

function baseEnv(overrides = {}) {
  return {
    IMAGE_API_PROXY_TARGET: 'https://default.example.com/v1',
    ...overrides,
  }
}

function jsonResponseMock(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('workers api proxy auth', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes through without token auth when no token is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    const response = await worker.fetch(
      createWorkerRequest(),
      baseEnv(),
    )
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects requests without the token when one is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await worker.fetch(
      createWorkerRequest(),
      baseEnv({ IMAGE_API_PROXY_TOKEN: 'secret-token' }),
    )
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects requests with a wrong token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await worker.fetch(
      createWorkerRequest({ headers: { 'x-taostudio-proxy-token': 'wrong' } }),
      baseEnv({ IMAGE_API_PROXY_TOKEN: 'secret-token' }),
    )
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a same-length wrong token (XOR branch)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await worker.fetch(
      createWorkerRequest({ headers: { 'x-taostudio-proxy-token': 'secres-tokex' } }),
      baseEnv({ IMAGE_API_PROXY_TOKEN: 'secret-token' }),
    )
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects http targets even for allowlisted hosts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await worker.fetch(
      createWorkerRequest({ headers: { 'x-taostudio-api-base-url': 'http://default.example.com/v1' } }),
      baseEnv(),
    )
    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not let upstream responses override the CORS allowlist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'https://evil.example.com',
      },
    }))
    const response = await worker.fetch(
      createWorkerRequest({ headers: { origin: 'https://image.taostudioai.com' } }),
      baseEnv(),
    )
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://image.taostudioai.com')
  })

  it('allows localhost dev origins on any port', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    const response = await worker.fetch(
      createWorkerRequest({ headers: { origin: 'http://localhost:5173' } }),
      baseEnv(),
    )
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
  })

  it('accepts requests with the correct token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    const response = await worker.fetch(
      createWorkerRequest({ headers: { 'x-taostudio-proxy-token': 'secret-token' } }),
      baseEnv({ IMAGE_API_PROXY_TOKEN: 'secret-token' }),
    )
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never injects server credentials for unauthenticated callers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    await worker.fetch(
      createWorkerRequest({ method: 'POST', url: 'https://image-proxy.taostudioai.com/api-proxy/images/generations', body: '{}' }),
      baseEnv({ IMAGE_API_PROXY_AUTHORIZATION: 'Bearer owner-key' }),
    )
    const forwarded = fetchMock.mock.calls[0][1].headers
    expect(forwarded.get('authorization')).toBeNull()
  })

  it('injects server credentials only for token-authenticated callers', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    await worker.fetch(
      createWorkerRequest({
        method: 'POST',
        url: 'https://image-proxy.taostudioai.com/api-proxy/images/generations',
        headers: { 'x-taostudio-proxy-token': 'secret-token' },
        body: '{}',
      }),
      baseEnv({ IMAGE_API_PROXY_TOKEN: 'secret-token', IMAGE_API_PROXY_AUTHORIZATION: 'Bearer owner-key' }),
    )
    const forwarded = fetchMock.mock.calls[0][1].headers
    expect(forwarded.get('authorization')).toBe('Bearer owner-key')
  })

  it('forwards the caller-provided authorization header as-is', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    await worker.fetch(
      createWorkerRequest({ headers: { authorization: 'Bearer caller-key' } }),
      baseEnv(),
    )
    const forwarded = fetchMock.mock.calls[0][1].headers
    expect(forwarded.get('authorization')).toBe('Bearer caller-key')
  })
})

describe('workers api proxy CORS', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reflects an allowed origin only', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    const response = await worker.fetch(
      createWorkerRequest({ headers: { origin: 'https://image.taostudioai.com' } }),
      baseEnv(),
    )
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://image.taostudioai.com')
  })

  it('omits allow-origin for unknown origins', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    const response = await worker.fetch(
      createWorkerRequest({ headers: { origin: 'https://evil.example.com' } }),
      baseEnv(),
    )
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('honors extra allowed origins from env', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    const response = await worker.fetch(
      createWorkerRequest({ headers: { origin: 'https://staging.taostudioai.com' } }),
      baseEnv({ IMAGE_API_PROXY_ALLOWED_ORIGINS: 'https://staging.taostudioai.com' }),
    )
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://staging.taostudioai.com')
  })

  it('answers preflights without token auth and without upstream calls', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await worker.fetch(
      createWorkerRequest({ method: 'OPTIONS', headers: { origin: 'https://image.taostudioai.com' } }),
      baseEnv({ IMAGE_API_PROXY_TOKEN: 'secret-token' }),
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://image.taostudioai.com')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('workers api proxy targets', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects dynamic targets when public targets are disabled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await worker.fetch(
      createWorkerRequest({ headers: { 'x-taostudio-api-base-url': 'https://api.example.com/v1' } }),
      baseEnv(),
    )
    expect(response.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allows hosts on the allowed-hosts list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponseMock({ ok: true }))
    const response = await worker.fetch(
      createWorkerRequest({ headers: { 'x-taostudio-api-base-url': 'https://gateway.partner.com/v1' } }),
      baseEnv({ IMAGE_API_PROXY_ALLOWED_HOSTS: 'gateway.partner.com' }),
    )
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://gateway.partner.com/v1/models'),
      expect.objectContaining({ method: 'GET' }),
    )
  })
})
