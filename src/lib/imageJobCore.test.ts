import { describe, expect, it } from 'vitest'
import {
  COMMON_IMAGE_RATIOS,
  assertTransition,
  calculateImageSize,
  deriveInheritedTarget,
  resolveEnhancementPolicy,
  resolveOutputTarget,
  validateImageJobRequest,
  ratioMatchesWithinOnePixel,
} from '../../packages/image-job-core/index.mjs'

const GOLDEN_4K = {
  '1:1': '2880x2880',
  '3:2': '3456x2304',
  '2:3': '2304x3456',
  '16:9': '3840x2160',
  '9:16': '2160x3840',
  '4:3': '3200x2400',
  '3:4': '2400x3200',
  '21:9': '3840x1600',
} as const

describe('Image Job Contract v1 core', () => {
  it.each(COMMON_IMAGE_RATIOS)('keeps the %s golden 4K preset stable', (ratio) => {
    expect(calculateImageSize('4K', ratio)).toBe(GOLDEN_4K[ratio as keyof typeof GOLDEN_4K])
  })

  it('derives a final target from the actual source dimensions', () => {
    expect(deriveInheritedTarget({ width: 1254, height: 1254 })).toMatchObject({ width: 2880, height: 2880, ratio: '1:1' })
    expect(deriveInheritedTarget({ width: 1086, height: 1448 })).toMatchObject({ width: 2400, height: 3200, ratio: '3:4' })
  })

  it('rejects explicit dimensions that conflict with the source ratio', () => {
    expect(() => resolveOutputTarget({ output: { ratioMode: 'inherit', dimensions: '2160x3840' } }, { width: 1024, height: 1536 })).toThrow(/conflict/)
  })

  it('enforces valid state transitions', () => {
    expect(assertTransition('queued', 'validating')).toBe(true)
    expect(() => assertTransition('queued', 'succeeded')).toThrow(/invalid/)
    expect(assertTransition('failed', 'queued')).toBe(true)
  })

  it('forces text, logo and UI assets onto deterministic processing', () => {
    expect(resolveEnhancementPolicy('logo', 'real-esrgan')).toEqual({
      requested: 'real-esrgan', selected: 'lanczos3', generativeAllowed: false, fallback: null,
    })
  })

  it('validates the minimum provider-neutral request', () => {
    expect(validateImageJobRequest({
      contractVersion: '1',
      idempotencyKey: 'agent-run-001',
      input: { prompt: 'studio portrait' },
      composition: { ratio: '1:1' },
      generation: { provider: 'mock', model: 'mock-v1' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', enhancement: 'auto' },
    })).toEqual({ valid: true, errors: [] })
  })

  it('preserves arbitrary source ratios within one output pixel', () => {
    let seed = 0x5f3759df
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0
      return seed / 0x1_0000_0000
    }
    for (let index = 0; index < 250; index += 1) {
      const source = {
        width: 256 + Math.floor(random() * 3800),
        height: 256 + Math.floor(random() * 3800),
      }
      const target = deriveInheritedTarget(source)
      expect(target.width).toBeLessThanOrEqual(3840)
      expect(target.height).toBeLessThanOrEqual(3840)
      expect(target.width * target.height).toBeLessThanOrEqual(8_294_400)
      expect(ratioMatchesWithinOnePixel(source, target)).toBe(true)
    }
  })
})
