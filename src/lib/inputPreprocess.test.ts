import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeInputCoverCropLayout,
  computeOutpaintLayout,
  fillMirrorBand,
  getInputRatioDeviation,
  resolveInputRatioPolicy,
  type BandFillRect,
} from './inputPreprocess'

describe('getInputRatioDeviation', () => {
  it('returns 0 for identical ratios regardless of pixel size', () => {
    expect(getInputRatioDeviation({ width: 1080, height: 1920 }, { width: 2160, height: 3840 })).toBe(0)
  })

  it('measures relative ratio deviation', () => {
    // 941x1672 ≈ 9:16（2160x3840），偏差约 0.05%
    expect(getInputRatioDeviation({ width: 941, height: 1672 }, { width: 2160, height: 3840 })).toBeCloseTo(0.0005, 3)
    // 1312x1199（≈11:10）对 9:16 偏差约 94.5%
    expect(getInputRatioDeviation({ width: 1312, height: 1199 }, { width: 2160, height: 3840 })).toBeCloseTo(0.9453, 3)
  })

  it('treats invalid dimensions as zero deviation', () => {
    expect(getInputRatioDeviation({ width: 0, height: 100 }, { width: 100, height: 100 })).toBe(0)
  })
})

describe('resolveInputRatioPolicy', () => {
  const target916 = { width: 2160, height: 3840 }

  it('keeps explicit crop/outpaint as-is and off/empty inputs as none', () => {
    const mismatched = [{ width: 1312, height: 1199 }]
    expect(resolveInputRatioPolicy('crop', mismatched, target916)).toBe('crop')
    expect(resolveInputRatioPolicy('outpaint', mismatched, target916)).toBe('outpaint')
    expect(resolveInputRatioPolicy('off', mismatched, target916)).toBe('none')
    expect(resolveInputRatioPolicy(undefined, mismatched, target916)).toBe('crop')
    expect(resolveInputRatioPolicy('crop', [], target916)).toBe('none')
    expect(resolveInputRatioPolicy('crop', mismatched, { width: 0, height: 0 })).toBe('none')
  })

  it('auto resolves to crop only when any input deviates beyond 2%', () => {
    expect(resolveInputRatioPolicy('auto', [{ width: 1312, height: 1199 }], target916)).toBe('crop')
    expect(resolveInputRatioPolicy('auto', [{ width: 941, height: 1672 }], target916)).toBe('none')
    // 第一张匹配、第二张偏差大 → 仍裁切（逐张处理前先整体决策）
    expect(resolveInputRatioPolicy('auto', [{ width: 941, height: 1672 }, { width: 1312, height: 1199 }], target916)).toBe('crop')
  })

  it('auto treats deviations around the threshold accordingly', () => {
    // 比例 = 目标比例 × 1.019，偏差 1.9% < 2% → 不触发
    expect(resolveInputRatioPolicy('auto', [{ width: 1019, height: 1000 }], { width: 1000, height: 1000 })).toBe('none')
    // 比例 = 目标比例 × 1.021，偏差 2.1% > 2% → 触发
    expect(resolveInputRatioPolicy('auto', [{ width: 1021, height: 1000 }], { width: 1000, height: 1000 })).toBe('crop')
  })

  it('auto with missing size metadata still deviates to crop', () => {
    expect(resolveInputRatioPolicy('auto', [{ width: 0, height: 0 }], target916)).toBe('none')
  })
})

describe('computeInputCoverCropLayout', () => {
  it('crops a ~5:4 source to 9:16 at scale 1 without upscaling', () => {
    const layout = computeInputCoverCropLayout({ width: 1312, height: 1199 }, { width: 2160, height: 3840 })
    expect(layout.canvasWidth).toBe(674)
    expect(layout.canvasHeight).toBe(1199)
    expect(layout.plan).toMatchObject({
      mode: 'cover',
      scale: 1,
      drawX: -319,
      drawY: 0,
      drawWidth: 1312,
      drawHeight: 1199,
      aspectMismatch: true,
    })
  })

  it('keeps the canvas untouched when ratios already match', () => {
    const layout = computeInputCoverCropLayout({ width: 1080, height: 1920 }, { width: 2160, height: 3840 })
    expect(layout).toMatchObject({ canvasWidth: 1080, canvasHeight: 1920 })
    expect(layout.plan.aspectMismatch).toBe(false)
  })
})

