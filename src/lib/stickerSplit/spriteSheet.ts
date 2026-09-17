// 战斗动作精灵图（Sprite Sheet）管线 —— X 文章 @8co28 的产品化实现。
// 文章流程：GPT-Image 2.5 生成 4×4 战斗动作 sprite sheet → 背景透明化 → 按格分解
// → 帧间位置对齐（registration）→ 合成 GIF。本实现把后四步全部收敛为本地确定性算法：
// 绿幕键控去底 → N×N 沟槽/几何切格 → 单主体守卫+紧裁 → 质心 registration 对齐
// → 统一画布帧序列（GIF/APNG 导出复用既有 encodeGif / TimelineRenderer）。
// 与 2×2 姿势表（actionFrames.ts 小幅局部动作）互补：本管线面向大幅战斗动作序列。
import { callImageApi } from '../api'
import { buildTransparentPrompt, removeKeyedBackgroundFromDataUrl } from '../transparentImage'
import { extractLargestComponent } from './engine'
import type { AppSettings, TaskParams } from '../../types'
import { loadImage } from '../canvasImage'

// ---------------------------------------------------------------------------
// 动作预设（大幅战斗动作序列，帧序左→右、上→下，首尾衔接成循环）
// ---------------------------------------------------------------------------

export interface SpriteMotionPreset {
  id: string
  label: string
  /** 动作语义（喂给 sprite sheet 提示词的连续动作描述） */
  motion: string
}

export const SPRITE_MOTION_PRESETS: SpriteMotionPreset[] = [
  { id: 'sword-slash', label: '挥剑连斩', motion: '完整的挥剑攻击循环：拔剑预备、举剑过顶蓄力、斜劈而下、剑光收势、回剑入鞘、回到起始站姿' },
  { id: 'punch-combo', label: '出拳连击', motion: '完整的拳击连击循环：格斗架势、右直拳、左勾拳、重拳爆发、收拳、回到格斗架势' },
  { id: 'cast-spell', label: '施法循环', motion: '完整的施法循环：双手合拢聚气、法力光效在掌心汇聚、向前推出释放、光芒消散、回到起始站姿' },
  { id: 'run-cycle', label: '奔跑循环', motion: '完整的侧面奔跑循环：支撑、腾空、换腿、再支撑，四肢摆动连贯，帧间等间隔，形成无缝跑步循环' },
  { id: 'hit-recover', label: '受击翻滚', motion: '完整的受击循环：被击中后仰、身体失去平衡、向后翻滚一圈、单膝撑地、起身回到站姿' },
  { id: 'battle-idle', label: '战斗待机', motion: '战斗待机循环：压低重心摆出战斗姿态、轻微左右晃动蓄力、肩膀起伏呼吸、回到姿态，小幅但清晰' },
  { id: 'jump-slam', label: '跳跃劈砍', motion: '完整的跳跃劈砍循环：下蹲蓄力、跃起至最高点、空中举武器过顶、下劈落地砸出冲击、起身、回到站姿' },
  { id: 'bow-shot', label: '拉弓射击', motion: '完整的射箭循环：取箭搭弦、拉满弓瞄准、撒放箭矢、收弓、回到站姿' },
]

