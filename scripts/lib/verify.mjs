// Verification helpers for generated images. Mirrors the checks the Playwright
// runner performs (run-youmind-5.mjs dataUrlToBuffer + exactDimensions +
// strictConfigVerified + technicalVerified) so headless and UI results use the
// same acceptance criteria.

import crypto from 'node:crypto'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function dataUrlToBuffer(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '')
  if (!match) throw new Error('Generated image is not a data URL')
  return match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]))
}

export function isDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:')
}

export function describeImageFile(buffer, filePath) {
  return {
    filePath,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    pngSignature: buffer.subarray(0, 8).equals(PNG_SIGNATURE),
    width: readPngWidth(buffer),
    height: readPngHeight(buffer),
  }
}

// PNG IHDR: width is bytes 16-19, height 20-23 (big-endian uint32).
function readPngWidth(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.length < 24) return null
  return buffer.readUInt32BE(16)
}
function readPngHeight(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.length < 24) return null
  return buffer.readUInt32BE(20)
}

export function verifyOutput(imageEntry, expectedSize, expectedConfig, actualParams) {
  const [expectedWidth, expectedHeight] = expectedSize.split('x').map(Number)
  const exactDimensions = imageEntry.width === expectedWidth && imageEntry.height === expectedHeight
  const pngSignature = Boolean(imageEntry.pngSignature)
  const formatOk = actualParams?.output_format === expectedConfig.output_format && imageEntry.pngSignature
  const moderationOk = actualParams?.moderation === undefined || actualParams?.moderation === expectedConfig.moderation
  const qualityAudit = actualParams?.quality ?? null
  const qualityRequestedHigh = expectedConfig.quality === 'high'
  const qualityDeliveredHigh = qualityAudit === 'high'
  const qualityDowngraded = qualityRequestedHigh && !qualityDeliveredHigh

  // Mirrors run-youmind-5 strictConfigVerified (with exact_size implicitly true
  // for headless since the UI canvas-resize path is not in play).
  const strictConfigVerified =
    expectedConfig.quality === 'high'
    && expectedConfig.output_format === 'png'
    && expectedConfig.moderation === 'low'
    && actualParams?.quality === 'high'
    && actualParams?.output_format === 'png'
    && exactDimensions

  // technicalVerified: format/size/PNG all correct. moderation is treated as
  // pass when the provider omits it (responses mode never returns moderation).
  const technicalVerified =
    actualParams?.output_format === 'png'
    && moderationOk
    && exactDimensions
    && pngSignature

  return {
    exactDimensions,
    pngSignature,
    formatOk,
    moderationOk,
    qualityAudit,
    qualityRequestedHigh,
    qualityDeliveredHigh,
    qualityDowngraded,
    strictConfigVerified,
    technicalVerified,
  }
}