describe('computeOutpaintLayout', () => {
  it('extends vertically when a wide source is placed on a 9:16 canvas at scale 1', () => {
    const layout = computeOutpaintLayout({ width: 1312, height: 1199 }, { width: 2160, height: 3840 })
    expect(layout).toMatchObject({
      canvasWidth: 1312,
      canvasHeight: 2332,
      drawX: 0,
      drawY: 566,
      drawWidth: 1312,
      drawHeight: 1199,
      bandLeft: 0,
      bandRight: 0,
      bandTop: 566,
      bandBottom: 567,
    })
  })

  it('extends horizontally when a narrow source is placed on a square canvas', () => {
    const layout = computeOutpaintLayout({ width: 941, height: 1672 }, { width: 1024, height: 1024 })
    expect(layout).toMatchObject({
      canvasWidth: 1672,
      canvasHeight: 1672,
      drawX: 365,
      drawY: 0,
      drawWidth: 941,
      drawHeight: 1672,
      bandLeft: 365,
      bandRight: 366,
      bandTop: 0,
      bandBottom: 0,
    })
  })

  it('produces zero bands for matching ratios', () => {
    const layout = computeOutpaintLayout({ width: 1080, height: 1920 }, { width: 2160, height: 3840 })
    expect(layout).toMatchObject({
      canvasWidth: 1080,
      canvasHeight: 1920,
      drawX: 0,
      drawY: 0,
      bandLeft: 0,
      bandRight: 0,
      bandTop: 0,
      bandBottom: 0,
    })
  })
})

