import { loadImage } from './canvasImage'
import { blobToDataUrl } from './dataUrl'
import { computeExactSizeDrawPlan, type ExactSizeDrawPlan } from './exactImageSize'
import type { InputRatioPolicy } from '../types'

/**
 * 编辑链路画幅防御第一层：输入图比例预处理。
 *
 * 网关编辑链路（responses tool 与 images/edits 实测一致）输出画幅 = 输入图原尺寸，
 * 请求侧 size 参数被无视。因此编辑任务控画幅的正解是在提交前把输入图处理到目标比例：
 * - crop：cover 裁切（复用 computeExactSizeDrawPlan），几何安全；
 * - outpaint：原图等比缩放置于目标比例画布中央（限制轴 scale=1，原图永不被放大），
 *   空出的过渡带以「镜像翻转 + 线性羽化 + 边缘拉伸底色」填充，配合提示词指令
 *   让模型按新画幅补全边缘内容。
 *
 * 处理只在小图上进行：输入图先缩到 ≤1536 长边，控制 canvas 开销（网关侧还会
 * 按输入图出图，输入图分辨率决定输出档位，1536 长边已是 1K 档上限）。
 */

export type ResolvedInputRatioPolicy = 'crop' | 'outpaint' | 'none'

/** 预处理前输入图先缩到的长边上限 */
export const INPUT_PREPROCESS_MAX_LONG_EDGE = 1536
/** auto 策略的比例偏差阈值：输入图比例与目标比例相对偏差超过 2% 才触发 crop */
export const INPUT_RATIO_AUTO_DEVIATION_THRESHOLD = 0.02
/** outpaint 策略拼在提示词开头的功能性扩边指令 */
export const OUTPAINT_PROMPT_HINT = '对画面边缘做无缝延展补全，与原图自然衔接，不要出现镜像重复的图案。'

export interface InputImageSource {
  dataUrl: string
  width?: number
  height?: number
}

export interface PreprocessedInputImage {
  dataUrl: string
  width: number
  height: number
}

export interface InputPreprocessResult {
  images: PreprocessedInputImage[]
  policy: ResolvedInputRatioPolicy
  /** 仅 outpaint 时返回，由调用方拼在提示词开头 */
  promptHint?: string
}

/** 计算源图比例相对目标比例的相对偏差（|rs - rt| / rt），0 表示比例一致 */
export function getInputRatioDeviation(
  source: { width: number; height: number },
  target: { width: number; height: number },
): number {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) return 0
  const sourceRatio = source.width / source.height
  const targetRatio = target.width / target.height
  return Math.abs(sourceRatio - targetRatio) / targetRatio
}

/** 解析用户策略为实际执行策略；auto 按比例偏差 >2% 折叠为 crop，否则不处理 */
export function resolveInputRatioPolicy(
  policy: InputRatioPolicy | undefined,
  imageSizes: Array<{ width?: number; height?: number }>,
  target: { width: number; height: number },
  autoDeviationThreshold = INPUT_RATIO_AUTO_DEVIATION_THRESHOLD,
): ResolvedInputRatioPolicy {
  if (imageSizes.length === 0 || target.width <= 0 || target.height <= 0) return 'none'
  if (policy === 'crop' || policy === 'outpaint') return policy
  if (policy === 'off') return 'none'
  // auto（含缺省）：任一输入图比例偏差超阈值才裁切；表情生图等画幅本就匹配的通道不受影响
  if (!policy || policy === 'auto') {
    return imageSizes.some((size) =>
      getInputRatioDeviation({ width: size.width ?? 0, height: size.height ?? 0 }, target) > autoDeviationThreshold,
    ) ? 'crop' : 'none'
  }
  return 'none'
}

export interface InputCoverCropLayout {
  canvasWidth: number
  canvasHeight: number
  plan: ExactSizeDrawPlan
}

/**
 * cover 裁切布局：画布尺寸按目标比例、限制轴对齐原图（scale=1，只裁不放大），
 * 裁切几何复用 computeExactSizeDrawPlan。
 */