export function getSpriteMotionPreset(id: string): SpriteMotionPreset | undefined {
  return SPRITE_MOTION_PRESETS.find((p) => p.id === id)
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const SPRITE_SAME_CHARACTER = [
  '所有格子里必须是完全相同的同一个角色：相同的外貌、发型、服装、道具、配色、画风与线条风格；相同视角与光照',
  '每格一个独立完整的动作帧，角色居中、大小基本一致，格与格之间边界清晰、互不粘连',
  '整图不加任何文字、编号、边框、网格线，禁止在角色背后加底板、卡片或任何衬底'
].join('。')

export interface SpriteSheetPromptOptions {
  motionId: string
  rows?: number
  cols?: number
  /** 有参考图时为编辑模式（角色一致性靠参考图），措辞相应调整 */
  hasReference?: boolean
  /** 用户对角色的补充描述（无参考图时的角色定义，或附加要求） */
  characterNote?: string
}

export function buildSpriteSheetPrompt(opts: SpriteSheetPromptOptions): string {
  const preset = getSpriteMotionPreset(opts.motionId)
  const motion = preset?.motion ?? opts.motionId
  const rows = Math.max(2, Math.min(6, opts.rows ?? 4))
  const cols = Math.max(2, Math.min(6, opts.cols ?? 4))
  const count = rows * cols
  const lines = [
    `[任务] 生成一张 ${rows}×${cols} 网格的游戏角色战斗动作精灵图 sprite sheet：${rows} 行 ${cols} 列共 ${count} 个格子。`,
    `[帧序] 从左到右、从上到下依次呈现一个完整流畅的动作循环（${motion}）；最后一格的动作要能自然衔接回第一格，形成无缝循环。`,
    opts.hasReference
      ? `[角色] 严格保持参考图中的角色不变：完全相同的外貌、发型、服装、道具、配色、画风与线条风格，只有姿势和动作不同。`
      : `[角色] 设计一个特征鲜明的单个游戏角色并全程保持完全一致${opts.characterNote ? `：${opts.characterNote}` : ''}。`,
    `[动作] 每格是一个关键动作帧，动作幅度大、姿态差异明显，帧与帧之间动作连续可读（类逐帧动画截图）。`,
    `${SPRITE_SAME_CHARACTER}。`,
    '整张图背景为纯绿色 #00FF00：均匀纯色，无渐变、无阴影、无地面、无环境元素；角色不能与背景融合，主体上不得出现大面积纯绿色。',
  ]
  if (opts.characterNote && opts.hasReference) lines.push(`[补充要求] ${opts.characterNote}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// N×N 切格（2×2 版 actionFrames.splitPoseSheetCells 的泛化）
// ---------------------------------------------------------------------------

/** 行/列透明沟槽带检测（透明率 ≥98.5% 的内部带）→ 纯函数，可单测。 */
export function detectTransparentBands(
  transparency: (index: number) => number,
  n: number,
  opts: { minRate?: number } = {},
): Array<[number, number]> {
  const minRate = opts.minRate ?? 0.985
  const out: Array<[number, number]> = []
  let start = -1
  for (let i = 0; i < n; i++) {
    const v = transparency(i) >= minRate
    if (v && start < 0) start = i
    if (!v && start >= 0) {
      out.push([start, i - 1])
      start = -1
    }
  }
  if (start >= 0) out.push([start, n - 1])
  // 内部带：不贴边（贴边的全透明带是画布留白，不是格间沟槽）
  return out.filter(([s, e]) => s > 0 && e < n - 1)
}

/** 由格间沟槽带推导切分坐标（期望 rows-1 条行带 / cols-1 条列带）；带数不符返回 null。 */
export function bandCoords(
  bands: Array<[number, number]>,
  n: number,
  cells: number,
): Array<[number, number]> | null {
  if (bands.length !== cells - 1) return null
  const edges: Array<[number, number]> = []
  let cursor = 0
  for (const [s, e] of bands) {
    edges.push([cursor, s - 1])
    cursor = e + 1
  }
  edges.push([cursor, n - 1])
  return edges
}

/** 几何等分坐标（沟槽检测失败时的退化路径）。 */
export function evenCoords(n: number, cells: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const step = n / cells
  for (let i = 0; i < cells; i++) out.push([Math.round(i * step), Math.round((i + 1) * step) - 1])
  return out
}

export interface SpriteCellGrid {
  rows: number
  cols: number
  /** 每格 [x0, y0, x1, y1]（含端点） */
  cells: Array<[number, number, number, number]>
  /** true=按透明沟槽切，false=几何等分退化 */
  byTroughs: boolean
}

/** 精灵图切格坐标决策：优先沟槽带（内容自适应），退化几何等分。纯函数。 */
export function planSpriteCellGrid(
  rowTransparency: (y: number) => number,
  colTransparency: (x: number) => number,
  width: number,
  height: number,
  rows: number,
  cols: number,
): SpriteCellGrid {
  const rb = bandCoords(detectTransparentBands(rowTransparency, height), height, rows)
  const cb = bandCoords(detectTransparentBands(colTransparency, width), width, cols)
  const byTroughs = rb !== null && cb !== null
  const ry = rb ?? evenCoords(height, rows)
  const cx = cb ?? evenCoords(width, cols)
  const cells: Array<[number, number, number, number]> = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push([cx[c][0], ry[r][0], cx[c][1], ry[r][1]])
    }
  }
  return { rows, cols, cells, byTroughs }
}

// ---------------------------------------------------------------------------
// 帧间主体对齐（registration，文章的「位置合わせ」本地算法化）
// ---------------------------------------------------------------------------

export interface SpriteSubject {
  /** 守卫+紧裁后的主体画布 */
  canvas: HTMLCanvasElement
  /** 主体在裁切画布内的 alpha 包围盒（恒等于画布四边）与 alpha 质心（画布坐标系） */
  centroid: { x: number; y: number }
  area: number
}

export interface RegisteredFrame {
  canvas: HTMLCanvasElement
  /** 该帧在统一画布内的落位偏移（相对联合包围盒原点） */
  offset: { dx: number; dy: number }
}

export interface SpriteRegistration {
  frames: RegisteredFrame[]
  canvasSize: { width: number; height: number }
}

export interface RegisterOptions {
  /** 对齐锚点：'first'=以首帧质心为基准（动作序列的标准 registration） */
  anchor?: 'first'
}

/** 单帧守卫（最大连通域）+ alpha 紧裁 → 主体画布与质心。 */
export function extractSpriteSubject(source: HTMLCanvasElement): SpriteSubject | null {
  const w = source.width
  const h = source.height
  const sctx = source.getContext('2d', { willReadFrequently: true })
  if (!sctx) throw new Error('无法创建画布上下文')
  let pixels: ImageData
  try {
    pixels = sctx.getImageData(0, 0, w, h)
  } catch {
    return null
  }
  let cropX = 0
  let cropY = 0
  let cropW = w
  let cropH = h
  // 守卫分支会把 data 换成 engine 的子集（Uint8ClampedArray<ArrayBufferLike>），
  // 声明放宽到公共上界（ImageData 构造走 new Uint8ClampedArray 拷贝，不受影响）
  let data: Uint8ClampedArray<ArrayBufferLike> = pixels.data
  try {
    const largest = extractLargestComponent({ width: w, height: h, data })
    if (largest && (largest.width < w * 0.95 || largest.height < h * 0.95)) {
      const guarded = document.createElement('canvas')
      guarded.width = largest.width
      guarded.height = largest.height
      guarded.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(largest.data), largest.width, largest.height), 0, 0)
      source = guarded
      data = largest.data
      cropW = largest.width
      cropH = largest.height
    }
  } catch {
    // 守卫失败退回整图
  }
  let minX = cropW
  let minY = cropH
  let maxX = -1
  let maxY = -1
  let area = 0
  let cx = 0
  let cy = 0
  let weightSum = 0
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const a = data[(y * cropW + x) * 4 + 3]
      if (a > 12) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        area++
        const w = a / 255
        cx += x * w
        cy += y * w
        weightSum += w
      }
    }
  }
  if (area <= 0 || maxX < 0 || weightSum <= 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = maxX - minX + 1
  canvas.height = maxY - minY + 1
  canvas.getContext('2d')?.drawImage(source, minX, minY, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
  return {
    canvas,
    // alpha 加权质心：分子与分母同为 alpha 权重（Σx·w / Σw），半透明像素（光效/辉光）
    // 按其不透明度参与锚点，帧间 alpha 分布差异不再污染 registration 基准
    centroid: { x: cx / weightSum - minX, y: cy / weightSum - minY },
    area,
  }
}

/**
 * 帧间 registration：每帧平移使 alpha 质心与基准帧（首帧）质心重合，
 * 再以全部帧的联合包围盒决定统一画布。消除生成网格里的主体位置抖动，
 * 保留动作本身的肢体变化（sprite 动画的标准对齐法，比文章「让 GPT 对齐」确定性更强）。
 */
export function registerSpriteFrames(subjects: SpriteSubject[], _opts: RegisterOptions = {}): SpriteRegistration | null {
  if (!subjects.length) return null
  const base = subjects[0]
  const placed = subjects.map((s) => {
    const dx = base.centroid.x - s.centroid.x
    const dy = base.centroid.y - s.centroid.y
    return { subject: s, dx, dy }
  })
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { subject, dx, dy } of placed) {
    minX = Math.min(minX, dx)
    minY = Math.min(minY, dy)
    maxX = Math.max(maxX, dx + subject.canvas.width)
    maxY = Math.max(maxY, dy + subject.canvas.height)
  }
  const width = Math.ceil(maxX - minX)
  const height = Math.ceil(maxY - minY)
  const frames = placed.map(({ subject, dx, dy }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')?.drawImage(subject.canvas, dx - minX, dy - minY)
    return { canvas, offset: { dx: dx - minX, dy: dy - minY } }
  })
  return { frames, canvasSize: { width, height } }
}

// ---------------------------------------------------------------------------
// QC 门（战斗动作幅度大，阈值较 2×2 姿势表放宽）
// ---------------------------------------------------------------------------

export const SPRITE_AREA_MIN_RATIO = 0.3
export const SPRITE_AREA_MAX_RATIO = 3.0

export function isSpriteAreaAcceptable(frameArea: number, medianArea: number): boolean {
  if (medianArea <= 0 || frameArea <= 0) return false
  const ratio = frameArea / medianArea
  return ratio >= SPRITE_AREA_MIN_RATIO && ratio <= SPRITE_AREA_MAX_RATIO
}

// ---------------------------------------------------------------------------
// 管线：生成 → 去底 → 切格 → 守卫/紧裁 → 对齐 → 帧序列
// ---------------------------------------------------------------------------

export interface SpriteAnimationResult {
  /** 对齐后的帧序列（统一画布，dataUrl PNG） */
  frames: string[]
  /** 原始 sprite sheet（生成返回、去底前）：查看/重切入口用 */
  sheetDataUrl: string
  /** 逐帧诊断（面积比/是否被剔除） */
  diagnostics: Array<{ index: number; areaRatio: number; dropped: boolean }>
  /** 切格方式：沟槽 or 几何退化 */
  gridMode: 'troughs' | 'even'
  byTroughs: boolean
  warnings: string[]
}

export interface ProcessSpriteSheetOptions {
  rows: number
  cols: number
}

async function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d')?.drawImage(image, 0, 0)
  return canvas
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/** 生成侧：一次 callImageApi 产出 sprite sheet（编辑模式带参考图），传输抖动 3 次退避重试。 */
export async function fetchSpriteSheet(
  settings: AppSettings,
  params: TaskParams,
  prompt: string,
  referenceDataUrl?: string,
): Promise<string> {
  let lastError: unknown = new Error('生成通道未返回图片')
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 8000 * attempt))
    try {
      const result = await callImageApi({
        settings,
        prompt,
        params: { ...params, n: 1 },
        // 消费方一律按 length 判定编辑/生成，[] 与「无参考图」语义等价
        inputImageDataUrls: referenceDataUrl ? [referenceDataUrl] : [],
      })
      const image = result.images?.[0]
      if (!image) throw new Error('生成通道未返回图片')
      return image
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 本地侧：sheet dataUrl → 去底 → 切格 → 守卫/紧裁 → 面积 QC → registration → 统一画布帧。 */
export async function processSpriteSheet(
  sheetDataUrl: string,
  opts: ProcessSpriteSheetOptions,
): Promise<SpriteAnimationResult> {
  const warnings: string[] = []
  const cleaned = await removeKeyedBackgroundFromDataUrl(sheetDataUrl)
  const sheet = await dataUrlToCanvas(cleaned)
  const sctx = sheet.getContext('2d', { willReadFrequently: true })
  if (!sctx) throw new Error('无法创建画布上下文')
  const { width: w, height: h } = sheet
  const alpha = sctx.getImageData(0, 0, w, h).data
  const rowT = (y: number) => {
    let n = 0
    for (let x = 0; x < w; x++) if (alpha[(y * w + x) * 4 + 3] <= 12) n++
    return n / w
  }
  const colT = (x: number) => {
    let n = 0
    for (let y = 0; y < h; y++) if (alpha[(y * w + x) * 4 + 3] <= 12) n++
    return n / h
  }
  const grid = planSpriteCellGrid(rowT, colT, w, h, opts.rows, opts.cols)
  if (!grid.byTroughs) warnings.push('未检测到格间透明沟槽，已按几何等分切格（若帧错位可重生成）')

  const subjects: Array<SpriteSubject | null> = grid.cells.map(([x0, y0, x1, y1]) => {
    const cell = document.createElement('canvas')
    cell.width = x1 - x0 + 1
    cell.height = y1 - y0 + 1
    cell.getContext('2d')?.drawImage(sheet, x0, y0, cell.width, cell.height, 0, 0, cell.width, cell.height)
    try {
      return extractSpriteSubject(cell)
    } catch {
      return null
    }
  })

  const areas = subjects.map((s) => s?.area ?? 0)
  const medianArea = median(areas.filter((a) => a > 0))
  const kept: Array<{ index: number; subject: SpriteSubject; areaRatio: number }> = []
  const diagnostics: SpriteAnimationResult['diagnostics'] = []
  subjects.forEach((s, index) => {
    const areaRatio = medianArea > 0 ? (s?.area ?? 0) / medianArea : 0
    const ok = s != null && isSpriteAreaAcceptable(s.area, medianArea)
    diagnostics.push({ index, areaRatio, dropped: !ok })
    if (ok && s) kept.push({ index, subject: s, areaRatio })
    else if (s != null) warnings.push(`第 ${index + 1} 格主体面积异常（比例 ${areaRatio.toFixed(2)}），已剔除`)
    else warnings.push(`第 ${index + 1} 格为空格，已剔除`)
  })
  if (kept.length < Math.max(2, Math.floor((opts.rows * opts.cols) * 0.5))) {
    throw new Error(`有效帧过少（${kept.length}/${opts.rows * opts.cols}），sprite sheet 质量不合格，请重试`)
  }

  const registration = registerSpriteFrames(kept.map((k) => k.subject))
  if (!registration) throw new Error('帧对齐失败')
  return {
    frames: registration.frames.map((f) => f.canvas.toDataURL('image/png')),
    // 透传原始 sheet：工坊「查看原图/重切」入口需要（generateSpriteAnimation 由此填充）
    sheetDataUrl,
    diagnostics,
    gridMode: grid.byTroughs ? 'troughs' : 'even',
    byTroughs: grid.byTroughs,
    warnings,
  }
}

/** 编排：生成（重试内建）+ 本地管线；QC 失败按纪律最多重生一次。 */
export async function generateSpriteAnimation(
  settings: AppSettings,
  params: TaskParams,
  opts: SpriteSheetPromptOptions & ProcessSpriteSheetOptions,
  referenceDataUrl?: string,
): Promise<SpriteAnimationResult> {
  const prompt = buildTransparentPrompt(buildSpriteSheetPrompt(opts))
  let lastError: unknown = new Error('sprite sheet 生成失败')
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 10000))
    const sheetDataUrl = await fetchSpriteSheet(settings, params, prompt, referenceDataUrl)
    try {
      // processSpriteSheet 透传 sheetDataUrl，结果的「原始 sheet」由此填充
      return await processSpriteSheet(sheetDataUrl, opts)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
