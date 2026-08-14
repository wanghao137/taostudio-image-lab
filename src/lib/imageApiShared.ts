import type { AppSettings, RefusalRecoveryRecord, ResponsesOutputItem, TaskParams } from '../types'
import { blobToDataUrl } from './dataUrl'

export const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

export const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024
export const PROMPT_REWRITE_GUARD_PREFIX = 'Treat everything after this line as one complete image-generation prompt, including the resolution instruction. Follow it exactly without rewriting or omitting anything:'

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
  maskDataUrl?: string
  skipCodexCliSizePrompt?: boolean
  onFalRequestEnqueued?: (request: { requestId: string; endpoint: string }) => void
  onCustomTaskEnqueued?: (task: { taskId: string }) => void
  onPartialImage?: (partial: { image: string; partialImageIndex?: number; requestIndex?: number }) => void
}

export interface CallApiResult {
  /** base64 data URL 列表 */
  images: string[]
  /** API 返回的实际生效参数 */
  actualParams?: Partial<TaskParams>
  /** 每张图片对应的实际生效参数 */
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  /** 每张图片对应的 API 改写提示词 */
  revisedPrompts?: Array<string | undefined>
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
  /** 并发多图请求中失败的单张请求 */
  failedRequests?: Array<{ requestIndex: number; error: string }>
  /** 审核/安全拒绝后的最小改写恢复记录 */
  refusalRecovery?: RefusalRecoveryRecord
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

// ===== 结构化 API 错误 =====

export type ApiErrorStage = 'request' | 'poll' | 'stream' | 'parse'

export class ApiError extends Error {
  readonly status?: number
  readonly providerCode?: string
  readonly retryable: boolean
  readonly stage: ApiErrorStage
  /** 上游 Retry-After 毫秒数（若响应提供了）。 */
  readonly retryAfterMs?: number
  /** 上游原始响应体的摘要（不含 base64 图片数据）。 */
  readonly rawPayloadSummary?: string