export function computeInputCoverCropLayout(
  source: { width: number; height: number },
  target: { width: number; height: number },
): InputCoverCropLayout {
  const targetRatio = target.width / target.height
  const sourceRatio = source.width / source.height
  const canvasWidth = sourceRatio > targetRatio
    ? Math.max(1, Math.round(source.height * targetRatio))
    : source.width
  const canvasHeight = sourceRatio > targetRatio
    ? source.height
    : Math.max(1, Math.round(source.width / targetRatio))
  return {
    canvasWidth,
    canvasHeight,
    plan: computeExactSizeDrawPlan(source, { width: canvasWidth, height: canvasHeight }, 'cover'),
  }
}

export interface InputOutpaintLayout {
  canvasWidth: number
  canvasHeight: number
  /** 原图在画布上的放置区（scale=1，限制轴与画布齐平） */
  drawX: number
  drawY: number
  drawWidth: number
  drawHeight: number
  /** 四周过渡带宽度（其中相对轴两侧必为 0） */
  bandLeft: number
  bandRight: number
  bandTop: number
  bandBottom: number
}

/**
 * outpaint 布局：原图整幅可见地放在目标比例画布中央，限制轴 scale=1（原图不被放大），
 * 另一轴的空带平均分到两侧。比例已一致时各带宽为 0。
 */
export function computeOutpaintLayout(
  source: { width: number; height: number },
  target: { width: number; height: number },
): InputOutpaintLayout {
  const targetRatio = target.width / target.height
  const sourceRatio = source.width / source.height
  const drawWidth = source.width
  const drawHeight = source.height
  // 原图相对更宽 → 画布按原图高打平、纵向更长（上下补边）；反之左右补边
  const canvasWidth = sourceRatio > targetRatio
    ? drawWidth
    : Math.max(drawWidth, Math.round(drawHeight * targetRatio))
  const canvasHeight = sourceRatio > targetRatio
    ? Math.max(drawHeight, Math.round(drawWidth / targetRatio))
    : drawHeight
  const drawX = Math.floor((canvasWidth - drawWidth) / 2)
  const drawY = Math.floor((canvasHeight - drawHeight) / 2)
  return {
    canvasWidth,
    canvasHeight,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
    bandLeft: drawX,
    bandRight: canvasWidth - drawWidth - drawX,
    bandTop: drawY,
    bandBottom: canvasHeight - drawHeight - drawY,
  }
}

const canvasToBlob = (canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('canvas export failed')), mime, quality)
  })

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable in this browser')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return canvas
}

async function canvasToPngDataUrl(canvas: HTMLCanvasElement): Promise<string> {
  return blobToDataUrl(await canvasToBlob(canvas, 'image/png'), 'image/png')
}

/** 输入图先缩到 ≤1536 长边，后续处理都在小图坐标上进行 */
async function createWorkingCanvas(dataUrl: string, rawWidth: number, rawHeight: number): Promise<HTMLCanvasElement> {
  const longEdge = Math.max(rawWidth, rawHeight)
  if (longEdge <= INPUT_PREPROCESS_MAX_LONG_EDGE) {
    const canvas = createCanvas(rawWidth, rawHeight)
    const image = await loadImage(dataUrl)
    canvas.getContext('2d')!.drawImage(image, 0, 0, rawWidth, rawHeight)
    return canvas
  }
  const scale = INPUT_PREPROCESS_MAX_LONG_EDGE / longEdge
  const width = Math.max(1, Math.round(rawWidth * scale))
  const height = Math.max(1, Math.round(rawHeight * scale))
  const canvas = createCanvas(width, height)
  const image = await loadImage(dataUrl)
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height)
  return canvas
}

export interface BandFillRect {
  sx: number
  sy: number
  sWidth: number
  sHeight: number
  dx: number
  dy: number
  dWidth: number
  dHeight: number
}

