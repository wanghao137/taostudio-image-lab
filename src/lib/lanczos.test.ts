import { describe, expect, it } from 'vitest'
import { computeAxisWeights, computeCoverCrop, lanczos3, lanczos3ResizeRGBA } from './lanczos'

describe('lanczos3 kernel', () => {
  it('has unit value at zero and zero at integer taps beyond radius', () => {
    expect(lanczos3(0)).toBe(1)
    expect(lanczos3(1)).toBeCloseTo(0, 6)
    expect(lanczos3(2)).toBeCloseTo(0, 6)
    expect(lanczos3(3)).toBe(0)
    expect(lanczos3(-3)).toBe(0)
  })

  it('is symmetric', () => {
    for (const x of [0.3, 0.7, 1.4, 2.2]) {
      expect(lanczos3(x)).toBeCloseTo(lanczos3(-x), 10)
    }
  })
})

describe('computeAxisWeights', () => {
  it('produces normalized weights per destination pixel', () => {
    const weights = computeAxisWeights(1024, 2048)
    expect(weights.starts.length).toBe(2048)
    expect(weights.counts.length).toBe(2048)
    let offset = 0
    for (let dst = 0; dst < 2048; dst += 1) {
      const count = weights.counts[dst]
      let sum = 0
      for (let k = 0; k < count; k += 1) sum += weights.weights[offset + k]
      expect(sum).toBeCloseTo(1, 5)
      offset += count
    }
  })

  it('keeps source indices in range for downscale', () => {
    const weights = computeAxisWeights(2048, 512)
    for (let dst = 0; dst < 512; dst += 1) {
      expect(weights.starts[dst]).toBeGreaterThanOrEqual(0)
      expect(weights.starts[dst] + weights.counts[dst]).toBeLessThanOrEqual(2048)
    }
  })
})

describe('lanczos3ResizeRGBA', () => {
  it('preserves a solid color exactly', () => {
    const src = new Uint8ClampedArray(16 * 16 * 4)
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 200
      src[i + 1] = 100
      src[i + 2] = 50
      src[i + 3] = 255
    }
    const dst = lanczos3ResizeRGBA(src, 16, 16, 32, 32)
    expect(dst.length).toBe(32 * 32 * 4)
    for (let i = 0; i < dst.length; i += 4) {
      expect(dst[i]).toBe(200)
      expect(dst[i + 1]).toBe(100)
      expect(dst[i + 2]).toBe(50)
      expect(dst[i + 3]).toBe(255)
    }
  })

  it('2x upscale of a step edge keeps both plateaus intact', () => {
    const src = new Uint8ClampedArray(8 * 8 * 4)
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const v = x < 4 ? 0 : 255
        const i = (y * 8 + x) * 4
        src[i] = v
        src[i + 1] = v
        src[i + 2] = v
        src[i + 3] = 255
      }
    }
    const dst = lanczos3ResizeRGBA(src, 8, 8, 16, 16)
    // 远离边缘的区域保持平台值（lanczos3 有轻微振铃，容忍 ±8）
    const sample = (x: number, y: number) => dst[(y * 16 + x) * 4]
    expect(sample(1, 8)).toBeLessThanOrEqual(8)
    expect(sample(14, 8)).toBeGreaterThanOrEqual(247)
  })
})

describe('computeCoverCrop', () => {
  it('crops width for wider-than-target sources', () => {
    const crop = computeCoverCrop(1600, 900, 3000, 2000) // 16:9 → 3:2
    expect(crop.cropH).toBe(900)
    expect(Math.round(crop.cropW / crop.cropH * 1000)).toBe(1500)
    expect(crop.x + crop.cropW).toBeLessThanOrEqual(1600)
  })

  it('crops height for taller-than-target sources', () => {
    const crop = computeCoverCrop(1000, 2000, 2000, 2000)
    expect(crop.cropW).toBe(1000)
    expect(crop.cropH).toBe(1000)
    expect(crop.y).toBe(500)
  })

  it('returns full source when ratios match', () => {
    const crop = computeCoverCrop(1200, 800, 3000, 2000)
    expect(crop).toEqual({ x: 0, y: 0, cropW: 1200, cropH: 800 })
  })
})
