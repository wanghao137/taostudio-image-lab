import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, getActiveApiProfile, normalizeSettings } from './apiProfiles'
import { clearProviderCapabilityStore, recordProviderSizeObservation } from './providerCapability'
import { getMaskDisabledReason, getOutputImageLimitForSettings, getParamDisabledReasons, getTaskParamSupport, normalizeParamsForSettings } from './paramCompatibility'
import { getImageParameterControls } from './imageParameterControls'

describe('parameter compatibility', () => {
  it.each(['images', 'responses'] as const)('normalizes stale Codex CLI parameters and disables their controls on %s', (apiMode) => {
    const profile = createDefaultOpenAIProfile({ codexCli: true, apiMode, imageGenerationModel: 'gpt-image-2.6-sunburst' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    const params = { ...DEFAULT_PARAMS, output_format: 'webp' as const, output_compression: 10, moderation: 'low' as const, complexity: 'high' as const, transparent_output: true }
    expect(normalizeParamsForSettings(params, settings)).toMatchObject({ output_format: 'png', output_compression: null, moderation: 'low', complexity: 'auto', transparent_output: true })
    const controls = getImageParameterControls(settings, profile, params).parameters
    for (const key of ['output_format', 'output_compression', 'moderation', 'complexity'] as const) {
      expect(controls[key].disabledReason).toContain('Codex CLI')
    }
    expect(getTaskParamSupport(settings, profile).complexity).toBe(false)
    expect(getMaskDisabledReason(profile)).toBe('Codex CLI 不支持遮罩编辑')
    expect(getMaskDisabledReason({ ...profile, codexCli: false })).toBeUndefined()
    expect(getParamDisabledReasons({ ...profile, codexCli: false }).complexity).toBeUndefined()
  })
  it.each(['google/nano-banana-2.1', 'xai/grok-imagine-image/v2.0/text-to-image', 'bytedance/seedream/v5.5/text-to-image'])('allows automatic ratios for fal.ai %s', (model) => {
    expect(getParamDisabledReasons(createDefaultFalProfile({ model })).autoSize).toBeUndefined()
  })

  it('only disables automatic size for fal.ai GPT Image generation', () => {
    const profile = createDefaultFalProfile({ model: 'openai/gpt-image-2.6/sunburst' })
    expect(getParamDisabledReasons(profile).autoSize).toBe('当前模型的文生图模式不支持自动尺寸')
    expect(getParamDisabledReasons(profile, { hasInputImages: true }).autoSize).toBeUndefined()
  })

  it.each(['google/nano-banana-2.1', 'xai/grok-imagine-image/v2.0/text-to-image', 'bytedance/seedream/v5.5/text-to-image'])('keeps output count when SVG falls back to PNG for %s', (model) => {
    const profile = createDefaultFalProfile({ model })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, output_format: 'svg', n: 4 }, settings)).toMatchObject({ output_format: 'png', n: 4 })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, output_format: 'svg', n: 8 }, settings)).toMatchObject({ output_format: 'png', n: 4 })
  })
  it.each([
    ['google/nano-banana-2.1', 'gemini', 4, 'local'],
    ['xai/grok-imagine-image/v2.0/text-to-image', 'grok', 4, 'local'],
    ['bytedance/seedream/v5.5/text-to-image', 'seedream', 4, 'api'],
  ])('normalizes fal.ai family controls for %s', (model, family, count, method) => {
    const profile = createDefaultFalProfile({ model })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })
    const params = normalizeParamsForSettings({ ...DEFAULT_PARAMS, n: 8, resolution: '2K', aspect_ratio: '16:9', google_search: true, thinking_level: 'medium', complexity: 'high' }, settings)
    expect(getOutputImageLimitForSettings(settings)).toBe(count)
    expect(params).toMatchObject({ n: count, aspect_ratio: '16:9', resolution: '2K', complexity: 'auto' })
    expect(getActiveApiProfile(settings).transparentBackgroundMethod).toBe(method)
    expect(params.google_search).toBe(family === 'gemini' ? true : undefined)
    expect(params.thinking_level).toBe(family === 'gemini' ? 'medium' : undefined)
  })
  it.each([
    ['gemini-nano-banana-2.1', true],
    ['gemini-3-pro-image', false],
    ['gemini-2.5-flash-image', false],
  ])('captures supported Google controls for %s', (model, thinking) => {
    const profile = createDefaultOpenAIProfile({ provider: 'google', model })
    expect(getTaskParamSupport(DEFAULT_SETTINGS, profile)).toEqual({ thinking, complexity: false })
  })

  it.each(['gpt-image-2.5', 'gpt-image-2.6'])('uses the Responses image tool model for complexity: %s', (imageGenerationModel) => {
    const profile = createDefaultOpenAIProfile({ apiMode: 'responses', model: 'example-text-model', imageGenerationModel })
    expect(getTaskParamSupport(DEFAULT_SETTINGS, profile)).toEqual({ thinking: false, complexity: imageGenerationModel === 'gpt-image-2.6' })
  })

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

  it('limits fal.ai SVG generation to one image and falls back to PNG for reference edits', () => {
    const profile = createDefaultFalProfile({ model: 'openai/gpt-image-2.6/sunburst' })
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id })

    expect(getParamDisabledReasons(profile).svg).toBeUndefined()
    expect(getParamDisabledReasons(profile, { hasInputImages: true }).svg).toBe('fal.ai 的参考图编辑不支持 SVG')
    expect(getOutputImageLimitForSettings(settings, 'svg')).toBe(1)
    expect(getOutputImageLimitForSettings(settings, 'png')).toBe(4)
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, output_format: 'svg', n: 4 }, settings)).toMatchObject({ output_format: 'svg', n: 1 })
    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, output_format: 'svg', n: 4 }, settings, { hasInputImages: true })).toMatchObject({ output_format: 'png', n: 4 })
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

    expect(normalizeParamsForSettings({ ...DEFAULT_PARAMS, size: '2048x2048', quality: 'high', output_format: 'gif', complexity: 'high', moderation: 'low' }, settings)).toMatchObject({
      size: '1024x1024',
      quality: DEFAULT_PARAMS.quality,
      output_format: 'png',
      complexity: 'auto',
      moderation: 'low',
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
