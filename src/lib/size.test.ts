import { describe, expect, it } from 'vitest'
import {
  calculateImageSize,
  normalizeCodexCliImageSize,
  normalizeImageSize,
  prependCodexCliSizePrompt,
  resolveExactDeliverySize,
  stripInjectedCodexCliSizePrompt,
} from './size'

describe('calculateImageSize', () => {
  it('uses common 16:9 display resolutions for the built-in tiers', () => {
    expect(calculateImageSize('1K', '16:9')).toBe('1280x720')
    expect(calculateImageSize('2K', '16:9')).toBe('2560x1440')
    expect(calculateImageSize('4K', '16:9')).toBe('3840x2160')
  })

  it('uses matching portrait presets for common ratios', () => {
    expect(calculateImageSize('2K', '9:16')).toBe('1440x2560')
    expect(calculateImageSize('2K', '2:3')).toBe('1440x2160')
    expect(calculateImageSize('2K', '3:4')).toBe('1536x2048')
  })

  it('uses explicit presets for poster/print ratios', () => {
    expect(calculateImageSize('2K', '5:4')).toBe('1920x1536')
    expect(calculateImageSize('4K', '4:5')).toBe('2400x3000')
    expect(calculateImageSize('4K', '3:5')).toBe('2160x3600')
  })

  it('falls back to budget-based sizing for custom ratios', () => {
    expect(calculateImageSize('2K', '7:5')).toBe('2416x1728')
  })
})

describe('Codex CLI size compatibility', () => {
  it('normalizes custom sizes to the 1K pixel budget', () => {
    expect(normalizeCodexCliImageSize('2048x2048')).toBe('1024x1024')
    expect(normalizeCodexCliImageSize('2048x1536')).toBe('1024x768')
    expect(normalizeCodexCliImageSize('1536x1024')).toBe('1536x1024')
  })

  it('preserves the input ratio approximately and clamps excessive ratios', () => {
    // 2500x2000 is a ~5:4 ratio; the normalizer keeps it within the 1K budget
    // while staying close to the original ratio (it does not snap to the 5:4
    // preset because the rounded input reduces to 156:125, not 5:4 exactly).
    const [width, height] = normalizeCodexCliImageSize('2500x2000').split('x').map(Number)
    expect(width / height).toBeCloseTo(1.25, 1)
    expect(width * height).toBeLessThanOrEqual(1_572_864)
    const [clampWidth, clampHeight] = normalizeCodexCliImageSize('4000x1000').split('x').map(Number)
    expect(clampWidth / clampHeight).toBeCloseTo(3, 2)
    expect(clampWidth * clampHeight).toBeLessThanOrEqual(1_572_864)
  })

  it('prepends a concise resolution hint only for explicit sizes', () => {
    expect(prependCodexCliSizePrompt('Draw a cat.\n', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.\n')
    expect(prependCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
    expect(prependCodexCliSizePrompt('Draw a cat.', 'auto')).toBe('Draw a cat.')
  })

  it('strips only the matching injected resolution hint', () => {
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Draw a cat.', '1024x1024')).toBe('Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 2048x2048 resolution. Draw a cat.', 'Draw a cat.', '1024x1024')).toBe('Generate at 2048x2048 resolution. Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Generate at 1024x1024 resolution. Draw a cat.', '1024x1024')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
    expect(stripInjectedCodexCliSizePrompt('Generate at 1024x1024 resolution. Draw a cat.', 'Draw a cat.', 'auto')).toBe('Generate at 1024x1024 resolution. Draw a cat.')
  })
})

describe('resolveExactDeliverySize (Provider Request Size ≠ Production Target)', () => {
  it('maps the normalized 4:5 form back to the exact preset target 2400x3000', () => {
    // 尺寸弹窗归一化把 4:5 4K 变成 2400x3008（16 倍数是 Provider 约束）；
    // 交付目标必须严格回到预设原始值 2400x3000
    expect(normalizeImageSize('2400x3000')).toBe('2400x3008')
    expect(resolveExactDeliverySize('2400x3008')).toEqual({ width: 2400, height: 3000 })
    expect(resolveExactDeliverySize('2400x3000')).toEqual({ width: 2400, height: 3000 })
  })

  it('maps the normalized 21:9 forms back to their exact preset targets across tiers', () => {
    expect(normalizeImageSize('3840x1646')).toBe('3840x1648')
    expect(resolveExactDeliverySize('3840x1648')).toEqual({ width: 3840, height: 1646 })
    expect(normalizeImageSize('2560x1097')).toBe('2560x1104')
    expect(resolveExactDeliverySize('2560x1104')).toEqual({ width: 2560, height: 1097 })
  })

  it('passes through preset sizes that are already 16-multiples unchanged', () => {
    expect(resolveExactDeliverySize('3840x2160')).toEqual({ width: 3840, height: 2160 })
    expect(resolveExactDeliverySize('3456x2304')).toEqual({ width: 3456, height: 2304 })
    expect(resolveExactDeliverySize('2400x3200')).toEqual({ width: 2400, height: 3200 })
    expect(resolveExactDeliverySize('2160x3840')).toEqual({ width: 2160, height: 3840 })
  })

  it('keeps custom sizes that do not match any preset as-is', () => {
    expect(resolveExactDeliverySize('2000x3008')).toEqual({ width: 2000, height: 3008 })
  })

  it('returns null for auto or unparseable sizes', () => {
    expect(resolveExactDeliverySize('auto')).toBeNull()
    expect(resolveExactDeliverySize('garbage')).toBeNull()
  })
})
