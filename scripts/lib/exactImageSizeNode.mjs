// Node mirror of src/lib/exactImageSize.ts — the "4K skill" client-side
// resize step. The provider does NOT guarantee exact pixel dimensions, so the
// production app takes whatever it returns and Canvas-resizes (cover) to the
// exact target. This module does the same with sharp.
//
// Source of truth: src/lib/exactImageSize.ts (resizeImageDataUrlToExactSize,
// cover mode). Keep in sync on change.

import sharp from 'sharp'
import { parseImageSize } from './size4k.mjs'
import { computeResizePlan, ratioMatchesWithinOnePixel } from '../../packages/image-job-core/index.mjs'

export function getExactImageSizeTarget(params) {
  if (!params.exact_size || params.size === 'auto') return null
  return parseImageSize(params.size)
}

export function computeExactSizeDrawPlan(source, target, mode = 'cover') {
  return computeResizePlan(source, target, mode)
}

export async function resizeBufferToExactSize(buffer, target, outputFormat = 'png') {
  const meta = await sharp(buffer).metadata()
  const sourceWidth = meta.width
  const sourceHeight = meta.height
  if (!sourceWidth || !sourceHeight) throw new Error('sharp could not read image dimensions')

  if (sourceWidth === target.width && sourceHeight === target.height) {
    return { buffer, width: sourceWidth, height: sourceHeight, resized: false, sourceWidth, sourceHeight }
  }

  if (!ratioMatchesWithinOnePixel({ width: sourceWidth, height: sourceHeight }, target)) {
    throw new Error(`inherit ratio conflict: source=${sourceWidth}x${sourceHeight}, target=${target.width}x${target.height}`)
  }

  const drawPlan = computeExactSizeDrawPlan(
    { width: sourceWidth, height: sourceHeight },
    target,
    'cover',
  )
  const resized = await sharp(buffer)
    .resize(target.width, target.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .toFormat(outputFormat, outputFormat === 'png' ? {} : { quality: 95 })
    .toBuffer()

  return {
    buffer: resized,
    width: target.width,
    height: target.height,
    resized: true,
    sourceWidth,
    sourceHeight,
    drawPlan,
  }
}
