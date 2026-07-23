const SIZE_PATTERN = /^\s*(\d+)\s*[xX\u00d7]\s*(\d+)\s*$/
const RATIO_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*[:xX\u00d7]\s*(\d+(?:\.\d+)?)\s*$/

export const CONTRACT_VERSION = '1'
export const MANIFEST_VERSION = '1'
export const MAX_EDGE = 3840
export const MAX_PIXELS = 8_294_400
export const COMMON_IMAGE_RATIOS = Object.freeze(['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9'])

// generation.apiMode selects the provider endpoint for a job.
// 'images' (default) -> POST /images/generations for image models (gpt-image-2).
// 'responses' -> POST /responses with an image_generation tool for text models
// that expose image output through the Responses API (gpt-5.6-sol).
export const API_MODES = Object.freeze(['images', 'responses'])

export const COMMON_SIZE_PRESETS = Object.freeze({
  '1K': Object.freeze({
    '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536',
    '16:9': '1280x720', '9:16': '720x1280', '4:3': '1024x768',
    '3:4': '768x1024', '21:9': '1280x549',
  }),
  '2K': Object.freeze({
    '1:1': '2048x2048', '3:2': '2160x1440', '2:3': '1440x2160',
    '16:9': '2560x1440', '9:16': '1440x2560', '4:3': '2048x1536',
    '3:4': '1536x2048', '21:9': '2560x1097',
  }),
  '4K': Object.freeze({
    '1:1': '2880x2880', '3:2': '3456x2304', '2:3': '2304x3456',
    '16:9': '3840x2160', '9:16': '2160x3840', '4:3': '3200x2400',
    '3:4': '2400x3200', '21:9': '3840x1646',
  }),
})

export const JOB_STATES = Object.freeze([
  'queued', 'validating', 'generating', 'source_ready', 'enhancing',
  'finalizing', 'succeeded', 'failed', 'cancelled',
])

export const TERMINAL_JOB_STATES = Object.freeze(['succeeded', 'failed', 'cancelled'])

export const JOB_STATE_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['validating', 'cancelled']),
  validating: Object.freeze(['generating', 'failed', 'cancelled']),
  generating: Object.freeze(['source_ready', 'failed', 'cancelled']),
  source_ready: Object.freeze(['enhancing', 'finalizing', 'failed', 'cancelled']),
  enhancing: Object.freeze(['finalizing', 'failed', 'cancelled']),
  finalizing: Object.freeze(['succeeded', 'failed', 'cancelled']),
  succeeded: Object.freeze([]),
  failed: Object.freeze(['queued']),
  cancelled: Object.freeze([]),
})

const TIER_PIXEL_BUDGET = Object.freeze({ '1K': 1_572_864, '2K': 4_194_304, '4K': MAX_PIXELS })
const MIN_PIXELS = 655_360
const MAX_ASPECT_RATIO = 3
const SIZE_MULTIPLE = 16
const MAX_RATIO_ERROR = 0.01

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

export function parseImageSize(value) {
  if (typeof value !== 'string') return null
  const match = value.match(SIZE_PATTERN)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return positiveInteger(width) && positiveInteger(height) ? { width, height } : null
}

export function parseRatio(value) {
  if (typeof value !== 'string') return null
  const match = value.match(RATIO_PATTERN)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null
}

export function greatestCommonDivisor(a, b) {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y !== 0) [x, y] = [y, x % y]
  return x || 1
}

export function formatExactRatio(width, height) {
  if (!positiveInteger(width) || !positiveInteger(height)) return null
  const divisor = greatestCommonDivisor(width, height)
  return `${width / divisor}:${height / divisor}`
}

export function relativeRatioError(left, right) {
  const leftRatio = left.width / left.height
  const rightRatio = right.width / right.height
  return Math.abs(leftRatio - rightRatio) / leftRatio
}

export function ratioMatches(left, right, tolerance = 0.001) {
  return positiveInteger(left?.width) && positiveInteger(left?.height)
    && positiveInteger(right?.width) && positiveInteger(right?.height)
    && relativeRatioError(left, right) <= tolerance
}

export function ratioMatchesWithinOnePixel(left, right) {
  const shortestEdge = Math.min(right?.width || 0, right?.height || 0)
  return shortestEdge > 0 && ratioMatches(left, right, 1 / shortestEdge)
}

export function ratioMatchesExactly(left, right) {
  return positiveInteger(left?.width) && positiveInteger(left?.height)
    && positiveInteger(right?.width) && positiveInteger(right?.height)
    && left.width * right.height === right.width * left.height
}

