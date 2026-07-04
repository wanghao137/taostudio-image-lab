import { DEFAULT_PARAMS, type TaskParams } from '../types'
import { calculateImageSize, COMMON_IMAGE_RATIOS, type CommonImageRatio, type ImageSize } from './size'

export const ASSET_4K_RATIO_PRESETS = COMMON_IMAGE_RATIOS

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

export function createAsset4KOriginalRatioPresetParams(
  source: ImageSize | null | undefined,
  options: { codexCli?: boolean; n?: number } = {},
): Partial<TaskParams> | null {
  const size = getAsset4KOriginalRatioSize(source)
  if (!size) return null

  return buildAsset4KParams(size, options)
}

export function isAsset4KRatioPresetActive(
  params: TaskParams,
  ratio: CommonImageRatio,
  options: { codexCli?: boolean; n?: number } = {},
) {
  const preset = createAsset4KRatioPresetParams(ratio, options)
  return Boolean(
    preset &&
    params.size === preset.size &&
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
    params.size === preset.size &&
    params.exact_size === true &&
    params.quality === preset.quality &&
    params.output_format === preset.output_format &&
    params.output_compression === null &&
    params.transparent_output === false &&
    params.n === preset.n,
  )
}
