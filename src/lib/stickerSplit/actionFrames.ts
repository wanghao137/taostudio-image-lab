// AI 动作帧 —— da-motion-sticker-skill A 路线（Codex 关键姿势）的产品实现。
// 每张贴纸一次生成 2×2 关键姿势表（起始=复现原图 / 预备 / 峰值 / 恢复，同一角色），
// 本地键控去底 → 2×2 切格 → 单主体守卫 → 归一化 → QC（姿势差/面积比/色板自愈）。
// 循环首帧强制用原始贴纸（exact-original-static-cell）；整层仿射动画按 Skill 禁用，
// 也不是失败回退项（QC 失败最多重生一次，仍败即报错扣留该张）。
import { callImageApi } from '../api'
import { buildTransparentPrompt, removeKeyedBackgroundFromDataUrl } from '../transparentImage'
import { extractLargestComponent } from './engine'
import type { AppSettings, TaskParams } from '../../types'
import { loadImage } from '../canvasImage'

export interface ActionTemplate {
  id: string
  label: string
  /** 动作语义（喂给姿势表提示词：预备→峰值→恢复的小幅局部动作描述） */
  motion: string
}

const SAME_CHARACTER = [
  '四个格子里必须是完全相同的同一个角色：相同的外貌、发型、表情基线、服装、道具、配色、画风与线条风格；相同视角与光照；只有姿势和相应表情不同',
  '画风与渲染方式必须与参考图完全一致：相同的上色方式、材质质感、线条风格与整体色板；严禁动漫化、插画化或任何画风转变',
  '每个格子里只有一个角色单体、居中且占格子大部分；四格之间边界清晰、互不粘连、不重叠',
  '整图不加任何文字、编号、边框，禁止在角色背后加白色底板、卡片、圆角框或任何衬底',
].join('。')

// 小幅局部动作白名单（解剖 motion-sticker-pack 案例实锤：帧间主体轮廓变化仅 0.1~0.7%）。
// 免费编辑通道下每帧剪影全换等于整角色重画，一致性必崩 —— 只允许表情/头部/单臂类动作。
export const ACTION_TEMPLATES: ActionTemplate[] = [
  { id: 'blink-smile', label: '眨眼笑', motion: '眨眼笑：眼睛从睁开开心地眯成月牙形再睁开，嘴角随之扬起又回落' },
  { id: 'wave', label: '挥手', motion: '挥手：右手抬起到肩侧、小幅挥动手掌、再落回身侧' },
  { id: 'nod', label: '点头', motion: '点头：头部微微低下、低头约三十度、再抬回正中目视前方' },
  { id: 'look', label: '左右看', motion: '左右看：头和眼睛转向左侧、再转向右侧、最后回到正中目视前方' },
  { id: 'bounce', label: '原地小弹', motion: '原地小弹：微微下蹲压缩身体、轻轻踮起脚尖舒展拉高、再双脚踏实站回原样，轮廓与原图基本相同' },
]

/** 帧主体面积 QC 门（withheld 语义）：面积比基准帧偏差过大 = 疑似多主体/坏帧，拒绝。 */
export const FRAME_AREA_MIN_RATIO = 0.45
export const FRAME_AREA_MAX_RATIO = 2.2

export function isFrameAreaAcceptable(frameArea: number, baseArea: number): boolean {
  if (baseArea <= 0 || frameArea <= 0) return false
  const ratio = frameArea / baseArea
  return ratio >= FRAME_AREA_MIN_RATIO && ratio <= FRAME_AREA_MAX_RATIO
}

/** 姿势差 QC 门（Skill prepare_keyposes 同款加权：0.6*α差 + 0.4*可见加权 RGB 差，0~1） */
export const POSE_DIFF_MIN = 0.02
export const POSE_DIFF_MAX_ANY = 0.025

function opaqueArea(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return 0
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let count = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] > 128) count++
  return count
}

