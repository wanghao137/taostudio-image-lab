// 贴纸动图核心：传统动画工艺引擎 + 帧序列调度 + 画面合成。
// 工艺层对应 AI 前表情包的真实做法（Animate/AE 关键帧工艺）：
//   弹性曲线（谐波叠加模拟阻尼弹簧，非正弦刚体）／果冻形变（切片弯折，非刚体旋转）／
//   节奏（预备-主动作-余韵）／特效符号（影子、集中线、星星、怒气青筋、冲击闪白）。
// 所有分量只用 sin/cos(2πk·t) 谐波构造 → 首尾帧严格相等，循环无缝。
// 全部确定性纯函数，预览与导出走同一条时间线，所见即所得。

export type MotionPreset = 'none' | 'bounce' | 'jelly' | 'sway' | 'heartbeat' | 'float' | 'shake'

export const MOTION_PRESETS: Array<{ value: MotionPreset; label: string }> = [
  { value: 'none', label: '无' },
  { value: 'bounce', label: '弹跳' },
  { value: 'jelly', label: '果冻' },
  { value: 'sway', label: '摇摆' },
  { value: 'heartbeat', label: '心跳' },
  { value: 'float', label: '飘浮' },
  { value: 'shake', label: '怒抖' },
]

/** 单帧的完整演出状态：刚体变换 + 果冻弯折 + 特效层。位移/缩放为画布比例，旋转弧度。 */
export interface FrameState {
  dx: number
  dy: number
  rotate: number
  scaleX: number
  scaleY: number
  /** 底部固定的二次弯折幅度（顶部水平偏移，画布宽比例）；正值向右弯 */
  bend: number
  fx: FrameFx
}

export interface FrameFx {
  /** 脚下影子（落地收缩）；scale<1 收紧 */
  shadow?: { scale: number; alpha: number }
  /** 全画布白闪 alpha */
  flash?: number
  /** 集中线强度 0-1 */
  speedLines?: number
  /** 闪烁星星（画布比例坐标） */
  stars?: Array<{ x: number; y: number; size: number; alpha: number }>
  /** 怒气青筋强度 0-1（右上角） */
  anger?: number
}

const TAU = Math.PI * 2
const IDENTITY: FrameState = { dx: 0, dy: 0, rotate: 0, scaleX: 1, scaleY: 1, bend: 0, fx: {} }

/** 半波整流窗：max(0, sin(2πt·k + φ))^p —— 周期事件（跳/搏动/爆点）的谐波构造块。 */
function pulse(t: number, k: number, phase = 0, power = 1) {
  return Math.max(0, Math.sin(TAU * k * t + phase)) ** power
}

/**
 * t ∈ [0,1) 为循环相位。幅度按内容占画布 72% 设计，位移/形变不出画。
 */
