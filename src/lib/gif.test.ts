import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_GIF_OPTIONS, getGifProfile, readGifMetadata, validateGifParams } from './gif'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { ANIMATED_GIF } from './__fixtures__/gif'

describe('GIF 文件与请求边界', () => {
  it('读取真实多帧文件的尺寸、延时与循环次数', () => {
    expect(readGifMetadata(ANIMATED_GIF)).toMatchObject({ width: 2, height: 2, frameCount: 2, durationMs: 400, frameDurationsMs: [200, 200], loopCount: 0 })
  })
  it('拒绝伪装成 GIF 的图片、截断文件、单帧结果和错误画布', () => {
    expect(() => readGifMetadata('data:image/png;base64,AAAA')).toThrow()
    expect(() => readGifMetadata('data:image/gif;base64,AAAA')).toThrow()
    const bytes = Uint8Array.from(atob(ANIMATED_GIF.split(',')[1]), (c) => c.charCodeAt(0))
    const url = (b: Uint8Array) => `data:image/gif;base64,${btoa(String.fromCharCode(...b))}`
    expect(() => readGifMetadata(url(bytes.slice(0, -1)))).toThrow('不完整')
    const secondControl = bytes.findIndex((b, i) => i > 48 && b === 0x21 && bytes[i + 1] === 0xf9)
    expect(() => readGifMetadata(url(Uint8Array.from([...bytes.slice(0, secondControl), 0x3b])))).toThrow('多帧')
    bytes[6] = 0; bytes[7] = 0
    expect(() => readGifMetadata(url(bytes))).toThrow('尺寸无效')
  })
  it('按指南验证 2–64 帧与尺寸倍数，隔离静态图选项', () => {
    const params = { ...DEFAULT_PARAMS, output_format: 'gif' as const, gif: { ...DEFAULT_GIF_OPTIONS } }
    expect(() => validateGifParams(params)).not.toThrow()
    expect(() => validateGifParams({ ...params, n: 10, quality: 'max', gif: { ...params.gif, frame_count: 64, frame_duration_ms: 2000 } })).not.toThrow()
    for (const frame_count of [1, 65, 2.5, NaN]) expect(() => validateGifParams({ ...params, gif: { ...params.gif, frame_count } })).toThrow()
    expect(() => validateGifParams({ ...params, size: '511x512' })).toThrow()
    expect(() => validateGifParams({ ...params, n: 11 })).toThrow()
    expect(() => validateGifParams({ ...params, transparent_output: true })).toThrow()
    expect(() => validateGifParams({ ...params, gif: { ...params.gif, frame_duration_ms: 205 } })).toThrow()
  })
  it('局部使用 Images 与 2.6 模型，不修改共享档案', () => {
    const profile = createDefaultOpenAIProfile({ apiMode: 'responses', streamImages: true, model: 'some-text-model' })
    expect(getGifProfile(profile, DEFAULT_GIF_OPTIONS.model)).toMatchObject({ apiMode: 'images', model: 'gpt-image-2.6-flare', streamImages: false })
    expect(profile.apiMode).toBe('responses')
    expect(() => getGifProfile({ ...profile, codexCli: true }, DEFAULT_GIF_OPTIONS.model)).toThrow()
  })
})
