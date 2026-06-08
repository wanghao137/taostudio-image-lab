import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { callAgentConversationTitleApi, callAgentResponsesApi, callBatchImageSingle } from './agentApi'

describe('callAgentResponsesApi', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('streams Agent text and requests configured partial images', async () => {
    const streamBody = [
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      '',
      'data: {"type":"response.output_text.delta","delta":"lo"}',
      '',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"Hello"}]},{"type":"image_generation_call","id":"ig_1","result":"ZmluYWw=","size":"1024x1024"}]}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(streamBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const textDeltas: string[] = []
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      streamImages: true,
      streamPartialImages: 2,
    })

    const result = await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
      onTextDelta: (delta) => textDeltas.push(delta),
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.stream).toBe(true)
    expect(body.tools[0].partial_images).toBe(2)
    expect(textDeltas).toEqual(['Hel', 'lo'])
    expect(result).toMatchObject({
      responseId: 'resp_1',
      text: 'Hello',
      images: [{ toolCallId: 'ig_1', dataUrl: 'data:image/png;base64,ZmluYWw=' }],
    })
  })

  it('passes mask data to the Agent image tool', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'edit' }] }],
      maskDataUrl: 'data:image/png;base64,bWFzaw==',
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools[0].input_image_mask).toEqual({ image_url: 'data:image/png;base64,bWFzaw==' })
  })

  it('uses batch-only tools when the prompt explicitly asks for generate_image_batch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Use the generate_image_batch tool to generate exactly 3 independent images concurrently.',
        }],
      }],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools.some((tool: { type?: string }) => tool.type === 'image_generation')).toBe(false)
    expect(body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'generate_image_batch' }),
    ]))
    expect(body.tool_choice).toEqual({ type: 'function', name: 'generate_image_batch' })
  })

  it('uses batch-only tools for Chinese multi-image independent proposal prompts', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: '请连续完成4张独立图片，不要四宫格，也不要拼成一张总图。每张图分别生成，但保持同一品牌视觉系统。',
        }],
      }],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools.some((tool: { type?: string }) => tool.type === 'image_generation')).toBe(false)
    expect(body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'generate_image_batch' }),
    ]))
    expect(body.tool_choice).toEqual({ type: 'function', name: 'generate_image_batch' })
  })

  it('uses batch-only tools for English multi-image independent prompts with separated count and noun', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'Generate exactly 2 independent product poster images. Do not make a collage.',
        }],
      }],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools.some((tool: { type?: string }) => tool.type === 'image_generation')).toBe(false)
    expect(body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'generate_image_batch' }),
    ]))
    expect(body.tool_choice).toEqual({ type: 'function', name: 'generate_image_batch' })
  })

  it('extracts image_generation results from base64 object fields', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        id: 'ig_base64',
        result: { base64: 'ZmlsZQ==' },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    const result = await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    expect(result.images).toEqual([{
      toolCallId: 'ig_base64',
      dataUrl: 'data:image/png;base64,ZmlsZQ==',
      actualParams: {},
    }])
  })

  it('stops reading a stream when the caller aborts after output starts', async () => {
    const streamBody = [
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      '',
      '',
    ].join('\n')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(streamBody))
        controller.close()
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))
    const textDeltas: string[] = []
    const abortController = new AbortController()
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      streamImages: true,
    })

    await expect(callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
      signal: abortController.signal,
      onTextDelta: (delta) => {
        textDeltas.push(delta)
        abortController.abort()
      },
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(textDeltas).toEqual(['Hel'])
  })

  it('generates a short conversation title without image tools', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: '<title>生成猫咪头像</title>' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      streamImages: true,
    })

    const title = await callAgentConversationTitleApi({
      settings: DEFAULT_SETTINGS,
      profile,
      prompt: '帮我生成一张橘猫头像，要赛博朋克风格',
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.instructions).toContain('<title>short title</title>')
    expect(body.tools).toBeUndefined()
    expect(body.stream).toBeUndefined()
    expect(body.input[0].content[0].text).toContain('帮我生成一张橘猫头像，要赛博朋克风格')
    expect(title).toBe('生成猫咪头像')
  })

  it('requests web search and applies citations', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_search',
      output: [
        {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
          action: { type: 'search', query: 'OpenAI web search docs' },
        },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'See OpenAI docs.',
            annotations: [{
              type: 'url_citation',
              start_index: 4,
              end_index: 15,
              url: 'https://platform.openai.com/docs',
              title: 'OpenAI Docs',
            }],
          }],
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
    })

    const result = await callAgentResponsesApi({
      settings: { ...DEFAULT_SETTINGS, agentWebSearch: true },
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.tools).toEqual(expect.arrayContaining([{ type: 'web_search' }]))
    expect(result.text).toBe('See [OpenAI docs](https://platform.openai.com/docs).')
    expect(result.outputItems?.[0]).toMatchObject({ type: 'web_search_call', status: 'completed' })
  })

  it('passes the configured API URL to the same-origin API proxy as a target header', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      apiProxy: true,
      baseUrl: 'https://api.example.com/v1',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    const [url, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(url).toBe('/api-proxy/responses')
    expect(headers['x-taostudio-api-base-url']).toBe('https://api.example.com/v1')
    expect(headers['x-taostudio-api-base-url']).not.toContain('test-key')
  })

  it('does not pass the configured API URL as a dynamic proxy target when API proxy is locked', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    vi.stubEnv('VITE_API_PROXY_LOCKED', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      apiProxy: false,
      baseUrl: 'http://127.0.0.1:7892',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    const [url, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(url).toBe('/api-proxy/responses')
    expect(headers['x-taostudio-api-base-url']).toBeUndefined()
  })

  it('does not force the API proxy for long 4K Agent requests when proxy is available', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      apiProxy: false,
      baseUrl: 'https://api.example.com/v1',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'brand prompt '.repeat(220) }] }],
    })

    const [url, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(url).toBe('https://api.example.com/v1/responses')
    expect(headers['x-taostudio-api-base-url']).toBeUndefined()
  })

  it('retries transient Agent network failures before returning the response', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      baseUrl: 'https://api.example.com/v1',
    })

    const promise = callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toMatchObject({ text: 'OK' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('recovers Agent image planning after two transient 502 responses', async () => {
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
          type: 'message',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      baseUrl: 'https://api.example.com/v1',
    })

    const promise = callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: DEFAULT_PARAMS,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await expect(promise).resolves.toMatchObject({ text: 'OK' })
  })

  it('falls back to the same-origin API proxy after retryable direct Agent network failures', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      apiProxy: false,
      baseUrl: 'https://api.example.com/v1',
    })

    const promise = callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await expect(promise).resolves.toMatchObject({ text: 'OK' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/responses')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/v1/responses')
    expect(fetchMock.mock.calls[2][0]).toBe('/api-proxy/responses')
    const headers = fetchMock.mock.calls[2][1]?.headers as Record<string, string>
    expect(headers['x-taostudio-api-base-url']).toBe('https://api.example.com/v1')
  })

  it('tries the same-origin API proxy after direct Agent network failures even when proxy availability was not embedded', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'false')
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      apiProxy: false,
      baseUrl: 'https://api.example.com/v1',
    })

    const promise = callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'prompt' }] }],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await expect(promise).resolves.toMatchObject({ text: 'OK' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/v1/responses')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/v1/responses')
    expect(fetchMock.mock.calls[2][0]).toBe('/api-proxy/responses')
    const headers = fetchMock.mock.calls[2][1]?.headers as Record<string, string>
    expect(headers['x-taostudio-api-base-url']).toBe('https://api.example.com/v1')
  })

  it('does not optimistically proxy long browser Agent requests when proxy availability was not embedded', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'false')
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        origin: 'https://image.taostudioai.com',
      },
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'OK' }],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      apiProxy: false,
      baseUrl: 'https://api.example.com/v1',
    })

    await callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'brand prompt '.repeat(220) }] }],
    })

    const [url, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(url).toBe('https://api.example.com/v1/responses')
    expect(headers['x-taostudio-api-base-url']).toBeUndefined()
  })

  it('falls back to direct Agent fetch when an enabled proxy returns gateway timeout', async () => {
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'gateway timeout' } }), {
        status: 524,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'OK' }],
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      apiProxy: true,
      baseUrl: 'https://api.example.com/v1',
    })

    const promise = callAgentResponsesApi({
      settings: DEFAULT_SETTINGS,
      profile,
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'brand prompt '.repeat(220) }] }],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))

    await expect(promise).resolves.toMatchObject({ text: 'OK' })

    expect(fetchMock.mock.calls[0][0]).toBe('/api-proxy/responses')
    expect(fetchMock.mock.calls[1][0]).toBe('/api-proxy/responses')
    expect(fetchMock.mock.calls[2][0]).toBe('/api-proxy/responses')
    expect(fetchMock.mock.calls[3][0]).toBe('https://api.example.com/v1/responses')
    const directHeaders = fetchMock.mock.calls[3][1]?.headers as Record<string, string>
    expect(directHeaders['x-taostudio-api-base-url']).toBeUndefined()
  })
})

