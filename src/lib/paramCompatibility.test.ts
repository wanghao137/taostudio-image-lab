import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings } from './apiProfiles'
import { clearProviderCapabilityStore, recordProviderSizeObservation } from './providerCapability'
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

  beforeEach(() => {
    clearProviderCapabilityStore()
  })

  it('requests the full exact size by default (no blanket 1K cap without evidence)', () => {
    const requested = normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, size: '3456x2304', exact_size: true },
      settings,
      { capRequestSize: true },
    )
    // 2026-09-11 实测 images 通道 size 真实生效；未观测到「压图」证据时
    // 不再按 provider 全局假设收口到 1K 档
    expect(requested.size).toBe('3456x2304')
    expect(requested.exact_size).toBe(true)
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

  it('caps to the 1K tier when observations prove the provider clamps large requests', () => {
    const active = getActiveApiProfile(settings)
    // 两次强请求（4K 3:2）都被压回 ~1K 档（1536x1024）
    for (let i = 0; i < 2; i += 1) {
      recordProviderSizeObservation({
        profile: active,
        requestedWidth: 3456,
        requestedHeight: 2304,
        observedWidth: 1536,
        observedHeight: 1024,
      })
    }
    expect(normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, size: '3456x2304', exact_size: true },
      settings,
      { capRequestSize: true },
    ).size).toBe('1536x1024')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '1536x1024', exact_size: true }, settings, { capRequestSize: true }).size).toBe('1536x1024')
  })

  it('keeps the full request when observations prove the provider honors large sizes', () => {
    const active = getActiveApiProfile(settings)
    recordProviderSizeObservation({
      profile: active,
      requestedWidth: 3456,
      requestedHeight: 2304,
      observedWidth: 1536,
      observedHeight: 1024,
    })
    recordProviderSizeObservation({
      profile: active,
      requestedWidth: 3456,
      requestedHeight: 2304,
      observedWidth: 3456,
      observedHeight: 2304,
    })
    expect(normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, size: '2304x3456', exact_size: true },
      settings,
      { capRequestSize: true },
    ).size).toBe('2304x3456')
  })

  it('does not let a single clamp observation flip the policy (needs >= 2)', () => {
    const active = getActiveApiProfile(settings)
    recordProviderSizeObservation({
      profile: active,
      requestedWidth: 3456,
      requestedHeight: 2304,
      observedWidth: 1536,
      observedHeight: 1024,
    })
    expect(normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, size: '3456x2304', exact_size: true },
      settings,
      { capRequestSize: true },
    ).size).toBe('3456x2304')
  })

  it('skips the cap when the profile declares nativeLargeOutput', () => {
    const activeOf = (s: ReturnType<typeof normalizeSettings>) => getActiveApiProfile(s)
    const largeProfile = createDefaultOpenAIProfile({ apiKey: 'test-key', codexCli: false, nativeLargeOutput: true })
    const largeSettings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [largeProfile],
      activeProfileId: largeProfile.id,
    })
    // 即便能力档案里有压图证据，显式声明优先生效
    for (let i = 0; i < 2; i += 1) {
      recordProviderSizeObservation({
        profile: activeOf(largeSettings),
        requestedWidth: 3456,
        requestedHeight: 2304,
        observedWidth: 1536,
        observedHeight: 1024,
      })
    }
    expect(normalizeParamsForSettings(
      { ...DEFAULT_PARAMS, size: '3456x2304', exact_size: true },
      largeSettings,
      { capRequestSize: true },
    ).size).toBe('3456x2304')
  })

  it('applies Codex CLI parameter limits to custom providers', () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [{
        id: 'custom-provider',
        name: 'Custom Provider',
        submit: { path: 'images/generations' },
      }],
      profiles: [{
        ...createDefaultOpenAIProfile(),
        provider: 'custom-provider',
        codexCli: true,
      }],
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048', quality: 'high' }, settings)).toMatchObject({
      size: '1024x1024',
      quality: DEFAULT_PARAMS.quality,
    })
  })

  it('does not apply Codex CLI parameter limits to fal.ai', () => {
    const profile = createDefaultFalProfile({ codexCli: true })
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      codexCli: true,
      profiles: [profile],
      activeProfileId: profile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048' }, settings).size).toBe('2048x2048')
  })

  it.each(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'] as const)('keeps 2.5 quality levels for %s', (model) => {
    const profile = createDefaultOpenAIProfile({ model })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile] })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'xhigh' }, settings).quality).toBe('xhigh')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max' }, settings).quality).toBe('max')
  })

  it.each(['openai/gpt-image-2.5/sunburst', 'openai/gpt-image-2.5/flare'] as const)('keeps fal.ai 2.5 quality levels for %s', (model) => {
    const profile = createDefaultFalProfile({ model })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'xhigh' }, settings).quality).toBe('xhigh')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max' }, settings).quality).toBe('max')
  })

  it.each(['vendor/gpt-image-2.5-custom', 'my-gpt-image-2.5-proxy'])('keeps 2.5 quality levels for a custom provider model %s', (model) => {
    const profile = { ...createDefaultOpenAIProfile({ model }), provider: 'custom-provider' }
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [{ id: 'custom-provider', name: 'Custom Provider', submit: { path: 'images/generations' } }],
      profiles: [profile],
      activeProfileId: profile.id,
    })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'xhigh' }, settings).quality).toBe('xhigh')
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max' }, settings).quality).toBe('max')
  })

  it('falls back to high when an older image model receives a 2.5 quality level', () => {
    const profile = createDefaultOpenAIProfile({ model: 'gpt-image-2' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile] })

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, quality: 'max' }, settings).quality).toBe('high')
  })
})