export function performanceAt(preset: MotionPreset, t: number): FrameState {
  switch (preset) {
    case 'none':
      return IDENTITY
    case 'bounce': {
      // 节奏 = 预备蹲(0~0.15) → 两段抛物线跳 → 落地压扁 → 谐波余韵
      const crouch = pulse(t, 1, Math.PI, 2) * pulse(t, 1, Math.PI) // 仅周期开头为正的低包络
      const hop = pulse(t, 1, 0, 0.7) + 0.85 * pulse(t, 1, -Math.PI * 0.55, 0.7)
      const airborne = Math.min(1, hop)
      // 落地压扁强度：跳起高度趋零时最大
      const squash = pulse(1 - airborne, 1, 0, 3) * (airborne < 0.25 ? 1 : 0)
      const settle = 0.05 * Math.sin(TAU * 2 * t + 0.6) * pulse(t, 1, -Math.PI * 0.3, 1)
      return {
        dx: 0,
        dy: -0.10 * airborne - 0.02 * crouch,
        rotate: 0.02 * Math.sin(TAU * t),
        scaleX: 1 + 0.09 * squash + 0.02 * settle,
        scaleY: 1 - 0.14 * squash + 0.03 * crouch - 0.02 * settle,
        bend: 0.03 * Math.sin(TAU * t + Math.PI / 2) * airborne,
        fx: {
          shadow: { scale: 1 - 0.4 * airborne, alpha: 0.25 * (1 - 0.55 * airborne) },
        },
      }
    }
    case 'jelly': {
      // 果冻：X/Y 互补伸缩（近似保体积）+ 相位错开的弯折 → 布丁感
      const sx = 0.09 * Math.sin(TAU * t) + 0.035 * Math.sin(TAU * 3 * t)
      return {
        dx: 0,
        dy: -0.015 * Math.sin(TAU * t),
        rotate: 0,
        scaleX: 1 + sx,
        scaleY: 1 - sx * 0.9,
        bend: 0.07 * Math.sin(TAU * t + Math.PI / 2) + 0.03 * Math.sin(TAU * 3 * t + Math.PI / 2),
        fx: { shadow: { scale: 1 - 0.1 * Math.abs(Math.sin(TAU * t)), alpha: 0.2 } },
      }
    }
    case 'sway': {
      // 软体摇摆：刚体旋转 + 反相位弯折（顶端滞后）→ 不像纸板
      const r = 0.13 * Math.sin(TAU * t) + 0.02 * Math.sin(TAU * 3 * t)
      return {
        dx: 0.02 * Math.sin(TAU * t),
        dy: 0,
        rotate: r,
        scaleX: 1,
        scaleY: 1 + 0.02 * Math.sin(TAU * 2 * t),
        bend: -0.09 * Math.sin(TAU * t + 0.5) - 0.02 * Math.sin(TAU * 3 * t + 0.5),
        fx: {},
      }
    }
    case 'heartbeat': {
      // 双跳脉搏：主搏 + 次搏 + 搏点星星与微闪
      const thump = pulse(t, 1, -0.35, 6) + 0.6 * pulse(t, 1, -1.5, 6)
      const s = 1 + 0.09 * thump
      return {
        dx: 0,
        dy: -0.012 * thump,
        rotate: 0,
        scaleX: s,
        scaleY: s * (1 + 0.02 * Math.sin(TAU * t)),
        bend: 0.02 * pulse(t, 1, -0.35, 3),
        fx: {
          flash: 0.10 * thump,
          stars: [
            { x: 0.16, y: 0.2, size: 0.09, alpha: thump },
            { x: 0.85, y: 0.26, size: 0.07, alpha: 0.7 * thump },
            { x: 0.78, y: 0.12, size: 0.05, alpha: 0.5 * thump },
          ],
        },
      }
    }
    case 'float': {
      // 飘浮：慢速升降 + 慢弯折 + 三颗角落星星呼吸
      const twinkle = (phase: number) => 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(TAU * 2 * t + phase))
      return {
        dx: 0,
        dy: -0.032 * Math.sin(TAU * t) - 0.006 * Math.sin(TAU * 3 * t),
        rotate: 0.02 * Math.sin(TAU * t + Math.PI / 3),
        scaleX: 1,
        scaleY: 1 + 0.012 * Math.sin(TAU * t * 2),
        bend: 0.045 * Math.sin(TAU * t + Math.PI / 2),
        fx: {
          stars: [
            { x: 0.14, y: 0.16, size: 0.07, alpha: twinkle(0) },
            { x: 0.87, y: 0.22, size: 0.06, alpha: twinkle(2.1) },
            { x: 0.8, y: 0.84, size: 0.05, alpha: twinkle(4.2) },
          ],
        },
      }
    }
    case 'shake': {
      // 怒抖：高频颤动 + 怒气青筋脉动 + 微弯折
      const anger = 0.55 + 0.45 * Math.sin(TAU * 2 * t)
      return {
        dx: 0.015 * Math.sin(TAU * 5 * t) + 0.008 * Math.sin(TAU * 8 * t + 1),
        dy: 0.011 * Math.sin(TAU * 6 * t + 0.7) + 0.005 * Math.sin(TAU * 9 * t),
        rotate: 0.015 * Math.sin(TAU * 5 * t + 0.3),
        scaleX: 1,
        scaleY: 1,
        bend: 0.018 * Math.sin(TAU * 6 * t),
        fx: { anger },
      }
    }
  }
}

