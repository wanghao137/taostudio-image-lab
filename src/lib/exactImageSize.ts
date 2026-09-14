import type { TaskParams } from '../types'
import { loadImage } from './canvasImage'
import { blobToDataUrl } from './dataUrl'
import { parseImageSize, resolveExactDeliverySize, type ImageSize } from './size'
import {
  calculateImageSize,
  computeResizePlan,
  deriveExactSourceTarget,
  formatExactRatio,
  ratioMatchesExactly,
} from '../../packages/image-job-core/index.mjs'
import { resizeImageHighQualityDetailed, type ResizeBackend } from './imageResizer'

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
  /** 实际执行重采样的后端（P0-D：输出格式不得改变几何采样结果） */
  resizerBackend?: ResizeBackend
  /** Worker → canvas 回退原因（未回退则无此字段；禁止静默降级） */
  resizerFallbackReason?: string
  /** JPEG/WebP 编码失败回退 PNG 的原因（像素已保住，仅格式降级；禁止静默） */
  encoderFallbackReason?: string
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

/**
 * exact_size 交付目标（P0-B）：params.size 可能是预设原始值（2400x3000）或
 * 尺寸弹窗归一化值（2400x3008，16 倍数是 Provider 请求约束而非资产约束）。
 * 经 resolveExactDeliverySize 反查预设表，交付目标一律解析到精确比例的
 * 预设原始值；与请求侧（normalizeImageSize）彻底解耦。
 */
export function getExactImageSizeTarget(params: Pick<TaskParams, 'size' | 'exact_size'>): ImageSize | null {
  if (!params.exact_size || params.size === 'auto') return null
  return resolveExactDeliverySize(params.size)
}

export function getExactImageCanonicalSourceSize(source: ImageSize, target: ImageSize): ImageSize {
  if (ratioMatchesExactly(source, target)) return { ...source }

  const targetRatio = formatExactRatio(target.width, target.height)
  const baseSize = targetRatio ? calculateImageSize('1K', targetRatio) : null
  const base = baseSize ? parseImageSize(baseSize) : null
  return deriveExactSourceTarget(base ?? source, target)
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
  // P0-D：所有输出格式共享同一 Lanczos3 像素（编码格式只能改变编码，不能
  // 改变几何采样结果）。Worker 固定产出 PNG；JPEG/WebP 只做 1:1 编码转换，
  // canvas 在该分支是纯编码器（不做任何重采样）。编码失败不得让整张已计费
  // 图片失败——回退无损 PNG 输出并显式记录原因（对抗审查 P1-1）。
  const resized = await resizeImageHighQualityDetailed(dataUrl, target.width, target.height, fitMode)
  let outputDataUrl = resized.dataUrl
  let encoderFallbackReason: string | undefined
  if (outputFormat !== 'png') {
    let bitmap: ImageBitmap | null = null
    try {
      const pngBlob = await (await fetch(resized.dataUrl)).blob()
      bitmap = await createImageBitmap(pngBlob)
      const canvas = document.createElement('canvas')
      canvas.width = target.width
      canvas.height = target.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is unavailable in this browser')
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(bitmap, 0, 0)
      outputDataUrl = await exportCanvas(canvas, outputFormat)
    } catch (error) {
      console.warn('目标格式编码失败，回退无损 PNG 输出', error)
      encoderFallbackReason = error instanceof Error ? error.message : String(error)
      outputDataUrl = resized.dataUrl
    } finally {
      bitmap?.close?.()
    }
  }

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
    resizerBackend: resized.backend,
    ...(resized.fallbackReason ? { resizerFallbackReason: resized.fallbackReason } : {}),
    ...(encoderFallbackReason ? { encoderFallbackReason } : {}),
  }
}
