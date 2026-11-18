// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { callImageApi } from './api'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { DEFAULT_GIF_OPTIONS } from './gif'
import { ANIMATED_GIF_BASE64 } from './__fixtures__/gif'

const profile = createDefaultOpenAIProfile({ id: 'gif-test', apiKey: 'test-only', baseUrl: 'https://example.test/v1', apiMode: 'responses', streamImages: true, responseFormatB64Json: true })
const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
const options = { settings, apiProfile: profile, prompt: '灯笼自然摇晃，首尾衔接', params: { ...DEFAULT_PARAMS, output_format: 'gif' as const, output_compression: 80, gif: { ...DEFAULT_GIF_OPTIONS } }, inputImageDataUrls: [] }
afterEach(() => vi.restoreAllMocks())

describe('原生 GIF 请求', () => {
  it('走 Images JSON，排除流式与压缩参数，返回多帧元数据', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: ANIMATED_GIF_BASE64 }], output_format: 'gif' }), { headers: { 'Content-Type': 'application/json' } }))
    const result = await callImageApi(options)
    expect(String(fetch.mock.calls[0][0])).toContain('/images/generations')
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ model: 'gpt-image-2.6', prompt: options.prompt, output_format: 'gif', moderation: 'low', size: 'auto', quality: 'auto', frame_count: 6, frame_duration_ms: 200, complexity: 'high', n: 1 })
    expect(result.images[0]).toBe(`data:image/gif;base64,${ANIMATED_GIF_BASE64}`)
    expect(result.animation).toMatchObject({ frameCount: 2, durationMs: 400 })
  })
  it('16 帧、自定义尺寸、max 画质与多个 GIF 都进入同一请求', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: ANIMATED_GIF_BASE64 }, { b64_json: ANIMATED_GIF_BASE64 }] })))
    const result = await callImageApi({ ...options, params: { ...options.params, n: 2, size: '512x512', quality: 'max', gif: { ...DEFAULT_GIF_OPTIONS, frame_count: 16, frame_duration_ms: 2000, complexity: 'low' } } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ n: 2, size: '512x512', quality: 'max', frame_count: 16, frame_duration_ms: 2000, complexity: 'low' })
    expect(result.animations).toHaveLength(2)
  })
  it('通道级禁用 GIF 的错误翻译为可操作指引', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'GIF output is not enabled for this request.', type: 'invalid_request_error' } }), { status: 400 }))
    await expect(callImageApi(options)).rejects.toThrow('通道未启用原生 GIF')
  })
  it('快速失败 429 自动退避重试至多 3 次（上游未开始生成，无双重消费）', async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'no available image quota' } }), { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'no available image quota' } }), { status: 429 }))
        .mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: ANIMATED_GIF_BASE64 }] })))
      const promise = callImageApi(options)
      const result = await vi.advanceTimersByTimeAsync(120_000).then(() => promise)
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(result.images[0]).toBe(`data:image/gif;base64,${ANIMATED_GIF_BASE64}`)
    } finally {
      vi.useRealTimers()
    }
  })
  it('超时类慢失败不重试 GIF（避免上游已执行导致双重消费）', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const slowOptions = { ...options, apiProfile: { ...profile, timeout: 2 } }
    await expect(callImageApi(slowOptions)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  }, 10_000)
  it('拒绝参考图与伪 GIF，不自动重新生成', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] })))
    await expect(callImageApi({ ...options, inputImageDataUrls: ['data:image/png;base64,AAAA'] })).rejects.toThrow('参考图')
    expect(fetch).not.toHaveBeenCalled()
    await expect(callImageApi(options)).rejects.toThrow('GIF')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('接收 GIF 与 PNG 混合结果，保留 GIF 并对齐元数据', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png, revised_prompt: 'static companion' }, { b64_json: `data:image/png;base64,${ANIMATED_GIF_BASE64}`, revised_prompt: 'animation' }] })))
    const result = await callImageApi(options)
    expect(result.images).toEqual([`data:image/gif;base64,${ANIMATED_GIF_BASE64}`])
    expect(result.gifCompanionCount).toBe(1)
    expect(result.revisedPrompts).toEqual(['animation'])
    expect(result.animations).toHaveLength(1)
    expect(result.actualParams).toMatchObject({ n: 1, output_format: 'gif' })
  })
  it('审核拒绝与网关错误不触发隐式改写或多次付费请求', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: { message: 'moderation_blocked' } }), { status: 400 }))
    await expect(callImageApi(options)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockClear().mockImplementation(async () => new Response('unavailable', { status: 502 }))
    await expect(callImageApi(options)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('仅有静态辅助图或损坏 GIF 时保持失败，不隐藏坏文件', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC'
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: png }] })))
    await expect(callImageApi(options)).rejects.toThrow('没有返回多帧 GIF')
    fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ b64_json: ANIMATED_GIF_BASE64 }, { b64_json: btoa('GIF89a') }] })))
    await expect(callImageApi(options)).rejects.toThrow('GIF 文件不完整')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
