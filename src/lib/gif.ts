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
  model: GIF_MODELS[1], frame_count: 6, frame_duration_ms: 200, complexity: 'high',
}

/**
 * 上游对整段 GIF 的总像素预算近似恒定（实测约 155 万像素，所有帧共享）：
 * 帧数越多单帧越小——16 帧≈309²、8 帧≈439²、6 帧≈508²、4 帧≈620²。
 * 以此估算单帧边长，帮助用户在清晰度与流畅度之间取舍。
 */
export const GIF_PIXEL_BUDGET = 1_550_000

export function estimateGifFrameSize(n: number, frameCount: number): number {
  const safeN = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
  const safeFrames = Number.isFinite(frameCount) && frameCount >= 1 ? Math.floor(frameCount) : 1
  return Math.floor(Math.sqrt(GIF_PIXEL_BUDGET / (safeN * safeFrames)))
}

/** GIF 请求支持 1k/2k/4k 档位（2k 放宽宽幅上限），或 16 倍数的逐帧宽高。 */
export function isGifSizeTier(size: string): boolean {
  return ['1k', '2k', '4k'].includes(size.toLowerCase())
}

export function validateGifParams(params: TaskParams): void {
  if (params.output_format !== 'gif') throw new Error('GIF 任务必须使用 GIF 输出格式')
  const gif = params.gif
  if (!gif || !GIF_MODELS.includes(gif.model)) throw new Error('请选择 GPT Image 2.6 GIF 模型')
  // 官方接口参考限制 2-16 帧；上游 GIF 总像素预算恒定，帧数越多单帧越小，16 帧以上清晰度不可接受。
  if (!Number.isInteger(gif.frame_count) || gif.frame_count < 2 || gif.frame_count > 16) throw new Error('GIF 帧数须为 2–16 的整数')
  if (!Number.isInteger(gif.frame_duration_ms) || gif.frame_duration_ms < 20 || gif.frame_duration_ms > 2000 || gif.frame_duration_ms % 10) throw new Error('每帧时长须为 20–2000ms，按 10ms 递增')
  if (!['low', 'medium', 'high'].includes(gif.complexity)) throw new Error('GIF 规划强度无效')
  if (params.size !== 'auto') {
    if (isGifSizeTier(params.size)) {
      // 档位制：官方契约中 GIF 的 size 为 1k/2k/4k，宽幅内容建议 2k。
    } else {
      const match = /^(\d+)x(\d+)$/.exec(params.size)
      if (!match || !match.slice(1).every((s) => Number(s) > 0 && Number.isSafeInteger(Number(s)) && Number(s) % 16 === 0)) throw new Error('GIF 每帧宽高须为 auto、1k、2k、4k 档位，或 16 倍数的宽高')
    }
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

/**
 * 把 GIF 请求参数与清晰度要求拼进提示词。
 * chatgpt2api 等走 ChatGPT web 对话流的网关会忽略 frame_count/frame_duration_ms 等 API 参数，
 * 提示词是这类通道控制帧数与清晰度的唯一途径；官方契约型供应商也会参考这些措辞。
 */
export function buildGifPromptEnhancement(gif: GifOptions, n: number): string {
  const nNote = Number.isInteger(n) && n > 1 ? `本次请求生成 ${n} 个独立 GIF，像素预算由它们均分。` : ''
  const sizeNote = estimateGifFrameSize(n, gif.frame_count)
  return [
    `整段GIF共${gif.frame_count}帧，每帧持续约${gif.frame_duration_ms}毫秒，首尾无缝循环。`,
    nNote,
    `所有帧均为高清渲染（预计单帧约${sizeNote}px见方），画面细节丰富清晰，文字与图案边缘锐利干净，笔画完整可辨，无模糊、无糊化、无重影、无抖动伪影。`,
    '采用干净平涂的赛璐璐上色，轮廓线粗而闭合、边缘锐利，以大色块为主；装饰元素克制：冲击线与特效符号总数不超过三条且线条粗壮清晰，画面无动态模糊、无景深虚化、无辉光、无柔焦。',
  ].filter(Boolean).join('')
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
