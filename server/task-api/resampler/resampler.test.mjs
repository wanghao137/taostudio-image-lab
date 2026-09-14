import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { resizeProductionAsset, resolveImageMagick } from './index.mjs'
import { resetImageMagickDetectionCache } from './imagemagick.mjs'

// EWA 8MP 级重采样单次可达数秒；默认 5s 会误杀
vi.setConfig({ testTimeout: 180_000 })

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

async function makeGradientPng(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#123456"/>
        <stop offset="0.5" stop-color="#78abcd"/>
        <stop offset="1" stop-color="#fedcba"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${Math.round(width * 0.3)}" cy="${Math.round(height * 0.4)}" r="${Math.round(Math.min(width, height) * 0.18)}" fill="#ff0055" fill-opacity="0.85"/>
    <rect x="${Math.round(width * 0.55)}" y="${Math.round(height * 0.55)}" width="${Math.round(width * 0.3)}" height="${Math.round(height * 0.2)}" fill="#00ff88" fill-opacity="0.6"/>
  </svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

async function makeRedOnTransparentPng(size = 200) {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: Buffer.from(
        `<svg width="${size}" height="${size}"><rect x="${size * 0.3}" y="${size * 0.3}" width="${size * 0.4}" height="${size * 0.4}" fill="#ff2244"/></svg>`,
      ),
      top: 0,
      left: 0,
    }])
    .png()
    .toBuffer()
}

const originalEnv = process.env.TAOSTUDIO_IMAGE_MAGICK

// 顶层探测一次 sidecar 可用性（按生产默认语义：无环境变量覆盖），
// 决定 EWA 用例 skip 与否。注意不能在 describe 注册期用 beforeAll 赋值——
// skipIf 在 it() 注册时求值，那时 beforeAll 尚未执行（会全部被跳过）。
resetImageMagickDetectionCache()
const imageMagickAvailable = Boolean(await resolveImageMagick())
resetImageMagickDetectionCache()

describe('resizeProductionAsset — sharp deterministic fallback', () => {
  beforeAll(() => {
    process.env.TAOSTUDIO_IMAGE_MAGICK = '0'
    resetImageMagickDetectionCache()
  })
  afterAll(() => {
    if (originalEnv === undefined) delete process.env.TAOSTUDIO_IMAGE_MAGICK
    else process.env.TAOSTUDIO_IMAGE_MAGICK = originalEnv
    resetImageMagickDetectionCache()
  })

  it('falls back to sharp with a recorded reason when ImageMagick is unavailable', async () => {
    const source = await makeGradientPng(1536, 1024)
    const { buffer, transform, pixelSha256 } = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 1536, height: 1024 },
      target: { width: 2400, height: 1600 },
    })
    const metadata = await sharp(buffer).metadata()
    expect(metadata.format).toBe('png')
    expect(metadata.width).toBe(2400)
    expect(metadata.height).toBe(1600)
    expect(transform.backend).toBe('sharp')
    expect(transform.fallback).toMatchObject({ requested: 'imagemagick-ewa', reason: 'imagemagick-unavailable' })
    expect(transform.method).toBe('tensor')
    expect(transform.target).toEqual({ width: 2400, height: 1600 })
    expect(transform.passes).toBe(1)
    expect(pixelSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is deterministic across repeated runs (pixel hash stable)', async () => {
    const source = await makeGradientPng(960, 1280)
    const first = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 960, height: 1280 },
      target: { width: 2400, height: 3200 },
    })
    const second = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 960, height: 1280 },
      target: { width: 2400, height: 3200 },
    })
    expect(second.pixelSha256).toBe(first.pixelSha256)
    expect(sha256(second.buffer)).toBe(sha256(first.buffer))
  })

  it('records a center cover crop when the source ratio conflicts with the target', async () => {
    const source = await makeGradientPng(1000, 1000)
    const { buffer, transform } = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 1000, height: 1000 },
      target: { width: 2400, height: 3000 },
    })
    const metadata = await sharp(buffer).metadata()
    expect(metadata.width).toBe(2400)
    expect(metadata.height).toBe(3000)
    // 方图 → 4:5 竖版：裁宽度（中心 800x1000）
    expect(transform.crop).toMatchObject({ x: 100, y: 0, width: 800, height: 1000 })
    expect(transform.crop.width / transform.crop.height).toBeCloseTo(2400 / 3000, 6)
  })

  it('passes through byte-exact when the source already equals the target', async () => {
    const source = await makeGradientPng(512, 512)
    const { buffer, transform } = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 512, height: 512 },
      target: { width: 512, height: 512 },
    })
    expect(buffer.equals(source)).toBe(true)
    expect(transform.method).toBe('passthrough')
    expect(transform.fallback).toBeNull()
  })

  it('rejects non-PNG sources and oversized targets', async () => {
    const jpeg = await sharp(await makeGradientPng(64, 64)).jpeg().toBuffer()
    await expect(resizeProductionAsset({
      sourceBuffer: jpeg,
      source: { width: 64, height: 64 },
      target: { width: 128, height: 128 },
    })).rejects.toMatchObject({ code: 'RESAMPLER_SOURCE_NOT_PNG' })
    const png = await makeGradientPng(64, 64)
    await expect(resizeProductionAsset({
      sourceBuffer: png,
      source: { width: 64, height: 64 },
      target: { width: 5000, height: 4000 },
    })).rejects.toMatchObject({ code: 'RESAMPLER_TARGET_TOO_LARGE' })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const source = await makeGradientPng(960, 1280)
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 960, height: 1280 },
      target: { width: 2400, height: 3200 },
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'RESAMPLER_ABORTED' })
  })

  it('preserves alpha in the sharp fallback', async () => {
    const source = await makeRedOnTransparentPng(128)
    const { buffer } = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 128, height: 128 },
      target: { width: 256, height: 256 },
    })
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)
    const idx = (Math.floor(256 * 0.5) * 256 + Math.floor(256 * 0.5)) * 4
    expect(data[idx + 3]).toBeGreaterThan(200)
    const corner = (5 * 256 + 5) * 4
    expect(data[corner + 3]).toBeLessThan(30)
  })
})