describe('callBatchImageSingle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('passes the configured API URL to the same-origin API proxy as a target header', async () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      output: [{
        type: 'image_generation_call',
        id: 'ig_1',
        result: 'ZmluYWw=',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      apiProxy: true,
      baseUrl: 'https://api.example.com/v1',
    })

    const result = await callBatchImageSingle({
      profile,
      params: DEFAULT_PARAMS,
      batchItemId: 'image_1',
      prompt: 'prompt',
      referenceImageDataUrls: [],
    })

    const [url, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(url).toBe('/api-proxy/responses')
    expect(headers['x-taostudio-api-base-url']).toBe('https://api.example.com/v1')
    expect(result.image?.dataUrl).toBe('data:image/png;base64,ZmluYWw=')
  })

  it('retries transient batch image network failures before returning the generated image', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: [{
          type: 'image_generation_call',
          id: 'ig_1',
          result: 'ZmluYWw=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      baseUrl: 'https://api.example.com/v1',
    })

    const promise = callBatchImageSingle({
      profile,
      params: DEFAULT_PARAMS,
      batchItemId: 'image_1',
      prompt: 'prompt',
      referenceImageDataUrls: [],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)

    await expect(promise).resolves.toMatchObject({
      image: { dataUrl: 'data:image/png;base64,ZmluYWw=' },
      error: null,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('recovers batch image generation after two transient 502 responses', async () => {
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
          id: 'ig_1',
          result: 'ZmluYWw=',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    const profile = createDefaultOpenAIProfile({
      apiKey: 'test-key',
      apiMode: 'responses',
      baseUrl: 'https://api.example.com/v1',
    })

    const promise = callBatchImageSingle({
      profile,
      params: DEFAULT_PARAMS,
      batchItemId: 'image_1',
      prompt: 'prompt',
      referenceImageDataUrls: [],
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    await expect(promise).resolves.toMatchObject({
      image: { dataUrl: 'data:image/png;base64,ZmluYWw=' },
      error: null,
    })
  })
})
