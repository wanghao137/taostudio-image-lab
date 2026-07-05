import type { TaskParams } from '../types'
import { canvasToBlob, loadImage } from './canvasImage'
import { blobToDataUrl } from './dataUrl'
import { parseImageSize, type ImageSize } from './size'

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

const ASPECT_EPSILON = 0.01

function round6(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function roundPixel(value: number) {
  const rounded = Math.round(value)
  return Object.is(rounded, -0) ? 0 : rounded
}

export function computeExactSizeDrawPlan(
  source: ImageSize,
  target: ImageSize,
  mode: ExactSizeFitMode = 'cover',
): ExactSizeDrawPlan {
  const widthScale = target.width / source.width
  const heightScale = target.height / source.height
  const scale = mode === 'contain'
    ? Math.min(widthScale, heightScale)
    : Math.max(widthScale, heightScale)
  const drawWidth = roundPixel(source.width * scale)
  const drawHeight = roundPixel(source.height * scale)
  const drawX = roundPixel((target.width - drawWidth) / 2)
  const drawY = roundPixel((target.height - drawHeight) / 2)
  const sourceAspect = source.width / source.height
  const targetAspect = target.width / target.height

  return {
    mode,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetWidth: target.width,
    targetHeight: target.height,
    scale: round6(scale),
    drawX,
    drawY,
    drawWidth,
    drawHeight,
    aspectMismatch: Math.abs(sourceAspect - targetAspect) > ASPECT_EPSILON,
  }
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
