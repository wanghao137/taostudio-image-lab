import type { ApiProfile, TaskParams } from '../types'

export const GIF_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const

export interface GifOptions {
  model: typeof GIF_MODELS[number]
  frame_count: number
  frame_duration_ms: number
  complexity: 'low' | 'medium' | 'high'
}

export interface GifMetadata {
  width: number
  height: number
  frameCount: number
  durationMs: number
  frameDurationsMs: number[]
  /** null 表示文件未指定循环，0 表示无限循环。 */
  loopCount: number | null
  byteLength: number
}

export const DEFAULT_GIF_OPTIONS: GifOptions = {
  model: GIF_MODELS[0], frame_count: 9, frame_duration_ms: 200, complexity: 'high',
}

export function validateGifParams(params: TaskParams): void {
  if (params.output_format !== 'gif') throw new Error('GIF 任务必须使用 GIF 输出格式')
  const gif = params.gif
  if (!gif || !GIF_MODELS.includes(gif.model)) throw new Error('请选择 GPT Image 2.6 GIF 模型')
  // 按官方生成指南开放 64 帧；部分网关与较早接口参考仍限制 16 帧。
  if (!Number.isInteger(gif.frame_count) || gif.frame_count < 2 || gif.frame_count > 64) throw new Error('GIF 帧数须为 2–64 的整数')
  if (!Number.isInteger(gif.frame_duration_ms) || gif.frame_duration_ms < 20 || gif.frame_duration_ms > 2000 || gif.frame_duration_ms % 10) throw new Error('每帧时长须为 20–2000ms，按 10ms 递增')
  if (!['low', 'medium', 'high'].includes(gif.complexity)) throw new Error('GIF 规划强度无效')
  if (params.size !== 'auto') {
    const match = /^(\d+)x(\d+)$/.exec(params.size)
    if (!match || !match.slice(1).every((s) => Number(s) > 0 && Number.isSafeInteger(Number(s)) && Number(s) % 16 === 0)) throw new Error('GIF 每帧宽高须为正整数且为 16 的倍数')
  }
  if (!Number.isInteger(params.n) || params.n < 1 || params.n > 10) throw new Error('GIF 生成数量须为 1–10 的整数')
  if (!['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(params.quality)) throw new Error('GIF 画质无效')
  if (!['auto', 'low'].includes(params.moderation)) throw new Error('GIF 内容审核选项无效')
  if (params.exact_size || params.transparent_output) throw new Error('GIF 不支持静态尺寸校正或透明后处理')
}

export function getGifProfile(profile: ApiProfile, model: GifOptions['model']): ApiProfile {
  if (profile.provider !== 'openai' || profile.codexCli) throw new Error('GIF 需要 OpenAI 兼容 Images API 配置，请在场景设置中选择')
  return { ...profile, apiMode: 'images', model, streamImages: false, responseFormatB64Json: false }
}

/** 网关可能把 GIF 与生成它的静态辅助图一起返回，按文件签名识别而非信任 MIME。 */
export function parseGifOutput(dataUrl: string): { image: string; metadata: GifMetadata } | null {
  const match = /^data:[^;,]+;base64,([\s\S]+)$/i.exec(dataUrl)
  if (!match) throw new Error('服务商返回了无法识别的 GIF 数据')
  const base64 = match[1].replace(/\s/g, '')
  let header: string
  try { header = atob(base64.slice(0, 24)) } catch { throw new Error('GIF 编码无效') }
  if (header.startsWith('GIF89a') || header.startsWith('GIF87a')) {
    const image = `data:image/gif;base64,${base64}`
    return { image, metadata: readGifMetadata(image) }
  }
  if (header.startsWith('\x89PNG\r\n\x1a\n') || header.startsWith('\xff\xd8\xff') || (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP')) return null
  throw new Error('服务商返回的内容不是有效 GIF')
}

/** 遍历 GIF 块读取时序；不把压缩数据里的分隔字节误当成帧。 */
export function readGifMetadata(dataUrl: string): GifMetadata {
  const match = /^data:image\/gif;base64,([\s\S]+)$/i.exec(dataUrl)
  if (!match) throw new Error('服务商未返回 GIF 文件')
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)) } catch { throw new Error('GIF 编码无效') }
  let offset = 0
  const requireBytes = (n: number) => {
    if (offset + n > bytes.length) throw new Error('GIF 文件不完整')
  }
  const skip = (n: number) => { requireBytes(n); offset += n }
  const u8 = () => { requireBytes(1); return bytes[offset++] }
  const u16 = () => u8() | (u8() << 8)
  const text = (n: number) => { requireBytes(n); const s = String.fromCharCode(...bytes.subarray(offset, offset + n)); offset += n; return s }
  const subBlocks = () => { for (let n = u8(); n; n = u8()) skip(n) }
  const signature = text(6)
  if (signature !== 'GIF89a' && signature !== 'GIF87a') throw new Error('服务商返回的内容不是有效 GIF')
  const width = u16(), height = u16(), packed = u8()
  if (!width || !height) throw new Error('GIF 画布尺寸无效')
  skip(2)
  if (packed & 0x80) skip(3 * (1 << ((packed & 7) + 1)))
  const frameDurationsMs: number[] = []
  let delay = 0, loopCount: number | null = null, ended = false
  while (offset < bytes.length) {
    const block = u8()
    if (block === 0x3b) { ended = true; break }
    if (block === 0x21) {
      const label = u8()
      if (label === 0xf9) {
        if (u8() !== 4) throw new Error('GIF 帧控制块无效')
        skip(1); delay = u16() * 10; skip(1)
        if (u8() !== 0) throw new Error('GIF 帧控制块不完整')
      } else if (label === 0xff) {
        const app = text(u8())
        for (let n = u8(); n; n = u8()) {
          requireBytes(n)
          if ((app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') && n === 3 && bytes[offset] === 1) loopCount = bytes[offset + 1] | (bytes[offset + 2] << 8)
          skip(n)
        }
      } else {
        subBlocks()
        if (label === 0x01) delay = 0
      }
    } else if (block === 0x2c) {
      const left = u16(), top = u16(), w = u16(), h = u16(), flags = u8()
      if (!w || !h || left + w > width || top + h > height) throw new Error('GIF 帧尺寸无效')
      if (flags & 0x80) skip(3 * (1 << ((flags & 7) + 1)))
      const codeSize = u8()
      if (codeSize < 2 || codeSize > 8) throw new Error('GIF 图像编码无效')
      subBlocks()
      frameDurationsMs.push(delay)
      delay = 0
    } else throw new Error('GIF 文件结构无效')
  }
  if (!ended) throw new Error('GIF 文件不完整')
  if (frameDurationsMs.length < 2) throw new Error('服务商未返回完整的多帧 GIF，请检查模型与 GIF 权限')
  return { width, height, frameCount: frameDurationsMs.length, frameDurationsMs, durationMs: frameDurationsMs.reduce((a, b) => a + b, 0), loopCount, byteLength: bytes.length }
}