/** 兼容旧调用方：只取刚体变换部分。 */
export function motionAt(preset: MotionPreset, t: number) {
  const s = performanceAt(preset, t)
  return { dx: s.dx, dy: s.dy, rotate: s.rotate, scaleX: s.scaleX, scaleY: s.scaleY }
}

/** 姿势序列里的一个展示步骤；blend>0 表示从 pose 溶解到 poseB。 */
export interface TimelineStep {
  pose: number
  poseB: number
  blend: number
  motionT: number
  delayMs: number
}

export interface SequenceConfig {
  /** 轮播姿势（贴纸输出 index），阅读顺序。单张贴纸模式只有一项。 */
  poses: number[]
  pingPong: boolean
  /** 姿势间溶解（每转场末尾插一帧 50/50 混合） */
  crossfade: boolean
  /** 每个姿势停留时长 */
  poseMs: number
  motionPreset: MotionPreset
}

export const DEFAULT_SEQUENCE: SequenceConfig = {
  poses: [],
  pingPong: true,
  crossfade: true,
  poseMs: 160,
  motionPreset: 'bounce',
}

/** 全局帧距（12.5fps，GIF 贴图的经典节拍；帧数随总时长线性增长，文件尺寸可控）。 */
export const ANIM_FRAME_MS = 80
/** 单张动效模式的一个动作周期。 */
const SINGLE_CYCLE_FRAMES = 12

/**
 * 导出/预览共用的离散时间线：每步一帧，预览按 delayMs 步进，导出按帧编码。
 * 动效相位（motionT）跨姿势连续推进，轮播时动作不停顿。
 */
export function buildTimeline(config: SequenceConfig): TimelineStep[] {
  const poses = config.poses.length > 0 ? config.poses : [1]
  const order = config.pingPong && poses.length > 1
    ? [...poses, ...poses.slice(1, -1).reverse()]
    : poses

  // 单张模式 = 一个完整动作周期；序列模式按 poseMs 细分为 80ms 网格；无动效时无需细分
  const single = poses.length === 1
  const still = config.motionPreset === 'none'
  const framesPerStop = still ? 1 : single ? SINGLE_CYCLE_FRAMES : Math.max(1, Math.round(config.poseMs / ANIM_FRAME_MS))

  const perStop: Array<Array<{ pose: number; poseB: number; blend: number }>> = order.map((pose, i) => {
    const next = order[(i + 1) % order.length]
    const useCrossfade = config.crossfade && !single && i < order.length - 1 && next !== pose
    const hold = useCrossfade ? Math.max(1, framesPerStop - 1) : framesPerStop
    const stop: Array<{ pose: number; poseB: number; blend: number }> = []
    for (let m = 0; m < hold; m++) stop.push({ pose, poseB: pose, blend: 0 })
    if (useCrossfade) stop.push({ pose, poseB: next, blend: 0.5 })
    return stop
  })

  const totalFrames = perStop.reduce((sum, s) => sum + s.length, 0) || 1
  const steps: TimelineStep[] = []
  let index = 0
  const delay = single && !still ? ANIM_FRAME_MS : config.poseMs / framesPerStop
  for (const stop of perStop) {
    for (const frame of stop) {
      steps.push({ ...frame, motionT: index / totalFrames, delayMs: delay })
      index++
    }
  }
  return steps
}

export function timelineTotalMs(steps: TimelineStep[]): number {
  return steps.reduce((sum, s) => sum + s.delayMs, 0)
}

/** 切图输出 → 独立 canvas（贴纸动图与缩略图共用）。 */
export function outputToCanvas(canvasLike: { w: number; h: number; data: Uint8ClampedArray }): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = canvasLike.w
  canvas.height = canvasLike.h
  canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(canvasLike.data), canvasLike.w, canvasLike.h), 0, 0)
  return canvas
}