export function deriveExactSourceTarget(base, final) {
  if (!positiveInteger(base?.width) || !positiveInteger(base?.height) || !positiveInteger(final?.width) || !positiveInteger(final?.height)) {
    throw new TypeError('base and final dimensions must be positive integers')
  }
  if (ratioMatchesExactly(base, final)) return { ...base }

  const divisor = greatestCommonDivisor(final.width, final.height)
  const reduced = { width: final.width / divisor, height: final.height / divisor }
  const basePixels = base.width * base.height
  let best = null
  for (let factor = 1; factor <= divisor; factor += 1) {
    if (divisor % factor !== 0) continue
    const candidate = { width: reduced.width * factor, height: reduced.height * factor }
    const score = Math.abs(Math.log((candidate.width * candidate.height) / basePixels))
    if (!best || score < best.score) best = { ...candidate, score }
  }
  return { width: best.width, height: best.height }
}

export function computeResizePlan(source, target, mode = 'cover') {
  if (!['cover', 'contain'].includes(mode)) throw new Error('resize mode must be cover or contain')
  if (!positiveInteger(source?.width) || !positiveInteger(source?.height) || !positiveInteger(target?.width) || !positiveInteger(target?.height)) {
    throw new TypeError('resize dimensions must be positive integers')
  }
  const widthScale = target.width / source.width
  const heightScale = target.height / source.height
  const scale = mode === 'contain' ? Math.min(widthScale, heightScale) : Math.max(widthScale, heightScale)
  const drawWidth = Math.round(source.width * scale)
  const drawHeight = Math.round(source.height * scale)
  const drawX = Math.round((target.width - drawWidth) / 2) || 0
  const drawY = Math.round((target.height - drawHeight) / 2) || 0
  return {
    mode,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetWidth: target.width,
    targetHeight: target.height,
    scale: Math.round(scale * 1_000_000) / 1_000_000,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
    aspectMismatch: !ratioMatches(source, target, 0.01),
  }
}

export function calculateImageSize(tier, ratio) {
  const parsed = parseRatio(ratio)
  const pixelBudget = TIER_PIXEL_BUDGET[tier]
  if (!parsed || !pixelBudget) return null
  const original = `${parsed.width}:${parsed.height}`
  if (COMMON_SIZE_PRESETS[tier][original]) return COMMON_SIZE_PRESETS[tier][original]
  const exact = formatExactRatio(parsed.width, parsed.height)
  if (exact && COMMON_SIZE_PRESETS[tier][exact]) return COMMON_SIZE_PRESETS[tier][exact]
  const equivalentPresetRatio = COMMON_IMAGE_RATIOS.find((commonRatio) => {
    const commonOutput = parseImageSize(COMMON_SIZE_PRESETS['4K'][commonRatio])
    return ratioMatchesWithinOnePixel(parsed, commonOutput)
  })
  if (equivalentPresetRatio) return COMMON_SIZE_PRESETS[tier][equivalentPresetRatio]

  const targetRatio = parsed.width / parsed.height
  let best = null
  for (let width = SIZE_MULTIPLE; width <= MAX_EDGE; width += SIZE_MULTIPLE) {
    const idealHeight = width / targetRatio
    const heights = new Set([
      Math.floor(idealHeight / SIZE_MULTIPLE) * SIZE_MULTIPLE,
      Math.ceil(idealHeight / SIZE_MULTIPLE) * SIZE_MULTIPLE,
    ])
    for (const height of heights) {
      if (height < SIZE_MULTIPLE || height > MAX_EDGE) continue
      const pixels = width * height
      if (pixels < MIN_PIXELS || pixels > pixelBudget) continue
      if (Math.max(width / height, height / width) > MAX_ASPECT_RATIO) continue
      if (Math.abs(width / height - targetRatio) / targetRatio > MAX_RATIO_ERROR) continue
      if (!best || pixels > best.width * best.height) best = { width, height }
    }
  }
  return best ? `${best.width}x${best.height}` : null
}

export function deriveInheritedTarget(source, options = {}) {
  if (!positiveInteger(source?.width) || !positiveInteger(source?.height)) {
    throw new TypeError('source dimensions must be positive integers')
  }
  const maxEdge = options.maxEdge ?? MAX_EDGE
  const maxPixels = options.maxPixels ?? MAX_PIXELS
  const exactRatio = formatExactRatio(source.width, source.height)
  const commonPreset = exactRatio ? COMMON_SIZE_PRESETS['4K'][exactRatio] : null
  if (commonPreset && maxEdge === MAX_EDGE && maxPixels === MAX_PIXELS) {
    const preset = parseImageSize(commonPreset)
    return { ...preset, ratio: exactRatio, ratioError: 0 }
  }
  const scale = Math.min(maxEdge / source.width, maxEdge / source.height, Math.sqrt(maxPixels / (source.width * source.height)))
  const targetWidth = Math.max(1, Math.floor(source.width * scale))
  const targetHeight = Math.max(1, Math.floor(source.height * scale))
  const target = { width: targetWidth, height: targetHeight }
  const error = relativeRatioError(source, target)
  if (!ratioMatchesWithinOnePixel(source, target)) throw new Error(`cannot derive inherited target without changing ratio: error=${error}`)
  return { ...target, ratio: formatExactRatio(source.width, source.height), ratioError: error }
}

