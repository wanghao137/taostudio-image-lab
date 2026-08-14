import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import { getOutputImageLimitForSettings, normalizeParamsForSettings } from './paramCompatibility'

describe('parameter compatibility', () => {
  it('limits OpenAI output count to 10', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: false })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(10)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 12 }, settings).n).toBe(10)
  })

  it('limits fal.ai output count to 4', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    expect(getOutputImageLimitForSettings(settings)).toBe(4)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 8 }, settings).n).toBe(4)
  })

  it('keeps OpenAI streaming output count so the request can disable streaming', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', streamImages: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 4 }, settings).n).toBe(4)
  })

  it('only replaces fal.ai auto size in text-to-image mode', () => {
    const falProfile = createDefaultFalProfile({ apiKey: 'fal-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [falProfile],
      activeProfileId: falProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings).size).toBe('1360x1024')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings, { hasInputImages: true }).size).toBe('auto')
  })

  it('disables exact-size post-processing for auto size', () => {
    const openAIProfile = createDefaultOpenAIProfile({ apiKey: 'test-key' })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [openAIProfile],
      activeProfileId: openAIProfile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto', exact_size: true }, settings).exact_size).toBe(false)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2160x3840', exact_size: true }, settings).exact_size).toBe(true)
  })

  it('limits Codex CLI custom sizes to 1K while preserving auto', () => {
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', codexCli: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048' }, settings).size).toBe('1024x1024')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings).size).toBe('auto')
  })

  it('preserves exact final dimensions when only the Codex CLI provider request should be limited', () => {
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', codexCli: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profile],
      activeProfileId: profile.id,
    })
    const params = { ...DEFAULT_PARAMS, size: '2160x3840', exact_size: true }

    expect(normalizeParamsForSettings(params, settings, { preserveExactSizeIntent: true }).size).toBe('2160x3840')
    expect(normalizeParamsForSettings(params, settings).size).toBe('720x1280')
  })
})

describe('capRequestSize (non-codexCli exact-size 4K asset requests)', () => {
  const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', codexCli: false })
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [profile],
    activeProfileId: profile.id,
  })

  it('caps exact-size 4K request size to the 1K tier while keeping the ratio', () => {
    const capped = normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, size: '3456x2304', exact_size: true },
      settings,
      { capRequestSize: true },
    )
    // 1K 档 3:2 预设 = 1536x1024，恰好也是探针实测的网关原生能力
    expect(capped.size).toBe('1536x1024')
    expect(capped.exact_size).toBe(true)
  })

  it('does not touch request size without capRequestSize (legacy behavior)', () => {
    const kept = normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, size: '3456x2304', exact_size: true },
      settings,
    )
    expect(kept.size).toBe('3456x2304')
  })

  it('leaves non-exact sizes and auto untouched', () => {
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048' }, settings, { capRequestSize: true }).size).toBe('2048x2048')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: 'auto' }, settings, { capRequestSize: true }).size).toBe('auto')
  })

  it('caps vertical and square 4K targets and keeps already-1K sizes unchanged', () => {
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2304x3456', exact_size: true }, settings, { capRequestSize: true }).size).toBe('1024x1536')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2880x2880', exact_size: true }, settings, { capRequestSize: true }).size).toBe('1024x1024')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '1536x1024', exact_size: true }, settings, { capRequestSize: true }).size).toBe('1536x1024')
  })

  it('skips the cap when the profile declares nativeLargeOutput', () => {
    const largeProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', codexCli: false, nativeLargeOutput: true })
    const largeSettings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [largeProfile],
      activeProfileId: largeProfile.id,
    })
    expect(normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, size: '3456x2304', exact_size: true },
      largeSettings,
      { capRequestSize: true },
    ).size).toBe('3456x2304')
  })
})
