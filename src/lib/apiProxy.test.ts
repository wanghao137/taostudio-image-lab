import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error api/proxy.js is a Vercel runtime module tested directly here.
import handler, { config } from '../../api/proxy.js'

function createRequest({
  method = 'GET',
  url = '/api/proxy?path=models',
  headers = {},
}: {
  method?: string
  url?: string
  headers?: Record<string, string>
}) {
  return {
    method,
    url,
    query: {},
    headers: {
      host: 'image.taostudioai.com',
      ...headers,
    },
    async *[Symbol.asyncIterator]() {},
  } as any
}

function createResponse() {
  const headers: Record<string, string> = {}
  return {
    statusCode: 200,
    headers,
    body: '',
    headersSent: false,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    end(value?: unknown) {
      this.headersSent = true
      this.body = value == null ? '' : String(value)
    },
    destroy(error?: unknown) {
      throw error instanceof Error ? error : new Error(String(error))
    },
  } as any
}

describe('api proxy dynamic targets', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('allows public HTTPS dynamic targets when enabled', async () => {
    vi.stubEnv('IMAGE_API_PROXY_TARGET', 'https://default.example.com/v1')
    vi.stubEnv('IMAGE_API_PROXY_ALLOW_PUBLIC_TARGETS', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const response = createResponse()
    await handler(createRequest({
      headers: {
        'x-taostudio-api-base-url': 'https://api.example.com/v1',
      },
    }), response)

    expect(response.statusCode).toBe(200)
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://api.example.com/v1/models'),
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('keeps the Vercel fallback proxy within the Hobby function limit', () => {
    expect(config.maxDuration).toBeLessThanOrEqual(300)
  })

  it('rejects local dynamic targets even when public dynamic targets are enabled', async () => {
    vi.stubEnv('IMAGE_API_PROXY_TARGET', 'https://default.example.com/v1')
    vi.stubEnv('IMAGE_API_PROXY_ALLOW_PUBLIC_TARGETS', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = createResponse()
    await handler(createRequest({
      headers: {
        'x-taostudio-api-base-url': 'http://127.0.0.1:7892',
      },
    }), response)

    expect(response.statusCode).toBe(403)
    expect(JSON.parse(response.body).error.message).toContain('local or private')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
