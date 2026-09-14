/**
 * Production 4K v2 — Native Production Resampler (facade)
 *
 * 业务层唯一入口：resizeProductionAsset({ sourceBuffer, source, target, ... })。
 * 业务层不感知 LanczosSharp/Robidoux 等滤镜名，只传 contentClass + 质量档。
 *
 * 后端优先级：
 *   1. ImageMagick 7 EWA distort Resize（pinned sidecar）——Production 默认；
 *   2. sharp tensor resize（lanczos3 kernel；libvips 放大路径实际为 cubic
 *      插值，transform 中如实标注）——ImageMagick 不可用/失败时的确定性回退；
 *   3. 任何回退都在 transform.fallback 中记录 requested/reason，禁止静默降级。
 *
 * 几何契约：调用方（service）已保证 source 与 target 比例整数级一致；本模块
 * 防御性地再做一次 cover 裁切（center）并记录 crop 像素，绝不拉伸。
 * 输出尺寸必须精确等于 target（验证失败即抛错走回退）。
 */

import sharp from 'sharp'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MAX_EDGE,
  MAX_PIXELS,
  ratioMatchesExactly,
} from '../../../packages/image-job-core/index.mjs'
import { PRODUCTION_FILTERS, resolveProductionFilter } from './policy.mjs'
import {
  createResamplerTempDir,
  removeTempDir,
  resolveImageMagick,
  runImageMagickEwaResize,
} from './imagemagick.mjs'
import { buildResamplerTransform, computePixelSha256 } from './manifest.mjs'

const FILTER_LABELS = Object.freeze({
  [PRODUCTION_FILTERS.lanczosSharp]: 'ewa-lanczos-sharp',
  [PRODUCTION_FILTERS.lanczosRadius]: 'ewa-lanczos-radius',
  [PRODUCTION_FILTERS.robidoux]: 'ewa-robidoux',
  [PRODUCTION_FILTERS.mitchell]: 'mitchell',
})

/** 中心 cover 裁切（与浏览器端 lanczos.ts computeCoverCrop 同算法） */
function computeCenterCoverCrop(source, target) {
  const srcRatio = source.width / source.height
  const targetRatio = target.width / target.height
  if (srcRatio > targetRatio) {
    const cropW = Math.round(source.height * targetRatio)
    return { x: Math.floor((source.width - cropW) / 2), y: 0, width: cropW, height: source.height }
  }
  const cropH = Math.round(source.width / targetRatio)
  return { x: 0, y: Math.floor((source.height - cropH) / 2), width: source.width, height: cropH }
}

function assertPositiveDimensions(value, label) {
  if (!Number.isSafeInteger(value?.width) || !Number.isSafeInteger(value?.height)
    || value.width <= 0 || value.height <= 0) {
    throw new TypeError(`${label} dimensions must be positive integers`)
  }
}

