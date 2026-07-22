import type { TaskParams } from '../types'
import { canvasToBlob, loadImage } from './canvasImage'
import { blobToDataUrl } from './dataUrl'
import { parseImageSize, type ImageSize } from './size'
import { computeResizePlan } from '../../packages/image-job-core/index.mjs'

const OUTPUT_MIME_BY_FORMAT: Record<TaskParams['output_format'], string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export interface ExactImageResizeResult {
  dataUrl: string
  width: number
  height: number
  resized: boolean
  sourceWidth: number
  sourceHeight: number
  drawPlan?: ExactSizeDrawPlan
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

export async function resizeImageDataUrlToExactSize(
  dataUrl: string,
  target: ImageSize,
  outputFormat: TaskParams['output_format'],
  fitMode: ExactSizeFitMode = 'cover',
): Promise<ExactImageResizeResult> {
  const image = await loadImage(dataUrl)
  const sourceWidth = image.naturalWidth
  const sourceHeight = image.naturalHeight

  if (sourceWidth === target.width && sourceHeight === target.height) {
    return {
      dataUrl,
      width: sourceWidth,
      height: sourceHeight,
      resized: false,
      sourceWidth,
      sourceHeight,
    }
  }

  const drawPlan = computeExactSizeDrawPlan(
    { width: sourceWidth, height: sourceHeight },
    target,
    fitMode,
  )
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, target.width, target.height)
  ctx.drawImage(
    image,
    drawPlan.drawX,
    drawPlan.drawY,
    drawPlan.drawWidth,
    drawPlan.drawHeight,
  )

  const mime = OUTPUT_MIME_BY_FORMAT[outputFormat] ?? 'image/png'
  const quality = outputFormat === 'png' ? undefined : 0.95
  const blob = await canvasToBlob(canvas, mime, quality)
  return {
    dataUrl: await blobToDataUrl(blob, mime),
    width: target.width,
    height: target.height,
    resized: true,
    sourceWidth,
    sourceHeight,
    drawPlan,
  }
}
