import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_GIF_OPTIONS, buildGifPromptEnhancement, estimateGifFrameSize, getGifProfile, readGifMetadata, validateGifParams } from './gif'
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
  it('按官方契约验证 2–16 帧与尺寸档位，隔离静态图选项', () => {
    const params = { ...DEFAULT_PARAMS, output_format: 'gif' as const, gif: { ...DEFAULT_GIF_OPTIONS } }
    expect(() => validateGifParams(params)).not.toThrow()
    expect(() => validateGifParams({ ...params, n: 10, quality: 'max', gif: { ...params.gif, frame_count: 16, frame_duration_ms: 2000 } })).not.toThrow()
    for (const frame_count of [1, 17, 2.5, NaN]) expect(() => validateGifParams({ ...params, gif: { ...params.gif, frame_count } })).toThrow('2–16')
    for (const size of ['1k', '2k', '4k', '2K']) expect(() => validateGifParams({ ...params, size })).not.toThrow()
    for (const size of ['3k', 'abc', '511x512']) expect(() => validateGifParams({ ...params, size })).toThrow()
    expect(() => validateGifParams({ ...params, n: 11 })).toThrow()
    expect(() => validateGifParams({ ...params, transparent_output: true })).toThrow()
    expect(() => validateGifParams({ ...params, gif: { ...params.gif, frame_duration_ms: 205 } })).toThrow()
  })
  it('估算单帧尺寸与提示词增强', () => {
    expect(estimateGifFrameSize(1, 16)).toBe(311)
    expect(estimateGifFrameSize(1, 8)).toBe(440)
    expect(estimateGifFrameSize(1, 6)).toBe(508)
    expect(estimateGifFrameSize(1, 4)).toBe(622)
    expect(estimateGifFrameSize(2, 8)).toBe(311)
    expect(estimateGifFrameSize(0, 8)).toBe(estimateGifFrameSize(1, 8))
    const enhancement = buildGifPromptEnhancement({ ...DEFAULT_GIF_OPTIONS, frame_count: 6, frame_duration_ms: 250 }, 1)
    expect(enhancement).toContain('整段GIF共6帧')
    expect(enhancement).toContain('每帧持续约250毫秒')
    expect(enhancement).toContain('预计单帧约508px')
    expect(enhancement).toContain('无模糊、无糊化、无重影')
    expect(buildGifPromptEnhancement(DEFAULT_GIF_OPTIONS, 2)).toContain('像素预算由它们均分')
    expect(buildGifPromptEnhancement(DEFAULT_GIF_OPTIONS, 1)).not.toContain('均分')
  })
  it('局部使用 Images 与 2.6 模型，不修改共享档案', () => {
    const profile = createDefaultOpenAIProfile({ apiMode: 'responses', streamImages: true, model: 'some-text-model' })
    expect(getGifProfile(profile, DEFAULT_GIF_OPTIONS.model)).toMatchObject({ apiMode: 'images', model: 'gpt-image-2.6', streamImages: false })
    expect(profile.apiMode).toBe('responses')
    expect(() => getGifProfile({ ...profile, codexCli: true }, DEFAULT_GIF_OPTIONS.model)).toThrow()
  })
})