export function getActionTemplate(id: string): ActionTemplate | undefined {
  return ACTION_TEMPLATES.find((t) => t.id === id)
}

function buildPoseSheetPrompt(motion: string): string {
  return [
    '[任务] 生成一张 2×2 网格的关键姿势表：两行两列共四个格子。',
    `[格子顺序] 左上=起始姿势：与输入图几乎完全相同的姿势；右上=预备帧：${motion}过程中的预备姿态；左下=峰值帧：该动作最明显的姿态；右下=恢复帧：动作结束回到接近原图的姿态（不得与峰值相同）。`,
    `[动作幅度] 只做小幅局部动作（${motion}），身体其余部分完全保持不动；角色不移动位置、不改变体型。`,
    `${SAME_CHARACTER}。`,
    '整张图背景为纯绿色 #00FF00：均匀纯色，无渐变、无阴影、无地面、无环境元素；角色不能与背景融合，主体上不得出现大面积纯绿色。',
  ].join('\n')
}

/** 2×2 切格：优先透明沟槽分带（行/列透明率 ≥98.5% 的内部带），退化时按几何四分。 */
export function splitPoseSheetCells(canvas: HTMLCanvasElement): HTMLCanvasElement[] {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建画布上下文')
  const { width: w, height: h } = canvas
  const alpha = ctx.getImageData(0, 0, w, h).data
  const rowTransparent = (y: number) => {
    let n = 0
    for (let x = 0; x < w; x++) if (alpha[(y * w + x) * 4 + 3] <= 8) n++
    return n / w
  }
  const colTransparent = (x: number) => {
    let n = 0
    for (let y = 0; y < h; y++) if (alpha[(y * w + x) * 4 + 3] <= 8) n++
    return n / h
  }
  const bands = (transparent: (i: number) => number, n: number) => {
    const out: Array<[number, number]> = []
    let start = -1
    for (let i = 0; i < n; i++) {
      const v = transparent(i) >= 0.985
      if (v && start < 0) start = i
      if (!v && start >= 0) {
        out.push([start, i - 1])
        start = -1
      }
    }
    if (start >= 0) out.push([start, n - 1])
    return out
  }
  const rb = bands(rowTransparent, h).filter(([s, e]) => s > 0 && e < h - 1)
  const cb = bands(colTransparent, w).filter(([s, e]) => s > 0 && e < w - 1)
  const coords: Array<[number, number, number, number]> = []
  if (rb.length === 1 && cb.length === 1) {
    const [rx0, rx1] = rb[0]
    const [cx0, cx1] = cb[0]
    coords.push([0, 0, cx0, rx0], [cx1 + 1, 0, w - 1, rx0], [0, rx1 + 1, cx0, h - 1], [cx1 + 1, rx1 + 1, w - 1, h - 1])
  } else {
    coords.push([0, 0, w >> 1, h >> 1], [(w >> 1) + 1, 0, w - 1, h >> 1], [0, (h >> 1) + 1, w >> 1, h - 1], [(w >> 1) + 1, (h >> 1) + 1, w - 1, h - 1])
  }
  return coords.map(([x0, y0, x1, y1]) => {
    const cell = document.createElement('canvas')
    cell.width = x1 - x0 + 1
    cell.height = y1 - y0 + 1
    cell.getContext('2d')?.drawImage(canvas, x0, y0, cell.width, cell.height, 0, 0, cell.width, cell.height)
    return cell
  })
}

