import { describe, expect, it } from 'vitest'
import { computeExactSizeDrawPlan, getExactImageCanonicalSourceSize, getExactImageSizeTarget } from './exactImageSize'

describe('getExactImageCanonicalSourceSize', () => {
  it('keeps an already exact-ratio source unchanged', () => {
    expect(getExactImageCanonicalSourceSize(
      { width: 1080, height: 1920 },
      { width: 2160, height: 3840 },
    )).toEqual({ width: 1080, height: 1920 })
  })

  it('normalizes a square provider response to the requested 9:16 source canvas', () => {
    expect(getExactImageCanonicalSourceSize(
      { width: 1254, height: 1254 },
      { width: 2160, height: 3840 },
    )).toEqual({ width: 720, height: 1280 })
  })

  it('uses an integer-exact source canvas for the 21:9 final preset', () => {
    expect(getExactImageCanonicalSourceSize(
      { width: 1915, height: 821 },
      { width: 3840, height: 1646 },
    )).toEqual({ width: 1920, height: 823 })
  })
})

describe('getExactImageSizeTarget (delivery size decoupling)', () => {
  it('resolves the normalized request form to the exact preset delivery target', () => {
    // 请求侧 2400x3008（16 倍数）→ 交付 2400x3000（预设原始精确值）
    expect(getExactImageSizeTarget({ size: '2400x3008', exact_size: true })).toEqual({ width: 2400, height: 3000 })
    expect(getExactImageSizeTarget({ size: '3840x1648', exact_size: true })).toEqual({ width: 3840, height: 1646 })
  })

  it('keeps already-exact preset sizes and standard 16-multiple presets unchanged', () => {
    expect(getExactImageSizeTarget({ size: '2400x3000', exact_size: true })).toEqual({ width: 2400, height: 3000 })
    expect(getExactImageSizeTarget({ size: '3840x2160', exact_size: true })).toEqual({ width: 3840, height: 2160 })
    expect(getExactImageSizeTarget({ size: '2400x3200', exact_size: true })).toEqual({ width: 2400, height: 3200 })
  })

  it('returns null for auto size or when exact_size is off', () => {
    expect(getExactImageSizeTarget({ size: 'auto', exact_size: true })).toBeNull()
    expect(getExactImageSizeTarget({ size: '2400x3008', exact_size: false })).toBeNull()
  })
})

describe('computeExactSizeDrawPlan', () => {
  it('uses full-canvas resize when source and target ratios already match', () => {
    expect(computeExactSizeDrawPlan(
      { width: 1080, height: 1920 },
      { width: 2160, height: 3840 },
      'cover',
    )).toMatchObject({
      mode: 'cover',
      targetWidth: 2160,
      targetHeight: 3840,
      drawX: 0,
      drawY: 0,
      drawWidth: 2160,
      drawHeight: 3840,
      aspectMismatch: false,
    })
  })

  it('cover-crops horizontally when a 2:3 source is converted to 9:16', () => {
    expect(computeExactSizeDrawPlan(
      { width: 1024, height: 1536 },
      { width: 2160, height: 3840 },
      'cover',
    )).toMatchObject({
      mode: 'cover',
      scale: 2.5,
      drawX: -200,
      drawY: 0,
      drawWidth: 2560,
      drawHeight: 3840,
      aspectMismatch: true,
    })
  })

  it('contain-pads vertically when a 2:3 source is converted to 9:16', () => {
    expect(computeExactSizeDrawPlan(
      { width: 1024, height: 1536 },
      { width: 2160, height: 3840 },
      'contain',
    )).toMatchObject({
      mode: 'contain',
      scale: 2.109375,
      drawX: 0,
      drawY: 300,
      drawWidth: 2160,
      drawHeight: 3240,
      aspectMismatch: true,
    })
  })

  it('cover-crops vertically for a wide source into a square target', () => {
    expect(computeExactSizeDrawPlan(
      { width: 1600, height: 900 },
      { width: 1024, height: 1024 },
      'cover',
    )).toMatchObject({
      mode: 'cover',
      scale: 1.137778,
      drawX: -398,
      drawY: 0,
      drawWidth: 1820,
      drawHeight: 1024,
      aspectMismatch: true,
    })
  })
})
