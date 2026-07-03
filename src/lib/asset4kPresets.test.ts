import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { ASSET_4K_RATIO_PRESETS, createAsset4KRatioPresetParams, getAsset4KRatioSize, isAsset4KRatioPresetActive } from './asset4kPresets'

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
})
