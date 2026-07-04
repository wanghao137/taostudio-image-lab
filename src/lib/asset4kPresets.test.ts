import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import {
  ASSET_4K_RATIO_PRESETS,
  createAsset4KOriginalRatioPresetParams,
  createAsset4KRatioPresetParams,
  getAsset4KInheritedRatioSource,
  getAsset4KOriginalRatioSize,
  getAsset4KRatioSize,
  isAsset4KOriginalRatioPresetActive,
  isAsset4KRatioPresetActive,
} from './asset4kPresets'

describe('asset 4K ratio presets', () => {
  it('covers the common uploaded-image ratios', () => {
    expect(ASSET_4K_RATIO_PRESETS.map((item) => item.value)).toEqual([
      '1:1',
      '3:2',
      '2:3',
      '16:9',
      '9:16',
      '4:3',
      '3:4',
      '21:9',
    ])
  })

  it('maps each common ratio to a high-resolution exact PNG size', () => {
    expect(Object.fromEntries(ASSET_4K_RATIO_PRESETS.map((item) => [item.value, getAsset4KRatioSize(item.value)]))).toEqual({
      '1:1': '2880x2880',
      '3:2': '3456x2304',
      '2:3': '2304x3456',
      '16:9': '3840x2160',
      '9:16': '2160x3840',
      '4:3': '3200x2400',
      '3:4': '2400x3200',
      '21:9': '3840x1600',
    })
  })

  it('builds generation params for high PNG exact-size output', () => {
    expect(createAsset4KRatioPresetParams('16:9')).toMatchObject({
      size: '3840x2160',
      exact_size: true,
      quality: 'high',
      output_format: 'png',
      output_compression: null,
      transparent_output: false,
      n: 1,
    })
  })

  it('keeps Codex CLI quality compatible while preserving the selected ratio', () => {
    const params = createAsset4KRatioPresetParams('9:16', { codexCli: true, n: 3 })
    expect(params).toMatchObject({
      size: '2160x3840',
      quality: DEFAULT_PARAMS.quality,
      n: 3,
    })
  })

  it('detects the active ratio preset from current task params', () => {
    const params = {
      ...DEFAULT_PARAMS,
      ...createAsset4KRatioPresetParams('21:9'),
    }

    expect(isAsset4KRatioPresetActive(params, '21:9')).toBe(true)
    expect(isAsset4KRatioPresetActive(params, '16:9')).toBe(false)
  })

  it('preserves the uploaded image aspect ratio for 4K high PNG output', () => {
    const source = { width: 1536, height: 1024 }

    expect(getAsset4KOriginalRatioSize(source)).toBe('3456x2304')
    expect(createAsset4KOriginalRatioPresetParams(source)).toMatchObject({
      size: '3456x2304',
      exact_size: true,
      quality: 'high',
      output_format: 'png',
      output_compression: null,
      transparent_output: false,
      n: 1,
    })
  })

  it('does not mark a square 4K preset as the original-ratio preset for a 3:2 source', () => {
    const source = { width: 1536, height: 1024 }
    const squareParams = {
      ...DEFAULT_PARAMS,
      ...createAsset4KRatioPresetParams('1:1'),
    }
    const originalRatioParams = {
      ...DEFAULT_PARAMS,
      ...createAsset4KOriginalRatioPresetParams(source),
    }

    expect(isAsset4KOriginalRatioPresetActive(squareParams, source)).toBe(false)
    expect(isAsset4KOriginalRatioPresetActive(originalRatioParams, source)).toBe(true)
  })

  it('uses uploaded image dimensions as the inherited 4K ratio source before current UI size', () => {
    const source = getAsset4KInheritedRatioSource({
      inputImages: [{ width: 1536, height: 1024 }],
      currentSize: '2880x2880',
    })

    expect(source).toEqual({
      kind: 'input-image',
      size: { width: 1536, height: 1024 },
    })
    expect(getAsset4KOriginalRatioSize(source?.size)).toBe('3456x2304')
  })

  it('uses the current base generation size as the inherited 4K ratio source when there is no uploaded image', () => {
    const source = getAsset4KInheritedRatioSource({
      inputImages: [],
      currentSize: '1536x1024',
    })

    expect(source).toEqual({
      kind: 'current-size',
      size: { width: 1536, height: 1024 },
    })
    expect(getAsset4KOriginalRatioSize(source?.size)).toBe('3456x2304')
  })

  it('does not invent an inherited 4K ratio source from auto size', () => {
    expect(getAsset4KInheritedRatioSource({
      inputImages: [],
      currentSize: 'auto',
    })).toBeNull()
  })
})
