import type { TaskParams } from '../types'
import { loadImage } from './canvasImage'
import { blobToDataUrl } from './dataUrl'
import { parseImageSize, type ImageSize } from './size'
import {
  calculateImageSize,
  computeResizePlan,
  deriveExactSourceTarget,
  formatExactRatio,
  ratioMatchesExactly,
} from '../../packages/image-job-core/index.mjs'
import { resizeImageHighQuality } from './imageResizer'

const canvasToBlob = (canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('canvas export failed')), mime, quality)
  })

const OUTPUT_MIME_BY_FORMAT: Record<TaskParams['output_format'], string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export interface ExactImageResizeResult {
  dataUrl: string
  sourceDataUrl: string
  width: number
  height: number
  resized: boolean
  sourceWidth: number
  sourceHeight: number
  rawSourceWidth: number
  rawSourceHeight: number
  sourceNormalized: boolean
  drawPlan?: ExactSizeDrawPlan
  normalizationPlan?: ExactSizeDrawPlan
}

export type ExactSizeFitMode = 'cover' | 'contain'

export interface ExactSizeDrawPlan {
  mode: ExactSizeFitMode
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
  scale: number
  drawX: number
  drawY: number
  drawWidth: number
  drawHeight: number
  aspectMismatch: boolean
}

export function computeExactSizeDrawPlan(
  source: ImageSize,
  target: ImageSize,
  mode: ExactSizeFitMode = 'cover',
): ExactSizeDrawPlan {
  return computeResizePlan(source, target, mode)
}

export function getExactImageSizeTarget(params: Pick<TaskParams, 'size' | 'exact_size'>): ImageSize | null {
  if (!params.exact_size || params.size === 'auto') return null
  return parseImageSize(params.size)
}

export function getExactImageCanonicalSourceSize(source: ImageSize, target: ImageSize): ImageSize {
  if (ratioMatchesExactly(source, target)) return { ...source }

  const targetRatio = formatExactRatio(target.width, target.height)
  const baseSize = targetRatio ? calculateImageSize('1K', targetRatio) : null
  const base = baseSize ? parseImageSize(baseSize) : null
  return deriveExactSourceTarget(base ?? source, target)
}

function createResizeCanvas(
  source: CanvasImageSource,
  target: ImageSize,
  drawPlan: ExactSizeDrawPlan,
) {
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable in this browser')

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, target.width, target.height)
  ctx.drawImage(
    source,
    drawPlan.drawX,
    drawPlan.drawY,
    drawPlan.drawWidth,
    drawPlan.drawHeight,
  )
  return canvas
}

async function exportCanvas(
  canvas: HTMLCanvasElement,
  outputFormat: TaskParams['output_format'],
) {
  const mime = OUTPUT_MIME_BY_FORMAT[outputFormat] ?? 'image/png'
  const quality = outputFormat === 'png' ? undefined : 0.95
  return blobToDataUrl(await canvasToBlob(canvas, mime, quality), mime)
}

export async function resizeImageDataUrlToExactSize(
  dataUrl: string,
  target: ImageSize,
  outputFormat: TaskParams['output_format'],
  fitMode: ExactSizeFitMode = 'cover',
): Promise<ExactImageResizeResult> {
  const image = await loadImage(dataUrl)
  const rawSource = { width: image.naturalWidth, height: image.naturalHeight }

  if (rawSource.width === target.width && rawSource.height === target.height) {
    return {
      dataUrl,
      sourceDataUrl: dataUrl,
      width: rawSource.width,
      height: rawSource.height,
      resized: false,
      sourceWidth: rawSource.width,
      sourceHeight: rawSource.height,
      rawSourceWidth: rawSource.width,
      rawSourceHeight: rawSource.height,
      sourceNormalized: false,
    }
  }

  // 单次重采样：raw → target（lanczos3 Worker，cover 裁切内建）。
  // 旧路径在比例不匹配时先规格化到 1K 再放大（两次重采样，中间还可能降规格），
  // 细节损失且 canvas 平滑近似双线性——已废弃。
  // sourceDataUrl 语义升级：直接保留 provider 原始输出（raw），供详情页
  // 查看/下载原生底图，而不是 1K 重编码版。
  const drawPlan = computeExactSizeDrawPlan(rawSource, target, fitMode)
  const outputDataUrl = outputFormat === 'png'
    ? await resizeImageHighQuality(dataUrl, target.width, target.height, fitMode)
    : await exportCanvas(
        createResizeCanvas(image, target, drawPlan),
        outputFormat,
      )

  return {
    dataUrl: outputDataUrl,
    sourceDataUrl: dataUrl,
    width: target.width,
    height: target.height,
    resized: true,
    sourceWidth: rawSource.width,
    sourceHeight: rawSource.height,
    rawSourceWidth: rawSource.width,
    rawSourceHeight: rawSource.height,
    sourceNormalized: false,
    drawPlan,
    normalizationPlan: undefined,
  }
}
