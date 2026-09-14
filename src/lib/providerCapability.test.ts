import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearProviderCapabilityStore,
  getProviderCapabilitySummary,
  loadProviderCapabilityStore,
  providerCapabilityKey,
  recordProviderSizeObservation,
  resolveProviderRequestSizePolicy,
} from './providerCapability'

const baseProfile = {
  provider: 'openai' as const,
  baseUrl: 'https://gw.example.com/v1',
  apiMode: 'images' as const,
  model: 'gpt-image-2.5-flare',
}

describe('providerCapabilityKey', () => {
  it('groups by provider + host + apiMode + model', () => {
    expect(providerCapabilityKey(baseProfile)).toBe('openai|gw.example.com|images|gpt-image-2.5-flare')
    expect(providerCapabilityKey({ ...baseProfile, apiMode: 'responses', imageGenerationModel: 'gpt-5.6-sol' }))
      .toBe('openai|gw.example.com|responses|gpt-5.6-sol')
  })

  it('normalizes host case and tolerates an invalid baseUrl', () => {
    expect(providerCapabilityKey({ ...baseProfile, baseUrl: 'https://GW.Example.com/v1' }))
      .toBe(providerCapabilityKey(baseProfile))
    expect(providerCapabilityKey({ ...baseProfile, baseUrl: 'not a url' })).toContain('|not a url|')
  })
})

describe('resolveProviderRequestSizePolicy', () => {
  beforeEach(() => {
    clearProviderCapabilityStore()
  })

  it('defaults to full request without evidence', () => {
    expect(resolveProviderRequestSizePolicy(baseProfile)).toBe('full')
  })

  it('returns full when nativeLargeOutput is explicitly declared', () => {
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 3456, requestedHeight: 2304, observedWidth: 1536, observedHeight: 1024 })
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 3456, requestedHeight: 2304, observedWidth: 1536, observedHeight: 1024 })
    expect(resolveProviderRequestSizePolicy({ ...baseProfile, nativeLargeOutput: true })).toBe('full')
  })

  it('flips to cap-1k only after repeated strong requests are clamped', () => {
    expect(resolveProviderRequestSizePolicy(baseProfile)).toBe('full')
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 3456, requestedHeight: 2304, observedWidth: 1536, observedHeight: 1024 })
    expect(resolveProviderRequestSizePolicy(baseProfile)).toBe('full')
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 2400, requestedHeight: 3008, observedWidth: 1024, observedHeight: 1280 })
    expect(resolveProviderRequestSizePolicy(baseProfile)).toBe('cap-1k')
  })

  it('stays full when the provider honors large requests', () => {
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 2400, requestedHeight: 3008, observedWidth: 2400, observedHeight: 3008 })
    expect(resolveProviderRequestSizePolicy(baseProfile)).toBe('full')
  })

  it('ignores weak (near-1K) requests as evidence', () => {
    // 1K 档附近的请求无法区分「支持大尺寸」与「恰好在 1K 档」
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 1536, requestedHeight: 1024, observedWidth: 1536, observedHeight: 1024 })
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 1600, requestedHeight: 1200, observedWidth: 1536, observedHeight: 1024 })
    expect(resolveProviderRequestSizePolicy(baseProfile)).toBe('full')
  })

  it('scopes evidence per host / apiMode / model (no cross-config bleed)', () => {
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 3456, requestedHeight: 2304, observedWidth: 1536, observedHeight: 1024 })
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 3456, requestedHeight: 2304, observedWidth: 1536, observedHeight: 1024 })
    expect(resolveProviderRequestSizePolicy({ ...baseProfile, baseUrl: 'https://other.example.com/v1' })).toBe('full')
    expect(resolveProviderRequestSizePolicy({ ...baseProfile, apiMode: 'responses', imageGenerationModel: 'gpt-5.6-sol' })).toBe('full')
    expect(resolveProviderRequestSizePolicy({ ...baseProfile, model: 'gpt-image-2' })).toBe('full')
  })

  it('keeps only the most recent samples (bounded memory)', () => {
    // 前 10 次真实生效、随后 12 次被压回 1K：滚动窗口内只剩压图证据 → 收口，
    // 说明旧证据会被滚动淘汰而非永久黏住
    for (let i = 0; i < 22; i += 1) {
      recordProviderSizeObservation({
        profile: baseProfile,
        requestedWidth: 3456,
        requestedHeight: 2304,
        observedWidth: i < 10 ? 3456 : 1536,
        observedHeight: i < 10 ? 2304 : 1024,
      })
    }
    const entry = loadProviderCapabilityStore()[providerCapabilityKey(baseProfile)]
    expect(entry.samples.length).toBeLessThanOrEqual(12)
    expect(resolveProviderRequestSizePolicy(baseProfile)).toBe('cap-1k')
  })

  it('survives a corrupted persisted payload gracefully', () => {
    try {
      localStorage.setItem('gpt-image-provider-capability-v1', '{not json')
    } catch {
      // 测试环境没有 localStorage 时跳过该断言（内存态无损坏场景）
    }
    expect(resolveProviderRequestSizePolicy(baseProfile)).toBe('full')
  })
})

describe('recordProviderSizeObservation + summary', () => {
  beforeEach(() => {
    clearProviderCapabilityStore()
  })

  it('records observations and exposes them via the summary', () => {
    recordProviderSizeObservation({
      profile: baseProfile,
      requestedWidth: 2400,
      requestedHeight: 3008,
      observedWidth: 2400,
      observedHeight: 3008,
    })
    const summary = getProviderCapabilitySummary(baseProfile)
    expect(summary.sampleCount).toBe(1)
    expect(summary.policy).toBe('full')
    expect(summary.samples[0]).toMatchObject({ requestedWidth: 2400, requestedHeight: 3008, observedWidth: 2400, observedHeight: 3008 })
  })

  it('records samples without observed dimensions (pending evidence)', () => {
    recordProviderSizeObservation({ profile: baseProfile, requestedWidth: 2400, requestedHeight: 3008 })
    const summary = getProviderCapabilitySummary(baseProfile)
    expect(summary.sampleCount).toBe(1)
    // 缺观测的样本不参与判定
    expect(resolveProviderRequestSizePolicy(baseProfile)).toBe('full')
  })
})