export function resolveOutputTarget(request, source) {
  const output = request?.output
  if (!output || output.ratioMode !== 'inherit') throw new Error('output.ratioMode must be inherit')
  if (output.dimensions) {
    const target = typeof output.dimensions === 'string' ? parseImageSize(output.dimensions) : output.dimensions
    if (!target) throw new Error('output.dimensions is invalid')
    if (source && !ratioMatchesWithinOnePixel(source, target)) {
      throw new Error('explicit output dimensions conflict with the source ratio')
    }
    return target
  }
  if (!source) throw new Error('source dimensions are required to inherit ratio')
  return deriveInheritedTarget(source, output.limits)
}

export function resolveEnhancementPolicy(contentClass, requested = 'auto') {
  const deterministicOnly = ['text', 'logo', 'ui'].includes(contentClass)
  if (deterministicOnly) return { requested, selected: 'lanczos3', generativeAllowed: false, fallback: null }
  if (requested === 'lanczos3' || requested === 'none') {
    return { requested, selected: requested, generativeAllowed: false, fallback: null }
  }
  return { requested, selected: requested === 'auto' ? 'lanczos3' : requested, generativeAllowed: requested !== 'auto', fallback: 'lanczos3' }
}

export function assertTransition(from, to) {
  if (!JOB_STATES.includes(from) || !JOB_STATES.includes(to)) throw new Error('unknown job state')
  if (!JOB_STATE_TRANSITIONS[from].includes(to)) throw new Error(`invalid job state transition: ${from} -> ${to}`)
  return true
}

export function validateImageJobRequest(request) {
  const errors = []
  if (!request || typeof request !== 'object') return { valid: false, errors: ['request must be an object'] }
  if (request.contractVersion !== CONTRACT_VERSION) errors.push('contractVersion must be 1')
  if (!request.idempotencyKey || typeof request.idempotencyKey !== 'string') errors.push('idempotencyKey is required')
  if (!request.input || typeof request.input !== 'object') errors.push('input is required')
  if (!request.input?.prompt && !request.input?.sourceAssetId) errors.push('input.prompt or input.sourceAssetId is required')
  if (request.composition?.ratio && !parseRatio(request.composition.ratio)) errors.push('composition.ratio is invalid')
  if (request.generation?.apiMode !== undefined && !API_MODES.includes(request.generation.apiMode)) errors.push(`generation.apiMode must be one of ${API_MODES.join(', ')}`)
  if (request.output?.ratioMode !== 'inherit') errors.push('output.ratioMode must be inherit')
  if (request.output?.format !== 'png') errors.push('output.format must be png in contract v1')
  if (request.output?.quality !== 'high') errors.push('output.quality must be high in contract v1')
  if (request.retry?.maxAttempts !== undefined && (!Number.isInteger(request.retry.maxAttempts) || request.retry.maxAttempts < 1 || request.retry.maxAttempts > 5)) errors.push('retry.maxAttempts must be an integer from 1 to 5')
  return { valid: errors.length === 0, errors }
}

export function createAssetManifest(input) {
  const required = ['assetId', 'jobId', 'kind', 'mediaType', 'width', 'height', 'bytes', 'sha256', 'storagePath', 'createdAt']
  for (const key of required) if (input?.[key] === undefined || input?.[key] === null || input?.[key] === '') throw new Error(`manifest.${key} is required`)
  if (!['source', 'final'].includes(input.kind)) throw new Error('manifest.kind must be source or final')
  if (!positiveInteger(input.width) || !positiveInteger(input.height) || !positiveInteger(input.bytes)) throw new Error('manifest dimensions and bytes must be positive integers')
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error('manifest.sha256 must be SHA-256 hex')
  return Object.freeze({
    manifestVersion: MANIFEST_VERSION,
    ...input,
    ratio: formatExactRatio(input.width, input.height),
  })
}

export function verifySourceFinalInvariant(source, final) {
  const errors = []
  if (source.kind !== 'source') errors.push('source manifest kind must be source')
  if (final.kind !== 'final') errors.push('final manifest kind must be final')
  if (final.parentAssetId !== source.assetId) errors.push('final.parentAssetId must reference source asset')
  if (!ratioMatchesExactly(source, final)) errors.push('source and final ratios differ at integer-pixel precision')
  return { valid: errors.length === 0, errors }
}
