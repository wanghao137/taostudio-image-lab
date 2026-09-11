import { describe, expect, it } from 'vitest'
import {
  computeInputCoverCropLayout,
  computeOutpaintLayout,
  getInputRatioDeviation,
  resolveInputRatioPolicy,
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