/**
 * 过渡带填充：镜像翻转 + 线性羽化。
 * - 底层：把紧邻原图边界的 1px 边缘条拉伸铺满过渡带（保证带外侧颜色自然延续）；
 * - 上层：把原图贴边的条带镜像翻转画进独立的 bandCanvas，用线性渐变 alpha
 *   （接缝处不透明 → 外侧全透明）做羽化后，再整体叠在拉伸底色之上，
 *   消除镜像接缝的硬边。
 * 镜像源条带超出原图尺寸时按原图尺寸截断（超出部分只保留拉伸底色）。
 *
 * 合成顺序要点：镜像条带只能先在 bandCanvas 内完成渐变、再叠上主画布。
 * 若先把镜像画上主画布、再从主画布取同区域内容做渐变，同内容 alpha=g 叠在
 * alpha=1 的同内容上合成恒为原色，羽化会成为视觉空操作（T2 审查 Critical 1）。
 */
export function fillMirrorBand(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  seamSide: 'left' | 'right' | 'top' | 'bottom',
  rect: BandFillRect,
) {
  const horizontal = seamSide === 'left' || seamSide === 'right'
  const bandLength = horizontal ? rect.dWidth : rect.dHeight
  if (bandLength <= 0) return

  // 底层：边缘 1px 条带拉伸铺满过渡带
  const edgeSourceWidth = horizontal ? 1 : rect.sWidth
  const edgeSourceHeight = horizontal ? rect.sHeight : 1
  const edgeSx = seamSide === 'right' ? rect.sx + rect.sWidth - 1 : rect.sx
  const edgeSy = seamSide === 'bottom' ? rect.sy + rect.sHeight - 1 : rect.sy
  ctx.drawImage(source, edgeSx, edgeSy, edgeSourceWidth, edgeSourceHeight, rect.dx, rect.dy, rect.dWidth, rect.dHeight)

  // 上层：镜像条带（截断到原图范围内）
  const mirrorLength = Math.min(bandLength, horizontal ? rect.sWidth : rect.sHeight)
  if (mirrorLength <= 0) return
  const mirror: BandFillRect = horizontal
    ? {
        sx: seamSide === 'left' ? rect.sx : rect.sx + rect.sWidth - mirrorLength,
        sy: rect.sy,
        sWidth: mirrorLength,
        sHeight: rect.sHeight,
        dx: seamSide === 'left' ? rect.dx + bandLength - mirrorLength : rect.dx,
        dy: rect.dy,
        dWidth: mirrorLength,
        dHeight: rect.dHeight,
      }
    : {
        sx: rect.sx,
        sy: seamSide === 'top' ? rect.sy : rect.sy + rect.sHeight - mirrorLength,
        sWidth: rect.sWidth,
        sHeight: mirrorLength,
        dx: rect.dx,
        dy: seamSide === 'top' ? rect.dy + bandLength - mirrorLength : rect.dy,
        dWidth: rect.dWidth,
        dHeight: mirrorLength,
      }

  // 镜像条带只画进 bandCanvas（bandCanvas 原点对应主画布 (rect.dx, rect.dy)），
  // 不先画主画布——否则后续渐变叠加会被同内容的全不透明底色吞掉。
  const bandCanvas = createCanvas(rect.dWidth, rect.dHeight)
  const bandCtx = bandCanvas.getContext('2d')!
  bandCtx.save()
  bandCtx.translate(
    mirror.dx - rect.dx + mirror.dWidth / 2,
    mirror.dy - rect.dy + mirror.dHeight / 2,
  )
  if (horizontal) bandCtx.scale(-1, 1)
  else bandCtx.scale(1, -1)
  bandCtx.drawImage(
    source,
    mirror.sx,
    mirror.sy,
    mirror.sWidth,
    mirror.sHeight,
    -mirror.dWidth / 2,
    -mirror.dHeight / 2,
    mirror.dWidth,
    mirror.dHeight,
  )
  bandCtx.restore()

  // 羽化：以「贴原图的一侧」为不透明端向带外渐隐（destination-in 只作用于镜像副本）
  bandCtx.globalCompositeOperation = 'destination-in'
  const gradient = horizontal
    ? bandCtx.createLinearGradient(seamSide === 'left' ? rect.dWidth : 0, 0, seamSide === 'left' ? 0 : rect.dWidth, 0)
    : bandCtx.createLinearGradient(0, seamSide === 'top' ? rect.dHeight : 0, 0, seamSide === 'top' ? 0 : rect.dHeight)
  gradient.addColorStop(0, 'rgba(0, 0, 0, 1)')
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  bandCtx.fillStyle = gradient
  bandCtx.fillRect(0, 0, rect.dWidth, rect.dHeight)

  // 带渐变 alpha 的镜像叠在 1px 拉伸底色之上
  ctx.drawImage(bandCanvas, rect.dx, rect.dy)
}