/** 姿势差指标（0~1）：0.6*α 差均值 + 0.4*可见加权 RGB 差均值，缩略到 96px 计算。 */
export function poseDifference(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
  const size = 96
  const thumb = (src: HTMLCanvasElement) => {
    const t = document.createElement('canvas')
    t.width = size
    t.height = size
    const tctx = t.getContext('2d', { willReadFrequently: true })
    if (!tctx) throw new Error('无法创建画布上下文')
    tctx.imageSmoothingQuality = 'high'
    tctx.drawImage(src, 0, 0, size, size)
    return tctx.getImageData(0, 0, size, size).data
  }
  const da = thumb(a)
  const db = thumb(b)
  let alphaDiff = 0
  let rgbNum = 0
  let visDen = 0
  const n = size * size
  for (let i = 0; i < n; i++) {
    const a1 = da[i * 4 + 3] / 255
    const a2 = db[i * 4 + 3] / 255
    alphaDiff += Math.abs(a1 - a2)
    const vis = Math.max(a1, a2)
    if (vis > 0) {
      rgbNum += ((Math.abs(da[i * 4] - db[i * 4]) + Math.abs(da[i * 4 + 1] - db[i * 4 + 1]) + Math.abs(da[i * 4 + 2] - db[i * 4 + 2])) / 3 / 255) * vis
      visDen += vis
    }
  }
  return 0.6 * (alphaDiff / n) + 0.4 * (rgbNum / Math.max(visDen, 1))
}

function medianRgbSolid(canvas: HTMLCanvasElement): [number, number, number] | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const { width: w, height: h } = canvas
  const data = ctx.getImageData(0, 0, w, h).data
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 3) {
      const i = (y * w + x) * 4
      if (data[i + 3] >= 200) {
        rs.push(data[i])
        gs.push(data[i + 1])
        bs.push(data[i + 2])
      }
    }
  }
  if (rs.length < 100) return null
  const mid = (arr: number[]) => arr.slice().sort((x, y) => x - y)[arr.length >> 1]
  return [mid(rs), mid(gs), mid(bs)]
}

function colorDistance(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** 色调漂移自愈：把姿势帧 RGB 逐通道分位映射到原图实体像素分布（中位色距>70 触发）。 */
export function histogramMatchTo(source: HTMLCanvasElement, reference: HTMLCanvasElement): HTMLCanvasElement {
  const refCtx = reference.getContext('2d', { willReadFrequently: true })
  const srcCtx = source.getContext('2d', { willReadFrequently: true })
  if (!refCtx || !srcCtx) throw new Error('无法创建画布上下文')
  const buildHist = (data: Uint8ClampedArray) => {
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= 200) {
        hist[0][data[i]]++
        hist[1][data[i + 1]]++
        hist[2][data[i + 2]]++
        n++
      }
    }
    return { hist, n }
  }
  const ref = buildHist(refCtx.getImageData(0, 0, reference.width, reference.height).data)
  const src = buildHist(srcCtx.getImageData(0, 0, source.width, source.height).data)
  const cdf = (hist: Uint32Array, n: number) => {
    const out = new Float64Array(256)
    let acc = 0
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      out[v] = acc / Math.max(n, 1)
    }
    return out
  }
  const refCdf = [cdf(ref.hist[0], ref.n), cdf(ref.hist[1], ref.n), cdf(ref.hist[2], ref.n)]
  const lut = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)]
  for (let c = 0; c < 3; c++) {
    let acc = 0
    let target = 0
    for (let v = 0; v < 256; v++) {
      acc += src.hist[c][v]
      const q = acc / Math.max(src.n, 1)
      while (target < 255 && refCdf[c][target + 1] < q) target++
      lut[c][v] = target
    }
  }
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const octx = out.getContext('2d')
  if (!octx) throw new Error('无法创建画布上下文')
  const img = srcCtx.getImageData(0, 0, source.width, source.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[0][d[i]]
    d[i + 1] = lut[1][d[i + 1]]
    d[i + 2] = lut[2][d[i + 2]]
  }
  octx.putImageData(img, 0, 0)
  return out
}

/** 动作帧统一归一化边长：所有帧(含原图帧)主体最长边一致，消除帧间尺度泵动。 */
export const ACTION_FRAME_SIDE = 768