describe('fillMirrorBand（outpaint 羽化合成顺序回归）', () => {
  interface RecordedOp {
    kind: 'drawImage' | 'fillRect' | 'composite' | 'gradient-stop'
    args: unknown[]
    seq: number
  }
  interface FakeCanvas {
    width: number
    height: number
    getContext: (type: string) => unknown
  }

  // 记录 draw 调用序列的 fake 2D context：不执行真实像素合成，只断言管线顺序。
  // clock 在主画布与 bandCanvas 两个 context 之间共享，保证跨 context 的时序可比。
  function createFakeContext(canvas: FakeCanvas, clock: { seq: number }) {
    const ops: RecordedOp[] = []
    const record = (kind: RecordedOp['kind'], args: unknown[]) => {
      ops.push({ kind, args, seq: clock.seq++ })
    }
    let composite = 'source-over'
    const ctx = {
      canvas,
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      fillStyle: '',
      drawImage: (...args: unknown[]) => record('drawImage', args),
      fillRect: (...args: unknown[]) => record('fillRect', args),
      save: () => {},
      restore: () => {},
      translate: () => {},
      scale: () => {},
      createLinearGradient: (...args: unknown[]) => {
        record('gradient-stop', args) // 渐变创建本身也占序号，保证先建渐变后填充
        return {
          addColorStop: (...stopArgs: unknown[]) => record('gradient-stop', stopArgs),
        }
      },
    }
    Object.defineProperty(ctx, 'globalCompositeOperation', {
      get: () => composite,
      set: (value: string) => {
        composite = value
        record('composite', [value])
      },
    })
    return { ctx, ops }
  }

  // fake document：fillMirrorBand 内部经 createCanvas → document.createElement('canvas')，
  // createElement 返回的 canvas 在 getContext 时接上指定的 fake context
  function stubFakeDocument(onCreateContext: (canvas: FakeCanvas) => unknown) {
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('canvas')
        const canvas: FakeCanvas = { width: 0, height: 0, getContext: () => onCreateContext(canvas) }
        return canvas
      },
    })
  }

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: () => {
        throw new Error('unexpected canvas creation')
      },
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('镜像条带只在 bandCanvas 内 ramp，最后带渐变叠于拉伸底色之上', () => {
    // 左侧过渡带 40px 宽：底色为 1px 边缘条拉伸，镜像条带渐变后叠上
    const rect: BandFillRect = { sx: 0, sy: 0, sWidth: 40, sHeight: 80, dx: 0, dy: 10, dWidth: 40, dHeight: 80 }
    const source = { width: 80, height: 80 } as HTMLCanvasElement
    const clock = { seq: 0 }
    const main = createFakeContext({ width: 120, height: 100, getContext: () => undefined }, clock)
    const band = createFakeContext({ width: 0, height: 0, getContext: () => undefined }, clock)
    let bandCanvas: FakeCanvas | undefined
    stubFakeDocument((canvas) => {
      bandCanvas = canvas
      return band.ctx
    })

    fillMirrorBand(main.ctx as unknown as CanvasRenderingContext2D, source, 'left', rect)

    // bandCanvas 尺寸 = 过渡带尺寸
    expect(bandCanvas).toMatchObject({ width: rect.dWidth, height: rect.dHeight })

    // 主画布只允许 2 次 drawImage：第一次 = 1px 边缘条拉伸底色，最后一次 = 叠 bandCanvas
    // （这两条精确断言同时排除了「镜像条带直接画上主画布」的旧实现）
    const mainDraws = main.ops.filter((op) => op.kind === 'drawImage')
    expect(mainDraws).toHaveLength(2)
    expect(mainDraws[0]!.args).toEqual([source, 0, 0, 1, 80, 0, 10, 40, 80])
    const finalComposite = mainDraws[1]!
    expect(finalComposite.args).toEqual([bandCanvas, rect.dx, rect.dy])

    // bandCanvas 内顺序：先画镜像源，后 destination-in 渐变、fillRect
    const bandDraw = band.ops.find((op) => op.kind === 'drawImage')
    expect(bandDraw).toBeDefined()
    expect(bandDraw!.args[0]).toBe(source)
    // 羽化渐变方向：左带在贴缝一侧（x=dWidth）不透明、外缘（x=0）透明
    expect(bandDraw!.args).toEqual([source, 0, 0, 40, 80, -20, -40, 40, 80])
    const gradientCreate = band.ops.find((op) => op.kind === 'gradient-stop')
    expect(gradientCreate!.args).toEqual([40, 0, 0, 0])
    const stops = band.ops.filter((op) => op.kind === 'gradient-stop').slice(1)
    expect(stops.map((op) => op.args)).toEqual([[0, 'rgba(0, 0, 0, 1)'], [1, 'rgba(0, 0, 0, 0)']])
    const composite = band.ops.find((op) => op.kind === 'composite')
    expect(composite!.args).toEqual(['destination-in'])
    const bandFillRect = band.ops.find((op) => op.kind === 'fillRect')
    expect(bandFillRect!.args).toEqual([0, 0, 40, 80])
    expect(bandDraw!.seq).toBeLessThan(composite!.seq)
    expect(composite!.seq).toBeLessThan(bandFillRect!.seq)

    // 主画布上的最终叠放必须发生在 band 内容 ramp（fillRect）之后
    expect(bandFillRect!.seq).toBeLessThan(finalComposite.seq)
  })

  it('上侧过渡带同样先 ramp 后叠放，且渐变在贴缝一侧不透明', () => {
    const rect: BandFillRect = { sx: 0, sy: 0, sWidth: 60, sHeight: 30, dx: 5, dy: 0, dWidth: 60, dHeight: 30 }
    const source = { width: 60, height: 90 } as HTMLCanvasElement
    const clock = { seq: 0 }
    const main = createFakeContext({ width: 70, height: 120, getContext: () => undefined }, clock)
    const band = createFakeContext({ width: 0, height: 0, getContext: () => undefined }, clock)
    let bandCanvas: FakeCanvas | undefined
    stubFakeDocument((canvas) => {
      bandCanvas = canvas
      return band.ctx
    })

    fillMirrorBand(main.ctx as unknown as CanvasRenderingContext2D, source, 'top', rect)

    expect(bandCanvas).toMatchObject({ width: rect.dWidth, height: rect.dHeight })
    const mainDraws = main.ops.filter((op) => op.kind === 'drawImage')
    expect(mainDraws).toHaveLength(2)
    // 底色：垂直带用 1px 高的边缘条拉伸
    expect(mainDraws[0]!.args).toEqual([source, 0, 0, 60, 1, 5, 0, 60, 30])
    expect(mainDraws[1]!.args[0]).toBe(bandCanvas)

    const bandDraw = band.ops.find((op) => op.kind === 'drawImage')!
    // 上带镜像条带垂直翻转后画进 bandCanvas
    expect(bandDraw.args).toEqual([source, 0, 0, 60, 30, -30, -15, 60, 30])
    // 上带：贴缝在 y=dHeight 一侧不透明
    const gradientCreate = band.ops.find((op) => op.kind === 'gradient-stop')!
    expect(gradientCreate.args).toEqual([0, 30, 0, 0])
    const bandFillRect = band.ops.find((op) => op.kind === 'fillRect')!
    expect(bandFillRect.seq).toBeLessThan(mainDraws[1]!.seq)
  })
})
