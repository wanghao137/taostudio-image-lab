import type { ApiProfile } from '../types'
import { getImageGenerationModel } from './imageModels'

/**
 * Provider 原生尺寸能力档案：按「provider + 网关 host + apiMode + 模型」记录
 * 请求尺寸 → 实际返回尺寸的观测历史，用于自适应决定 exact_size 大目标的
 * 请求侧策略（全尺寸请求 or 收口到 1K 档底图 + 本地放大）。
 *
 * 背景：2026-08-14 的探针实测（一律 1K cap）已被 2026-09-11 的分模式实测取代——
 * /v1/images/generations 的 size 真实生效（不同网关能力不同），/v1/responses 忽略
 * size。因此不能再按 provider 全局假设，而是学习每个配置的真实返回像素。
 *
 * Provider 中立：host 只作为 opaque key 参与分组，不做任何硬编码主机判断。
 */

const STORAGE_KEY = 'gpt-image-provider-capability-v1'
/** 每个能力 key 保留的最近观测数（足够判定趋势，又不至于被旧状态黏住） */
const MAX_SAMPLES_PER_KEY = 12
/** 1K 档像素预算（与 size.ts MAX_1K_PIXELS 同源语义） */
const CLAMP_PIXELS = 1_572_864
/** 请求像素达到该值以上才算「强请求」证据（2K/4K 档；1K 附近的请求无法区分） */
const STRONG_REQUEST_PIXELS = 2_400_000
/** 判定「收口」所需的最近强请求观测数 */
const CLAMP_EVIDENCE_SAMPLES = 2

export interface ProviderSizeSample {
  requestedWidth: number
  requestedHeight: number
  observedWidth?: number
  observedHeight?: number
  at: number
}

export interface ProviderCapabilityEntry {
  samples: ProviderSizeSample[]
  lastSeenAt: number
}

export type ProviderCapabilityStore = Record<string, ProviderCapabilityEntry>

export type ProviderRequestSizePolicy = 'full' | 'cap-1k'

/** localStorage 不可用（测试/SSR）时的进程内兜底，保证行为可测且不抛错 */
const memoryStore = new Map<string, string>()

function readRawStore(): string | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage.getItem(STORAGE_KEY)
  } catch {
    // 隐私模式等场景 localStorage 访问可能抛错，回落内存
  }
  return memoryStore.get(STORAGE_KEY) ?? null
}

function writeRawStore(raw: string) {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, raw)
      return
    }
  } catch {
    // 同上
  }
  memoryStore.set(STORAGE_KEY, raw)
}

function parseStore(raw: string | null): ProviderCapabilityStore {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as ProviderCapabilityStore
  } catch {
    return {}
  }
}

export function loadProviderCapabilityStore(): ProviderCapabilityStore {
  return parseStore(readRawStore())
}

function persistStore(store: ProviderCapabilityStore) {
  writeRawStore(JSON.stringify(store))
}

function hostFingerprint(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase()
  } catch {
    return baseUrl.trim().toLowerCase()
  }
}

/** 能力分组 key：provider | 网关 host | apiMode | 生图模型（与请求实际去向一致的维度） */
export function providerCapabilityKey(profile: Pick<ApiProfile, 'provider' | 'baseUrl' | 'apiMode' | 'model' | 'imageGenerationModel'>): string {
  return [
    profile.provider,
    hostFingerprint(profile.baseUrl ?? ''),
    profile.apiMode,
    getImageGenerationModel(profile) || '',
  ].map((part) => String(part).trim()).join('|')
}

function samplePixels(sample: ProviderSizeSample): number {
  return sample.requestedWidth * sample.requestedHeight
}

function observedPixels(sample: ProviderSizeSample): number | null {
  if (!sample.observedWidth || !sample.observedHeight) return null
  return sample.observedWidth * sample.observedHeight
}

/**
 * 请求侧策略决策：
 * - nativeLargeOutput=true：显式声明支持大尺寸，直接全尺寸请求；
 * - 有 ≥2 次强请求（≥2.4MP）全部被压回 ~1K 档：判定该配置不支持大尺寸原生输出，
 *   收口到 1K 底图 + 本地放大（与旧行为一致，但只对「被证明会压图」的配置生效）；
 * - 任一强请求观测到真实生效：全尺寸请求；
 * - 无证据（首次使用）：默认全尺寸请求（2026-09-11 实测 images 通道 size 生效；
 *   官方 OpenAI 接受 normalizeImageSize 后的 16 倍数任意尺寸）。
 */
export function resolveProviderRequestSizePolicy(
  profile: Pick<ApiProfile, 'provider' | 'baseUrl' | 'apiMode' | 'model' | 'imageGenerationModel' | 'nativeLargeOutput'>,
): ProviderRequestSizePolicy {
  if (profile.nativeLargeOutput === true) return 'full'
  const entry = loadProviderCapabilityStore()[providerCapabilityKey(profile)]
  if (!entry) return 'full'
  const strongSamples = entry.samples.filter((sample) => samplePixels(sample) >= STRONG_REQUEST_PIXELS)
  if (strongSamples.length < CLAMP_EVIDENCE_SAMPLES) return 'full'
  const withObservation = strongSamples.filter((sample) => observedPixels(sample) !== null)
  if (withObservation.length < CLAMP_EVIDENCE_SAMPLES) return 'full'
  const clamped = withObservation.filter((sample) => {
    const observed = observedPixels(sample) ?? 0
    return observed <= CLAMP_PIXELS * 1.05 && samplePixels(sample) >= observed * 1.8
  })
  if (clamped.length === withObservation.length) return 'cap-1k'
  return 'full'
}

/**
 * 记录一次「请求尺寸 → 实际返回尺寸」观测。只在纯文生图（无输入图）链路调用：
 * 编辑链路输出画幅锁定输入图尺寸（2026-09-11 实测），观测会被污染。
 */
export function recordProviderSizeObservation(input: {
  profile: Pick<ApiProfile, 'provider' | 'baseUrl' | 'apiMode' | 'model' | 'imageGenerationModel'>
  requestedWidth: number
  requestedHeight: number
  observedWidth?: number
  observedHeight?: number
}) {
  const key = providerCapabilityKey(input.profile)
  if (!key) return
  const store = loadProviderCapabilityStore()
  const entry = store[key] ?? { samples: [], lastSeenAt: 0 }
  const next: ProviderSizeSample = {
    requestedWidth: input.requestedWidth,
    requestedHeight: input.requestedHeight,
    observedWidth: input.observedWidth,
    observedHeight: input.observedHeight,
    at: Date.now(),
  }
  entry.samples = [...entry.samples, next].slice(-MAX_SAMPLES_PER_KEY)
  entry.lastSeenAt = next.at
  store[key] = entry
  persistStore(store)
}

/** 诊断用途：读取某配置当前的观测历史与推导结论 */
export function getProviderCapabilitySummary(
  profile: Pick<ApiProfile, 'provider' | 'baseUrl' | 'apiMode' | 'model' | 'imageGenerationModel' | 'nativeLargeOutput'>,
) {
  const entry = loadProviderCapabilityStore()[providerCapabilityKey(profile)]
  return {
    key: providerCapabilityKey(profile),
    sampleCount: entry?.samples.length ?? 0,
    samples: entry?.samples ?? [],
    policy: resolveProviderRequestSizePolicy(profile),
  }
}

/** 测试与用户重置用途：清空能力档案 */
export function clearProviderCapabilityStore() {
  writeRawStore('{}')
}