  constructor(options: {
    message: string
    status?: number
    providerCode?: string
    retryable?: boolean
    stage?: ApiErrorStage
    retryAfterMs?: number
    rawPayloadSummary?: string
    cause?: unknown
  }) {
    super(options.message)
    this.name = 'ApiError'
    // ES2020 目标没有 Error cause 构造签名，手动挂接（保留原始错误链）。
    if (options.cause !== undefined && !('cause' in this)) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
    this.status = options.status
    this.providerCode = options.providerCode
    this.retryable = options.retryable ?? isRetryableHttpStatus(options.status)
    this.stage = options.stage ?? 'request'
    this.retryAfterMs = options.retryAfterMs
    this.rawPayloadSummary = options.rawPayloadSummary
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** 408/429/5xx 及网络层失败值得自动重试；4xx 其余是调用方问题，重试无意义。 */
export function isRetryableHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return false
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError
}

/** 标记「fetch 调用本身抛出」的网络错误（区别于响应消费阶段的 TypeError）。 */
export class NetworkFetchError extends ApiError {
  constructor(message: string, cause?: unknown) {
    super({ message, retryable: true, stage: 'request', cause })
    this.name = 'NetworkFetchError'
  }
}

/** 包装 fetch：只有 fetch 本身失败（未收到响应）才算可重试网络错误；
 * 响应消费阶段的 TypeError（response.json()/流读取）在服务端可能已计费，
 * 一律不自动重试，避免双重消费。 */
export async function fetchWithRetryClassification(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (err) {
    if (err instanceof TypeError) {
      throw new NetworkFetchError(err.message || '网络请求失败', err)
    }
    throw err
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

// ===== 瞬态失败重试 =====

export interface TransientRetryOptions {
  /** 最多重试次数（不含首次尝试）。 */
  maxRetries?: number
  /** 基础退避毫秒，指数递增并加抖动。 */
  baseDelayMs?: number
  /** 单次退避上限。 */
  maxDelayMs?: number
  /** 判定哪些错误值得重试；默认 408/429/5xx/网络 TypeError。 */
  shouldRetry?: (error: unknown, attempt: number) => boolean
  signal?: AbortSignal
  /** 供测试注入的等待函数。 */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

export function defaultTransientRetryDelay(attempt: number, retryAfterMs?: number, baseDelayMs = 1000, maxDelayMs = 15000): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0 && retryAfterMs <= 120_000) return Math.min(retryAfterMs, maxDelayMs * 4)
  const exponential = baseDelayMs * 2 ** (attempt - 1)
  const jitter = Math.random() * 0.3 * exponential
  return Math.min(exponential + jitter, maxDelayMs)
}

export function parseRetryAfterMs(response: Response | undefined): number | undefined {
  const value = response?.headers?.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

function defaultShouldRetry(error: unknown): boolean {
  if (isApiError(error)) return error.retryable
  // 只有 NetworkFetchError（fetch 本身失败）可重试；裸 TypeError 来自
  // 响应消费/转换阶段，服务端可能已计费，不自动重试。
  return error instanceof NetworkFetchError
}

export const transientRetrySleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeoutId)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 有界瞬态失败重试：覆盖 408/429/5xx 与网络层 TypeError。
 * 长耗时图像请求（尤其 4K）目前一次网关抖动就整体失败；这里是
 * 请求层的统一兜底。超时 AbortError 不重试（由上层超时机制统一管辖）。
 */
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 2
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry
  const sleep = options.sleepFn ?? transientRetrySleep

  let attempt = 0
  while (true) {
    try {
      return await operation()
    } catch (error) {
      if (isAbortError(error)) throw error
      attempt += 1
      if (attempt > maxRetries || !shouldRetry(error, attempt)) throw error
      const retryAfterMs = isApiError(error) ? error.retryAfterMs : undefined
      const delayMs = defaultTransientRetryDelay(attempt, retryAfterMs, options.baseDelayMs, options.maxDelayMs)
      options.onRetry?.(error, attempt, delayMs)
      await sleep(delayMs, options.signal)
    }
  }
}

export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

export function normalizeBase64Image(value: string, fallbackMime: string): string {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

export function getResponsesImageResultBase64(result: ResponsesOutputItem['result']): string | undefined {
  const b64 = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
    ? typeof result.b64_json === 'string'
      ? result.b64_json
      : typeof result.base64 === 'string'
      ? result.base64
      : typeof result.image === 'string'
      ? result.image
      : typeof result.data === 'string'
      ? result.data
      : ''
    : ''

  return b64.trim() ? b64 : undefined
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function getDataUrlEncodedByteSize(dataUrl: string): number {
  return dataUrl.length
}

export function getDataUrlDecodedByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length

  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) return decodeURIComponent(payload).length

  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function assertMaxBytes(label: string, bytes: number, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new Error(`${label}过大：${formatMiB(bytes)}，上限为 ${formatMiB(maxBytes)}`)
  }
}

export function assertImageInputPayloadSize(bytes: number) {
  assertMaxBytes('图像输入有效负载总大小', bytes, MAX_IMAGE_INPUT_PAYLOAD_BYTES)
}

export function assertMaskEditFileSize(label: string, bytes: number) {
  assertMaxBytes(label, bytes, MAX_MASK_EDIT_FILE_BYTES)
}

export const IMAGE_FETCH_CORS_HINT = ' 可点链接按钮复制结果链接，或尝试开启「返回 Base64 图片数据」避免此问题。'
export const STREAMING_UNSUPPORTED_HINT = '提示：当前使用的 API 可能不支持流式传输，请尝试关闭「流式传输」功能。'
export const STREAMING_FORMAT_HINT = '提示：API 返回了无法解析的流式数据格式，请尝试关闭「流式传输」功能。'

export function appendStreamingUnsupportedHint(message: string): string {
  return message ? `${message}\n${STREAMING_UNSUPPORTED_HINT}` : STREAMING_UNSUPPORTED_HINT
}

export function appendStreamingFormatHint(message: string): string {
  return message ? `${message}\n${STREAMING_FORMAT_HINT}` : STREAMING_FORMAT_HINT
}

/** 排除明确与流式无关的状态码后追加提示 */
export function maybeAppendStreamingHint(message: string, status: number, streamImages?: boolean): string {
  if (!streamImages) return message
  if (status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500) {
    return message
  }
  return appendStreamingUnsupportedHint(message)
}

async function probeNoCorsReachability(url: string, timeoutMs = 8000): Promise<'opaque' | 'reachable' | 'failed'> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.type === 'opaque' ? 'opaque' : 'reachable'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal): Promise<string> {
  if (isDataUrl(url)) return url

  let response: Response
  try {
    response = await fetch(url, {
      cache: 'no-store',
      signal,
    })
  } catch (err) {
    if (err instanceof TypeError) {
      const probe = await probeNoCorsReachability(url)
      if (probe === 'opaque') {
        throw new Error(`图片已生成，但因服务商未允许跨域，图片链接下载失败。${IMAGE_FETCH_CORS_HINT}`)
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error(`图片链接下载失败（网络不可用）。${IMAGE_FETCH_CORS_HINT}`)
      }
      throw new Error(`图片链接下载失败（可能因跨域限制、链接过期或网络异常）。${IMAGE_FETCH_CORS_HINT}`)
    }
    throw err
  }

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  const blob = await response.blob()
  return blobToDataUrl(blob, fallbackMime)
}

export async function getApiErrorMessage(response: Response): Promise<string> {
  let errorMsg = `HTTP ${response.status}`
  const textResponse = response.clone()
  try {
    const errJson = await response.json()
    if (errJson.error?.message) errorMsg = errJson.error.message
    else if (errJson.error?.code) errorMsg = errJson.error.code
    else if (typeof errJson.detail === 'string') errorMsg = errJson.detail
    else if (Array.isArray(errJson.detail)) errorMsg = errJson.detail.map((item: unknown) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
    else if (typeof errJson.error === 'string') errorMsg = errJson.error
    else if (errJson.message) errorMsg = errJson.message
  } catch {
    try {
      errorMsg = await textResponse.text()
    } catch {
      /* ignore */
    }
  }
  return errorMsg
}

export function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Partial<TaskParams> = {}

  if (typeof record.size === 'string') actualParams.size = record.size
  if (record.quality === 'auto' || record.quality === 'low' || record.quality === 'medium' || record.quality === 'high') {
    actualParams.quality = record.quality
  }
  if (record.output_format === 'png' || record.output_format === 'jpeg' || record.output_format === 'webp') {
    actualParams.output_format = record.output_format
  }
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n

  return actualParams
}

export function mergeActualParams(...sources: Array<Partial<TaskParams> | undefined>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}
