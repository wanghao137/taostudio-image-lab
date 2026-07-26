// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLocalImageTaskApiConfig,
  controlImageBatch,
  createImageBatch,
  createImageTaskGeneration,
  listImageBatches,
  readLocalImageTaskApiConfig,
  saveLocalImageTaskApiConfig,
} from './imageTaskApi'

describe('Image Task API session configuration', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  it('normalizes and restores connection data from the current tab session', () => {
    const saved = saveLocalImageTaskApiConfig({
      baseUrl: ' http://127.0.0.1:9789/// ',
      token: ' session-token ',
    })

    expect(saved).toEqual({
      baseUrl: 'http://127.0.0.1:9789',
      token: 'session-token',
    })
    expect(readLocalImageTaskApiConfig()).toEqual(saved)
  })

  it('clears the runtime connection without persisting it to localStorage', () => {
    saveLocalImageTaskApiConfig({
      baseUrl: 'http://127.0.0.1:9789',
      token: 'session-token',
    })

    expect(window.localStorage.length).toBe(0)
    clearLocalImageTaskApiConfig()
    expect(readLocalImageTaskApiConfig()).toBeNull()
  })

  it('rejects unsupported URL schemes', () => {
    expect(() => saveLocalImageTaskApiConfig({
      baseUrl: 'file:///tmp/task-api',
      token: 'session-token',
    })).toThrow('must use HTTP or HTTPS')
  })
})

describe('Image Task API generation defaults', () => {
  it('leaves baseSize unset so the engine applies its 2K default', () => {
    const generation = createImageTaskGeneration({
      provider: 'configured',
      model: 'gpt-image-2',
      apiMode: 'images',
    })

    expect(generation).toEqual({
      provider: 'configured',
      model: 'gpt-image-2',
      apiMode: 'images',
    })
    expect(generation).not.toHaveProperty('baseSize')
  })

  it('preserves an explicit provider-neutral fallback route', () => {
    expect(createImageTaskGeneration({
      provider: 'configured',
      model: 'gpt-image-2',
      apiMode: 'images',
      fallback: { provider: 'configured', model: 'gpt-5.6-sol', apiMode: 'responses' },
    })).toEqual({
      provider: 'configured',
      model: 'gpt-image-2',
      apiMode: 'images',
      fallback: { provider: 'configured', model: 'gpt-5.6-sol', apiMode: 'responses' },
    })
  })
})

describe('Image Task API batch controls', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the batch endpoints without changing the job contract', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      return new Response(JSON.stringify({ id: 'batch_test', items: [], stats: {} }), {
        status: url.endsWith('/image-batches') && init?.method === 'POST' ? 201 : 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const config = { baseUrl: 'http://127.0.0.1:9789', token: 'session-token' }
    const request = {
      idempotencyKey: 'batch-ui-test-001',
      items: [{
        itemKey: 'one',
        request: {
          contractVersion: '1' as const,
          idempotencyKey: 'batch-ui-job-001',
          input: { prompt: 'test prompt' },
          composition: { ratio: '1:1' },
          generation: { provider: 'configured', model: 'gpt-image-2', apiMode: 'images' as const },
          output: { ratioMode: 'inherit' as const, format: 'png' as const, quality: 'high' as const, enhancement: 'lanczos3' as const },
        },
      }],
    }
    await createImageBatch(config, request)
    await listImageBatches(config)
    await controlImageBatch(config, 'batch_test', 'retry-failed')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:9789/v1/image-batches')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(request)
    expect(String(fetchMock.mock.calls[2][0])).toBe('http://127.0.0.1:9789/v1/image-batches/batch_test/retry-failed')
  })
})
