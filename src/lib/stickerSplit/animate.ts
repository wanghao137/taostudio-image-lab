// 贴纸动图核心：刚体运动预设 + 帧序列调度 + 画面合成。
// 设计原则：聊天贴纸的原生语法是低帧数有限动画（2~9 帧姿势轮播 + 刚体动效），
// 所有计算确定性、纯函数化，预览与导出走同一条时间线，所见即所得。

export type MotionPreset = 'none' | 'bounce' | 'sway' | 'heartbeat' | 'float' | 'shake'

export const MOTION_PRESETS: Array<{ value: MotionPreset; label: string }> = [
  { value: 'none', label: '无' },
  { value: 'bounce', label: '弹跳' },
  { value: 'sway', label: '摇摆' },
  { value: 'heartbeat', label: '心跳' },
  { value: 'float', label: '浮动' },
  { value: 'shake', label: '抖动' },
]

/** 相对画布中心的刚体变换；位移/缩放为画布尺寸比例，旋转为弧度。 */
export interface MotionTransform {
  dx: number
  dy: number
  rotate: number
  scaleX: number
  scaleY: number
}

const IDENTITY: MotionTransform = { dx: 0, dy: 0, rotate: 0, scaleX: 1, scaleY: 1 }
const TAU = Math.PI * 2

/** t ∈ [0,1) 为循环相位。动效幅度按内容占画布 72% 设计，不会出画。 */
export function motionAt(preset: MotionPreset, t: number): MotionTransform {
  switch (preset) {
    case 'none':
      return IDENTITY
    case 'bounce': {
      // 两个弹跳周期：落地瞬间 squash（压扁拉伸），腾空最高点位移最大
      const hop = Math.abs(Math.sin(TAU * t))
      const squash = Math.max(0, 1 - hop * 4)
      return { dx: 0, dy: -0.09 * hop, rotate: 0, scaleX: 1 + 0.08 * squash, scaleY: 1 - 0.12 * squash }
    }
    case 'sway':
      return { ...IDENTITY, rotate: 0.12 * Math.sin(TAU * t) }
    case 'heartbeat': {
      // 双跳脉搏：主搏 + 次搏
      const beat = Math.exp(-(((t - 0.12) / 0.045) ** 2)) + 0.55 * Math.exp(-(((t - 0.32) / 0.05) ** 2))
      const s = 1 + 0.08 * beat
      return { ...IDENTITY, scaleX: s, scaleY: s }
    }
    case 'float':
      return { ...IDENTITY, dy: -0.03 * Math.sin(TAU * t), rotate: 0.025 * Math.sin(TAU * t + Math.PI / 3) }
    case 'shake':
      return { ...IDENTITY, dx: 0.016 * Math.sin(TAU * t * 6), dy: 0.011 * Math.sin(TAU * t * 5 + 1) }
  }
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
    this.sources = sources
    this.uniformMaxDim = uniformMaxDim
  }

  render(step: TimelineStep, preset: MotionPreset) {
    composeAnimationFrame(this.ctx, {
      size: this.canvas.width,
      pose: step.pose,
      poseB: step.poseB,
      blend: step.blend,
      transform: motionAt(preset, step.motionT),
      sources: this.sources,
      uniformMaxDim: this.uniformMaxDim,
      tempCanvas: this.temp,
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
  transform: MotionTransform
  /** 参与序列的全部源，用于统一缩放（保持姿势间相对大小） */
  sources: ComposeSource[]
  /** 统一缩放的基准尺寸（所有姿势的最大边），调用方按选中集合预计算 */
  uniformMaxDim: number
  tempCanvas: HTMLCanvasElement
}

/** 把（可能混合的）姿势按统一缩放居中，再叠加刚体变换，画到 ctx（画布已按 size 创建）。 */
export function composeAnimationFrame(ctx: CanvasRenderingContext2D, options: ComposeFrameOptions) {
  const { size, pose, poseB, blend, transform, sources, uniformMaxDim, tempCanvas } = options
  const a = sources.find((s) => s.index === pose)
  if (!a) return
  const b = blend > 0 ? sources.find((s) => s.index === poseB) : undefined

  // 内容先在临时画布上完成混合与居中（统一缩放），再整体做刚体变换
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

  ctx.clearRect(0, 0, size, size)
  ctx.save()
  ctx.translate(size / 2 + transform.dx * size, size / 2 + transform.dy * size)
  ctx.rotate(transform.rotate)
  ctx.scale(transform.scaleX, transform.scaleY)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(tempCanvas, -contentW / 2, -contentW / 2)
  ctx.restore()
}