function drawSquareNormalized(cropSource: HTMLCanvasElement, cropX: number, cropY: number, cropW: number, cropH: number, side: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = side
  out.height = side
  const octx = out.getContext('2d')
  if (!octx) throw new Error('无法创建画布上下文')
  octx.imageSmoothingQuality = 'high'
  // 底部锚定:主体下缘贴画布底边,水平居中。角色贴纸的稳定参照是底部基线(脚/身下缘),
  // 头部/表情动作不再牵动整体位移——stable-canvas 的"固定粘贴位置"原理。
  octx.drawImage(cropSource, cropX, cropY, cropW, cropH, (side - cropW) / 2, side - cropH, cropW, cropH)
  return out
}

/** 任意画布 → 最大连通域守卫 → alpha 紧裁 → 固定边长方形居中（底缘锚定）。 */
export function normalizeCanvasToActionFrame(source: HTMLCanvasElement): HTMLCanvasElement {
  const w = source.width
  const h = source.height
  const sctx = source.getContext('2d', { willReadFrequently: true })
  if (!sctx) throw new Error('无法创建画布上下文')

  let cropSource = source
  let cropX = 0
  let cropY = 0
  let cropW = w
  let cropH = h
  try {
    const pixels = sctx.getImageData(0, 0, w, h)
    const largest = extractLargestComponent({ width: w, height: h, data: pixels.data })
    if (largest && (largest.width < w * 0.95 || largest.height < h * 0.95)) {
      const guarded = document.createElement('canvas')
      guarded.width = largest.width
      guarded.height = largest.height
      guarded.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(largest.data), largest.width, largest.height), 0, 0)
      cropSource = guarded
      cropW = largest.width
      cropH = largest.height
    }
  } catch {
    // 守卫失败退回整图
  }

  const gctx = cropSource.getContext('2d', { willReadFrequently: true })
  if (gctx) {
    const data = gctx.getImageData(0, 0, cropW, cropH).data
    let minX = cropW
    let minY = cropH
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        if (data[(y * cropW + x) * 4 + 3] > 12) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX >= 0) {
      cropX = minX
      cropY = minY
      cropW = maxX - minX + 1
      cropH = maxY - minY + 1
    }
  }

  // 缩放到统一边长：主体最长边 → ACTION_FRAME_SIDE
  const long = Math.max(cropW, cropH)
  const scaled = document.createElement('canvas')
  scaled.width = Math.max(1, Math.round((cropW / long) * ACTION_FRAME_SIDE))
  scaled.height = Math.max(1, Math.round((cropH / long) * ACTION_FRAME_SIDE))
  const sctx2 = scaled.getContext('2d')
  if (!sctx2) throw new Error('无法创建画布上下文')
  sctx2.imageSmoothingQuality = 'high'
  sctx2.drawImage(cropSource, cropX, cropY, cropW, cropH, 0, 0, scaled.width, scaled.height)
  return drawSquareNormalized(scaled, 0, 0, scaled.width, scaled.height, ACTION_FRAME_SIDE)
}

/** dataURL → canvas（合成管线的帧源）。 */
export async function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d')?.drawImage(image, 0, 0)
  return canvas
}

export interface ActionPoseSheet {
  /** 预备/峰值/恢复三帧（已归一化到 ACTION_FRAME_SIDE 画布），起始帧由调用方用原图 */
  poses: Array<{ label: string; dataUrl: string }>
  /** 生成起始格与原图的姿势差（>0.30 说明生成器没复现原图，已强制用原始贴纸当首帧） */
  generatedStartDifference: number
  /** 三个动作帧相对原图的姿势差 */
  motionDifferences: number[]
  /** 是否触发了色板自愈 */
  paletteAutocorrect: boolean
}

/**
 * Skill A 路线核心：一次生成 2×2 姿势表 → 本地去底/切格/守卫/归一化 → QC。
 * 传输抖动自动重试（3 次退避）；QC 失败按 Skill 纪律最多重生一次，仍败抛错（不回退仿射）。
 */
