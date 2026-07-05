import { describe, expect, it } from 'vitest'
import { computeExactSizeDrawPlan } from './exactImageSize'

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