async function runSharpFallback({ sourceBuffer, crop, target, requestedBackend, reason, signal = null }) {
  if (signal?.aborted) {
    throw Object.assign(new Error('resampler aborted before sharp fallback'), { code: 'RESAMPLER_ABORTED', retryable: false })
  }
  let pipeline = sharp(sourceBuffer)
  if (crop) pipeline = pipeline.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
  const buffer = await pipeline
    .resize(target.width, target.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer()
  const metadata = await sharp(buffer).metadata()
  if (metadata.width !== target.width || metadata.height !== target.height) {
    throw Object.assign(new Error(`sharp fallback produced ${metadata.width}x${metadata.height}`), { code: 'RESAMPLER_OUTPUT_MISMATCH' })
  }
  const transform = buildResamplerTransform({
    backend: 'sharp',
    method: 'tensor',
    // libvips 放大时 kernel 缺少对应 interpolator，lanczos3 实际映射为 cubic
    // 插值——如实标注，不得继续叫 lanczos3 upscale
    filter: 'lanczos3-kernel(upscale≈cubic)',
    source: crop ? { width: crop.width, height: crop.height } : target,
    crop,
    target,
    fallback: { requested: requestedBackend, reason },
  })
  return { buffer, transform }
}

/**
 * @param {object} input
 * @param {Buffer} input.sourceBuffer      引擎 source PNG（已由 service 校验/生成）
 * @param {{width:number,height:number}} input.source
 * @param {{width:number,height:number}} input.target  精确交付目标
 * @param {string} [input.contentClass]    photo|illustration|text|logo|ui
 * @param {string} [input.profile]         auto|faithful|detail
 * @param {string} [input.tmpRoot]         临时目录基目录（缺省系统 tmp）
 * @param {AbortSignal} [input.signal]     取消信号（cancel during resize）
 * @returns {Promise<{buffer: Buffer, transform: object, pixelSha256: string}>}
 */
export async function resizeProductionAsset(input) {
  const {
    sourceBuffer,
    source,
    target,
    contentClass = 'photo',
    profile = 'auto',
    tmpRoot = null,
    signal = null,
  } = input
  if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0) throw new TypeError('sourceBuffer is required')
  assertPositiveDimensions(source, 'source')
  assertPositiveDimensions(target, 'target')
  if (target.width > MAX_EDGE || target.height > MAX_EDGE || target.width * target.height > MAX_PIXELS) {
    throw Object.assign(new Error('target exceeds production limits'), { code: 'RESAMPLER_TARGET_TOO_LARGE', retryable: false })
  }

  const metadata = await sharp(sourceBuffer).metadata()
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw Object.assign(new Error('production resampler only accepts PNG sources'), { code: 'RESAMPLER_SOURCE_NOT_PNG', retryable: false })
  }
  const sourceDimensions = { width: metadata.width, height: metadata.height }

  // 源即目标：passthrough（不做任何重采样，像素逐字节保留）
  if (sourceDimensions.width === target.width && sourceDimensions.height === target.height) {
    const pixelSha256 = await computePixelSha256(sourceBuffer)
    return {
      buffer: sourceBuffer,
      transform: buildResamplerTransform({
        backend: 'none',
        method: 'passthrough',
        filter: 'none',
        source: sourceDimensions,
        crop: null,
        target,
        fallback: null,
      }),
      pixelSha256,
    }
  }

  const crop = ratioMatchesExactly(sourceDimensions, target) ? null : computeCenterCoverCrop(sourceDimensions, target)
  const filter = resolveProductionFilter(contentClass, profile)
  const filterLabel = FILTER_LABELS[filter] ?? 'ewa-custom'
  if (signal?.aborted) {
    throw Object.assign(new Error('resampler aborted before backend dispatch'), { code: 'RESAMPLER_ABORTED', retryable: false })
  }
  const imageMagick = await resolveImageMagick()

  if (imageMagick) {
    const tempDir = await createResamplerTempDir(tmpRoot)
    try {
      if (signal?.aborted) throw Object.assign(new Error('resampler aborted before imagemagick'), { code: 'IMAGEMAGICK_ABORTED' })
      const inputPath = join(tempDir, 'in.png')
      const outputPath = join(tempDir, 'out.png')
      await writeFile(inputPath, sourceBuffer)
      await runImageMagickEwaResize({
        executable: imageMagick.executable,
        inputPath,
        outputPath,
        targetWidth: target.width,
        targetHeight: target.height,
        filter,
        crop,
        signal,
      })
      const buffer = await readFile(outputPath)
      const outMetadata = await sharp(buffer).metadata()
      if (outMetadata.format !== 'png' || outMetadata.width !== target.width || outMetadata.height !== target.height) {
        throw Object.assign(
          new Error(`imagemagick produced ${outMetadata.format} ${outMetadata.width}x${outMetadata.height}`),
          { code: 'RESAMPLER_OUTPUT_MISMATCH' },
        )
      }
      const pixelSha256 = await computePixelSha256(buffer)
      const transform = buildResamplerTransform({
        backend: 'imagemagick-ewa',
        backendVersion: imageMagick.version,
        method: 'ewa',
        filter: filterLabel,
        source: crop ? { width: crop.width, height: crop.height } : sourceDimensions,
        crop,
        target,
        fallback: null,
      })
      return { buffer, transform, pixelSha256 }
    } catch (error) {
      if (signal?.aborted || error?.code === 'IMAGEMAGICK_ABORTED') {
        throw Object.assign(new Error('resampler aborted during imagemagick'), { code: 'RESAMPLER_ABORTED', retryable: false })
      }
      const reason = `${error?.code ?? 'error'}: ${String(error?.message ?? error).slice(0, 200)}`
      const fallbackResult = await runSharpFallback({ sourceBuffer, crop, target, requestedBackend: 'imagemagick-ewa', reason, signal })
      return { ...fallbackResult, pixelSha256: await computePixelSha256(fallbackResult.buffer) }
    } finally {
      await removeTempDir(tempDir)
    }
  }

  const fallbackResult = await runSharpFallback({
    sourceBuffer,
    crop,
    target,
    requestedBackend: 'imagemagick-ewa',
    reason: 'imagemagick-unavailable',
    signal,
  })
  return { ...fallbackResult, pixelSha256: await computePixelSha256(fallbackResult.buffer) }
}

export { resolveImageMagick } from './imagemagick.mjs'
export { computePixelSha256 } from './manifest.mjs'
export { PRODUCTION_FILTERS } from './policy.mjs'
