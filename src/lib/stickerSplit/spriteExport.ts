// 表情工坊（战斗 Sprite GIF）的导出辅助：帧 dataUrl → 统一尺寸画布 →
// GIF（gifEncode）/ APNG（apng）/ 帧 ZIP（fflate）。画布相关部分集中在
// 本模块，store 只做编排与 toast——store 测试整体 mock 本模块即可覆盖
// 导出链路（jsdom 无 canvas）。复用 StickerAnimatePanel 的逐帧快照与
// download.ts 的 zip 模式。
import { zipSync } from 'fflate'
import { loadImage } from '../canvasImage'
import type { GifFrame } from './gifEncode'

/** 导出尺寸：256/512 定边（按首帧长边等比缩放），'original' 保持注册画布原尺寸 */
export type SpriteExportSize = 256 | 512 | 'original'

interface FrameCanvas {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

/** 帧 dataUrl 逐张解码并缩放到统一尺寸（registration 帧同画布；按首帧长边定缩放比）。 */
async function loadSpriteFrameCanvases(dataUrls: string[], exportSize: SpriteExportSize): Promise<FrameCanvas[]> {
  const images = await Promise.all(dataUrls.map((dataUrl) => loadImage(dataUrl)))
  if (!images.length) throw new Error('没有帧')
  const baseWidth = images[0].naturalWidth
  const baseHeight = images[0].naturalHeight
  if (baseWidth <= 0 || baseHeight <= 0) throw new Error('帧尺寸无效')
  const scale = exportSize === 'original'
    ? 1
    : (exportSize as number) / Math.max(baseWidth, baseHeight)
  const width = Math.max(1, Math.round(baseWidth * scale))
  const height = Math.max(1, Math.round(baseHeight * scale))
  return images.map((image) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布上下文')
    ctx.drawImage(image, 0, 0, width, height)
    return { canvas, width, height }
  })
}

/** GIF 帧序列：统一尺寸画布 → RGBA 像素（encodeGif 入参），全部帧同 delayMs。 */
export async function buildSpriteGifFrames(dataUrls: string[], exportSize: SpriteExportSize, delayMs: number): Promise<GifFrame[]> {
  const canvases = await loadSpriteFrameCanvases(dataUrls, exportSize)
  return canvases.map(({ canvas, width, height }) => {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法读取画布像素')
    return { data: ctx.getImageData(0, 0, width, height).data, width, height, delayMs }
  })
}

/** APNG 帧序列：每帧独立画布快照（encodeApngFromCanvases 入参），全部帧同 delayMs。 */
export async function buildSpriteApngFrames(
  dataUrls: string[],
  exportSize: SpriteExportSize,
  delayMs: number,
): Promise<Array<{ canvas: HTMLCanvasElement; delayMs: number }>> {
  const canvases = await loadSpriteFrameCanvases(dataUrls, exportSize)
  return canvases.map(({ canvas }) => ({ canvas, delayMs }))
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** 帧 ZIP 条目：原始注册帧 PNG（不缩放），命名 frame-01.png 起。纯 JS，Node 可测。 */
export function spriteFramesZipEntries(dataUrls: string[]): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  dataUrls.forEach((dataUrl, index) => {
    files[`frame-${String(index + 1).padStart(2, '0')}.png`] = dataUrlToBytes(dataUrl)
  })
  return files
}

/** 打包并触发下载，返回文件数。 */
export function downloadSpriteFramesZip(dataUrls: string[], fileName: string): number {
  const files = spriteFramesZipEntries(dataUrls)
  if (!Object.keys(files).length) return 0
  const zipped = zipSync(files, { level: 6 })
  const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
  downloadBlob(new Blob([buffer], { type: 'application/zip' }), fileName)
  return dataUrls.length
}

/** 触发浏览器下载（StickerAnimatePanel / download.ts 同款）。 */
export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function formatBlobSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`
}