/** 时间线渲染器：预览与导出共用，保证所见即所得。 */
export class TimelineRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly temp: HTMLCanvasElement
  private readonly warp: HTMLCanvasElement
  private readonly sources: ComposeSource[]
  private readonly uniformMaxDim: number

  constructor(sources: ComposeSource[], uniformMaxDim: number, size: number) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = size
    this.canvas.height = size
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建画布上下文')
    this.ctx = ctx
    this.temp = document.createElement('canvas')
    this.warp = document.createElement('canvas')
    this.sources = sources
    this.uniformMaxDim = uniformMaxDim
  }

  render(step: TimelineStep, preset: MotionPreset) {
    composeAnimationFrame(this.ctx, {
      size: this.canvas.width,
      pose: step.pose,
      poseB: step.poseB,
      blend: step.blend,
      state: performanceAt(preset, step.motionT),
      sources: this.sources,
      uniformMaxDim: this.uniformMaxDim,
      tempCanvas: this.temp,
      warpCanvas: this.warp,
    })
    return this.canvas
  }
}

/** 内容占画布比例：给位移/旋转/缩放留安全余量。 */
export const CONTENT_RATIO = 0.72

export interface ComposeSource {
  index: number
  canvas: HTMLCanvasElement
}

export interface ComposeFrameOptions {
  size: number
  pose: number
  poseB: number
  blend: number
  state: FrameState
  /** 参与序列的全部源，用于统一缩放（保持姿势间相对大小） */
  sources: ComposeSource[]
  /** 统一缩放的基准尺寸（所有姿势的最大边），调用方按选中集合预计算 */
  uniformMaxDim: number
  tempCanvas: HTMLCanvasElement
  /** 弯折/特效所需的第二临时画布；缺省时退化为纯刚体 */
  warpCanvas?: HTMLCanvasElement
}

/** 把（可能混合的）姿势统一缩放居中 → 果冻弯折 → 刚体变换 → 特效层，画到 ctx。 */
export function composeAnimationFrame(ctx: CanvasRenderingContext2D, options: ComposeFrameOptions) {
  const { size, pose, poseB, blend, state, sources, uniformMaxDim, tempCanvas } = options
  const a = sources.find((s) => s.index === pose)
  if (!a) return
  const b = blend > 0 ? sources.find((s) => s.index === poseB) : undefined

  // 1) 姿势混合与居中（统一缩放）
  const scale = (size * CONTENT_RATIO) / Math.max(1, uniformMaxDim)
  const contentW = Math.max(1, Math.round(uniformMaxDim * scale))
  tempCanvas.width = contentW
  tempCanvas.height = contentW
  const tctx = tempCanvas.getContext('2d')
  if (!tctx) return
  tctx.clearRect(0, 0, contentW, contentW)
  const drawCentered = (source: ComposeSource, alpha: number) => {
    tctx.globalAlpha = alpha
    const w = source.canvas.width * scale
    const h = source.canvas.height * scale
    tctx.drawImage(source.canvas, (contentW - w) / 2, (contentW - h) / 2, w, h)
  }
  drawCentered(a, 1 - blend)
  if (b) drawCentered(b, blend)
  tctx.globalAlpha = 1

  // 2) 果冻弯折：底部固定，顶部按二次曲线水平偏移（切片搬移，软体感的关键）
  let content = tempCanvas
  if (Math.abs(state.bend) > 0.0005 && options.warpCanvas) {
    const warp = options.warpCanvas
    const margin = Math.ceil(Math.abs(state.bend) * contentW)
    warp.width = contentW + margin * 2
    warp.height = contentW
    const wctx = warp.getContext('2d')
    if (wctx) {
      wctx.clearRect(0, 0, warp.width, warp.height)
      const sliceH = 3
      for (let y = 0; y < contentW; y += sliceH) {
        const k = 1 - y / contentW // 顶部 k→1，底部 k→0
        const offset = state.bend * contentW * k * k
        wctx.drawImage(tempCanvas, 0, y, contentW, sliceH, margin + offset, y, contentW, sliceH)
      }
      content = warp
    }
  }

  // 3) 清屏 → 影子（在角色脚下，先画）→ 刚体变换绘制内容
  ctx.clearRect(0, 0, size, size)
  const cx = size / 2 + state.dx * size
  const cy = size / 2 + state.dy * size
  if (state.fx.shadow) {
    const footY = cy + (contentW / 2) * state.scaleY + 0.012 * size
    ctx.save()
    ctx.globalAlpha = state.fx.shadow.alpha
    ctx.fillStyle = '#000000'
    ctx.beginPath()
    ctx.ellipse(cx, Math.min(footY, size * 0.97), (contentW * 0.3) * state.fx.shadow.scale * state.scaleX, size * 0.022, 0, 0, TAU)
    ctx.fill()
    ctx.restore()
  }
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(state.rotate)
  ctx.scale(state.scaleX, state.scaleY)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(content, -content.width / 2, -contentW / 2)
  ctx.restore()

  // 4) 特效符号层（漫画语法：星星/集中线/怒气/闪白）
  drawFrameFx(ctx, size, state.fx)
}

