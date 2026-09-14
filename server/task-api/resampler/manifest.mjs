/**
 * Production 4K v2 — Transform Manifest / Pixel Hash
 *
 * fileSha256：文件字节级一致性（PNG 压缩级别/编码器变化会改变它）。
 * pixelSha256：解码后的视觉像素一致性——canonical RGBA（straight alpha）+
 * 宽高前缀的 SHA-256。用于回答「算法版本变了吗 / 编码参数变了吗 / 像素变了吗」，
 * 并作为 Repeated deterministic job 的 DoD 依据（同 Source+Target+Engine 版本下
 * pixelSha256 必须可复现）。
 */

import { createHash } from 'node:crypto'
import sharp from 'sharp'

/** 计算 canonical RGBA pixel hash：`<W>x<H>|` + 逐字节 RGBA（straight alpha） */
export async function computePixelSha256(buffer) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const hash = createHash('sha256')
  hash.update(`${info.width}x${info.height}|`)
  hash.update(data)
  return hash.digest('hex')
}

export function computeBufferSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 组装 manifest transform 块（resampler 部分）。业务 manifest 其余字段
 * （geometry/exactPixels/appliedEnhancement 等）由 service 层合并。
 */
export function buildResamplerTransform(input) {
  const {
    backend,
    backendVersion,
    method,
    filter,
    source,
    crop,
    target,
    fallback = null,
  } = input
  const scaleX = Number((target.width / source.width).toFixed(6))
  const scaleY = Number((target.height / source.height).toFixed(6))
  return {
    backend,
    ...(backendVersion ? { backendVersion } : {}),
    method,
    filter,
    colorspace: 'srgb',
    source: { width: source.width, height: source.height },
    crop: crop ? { ...crop } : null,
    target: { width: target.width, height: target.height },
    scaleX,
    scaleY,
    passes: 1,
    fallback,
  }
}