describe.skipIf(!imageMagickAvailable)('resizeProductionAsset — ImageMagick EWA (pinned sidecar)', () => {
  beforeAll(() => {
    // sharp-fallback 组的 beforeAll 把探测缓存置为「不可用」；进入本组前恢复
    if (originalEnv !== undefined) process.env.TAOSTUDIO_IMAGE_MAGICK = originalEnv
    else delete process.env.TAOSTUDIO_IMAGE_MAGICK
    resetImageMagickDetectionCache()
  })

  it('runs EWA LanczosSharp to exact target dimensions', async () => {
    const source = await makeGradientPng(1536, 1024)
    const { buffer, transform, pixelSha256 } = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 1536, height: 1024 },
      target: { width: 3456, height: 2304 },
    })
    const metadata = await sharp(buffer).metadata()
    expect(metadata.width).toBe(3456)
    expect(metadata.height).toBe(2304)
    expect(transform.backend).toBe('imagemagick-ewa')
    expect(transform.method).toBe('ewa')
    expect(transform.filter).toBe('ewa-lanczos-sharp')
    expect(transform.fallback).toBeNull()
    expect(transform.backendVersion).toContain('7.')
    expect(pixelSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is byte-and-pixel deterministic across repeated EWA runs', async () => {
    const source = await makeGradientPng(600, 800)
    const first = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 600, height: 800 },
      target: { width: 1200, height: 1600 },
    })
    const second = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 600, height: 800 },
      target: { width: 1200, height: 1600 },
    })
    expect(second.pixelSha256).toBe(first.pixelSha256)
    expect(sha256(second.buffer)).toBe(sha256(first.buffer))
  })

  it('keeps semi-transparent edges red (no black/white fringe) on alpha content', async () => {
    const source = await makeRedOnTransparentPng(100)
    const { buffer, transform } = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 100, height: 100 },
      target: { width: 400, height: 400 },
    })
    expect(transform.backend).toBe('imagemagick-ewa')
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true })
    expect(info.channels).toBe(4)
    let semiEdgePixels = 0
    let redHuePixels = 0
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const idx = (y * info.width + x) * 4
        const alpha = data[idx + 3]
        if (alpha > 30 && alpha < 225) {
          semiEdgePixels += 1
          const r = data[idx]
          const g = data[idx + 1]
          const b = data[idx + 2]
          // 红色主体边缘的半透明像素应保持红色色相，不允许黑边/白边化
          if (r > 80 && r > b * 1.5 && g < r) redHuePixels += 1
        }
      }
    }
    expect(semiEdgePixels).toBeGreaterThan(50)
    // 允许极少量混叠，但 ≥90% 半透明边缘必须保持红色色相（无 fringe 回归）
    expect(redHuePixels / semiEdgePixels).toBeGreaterThanOrEqual(0.9)
  })

  it('crops to exact ratio when source and target ratios mismatch', async () => {
    const source = await makeGradientPng(600, 600)
    const { buffer, transform } = await resizeProductionAsset({
      sourceBuffer: source,
      source: { width: 600, height: 600 },
      target: { width: 1200, height: 1500 },
    })
    const metadata = await sharp(buffer).metadata()
    expect(metadata.width).toBe(1200)
    expect(metadata.height).toBe(1500)
    expect(transform.crop).not.toBeNull()
    // 整数 crop 只能近似目标比例（600 高度下宽为 480 → 精确），
    // 残差由 '!' 强制几何吸收
    expect(transform.crop.width / transform.crop.height).toBeCloseTo(0.8, 3)
  })
})
