import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_SETTINGS } from './apiProfiles'
import { callImageApi } from './api'

const TEST_IMAGE_DATA_URL = 'data:image/png;base64,aW1hZ2U='
const TEST_MASK_DATA_URL = 'data:image/png;base64,bWFzaw=='

function createDataUrlBlobResponse(type = 'image/png') {
  return new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { 'Content-Type': type },
  })
}

function createOpenAISettings(overrides: Partial<typeof DEFAULT_SETTINGS> = {}) {
  return {
    ...DEFAULT_SETTINGS,
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/v1',
    profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
      ...profile,
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
    })),
    ...overrides,
  }
}

function installImageToPngTestStubs() {
  class TestImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 1
    naturalHeight = 1

    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }

  vi.stubGlobal('Image', TestImage)
  vi.stubGlobal('document', {
    createElement: (tagName: string) => {
      if (tagName !== 'canvas') throw new Error(`Unsupported test element: ${tagName}`)
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => undefined,
        }),
        toBlob: (callback: (blob: Blob | null) => void, type?: string) => {
          callback(new Blob([new Uint8Array([1, 2, 3])], { type: type || 'image/png' }))
        },
      }
    },
  })
}

describe('callImageApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each([false, true])(
    'adds the prompt rewrite guard on Responses API when Codex CLI mode is %s',
    async (codexCli) => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'aW1hZ2U=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

      await callImageApi({
        settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', apiMode: 'responses', codexCli },
        prompt: 'prompt',
        params: { ...DEFAULT_PARAMS },
        inputImageDataUrls: [],
      })

      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(String((init as RequestInit).body))
      expect(body.input).toBe('Use the following text as the complete prompt. Do not rewrite it:\nprompt')
    },
  )

  it('records actual params returned on Images API responses in Codex CLI mode', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output_format: 'png',
      quality: 'medium',
      size: '1033x1522',
      data: [{
        b64_json: 'aW1hZ2U=',
        revised_prompt: '移除靴子',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.actualParams).toEqual({
      output_format: 'png',
      quality: 'medium',
      size: '1033x1522',
    })
    expect(result.actualParamsList).toEqual([{
      output_format: 'png',
      quality: 'medium',
      size: '1033x1522',
    }])
    expect(result.revisedPrompts).toEqual(['移除靴子'])
  })

  it('does not synthesize actual quality in Codex CLI mode when the API omits it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output_format: 'png',
      size: '1033x1522',
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', codexCli: true },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(result.actualParams).toEqual({
      output_format: 'png',
      size: '1033x1522',
    })
    expect(result.actualParams?.quality).toBeUndefined()
    expect(result.actualParamsList).toEqual([{
      output_format: 'png',
      size: '1033x1522',
    }])
  })

  it('streams Images API partial images and resolves the final completed image', async () => {
    const streamBody = [
      'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}',
      '',
      'data: {"type":"image_generation.completed","b64_json":"ZmluYWw=","size":"1024x1024","quality":"high","output_format":"png"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const partialImages: string[] = []

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        streamPartialImages: 3,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
          streamPartialImages: 3,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onPartialImage: (partial: { image: string }) => partialImages.push(partial.image),
    } as any)

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body).toMatchObject({
      stream: true,
      partial_images: 3,
    })
    expect(partialImages).toEqual(['data:image/png;base64,cGFydGlhbA=='])
    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: {
        output_format: 'png',
        quality: 'high',
        size: '1024x1024',
      },
      actualParamsList: [{
        output_format: 'png',
        quality: 'high',
        size: '1024x1024',
      }],
    })
  })

  it('does not expect revised prompts on official Images API stream completed events', async () => {
    const streamBody = [
      'data: {"created_at":1779112721,"type":"image_generation.completed","b64_json":"ZmluYWw=","background":"opaque","output_format":"jpeg","quality":"medium","sequence_number":0,"size":"1448x1086","usage":{"total_tokens":1569}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)

    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: {
        output_format: 'jpeg',
        quality: 'medium',
        size: '1448x1086',
      },
      revisedPrompts: [undefined],
    })
  })

  it('parses Images API stream result events with data b64_json', async () => {
    const streamBody = [
      'data: {"object":"image.generation.chunk","created":1779551054,"model":"gpt-image-2"}',
      '',
      'data: {"object":"image.generation.result","created":1779551140,"model":"gpt-image-2","data":[{"b64_json":"ZmluYWw=","revised_prompt":"rewritten"}],"size":"1024x1536","quality":"medium","output_format":"png"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)

    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: {
        output_format: 'png',
        quality: 'medium',
        size: '1024x1536',
      },
      actualParamsList: [{
        output_format: 'png',
        quality: 'medium',
        size: '1024x1536',
      }],
      revisedPrompts: ['rewritten'],
    })
  })

  it('splits Images API streaming into concurrent single-image requests when n is greater than 1', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const streamBody = [
        'data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"cGFydGlhbA=="}',
        '',
        'data: {"type":"image_generation.completed","b64_json":"ZmluYWw=","size":"1024x1024","quality":"high","output_format":"png"}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')
      return new Response(streamBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    const partials: Array<{ image: string; requestIndex?: number }> = []

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        streamImages: true,
        streamPartialImages: 1,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          streamImages: true,
          streamPartialImages: 1,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, n: 2 },
      inputImageDataUrls: [],
      onPartialImage: (partial: { image: string; requestIndex?: number }) => partials.push(partial),
    } as any)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String((init as RequestInit).body))
      expect(body.n).toBeUndefined()
      expect(body.stream).toBe(true)
      expect(body.partial_images).toBe(1)
    }
    expect(result.images).toHaveLength(2)
    expect(result.images).toEqual([
      'data:image/png;base64,ZmluYWw=',
      'data:image/png;base64,ZmluYWw=',
    ])
    expect(partials.map((partial) => partial.requestIndex).sort()).toEqual([0, 1])
    expect(partials.map((partial) => partial.image)).toEqual([
      'data:image/png;base64,cGFydGlhbA==',
      'data:image/png;base64,cGFydGlhbA==',
    ])
  })

  it('fills missing Images API outputs when the provider ignores native n', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        size: '1024x1024',
        output_format: 'jpeg',
        data: [{ b64_json: 'Zmlyc3Q=' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        size: '1024x1024',
        output_format: 'jpeg',
        data: [{ b64_json: 'c2Vjb25k' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        size: '1024x1024',
        output_format: 'jpeg',
        data: [{ b64_json: 'dGhpcmQ=' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        baseUrl: 'https://native-n.example.com/v1',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          baseUrl: 'https://native-n.example.com/v1',
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'jpeg', n: 3 },
      inputImageDataUrls: [],
    } as any)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).n).toBe(3)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).n).toBeUndefined()
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).n).toBeUndefined()
    expect(result.images).toEqual([
      'data:image/jpeg;base64,Zmlyc3Q=',
      'data:image/jpeg;base64,c2Vjb25k',
      'data:image/jpeg;base64,dGhpcmQ=',
    ])
    expect(result.actualParams).toEqual({
      size: '1024x1024',
      output_format: 'jpeg',
      n: 3,
    })
    expect(result.actualParamsList).toEqual([
      { size: '1024x1024', output_format: 'jpeg' },
      { size: '1024x1024', output_format: 'jpeg' },
      { size: '1024x1024', output_format: 'jpeg' },
    ])
  })

  it('learns Responses fallback before launching remaining concurrent Images API requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'failed to parse multipart form' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'failed to parse multipart form' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'Zmlyc3Q=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'c2Vjb25k',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'dGhpcmQ=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        baseUrl: 'https://concurrent-fallback.example.com/v1',
        responseFormatB64Json: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          baseUrl: 'https://concurrent-fallback.example.com/v1',
          responseFormatB64Json: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, n: 3, size: '2160x3840' },
      inputImageDataUrls: [],
    } as any)

    expect(result.images).toEqual([
      'data:image/png;base64,Zmlyc3Q=',
      'data:image/png;base64,c2Vjb25k',
      'data:image/png;base64,dGhpcmQ=',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://concurrent-fallback.example.com/v1/images/generations',
      'https://concurrent-fallback.example.com/v1/images/generations',
      'https://concurrent-fallback.example.com/v1/responses',
      'https://concurrent-fallback.example.com/v1/responses',
      'https://concurrent-fallback.example.com/v1/responses',
    ])
  })

  it('streams Responses API partial images and resolves the completed response image', async () => {
    const streamBody = [
      'data: {"type":"response.image_generation_call.partial_image","partial_image_index":0,"partial_image_b64":"cGFydGlhbA=="}',
      '',
      'data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","result":"ZmluYWw=","revised_prompt":"rewritten","size":"1024x1024"}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const partialImages: string[] = []

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        streamImages: true,
        streamPartialImages: 1,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          apiMode: 'responses',
          streamImages: true,
          streamPartialImages: 1,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onPartialImage: (partial: { image: string }) => partialImages.push(partial.image),
    } as any)

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.stream).toBe(true)
    expect(body.tools[0].partial_images).toBe(1)
    expect(partialImages).toEqual(['data:image/png;base64,cGFydGlhbA=='])
    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: { size: '1024x1024' },
      actualParamsList: [{ size: '1024x1024' }],
      revisedPrompts: ['rewritten'],
    })
  })

  it('parses Responses API image result objects in gallery mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        result: { b64_json: 'ZmluYWw=' },
        size: '1024x1024',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    const result = await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', apiMode: 'responses' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: { size: '1024x1024' },
      actualParamsList: [{ size: '1024x1024' }],
    })
  })

  it('recovers Responses API image generation after two transient 502 responses', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'openai_error' } }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'openai_error' } }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'aW1hZ2U=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        baseUrl: 'https://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,aW1hZ2U='],
    }))
  })

  it('keeps Responses API stream output item images when completed response omits result', async () => {
    const streamBody = [
      'data: {"type":"response.output_item.done","item":{"id":"img-call-1","type":"image_generation_call","status":"generating","action":"generate","result":"ZmluYWw=","size":"1024x1024"},"output_index":0}',
      '',
      'data: {"type":"response.completed","response":{"output":[{"type":"image_generation_call","status":"completed","result":""}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const result = await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        streamImages: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          apiMode: 'responses',
          streamImages: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    } as any)

    expect(result).toMatchObject({
      images: ['data:image/png;base64,ZmluYWw='],
      actualParams: { size: '1024x1024' },
      actualParamsList: [{ size: '1024x1024' }],
    })
  })

  it('uses the same-origin API proxy path when API proxy is enabled', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: 'http://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-proxy/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('passes the configured API URL to the same-origin API proxy as a target header', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: 'https://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const [url, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(url).toBe('/api-proxy/images/generations')
    expect(headers['x-taostudio-api-base-url']).toBe('https://api.example.com/v1')
    expect(headers['x-taostudio-api-base-url']).not.toContain('test-key')
  })

  it('uses the same-origin API proxy path when API proxy is enabled and base URL is empty', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: '',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-proxy/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('uses the same-origin API proxy path for sync custom providers', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: '',
        apiKey: 'test-key',
        apiProxy: true,
        customProviders: [{
          id: 'custom-sync',
          name: 'Custom Sync',
          template: 'http-image',
          submit: {
            path: 'custom/images',
            method: 'POST',
            contentType: 'json',
            body: { model: '$profile.model', prompt: '$prompt' },
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'profile-custom-sync',
          provider: 'custom-sync',
          baseUrl: '',
          apiKey: 'test-key',
          model: 'model',
          apiProxy: true,
        }],
        activeProfileId: 'profile-custom-sync',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-proxy/custom/images',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects API proxy for async custom providers', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: '',
        apiKey: 'test-key',
        apiProxy: true,
        customProviders: [{
          id: 'custom-async-proxy',
          name: 'Custom Async Proxy',
          template: 'http-image',
          submit: {
            path: 'images/generations',
            method: 'POST',
            contentType: 'json',
            body: { model: '$profile.model', prompt: '$prompt' },
            taskIdPath: 'task_id',
          },
          poll: {
            path: 'images/tasks/{task_id}',
            method: 'GET',
            intervalSeconds: 1,
            statusPath: 'status',
            successValues: ['done'],
            failureValues: ['failed'],
            result: { b64JsonPaths: ['data.*.b64_json'] },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'profile-custom-async-proxy',
          provider: 'custom-async-proxy',
          baseUrl: '',
          apiKey: 'test-key',
          model: 'model',
          apiProxy: true,
        }],
        activeProfileId: 'profile-custom-async-proxy',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })).rejects.toThrow('异步任务的自定义服务商')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the same-origin API proxy path when API proxy is locked', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    vi.stubEnv('VITE_API_PROXY_LOCKED', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: false,
        baseUrl: 'http://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api-proxy/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('does not pass the configured API URL as a dynamic proxy target when API proxy is locked', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    vi.stubEnv('VITE_API_PROXY_LOCKED', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        result: 'aW1hZ2U=',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        apiProxy: false,
        baseUrl: 'http://127.0.0.1:7892',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      inputImageDataUrls: [],
    })

    const [url, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(url).toBe('/api-proxy/responses')
    expect(headers['x-taostudio-api-base-url']).toBeUndefined()
  })

  it('does not force the API proxy for long 4K Images API requests when proxy is available', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: false,
        baseUrl: 'https://api.example.com/v1',
      },
      prompt: '清甜小馆品牌视觉提案。'.repeat(180),
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      inputImageDataUrls: [],
    })

    const [url, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(url).toBe('https://api.example.com/v1/images/generations')
    expect(headers['x-taostudio-api-base-url']).toBeUndefined()
  })

  it('does not add cache request headers that require extra CORS allow-list entries', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers).not.toHaveProperty('Pragma')
    expect(headers).not.toHaveProperty('Cache-Control')
    expect((init as RequestInit).cache).toBe('no-store')
  })

  it('ignores stored API proxy settings when the current deployment has no proxy', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'false')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: 'http://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.example.com/v1/images/generations',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('tries the same-origin API proxy after direct network failures even when proxy availability was not embedded', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'false')
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: 'aW1hZ2U=' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: false,
        baseUrl: 'https://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      inputImageDataUrls: [],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,aW1hZ2U='],
    }))
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[2][0]).toBe('/api-proxy/images/generations')
    const headers = fetchMock.mock.calls[2][1]?.headers as Record<string, string>
    expect(headers['x-taostudio-api-base-url']).toBe('https://api.example.com/v1')
  })

  it('does not optimistically proxy long browser requests when proxy availability was not embedded', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'false')
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        origin: 'https://image.taostudioai.com',
      },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: 'aW1hZ2U=' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: false,
        baseUrl: 'https://api.example.com/v1',
      },
      prompt: 'brand proposal '.repeat(180),
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      inputImageDataUrls: [],
    })

    const [url, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(url).toBe('https://api.example.com/v1/images/generations')
    expect(headers['x-taostudio-api-base-url']).toBeUndefined()
  })

  it('falls back to direct fetch when an enabled proxy returns gateway timeout', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'gateway timeout' } }), {
        status: 524,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'gateway timeout' } }), {
        status: 524,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: 'aW1hZ2U=' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: true,
        baseUrl: 'https://api.example.com/v1',
      },
      prompt: 'brand proposal '.repeat(180),
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      inputImageDataUrls: [],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,aW1hZ2U='],
    }))

    expect(fetchMock.mock.calls[0][0]).toBe('/api-proxy/images/generations')
    expect(fetchMock.mock.calls[1][0]).toBe('/api-proxy/images/generations')
    expect(fetchMock.mock.calls[2][0]).toBe('https://api.example.com/v1/images/generations')
    const directHeaders = fetchMock.mock.calls[2][1]?.headers as Record<string, string>
    expect(directHeaders['x-taostudio-api-base-url']).toBeUndefined()
  })

  it('falls back to Responses edit when Images edits returns retryable errors', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('data:')) return createDataUrlBlobResponse()
      if (url.endsWith('/images/edits')) {
        return new Response(JSON.stringify({ error: { message: 'openai_error' } }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/responses')) {
        return new Response(JSON.stringify({
          output: [{
            type: 'image_generation_call',
            result: 'ZWRpdA==',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404 })
    })

    const promise = callImageApi({
      settings: createOpenAISettings(),
      prompt: 'edit prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      inputImageDataUrls: [TEST_IMAGE_DATA_URL],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,ZWRpdA=='],
    }))
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      TEST_IMAGE_DATA_URL,
      'https://api.example.com/v1/images/edits',
      'https://api.example.com/v1/images/edits',
      'https://api.example.com/v1/responses',
    ])
    const responsesBody = JSON.parse(String(fetchMock.mock.calls[3][1]?.body))
    expect(responsesBody.tools[0]).toMatchObject({
      type: 'image_generation',
      action: 'edit',
      size: '1024x1024',
    })
    expect(responsesBody.tools[0].input_image_mask).toBeUndefined()
    expect(responsesBody.input[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'input_image', image_url: TEST_IMAGE_DATA_URL }),
    ]))
  })

  it('preserves the mask when falling back from Images edits to Responses edit', async () => {
    vi.useFakeTimers()
    installImageToPngTestStubs()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.startsWith('data:')) return createDataUrlBlobResponse()
      if (url.endsWith('/images/edits')) {
        return new Response(JSON.stringify({ error: { message: 'openai_error' } }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/responses')) {
        return new Response(JSON.stringify({
          output: [{
            type: 'image_generation_call',
            result: 'bWFza2Vk',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 404 })
    })

    const promise = callImageApi({
      settings: createOpenAISettings(),
      prompt: 'masked edit prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      inputImageDataUrls: [TEST_IMAGE_DATA_URL],
      maskDataUrl: TEST_MASK_DATA_URL,
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,bWFza2Vk'],
    }))
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      TEST_MASK_DATA_URL,
      'https://api.example.com/v1/images/edits',
      'https://api.example.com/v1/images/edits',
      'https://api.example.com/v1/responses',
    ])
    const responsesBody = JSON.parse(String(fetchMock.mock.calls[3][1]?.body))
    expect(responsesBody.tools[0]).toMatchObject({
      type: 'image_generation',
      action: 'edit',
      input_image_mask: {
        image_url: TEST_MASK_DATA_URL,
      },
    })
    expect(responsesBody.input[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'input_image', image_url: TEST_IMAGE_DATA_URL }),
    ]))
  })

  it('retries transient Images API network failures before returning the generated image', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: 'aW1hZ2U=' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,aW1hZ2U='],
    }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to the same-origin API proxy after retryable direct Images API network failures', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: 'aW1hZ2U=' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiProxy: false,
        baseUrl: 'https://api.example.com/v1',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      inputImageDataUrls: [],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,aW1hZ2U='],
    }))
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[2][0]).toBe('/api-proxy/images/generations')
  })

  it('falls back to Images API generation without b64_json response_format when the provider rejects JSON as multipart', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'failed to parse multipart form' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: 'aW1hZ2U=' }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        baseUrl: 'https://api.example.com/v1',
        responseFormatB64Json: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          baseUrl: 'https://api.example.com/v1',
          responseFormatB64Json: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      inputImageDataUrls: [],
    } as any)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,aW1hZ2U='],
    }))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).response_format).toBe('b64_json')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).response_format).toBeUndefined()
  })

  it('falls back to Responses API when Images API JSON generation keeps failing with multipart compatibility errors', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'failed to parse multipart form' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'failed to parse multipart form' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'aW1hZ2U=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        baseUrl: 'https://fallback.example.com/v1',
        responseFormatB64Json: true,
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
          ...profile,
          apiKey: 'test-key',
          baseUrl: 'https://fallback.example.com/v1',
          responseFormatB64Json: true,
        })),
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      inputImageDataUrls: [],
    } as any)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await expect(promise).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,aW1hZ2U='],
    }))
    expect(fetchMock.mock.calls[0][0]).toBe('https://fallback.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[1][0]).toBe('https://fallback.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[2][0]).toBe('https://fallback.example.com/v1/responses')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).response_format).toBe('b64_json')
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).response_format).toBeUndefined()
    const responsesBody = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(responsesBody.tools[0].type).toBe('image_generation')
    expect(responsesBody.tools[0].size).toBe('1024x1024')
  })

  it('reuses a successful Responses fallback for the same Images API provider in the current session', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'failed to parse multipart form' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'failed to parse multipart form' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'Zmlyc3Q=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          result: 'c2Vjb25k',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const settings = {
      ...DEFAULT_SETTINGS,
      apiKey: 'test-key',
      baseUrl: 'https://session-cache.example.com/v1',
      responseFormatB64Json: true,
      profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({
        ...profile,
        apiKey: 'test-key',
        baseUrl: 'https://session-cache.example.com/v1',
        responseFormatB64Json: true,
      })),
    }

    const first = callImageApi({
      settings,
      prompt: 'first prompt',
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      inputImageDataUrls: [],
    } as any)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await expect(first).resolves.toEqual(expect.objectContaining({
      images: ['data:image/png;base64,Zmlyc3Q='],
    }))

    const second = await callImageApi({
      settings,
      prompt: 'second prompt',
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      inputImageDataUrls: [],
    } as any)

    expect(second.images).toEqual(['data:image/png;base64,c2Vjb25k'])
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[0][0]).toBe('https://session-cache.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[1][0]).toBe('https://session-cache.example.com/v1/images/generations')
    expect(fetchMock.mock.calls[2][0]).toBe('https://session-cache.example.com/v1/responses')
    expect(fetchMock.mock.calls[3][0]).toBe('https://session-cache.example.com/v1/responses')
  })

  it('adds redacted request diagnostics when a retryable Images API response still fails', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'gateway timeout' } }), {
        status: 524,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'gateway timeout' } }), {
        status: 524,
        headers: { 'Content-Type': 'application/json' },
      }))

    const errorPromise: Promise<Error & { apiDiagnostics?: unknown }> = callImageApi({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key', baseUrl: 'https://api.example.com/v1' },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }).then(() => {
      throw new Error('Expected callImageApi to reject')
    }).catch((err) => err as Error & { apiDiagnostics?: unknown })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)

    const error = await errorPromise
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('gateway timeout')
    expect(error.message).toContain('API request diagnostics')
    expect(error.message).toContain('"status":524')
    expect(error.message).not.toContain('test-key')
    expect(error.apiDiagnostics).toMatchObject({
      endpoint: 'images/generations',
      attempts: 2,
      status: 524,
      retryable: true,
    })
  })

  it('polls custom async tasks immediately and keeps polling after transient network errors', async () => {
    vi.useFakeTimers()
    const onCustomTaskEnqueued = vi.fn()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          status: 'SUCCESS',
          data: {
            data: [{ b64_json: 'aW1hZ2U=' }],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.example.com/v1',
        customProviders: [{
          id: 'custom-async',
          name: 'Custom Async',
          template: 'http-image',
          submit: {
            path: 'images/generations',
            method: 'POST',
            contentType: 'json',
            query: { async: 'true' },
            body: { model: '$profile.model', prompt: '$prompt' },
            taskIdPath: 'task_id',
          },
          poll: {
            path: 'images/tasks/{task_id}',
            method: 'GET',
            intervalSeconds: 1,
            statusPath: 'data.status',
            successValues: ['SUCCESS'],
            failureValues: ['FAILURE'],
            errorPath: 'data.fail_reason',
            result: {
              imageUrlPaths: ['data.data.data.*.url'],
              b64JsonPaths: ['data.data.data.*.b64_json'],
            },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'profile-custom',
          provider: 'custom-async',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
          timeout: 60,
        }],
        activeProfileId: 'profile-custom',
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
      onCustomTaskEnqueued,
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(onCustomTaskEnqueued).toHaveBeenCalledWith({ taskId: 'task-1' })
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/v1/images/tasks/task-1')
    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toEqual({
      images: ['data:image/png;base64,aW1hZ2U='],
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not apply submit timeout to custom async polling after receiving a task id', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ task_id: 'task-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: 'IN_PROGRESS' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          status: 'SUCCESS',
          data: {
            data: [{ b64_json: 'aW1hZ2U=' }],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const promise = callImageApi({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.example.com/v1',
        customProviders: [{
          id: 'custom-async',
          name: 'Custom Async',
          template: 'http-image',
          submit: {
            path: 'images/generations',
            method: 'POST',
            contentType: 'json',
            query: { async: 'true' },
            body: { model: '$profile.model', prompt: '$prompt' },
            taskIdPath: 'task_id',
          },
          poll: {
            path: 'images/tasks/{task_id}',
            method: 'GET',
            intervalSeconds: 5,
            statusPath: 'data.status',
            successValues: ['SUCCESS'],
            failureValues: ['FAILURE'],
            result: {
              b64JsonPaths: ['data.data.data.*.b64_json'],
            },
          },
        }],
        profiles: [{
          ...DEFAULT_SETTINGS.profiles[0],
          id: 'profile-custom',
          provider: 'custom-async',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          model: 'model',
          timeout: 1,
        }],
        activeProfileId: 'profile-custom',
        timeout: 1,
      },
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    })

    await vi.advanceTimersByTimeAsync(6000)

    await expect(promise).resolves.toEqual({
      images: ['data:image/png;base64,aW1hZ2U='],
    })
  })
})
