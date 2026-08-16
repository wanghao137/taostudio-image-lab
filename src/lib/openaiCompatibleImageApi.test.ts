// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callImageApi } from './api'
import { ApiError, isApiError, isRetryableHttpStatus, parseRetryAfterMs, withTransientRetry, transientRetrySleep } from './imageApiShared'
import { DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { DEFAULT_PARAMS } from '../types'

// 核心直测：api.test.ts 覆盖 happy path / 流式 / 并发 / 拒绝重写；
// 这里补齐 P0 文件的关键行为——瞬态重试分类、Retry-After 解析、
// 结构化 ApiError、以及不重试的确定性别错误。

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

const baseSettings = normalizeSettings({
  ...DEFAULT_SETTINGS,
  apiKey: 'test-key',
})

describe('ApiError structure', () => {
  it('carries status, retryable, and stage', () => {
    const err = new ApiError({ message: 'test', status: 502, stage: 'request' })
    expect(isApiError(err)).toBe(true)
    expect(err.status).toBe(502)
    expect(err.retryable).toBe(true)
    expect(err.stage).toBe('request')
  })

  it('is distinguishable from plain Error', () => {
    expect(isApiError(new Error('plain'))).toBe(false)
  })
})

describe('isRetryableHttpStatus', () => {
  it('retries 408, 429, and 5xx', () => {
    expect(isRetryableHttpStatus(408)).toBe(true)
    expect(isRetryableHttpStatus(429)).toBe(true)
    expect(isRetryableHttpStatus(500)).toBe(true)
    expect(isRetryableHttpStatus(502)).toBe(true)
    expect(isRetryableHttpStatus(503)).toBe(true)
  })

  it('does not retry 400, 401, 403, 404, 422', () => {
    expect(isRetryableHttpStatus(400)).toBe(false)
    expect(isRetryableHttpStatus(401)).toBe(false)
    expect(isRetryableHttpStatus(403)).toBe(false)
    expect(isRetryableHttpStatus(404)).toBe(false)
    expect(isRetryableHttpStatus(422)).toBe(false)
  })

  it('does not retry undefined', () => {
    expect(isRetryableHttpStatus(undefined)).toBe(false)
  })
})

describe('parseRetryAfterMs', () => {
  it('parses seconds format', () => {
    const response = new Response(null, { headers: { 'Retry-After': '2' } })
    expect(parseRetryAfterMs(response)).toBe(2000)
  })

  it('parses HTTP date format', () => {
    const future = new Date(Date.now() + 5000).toUTCString()
    const response = new Response(null, { headers: { 'Retry-After': future } })
    const ms = parseRetryAfterMs(response)
    expect(ms).toBeGreaterThan(3000)
    expect(ms).toBeLessThanOrEqual(5000)
  })

  it('returns undefined for missing header', () => {
    expect(parseRetryAfterMs(new Response())).toBeUndefined()
  })
})

describe('withTransientRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries retryable ApiError and succeeds', async () => {
    let calls = 0
    const result = await withTransientRetry(async () => {
      calls += 1
      if (calls === 1) throw new ApiError({ message: 'gateway down', status: 502 })
      return 'ok'
    }, { sleepFn: async () => {} })
    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })

  it('does not retry non-retryable ApiError', async () => {
    let calls = 0
    await expect(withTransientRetry(async () => {
      calls += 1
      throw new ApiError({ message: 'unauthorized', status: 401 })
    }, { sleepFn: async () => {} })).rejects.toThrow('unauthorized')
    expect(calls).toBe(1)
  })

  it('gives up after maxRetries', async () => {
    let calls = 0
    await expect(withTransientRetry(async () => {
      calls += 1
      throw new ApiError({ message: 'still down', status: 503 })
    }, { sleepFn: async () => {} })).rejects.toThrow('still down')
    // 1 original + 2 retries = 3
    expect(calls).toBe(3)
  })

  it('does not retry AbortError', async () => {
    let calls = 0
    const abort = new DOMException('Aborted', 'AbortError')
    await expect(withTransientRetry(async () => {
      calls += 1
      throw abort
    }, { sleepFn: async () => {} })).rejects.toBe(abort)
    expect(calls).toBe(1)
  })
})

describe('transientRetrySleep', () => {
  it('resolves after the delay', async () => {
    const start = Date.now()
    await transientRetrySleep(10)
    expect(Date.now() - start).toBeGreaterThanOrEqual(5)
  })
})

describe('end-to-end via callImageApi — retry classification', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries a 429 with Retry-After and succeeds', async () => {
    let callCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) {
        return jsonResponse({ error: { message: 'rate limited' } }, 429, { 'Retry-After': '0.01' })
      }
      return jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] })
    })

    const result = await callImageApi({
      settings: baseSettings,
      prompt: 'test',
      params: { ...DEFAULT_PARAMS, n: 1 },
      inputImageDataUrls: [],
    })

    expect(result.images).toHaveLength(1)
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  it('does not retry a 400 bad request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ error: { message: 'invalid model' } }, 400))

    await expect(callImageApi({
      settings: baseSettings,
      prompt: 'test',
      params: { ...DEFAULT_PARAMS, n: 1 },
      inputImageDataUrls: [],
    })).rejects.toThrow('invalid model')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 401 auth failure', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ error: { message: 'bad key' } }, 401))

    await expect(callImageApi({
      settings: baseSettings,
      prompt: 'test',
      params: { ...DEFAULT_PARAMS, n: 1 },
      inputImageDataUrls: [],
    })).rejects.toThrow('bad key')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