export async function generateActionPoseSheet(
  settings: AppSettings,
  params: TaskParams,
  stickerDataUrl: string,
  motion: string,
): Promise<ActionPoseSheet> {
  const prompt = buildTransparentPrompt(buildPoseSheetPrompt(motion))
  const editParams: TaskParams = { ...params, n: 1 }

  const stickerCanvas = await dataUrlToCanvas(stickerDataUrl)
  const original = normalizeCanvasToActionFrame(stickerCanvas)
  const baseArea = opaqueArea(original)
  const baseMedian = medianRgbSolid(original)

  let lastError: unknown = new Error('生成通道未返回图片')
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10000))
    const sheetDataUrl = await fetchPoseSheet(settings, editParams, prompt, stickerDataUrl)
    try {
      return await processPoseSheet(sheetDataUrl, { original, baseArea, baseMedian })
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function fetchPoseSheet(settings: AppSettings, params: TaskParams, prompt: string, stickerDataUrl: string): Promise<string> {
  let lastError: unknown = new Error('生成通道未返回图片')
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 8000 * attempt))
    try {
      const result = await callImageApi({ settings, prompt, params, inputImageDataUrls: [stickerDataUrl] })
      const image = result.images?.[0]
      if (!image) throw new Error('生成通道未返回图片')
      return image
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function processPoseSheet(
  sheetDataUrl: string,
  ctx: { original: HTMLCanvasElement; baseArea: number; baseMedian: [number, number, number] | null },
): Promise<ActionPoseSheet> {
  const cleaned = await removeKeyedBackgroundFromDataUrl(sheetDataUrl)
  const sheet = await dataUrlToCanvas(cleaned)
  const cells = splitPoseSheetCells(sheet)
  if (cells.length !== 4) throw new Error(`姿势页应切出 4 格，实际 ${cells.length} 格`)
  const normalized = cells.map((c) => normalizeCanvasToActionFrame(c))
  if (normalized.some((c) => opaqueArea(c) <= 0)) throw new Error('姿势页存在空格子')

  // QC① 面积比（多主体/坏帧门）
  const areas = normalized.map((c) => opaqueArea(c))
  normalized.forEach((c, i) => {
    if (!isFrameAreaAcceptable(areas[i], ctx.baseArea) && i > 0) {
      throw new Error(`第 ${i + 1} 格主体面积异常（疑似多主体或坏帧）`)
    }
  })

  // QC② 姿势差（必须有真实姿势变化；峰值差不足 = 没有真实动作）
  const diffs = [1, 2, 3].map((i) => poseDifference(ctx.original, normalized[i]))
  if (diffs[1] < POSE_DIFF_MIN) throw new Error(`峰值与原图过于相似（差 ${diffs[1].toFixed(3)}），需真实姿势变化`)
  if (Math.max(...diffs) < POSE_DIFF_MAX_ANY) throw new Error('姿势页无有效姿势变化')

  // QC③ 色板自愈（中位色距>70 → 分位直方图匹配回原图色板）
  let paletteAutocorrect = false
  const baseMedian = ctx.baseMedian
  if (baseMedian) {
    const drifted = normalized.slice(1).some((c) => {
      const m = medianRgbSolid(c)
      return m != null && colorDistance(m, baseMedian) > 70
    })
    if (drifted) {
      for (let i = 1; i < 4; i++) normalized[i] = histogramMatchTo(normalized[i], ctx.original)
      paletteAutocorrect = true
    }
  }

  const labels = ['预备', '峰值', '恢复']
  return {
    poses: [1, 2, 3].map((i) => ({ label: labels[i - 1], dataUrl: normalized[i].toDataURL('image/png') })),
    generatedStartDifference: poseDifference(ctx.original, normalized[0]),
    motionDifferences: diffs,
    paletteAutocorrect,
  }
}
