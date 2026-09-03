import { DEFAULT_PARAMS, type TaskParams } from '../types'
import { calculateImageSize, COMMON_IMAGE_RATIOS, normalizeImageSize, parseImageSize, type CommonImageRatio, type ImageSize } from './size'

export const ASSET_4K_RATIO_PRESETS = COMMON_IMAGE_RATIOS

export type Asset4KInheritedRatioSourceKind = 'input-image' | 'current-size'

export interface Asset4KInheritedRatioSource {
  kind: Asset4KInheritedRatioSourceKind
  size: ImageSize
}

interface RatioSourceImage {
  width?: number
  height?: number
}

export function getAsset4KRatioSize(ratio: CommonImageRatio) {
  return calculateImageSize('4K', ratio)
}

export function createAsset4KRatioPresetParams(
  ratio: CommonImageRatio,
  options: { codexCli?: boolean; n?: number } = {},
): Partial<TaskParams> | null {
  const size = getAsset4KRatioSize(ratio)
  if (!size) return null

  return {
    size,
    exact_size: true,
    quality: options.codexCli ? DEFAULT_PARAMS.quality : 'high',
    output_format: 'png',
    output_compression: null,
    transparent_output: false,
    n: options.n ?? 1,
  }
}

function buildAsset4KParams(size: string, options: { codexCli?: boolean; n?: number } = {}): Partial<TaskParams> {
  return {
    size,
    exact_size: true,
    quality: options.codexCli ? DEFAULT_PARAMS.quality : 'high',
    output_format: 'png',
    output_compression: null,
    transparent_output: false,
    n: options.n ?? 1,
  }
}

export function getAsset4KOriginalRatioSize(source: ImageSize | null | undefined) {
  if (!source?.width || !source.height) return null
  return calculateImageSize('4K', `${source.width}:${source.height}`)
}

export function getAsset4KInheritedRatioSource(options: {
  inputImages?: RatioSourceImage[]
  currentSize?: string | null
}): Asset4KInheritedRatioSource | null {
  const inputImage = options.inputImages?.find((img) => img.width && img.height)
  if (inputImage?.width && inputImage.height) {
    return {
      kind: 'input-image',
      size: { width: inputImage.width, height: inputImage.height },
    }
  }

  const parsedCurrentSize = options.currentSize && options.currentSize !== 'auto'
    ? parseImageSize(options.currentSize)
    : null
  if (parsedCurrentSize) {
    return {
      kind: 'current-size',
      size: parsedCurrentSize,
    }
  }

  return null
}

export function createAsset4KOriginalRatioPresetParams(
  source: ImageSize | null | undefined,
  options: { codexCli?: boolean; n?: number } = {},
): Partial<TaskParams> | null {
  const size = getAsset4KOriginalRatioSize(source)
  if (!size) return null

  return buildAsset4KParams(size, options)
}

// 尺寸可能以预设原始值（2400x3000）或尺寸弹窗归一化值（2400x3008）两种形态
// 存在任务参数里，激活态判断统一按归一化后的值比对。
function matchesPresetSize(actualSize: string | undefined, presetSize: string | undefined) {
  if (!actualSize || !presetSize) return false
  return normalizeImageSize(actualSize) === normalizeImageSize(presetSize)
}

export function isAsset4KRatioPresetActive(
  params: TaskParams,
  ratio: CommonImageRatio,
  options: { codexCli?: boolean; n?: number } = {},
) {
  const preset = createAsset4KRatioPresetParams(ratio, options)
  return Boolean(
    preset &&
    matchesPresetSize(params.size, preset.size) &&
    params.exact_size === true &&
    params.quality === preset.quality &&
    params.output_format === preset.output_format &&
    params.output_compression === null &&
    params.transparent_output === false &&
    params.n === preset.n,
  )
}

export function isAsset4KOriginalRatioPresetActive(
  params: TaskParams,
  source: ImageSize | null | undefined,
  options: { codexCli?: boolean; n?: number } = {},
) {
  const preset = createAsset4KOriginalRatioPresetParams(source, options)
  return Boolean(
    preset &&
    matchesPresetSize(params.size, preset.size) &&
    params.exact_size === true &&
    params.quality === preset.quality &&
    params.output_format === preset.output_format &&
    params.output_compression === null &&
    params.transparent_output === false &&
    params.n === preset.n,
  )
}