async function processImage(
  image: InputImageSource,
  target: { width: number; height: number },
  policy: 'crop' | 'outpaint',
): Promise<PreprocessedInputImage> {
  const raw = image.width && image.width > 0 && image.height && image.height > 0
    ? { width: image.width, height: image.height }
    : await probeImageSize(image.dataUrl)
  const working = await createWorkingCanvas(image.dataUrl, raw.width, raw.height)

  if (policy === 'crop') {
    const layout = computeInputCoverCropLayout(
      { width: working.width, height: working.height },
      target,
    )
    const canvas = createCanvas(layout.canvasWidth, layout.canvasHeight)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(
      working,
      layout.plan.drawX,
      layout.plan.drawY,
      layout.plan.drawWidth,
      layout.plan.drawHeight,
    )
    return { dataUrl: await canvasToPngDataUrl(canvas), width: canvas.width, height: canvas.height }
  }

  const layout = computeOutpaintLayout({ width: working.width, height: working.height }, target)
  const canvas = createCanvas(layout.canvasWidth, layout.canvasHeight)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(working, layout.drawX, layout.drawY)
  fillMirrorBand(ctx, working, 'left', {
    sx: 0,
    sy: 0,
    sWidth: layout.drawX,
    sHeight: working.height,
    dx: 0,
    dy: layout.drawY,
    dWidth: layout.bandLeft,
    dHeight: layout.drawHeight,
  })
  fillMirrorBand(ctx, working, 'right', {
    sx: working.width - layout.bandRight,
    sy: 0,
    sWidth: layout.bandRight,
    sHeight: working.height,
    dx: layout.drawX + layout.drawWidth,
    dy: layout.drawY,
    dWidth: layout.bandRight,
    dHeight: layout.drawHeight,
  })
  fillMirrorBand(ctx, working, 'top', {
    sx: 0,
    sy: 0,
    sWidth: working.width,
    sHeight: layout.drawY,
    dx: layout.drawX,
    dy: 0,
    dWidth: layout.drawWidth,
    dHeight: layout.bandTop,
  })
  fillMirrorBand(ctx, working, 'bottom', {
    sx: 0,
    sy: working.height - layout.bandBottom,
    sWidth: working.width,
    sHeight: layout.bandBottom,
    dx: layout.drawX,
    dy: layout.drawY + layout.drawHeight,
    dWidth: layout.drawWidth,
    dHeight: layout.bandBottom,
  })
  return { dataUrl: await canvasToPngDataUrl(canvas), width: canvas.width, height: canvas.height }
}

async function probeImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(dataUrl)
  return { width: image.naturalWidth, height: image.naturalHeight }
}

/**
 * 把编辑任务的输入图预处理到目标比例。
 * policy 解析见 resolveInputRatioPolicy；未触发处理时原样返回输入图。
 */
export async function preprocessInputImagesForTarget(
  images: InputImageSource[],
  target: { width: number; height: number },
  policy: InputRatioPolicy | undefined,
  options: { autoDeviationThreshold?: number } = {},
): Promise<InputPreprocessResult> {
  const measured = await Promise.all(images.map(async (image) => {
    if (image.width && image.width > 0 && image.height && image.height > 0) {
      return { dataUrl: image.dataUrl, width: image.width, height: image.height }
    }
    const size = await probeImageSize(image.dataUrl)
    return { dataUrl: image.dataUrl, ...size }
  }))
  const resolved = resolveInputRatioPolicy(
    policy,
    measured,
    target,
    options.autoDeviationThreshold,
  )
  if (resolved === 'none') {
    return { images: measured, policy: 'none' }
  }
  const processed: PreprocessedInputImage[] = []
  for (const image of measured) {
    processed.push(await processImage(image, target, resolved))
  }
  return {
    images: processed,
    policy: resolved,
    promptHint: resolved === 'outpaint' ? OUTPAINT_PROMPT_HINT : undefined,
  }
}