function drawFrameFx(ctx: CanvasRenderingContext2D, size: number, fx: FrameFx) {
  if (fx.stars) {
    for (const star of fx.stars) {
      if (star.alpha <= 0.02) continue
      ctx.save()
      ctx.globalAlpha = Math.min(1, star.alpha)
      ctx.fillStyle = '#ffd93d'
      ctx.strokeStyle = '#f5a623'
      ctx.lineWidth = Math.max(1, size * 0.004)
      drawStar(ctx, star.x * size, star.y * size, 4, (star.size * size) / 2, (star.size * size) / 4.5)
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }
  if (fx.speedLines && fx.speedLines > 0.05) {
    ctx.save()
    ctx.globalAlpha = 0.5 * fx.speedLines
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = Math.max(1.2, size * 0.006)
    const cx = size / 2
    const cy = size / 2
    for (let i = 0; i < 28; i++) {
      const angle = (i / 28) * TAU + 0.11
      const jitter = 0.82 + 0.1 * Math.sin(i * 7.3)
      const r1 = size * 0.46 * jitter
      const r2 = size * 0.62 * jitter
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1)
      ctx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2)
      ctx.stroke()
    }
    ctx.restore()
  }
  if (fx.anger && fx.anger > 0.05) {
    // 漫画怒气青筋：四条短线组成的十字凸起，右上角，随强度脉动
    const s = size * 0.16 * (0.85 + 0.15 * fx.anger)
    const cx = size * 0.845
    const cy = size * 0.145
    ctx.save()
    ctx.globalAlpha = Math.min(1, 0.35 + 0.65 * fx.anger)
    ctx.strokeStyle = '#e33'
    ctx.lineWidth = Math.max(2, size * 0.011)
    ctx.lineCap = 'round'
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2
      const dx = Math.cos(a) * s * 0.5
      const dy = Math.sin(a) * s * 0.5
      ctx.beginPath()
      ctx.moveTo(cx - dx * 0.45 - dy * 0.16, cy - dy * 0.45 + dx * 0.16)
      ctx.lineTo(cx + dx * 0.8, cy + dy * 0.8)
      ctx.stroke()
    }
    ctx.restore()
  }
  if (fx.flash && fx.flash > 0.02) {
    ctx.save()
    ctx.globalAlpha = Math.min(0.5, fx.flash)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    ctx.restore()
  }
}

/** 四角星（n=4 的尖星） */
function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, spikes: number, outerR: number, innerR: number) {
  ctx.beginPath()
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR
    const a = (i * Math.PI) / spikes - Math.PI / 2
    const x = cx + Math.cos(a) * r
    const y = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}
