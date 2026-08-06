import type { ApiMode } from '../types'

export interface ImageTaskApiConfig {
  baseUrl: string
  token: string
}

const IMAGE_TASK_API_SESSION_KEY = 'taostudio.imageTaskApi.session'

export type ImageJobStateV1 = 'queued' | 'validating' | 'generating' | 'source_ready' | 'enhancing' | 'finalizing' | 'succeeded' | 'failed' | 'cancelled'

export interface ImageJobRequestV1 {
  contractVersion: '1'
  idempotencyKey: string
  input: { prompt?: string; sourceAssetId?: string }
  composition: { ratio: string }
  generation: {
    provider: string
    model: string
    baseSize?: string
    apiMode?: ApiMode
    fallback?: { provider: string; model: string; apiMode?: ApiMode }
  }
  output: {
    ratioMode: 'inherit'
    format: 'png'
    quality: 'high'
    dimensions?: string
    enhancement: 'auto' | 'none' | 'lanczos3' | 'real-esrgan' | 'hat'
    contentClass?: 'photo' | 'illustration' | 'text' | 'logo' | 'ui'
  }
  retry?: { maxAttempts?: number }
}

export function createImageTaskGeneration(options: {
  provider: string
  model: string
  apiMode?: ApiMode
  fallback?: { provider: string; model: string; apiMode?: ApiMode }
}): ImageJobRequestV1['generation'] {
  return {
    provider: options.provider,
    model: options.model,
    ...(options.apiMode ? { apiMode: options.apiMode } : {}),
    ...(options.fallback ? { fallback: options.fallback } : {}),
  }
}

export interface ImageJobEventV1 {
  state: ImageJobStateV1
  detail: Record<string, unknown> | null
  createdAt: string
}

export interface ImageProviderCallV1 {
  id: number
  attempt: number
  routeIndex: number
  route: { provider: string; model: string; apiMode: ApiMode }
  state: 'started' | 'succeeded' | 'failed' | 'interrupted'
  startedAt: string
  completedAt?: string | null
  usage?: Record<string, unknown> | null
  error?: Record<string, unknown> | null
  httpStatus?: number | null
}

export interface ImageJobV1 {
  id: string
  contractVersion: '1'
  request: ImageJobRequestV1
  state: ImageJobStateV1
  attempts: number
  routeIndex: number
  routeAttempts: number
  maxAttempts: number
  actualRoute: { provider: string; model: string; apiMode: ApiMode }
  cancelRequested: boolean
  sourceAssetId?: string | null
  finalAssetId?: string | null
  error?: {
    code?: string
    message?: string
    retryable?: boolean
    stage?: string
    providerCode?: string
    httpStatus?: number
    failureClass?: string
    recoveryAction?: string
  } | null
  result?: {
    sourceAssetId?: string
    finalAssetId?: string
    manifestVersion?: string
    actualRoute?: { provider: string; model: string; apiMode: ApiMode }
  } | null
  accounting?: {
    calls: ImageProviderCallV1[]
  } | null
  events?: ImageJobEventV1[]
  createdAt: string
  updatedAt: string
}

export interface ImageAssetManifestV1 {
  manifestVersion: '1'
  assetId: string
  jobId: string
  kind: 'source' | 'final'
  parentAssetId: string | null
  mediaType: 'image/png'
  width: number
  height: number
  ratio: string
  bytes: number
  sha256: string
  storagePath: string
  createdAt: string
  transform?: Record<string, unknown> | null
}

export interface ImageTaskCapabilitiesV1 {
  service: 'taostudio-image-task-api'
  apiVersion: '1'
  contractVersion: '1'
  manifestVersion: '1'
  capabilities: {
    inputModes: Array<'prompt' | 'source' | 'edit'>
    apiModes: ApiMode[]
    ratios: string[]
    generation: {
      defaultProvider: 'configured'
      defaultModel: string | null
    }
    output: {
      formats: ['png']
      qualities: ['high']
      acceptedEnhancements: ImageJobRequestV1['output']['enhancement'][]
      implementedEnhancements: string[]
      enhancementFallback: string
      maxEdge: number
      maxPixels: number
    }
    retry: { maxAttempts: number }
    upload: { mediaTypes: ['image/png']; maxBytes: number }
    jobs: { states: ImageJobStateV1[]; defaultListLimit: number; maxListLimit: number }
    batches: {
      maxItems: number
      states: Array<'running' | 'paused' | 'completed'>
      qaStatuses: ImageBatchQaStatusV1[]
      acceptanceStatuses: ImageBatchAcceptanceStatusV1[]
      humanReviewStatuses: Array<'not_ready' | 'pending' | 'approved' | 'rejected' | 'not_applicable'>
      automation: {
        supported: boolean
        maxRevisions: number
        features: Array<'multi_output_expansion' | 'safe_rewrite' | 'visual_qa' | 'human_review' | 'optional_auto_revision'>
      }
    }
    events: { transport: 'polling' | 'sse' }
  }
}

export interface ImageJobListV1 {
  items: ImageJobV1[]
  nextCursor: string | null
  stats: {
    total: number
    terminal: number
    active: number
    queued: number
    succeeded: number
    failed: number
    cancelled: number
    byState: Record<ImageJobStateV1, number>
    matching: number
  }
}

export type ImageBatchQaStatusV1 = 'not_run' | 'passed' | 'failed' | 'needs_review'
export type ImageBatchAcceptanceStatusV1 = 'pending' | 'accepted' | 'needs_review' | 'rejected'

export interface ImageBatchItemV1 {
  itemKey: string
  sourceItemKey: string
  position: number
  outputIndex: number
  outputCount: number
  revision: number
  automationState: 'idle' | 'processing' | 'done'
  generationStatus: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  qaStatus: ImageBatchQaStatusV1
  acceptanceStatus: ImageBatchAcceptanceStatusV1
  failureClass?: string | null
  recoveryAction?: string | null
  review?: Record<string, unknown> | null
  humanReviewStatus: 'not_ready' | 'pending' | 'approved' | 'rejected' | 'not_applicable'
  humanReview?: Record<string, unknown> | null
  job: ImageJobV1
  jobHistory: Array<{
    revision: number
    reason: string
    createdAt: string
    job: ImageJobV1
  }>
}

export interface ImageBatchEventV1 {
  event: string
  detail: Record<string, unknown> | null
  createdAt: string
}

export interface ImageBatchV1 {
  id: string
  name?: string | null
  logicalKey?: string | null
  state: 'running' | 'paused' | 'completed'
  controlState: 'running' | 'paused'
  pauseReason?: string | null
  runner?: {
    active: boolean
    owner: string | null
    attempt: number
    heartbeatAt: string | null
    leaseExpiresAt: string | null
  }
  automation: ImageBatchAutomationV1
  acceptanceState: 'pending' | 'accepted' | 'needs_review' | 'rejected'
  facets?: {
    models: string[]
    dimensions: string[]
    failureClasses: string[]
  }
  stats: {
    total: number
    terminal: number
    active: number
    queued: number
    succeeded: number
    failed: number
    cancelled: number
    accepted: number
    needsReview: number
    rejected: number
    acceptancePending: number
    qaPassed: number
    qaFailed: number
    qaNeedsReview: number
    qaNotRun: number
    humanReviewPending: number
    humanReviewApproved: number
    humanReviewRejected: number
  }
  items: ImageBatchItemV1[]
  events: ImageBatchEventV1[]
  createdAt: string
  updatedAt: string
}

export interface ImageBatchAutomationV1 {
  enabled: boolean
  autoRevise?: boolean
  maxRevisions?: number
  revisionRoute?: {
    provider: string
    model: string
    apiMode: 'responses'
  }
}

export type ImageBatchSummaryV1 = Omit<ImageBatchV1, 'items' | 'events'>

export interface ImageBatchItemListV1 {
  items: ImageBatchItemV1[]
  nextCursor: string | null
  total: number
}

export interface ImageBatchEventListV1 {
  items: ImageBatchEventV1[]
  nextCursor: string | null
  total: number
}

export interface ImageBatchCreateRequestV1 {
  idempotencyKey: string
  logicalKey?: string
  name?: string
  automation?: ImageBatchAutomationV1
  items: Array<{ itemKey: string; copies?: number; request: ImageJobRequestV1 }>
}

export class ImageTaskApiError extends Error {
  status: number
  code: string
  details: unknown

  constructor(message: string, options: { status: number; code?: string; details?: unknown }) {
    super(message)
    this.name = 'ImageTaskApiError'
    this.status = options.status
    this.code = options.code || 'IMAGE_TASK_API_ERROR'
    this.details = options.details
  }
}

export function readLocalImageTaskApiConfig(): ImageTaskApiConfig | null {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.sessionStorage.getItem(IMAGE_TASK_API_SESSION_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<ImageTaskApiConfig>
        const baseUrl = parsed.baseUrl?.trim()
        const token = parsed.token?.trim()
        if (baseUrl && token) return { baseUrl, token }
      }
    } catch {
      // Invalid or unavailable session storage falls back to build-time local configuration.
    }
  }
  const baseUrl = import.meta.env.VITE_IMAGE_TASK_API_URL?.trim()
  const token = import.meta.env.VITE_IMAGE_TASK_API_TOKEN?.trim()
  return baseUrl && token ? { baseUrl, token } : null
}

export function saveLocalImageTaskApiConfig(config: ImageTaskApiConfig): ImageTaskApiConfig {
  const normalized = {
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    token: config.token.trim(),
  }
  if (!normalized.baseUrl || !normalized.token) throw new Error('Image Task API URL and token are required')
  const url = new URL(normalized.baseUrl)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Image Task API URL must use HTTP or HTTPS')
  window.sessionStorage.setItem(IMAGE_TASK_API_SESSION_KEY, JSON.stringify(normalized))
  return normalized
}

export function clearLocalImageTaskApiConfig(): void {
  window.sessionStorage.removeItem(IMAGE_TASK_API_SESSION_KEY)
}

async function taskFetch(config: ImageTaskApiConfig, path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, config.baseUrl), {
    ...init,
    headers: { authorization: `Bearer ${config.token}`, ...init?.headers },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new ImageTaskApiError(payload?.error?.message || `Image Task API returned HTTP ${response.status}`, {
      status: response.status,
      code: payload?.error?.code,
      details: payload?.error?.details,
    })
  }
  return response
}

export async function getImageTaskCapabilities(config: ImageTaskApiConfig): Promise<ImageTaskCapabilitiesV1> {
  return (await taskFetch(config, '/v1/capabilities')).json()
}

export async function createImageJob(config: ImageTaskApiConfig, request: ImageJobRequestV1): Promise<ImageJobV1> {
  const response = await taskFetch(config, '/v1/image-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  return response.json()
}

export async function getImageJob(config: ImageTaskApiConfig, id: string): Promise<ImageJobV1> {
  return (await taskFetch(config, `/v1/image-jobs/${encodeURIComponent(id)}`)).json()
}

export async function listImageJobs(
  config: ImageTaskApiConfig,
  options: { limit?: number; cursor?: string; state?: ImageJobStateV1 } = {},
): Promise<ImageJobListV1> {
  const search = new URLSearchParams()
  if (options.limit !== undefined) search.set('limit', String(options.limit))
  if (options.cursor) search.set('cursor', options.cursor)
  if (options.state) search.set('state', options.state)
  const query = search.size ? `?${search.toString()}` : ''
  return (await taskFetch(config, `/v1/image-jobs${query}`)).json()
}

export async function createImageBatch(config: ImageTaskApiConfig, request: ImageBatchCreateRequestV1): Promise<ImageBatchV1> {
  return (await taskFetch(config, '/v1/image-batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
})).json()
}

// The server currently caps batch list results at `limit` (no cursor pagination),
// so historical batches beyond the limit are silently absent. The caller is
// expected to surface this when batches.length === limit. Default raised from
// 30 to 50 to cover typical internal usage without truncation.
export const BATCH_LIST_LIMIT = 50
export async function listImageBatches(config: ImageTaskApiConfig, limit = BATCH_LIST_LIMIT): Promise<{ items: ImageBatchSummaryV1[] }> {
  return (await taskFetch(config, `/v1/image-batches?limit=${encodeURIComponent(String(limit))}`)).json()
}

export async function getImageBatch(config: ImageTaskApiConfig, id: string): Promise<ImageBatchV1> {
  return (await taskFetch(config, `/v1/image-batches/${encodeURIComponent(id)}`)).json()
}

export async function getImageBatchSummary(config: ImageTaskApiConfig, id: string): Promise<ImageBatchSummaryV1> {
  return (await taskFetch(config, `/v1/image-batches/${encodeURIComponent(id)}/summary`)).json()
}

export async function listImageBatchItems(
  config: ImageTaskApiConfig,
  id: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<ImageBatchItemListV1> {
  const search = new URLSearchParams()
  if (options.limit !== undefined) search.set('limit', String(options.limit))
  if (options.cursor) search.set('cursor', options.cursor)
  const query = search.size ? `?${search.toString()}` : ''
  return (await taskFetch(config, `/v1/image-batches/${encodeURIComponent(id)}/items${query}`)).json()
}

export async function listAllImageBatchItems(config: ImageTaskApiConfig, id: string, limit = 100): Promise<ImageBatchItemV1[]> {
  const items: ImageBatchItemV1[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  while (true) {
    const page = await listImageBatchItems(config, id, { limit, cursor })
    items.push(...page.items)
    if (!page.nextCursor || cursors.has(page.nextCursor)) break
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  return items
}

export async function listImageBatchEvents(
  config: ImageTaskApiConfig,
  id: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<ImageBatchEventListV1> {
  const search = new URLSearchParams()
  if (options.limit !== undefined) search.set('limit', String(options.limit))
  if (options.cursor) search.set('cursor', options.cursor)
  const query = search.size ? `?${search.toString()}` : ''
  return (await taskFetch(config, `/v1/image-batches/${encodeURIComponent(id)}/events${query}`)).json()
}

export async function controlImageBatch(
  config: ImageTaskApiConfig,
  id: string,
  action: 'pause' | 'resume' | 'retry-failed' | 'retry-cancelled',
): Promise<ImageBatchV1> {
  return (await taskFetch(config, `/v1/image-batches/${encodeURIComponent(id)}/${action}`, { method: 'POST' })).json()
}

// P1-4: Bulk review — accept or reject multiple items in one call
export async function bulkReviewBatchItems(
  config: ImageTaskApiConfig,
  batchId: string,
  itemKeys: string[],
  acceptanceStatus: 'accepted' | 'rejected',
): Promise<ImageBatchV1> {
  // The engine's review endpoint is per-item, so we batch client-side.
  // Items are reviewed sequentially to avoid race conditions on the batch row.
  let lastBatch: ImageBatchV1 | null = null
  for (const itemKey of itemKeys) {
    lastBatch = await reviewImageBatchItem(config, batchId, itemKey, { acceptanceStatus })
  }
  return lastBatch!
}

// P2-11: Archive / delete batch
export async function archiveImageBatch(config: ImageTaskApiConfig, id: string): Promise<ImageBatchV1> {
  return (await taskFetch(config, `/v1/image-batches/${encodeURIComponent(id)}/archive`, { method: 'POST' })).json()
}

export async function deleteImageBatch(config: ImageTaskApiConfig, id: string): Promise<{ deleted: boolean }> {
  return (await taskFetch(config, `/v1/image-batches/${encodeURIComponent(id)}`, { method: 'DELETE' })).json()
}

// P0-3: Asset GC
export async function pruneAssets(config: ImageTaskApiConfig, options?: { batchId?: string; includeOrphans?: boolean }): Promise<{ prunedHarvested: number; prunedOrphaned: number }> {
  const body = options ? JSON.stringify({ batchId: options.batchId, includeOrphans: options.includeOrphans }) : '{}'
  return (await taskFetch(config, '/v1/assets/prune', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json()
}

// P1-7: Retry with modified prompt
export async function replaceBatchItemJobWithPrompt(
  config: ImageTaskApiConfig,
  batchId: string,
  itemKey: string,
  request: ImageJobRequestV1,
  reason: string,
): Promise<ImageBatchV1> {
  return (await taskFetch(config, `/v1/image-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemKey)}/job`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request, reason }),
  })).json()
}

export async function subscribeImageTaskEvents(
  config: ImageTaskApiConfig,
  options: { signal: AbortSignal; onChange: () => void; onOpen?: () => void },
): Promise<void> {
  const response = await taskFetch(config, '/v1/events', {
    headers: { accept: 'text/event-stream' },
    signal: options.signal,
  })
  if (!response.body) throw new Error('Image Task API event stream is unavailable')
  options.onOpen?.()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() || ''
    for (const frame of frames) {
      if (frame.split('\n').some((line) => line.startsWith('event: change'))) options.onChange()
    }
  }
}

export async function reviewImageBatchItem(
  config: ImageTaskApiConfig,
  batchId: string,
  itemKey: string,
  review: {
    acceptanceStatus: Extract<ImageBatchAcceptanceStatusV1, 'accepted' | 'rejected'>
    detail?: Record<string, unknown>
  },
): Promise<ImageBatchV1> {
  return (await taskFetch(
    config,
    `/v1/image-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemKey)}/review`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(review),
    },
  )).json()
}

export async function recordImageBatchItemQa(
  config: ImageTaskApiConfig,
  batchId: string,
  itemKey: string,
  review: {
    qaStatus: ImageBatchQaStatusV1
    failureClass?: string
    recoveryAction?: string
    detail?: Record<string, unknown>
  },
): Promise<ImageBatchV1> {
  return (await taskFetch(
    config,
    `/v1/image-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemKey)}/qa`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(review),
    },
  )).json()
}

export async function replaceImageBatchItemJob(
  config: ImageTaskApiConfig,
  batchId: string,
  itemKey: string,
  request: ImageJobRequestV1,
  reason?: string,
): Promise<ImageBatchV1> {
  return (await taskFetch(
    config,
    `/v1/image-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemKey)}/job`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request, ...(reason ? { reason } : {}) }),
    },
  )).json()
}

export async function waitForImageJob(
  config: ImageTaskApiConfig,
  id: string,
  options: { timeoutMs?: number; signal?: AbortSignal; onUpdate?: (job: ImageJobV1) => void | Promise<void> } = {},
): Promise<ImageJobV1> {
  const deadline = Date.now() + (options.timeoutMs ?? 300_000)
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted()
    const job = await getImageJob(config, id)
    await options.onUpdate?.(job)
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('Image Task API polling timed out')
}

// In-memory LRU blob caches so re-opening a job/batch inspector does not
// re-download the same PNG on every access. The engine stores image bytes
// server-side and serves them over HTTP with no client cache headers, so
// without this layer the inspector re-fetches on every render. Mirrors the
// gallery's imageCache.ts LRU pattern but keyed on assetId (not task id) and
// holding Blob objects (not data URLs) to avoid base64-inflating 4K PNGs.
const engineBlobCache = new Map<string, Blob>()
const engineThumbnailCache = new Map<string, Blob>()
const MAX_ENGINE_BLOB_ENTRIES = 6
const MAX_ENGINE_THUMBNAIL_ENTRIES = 60

function cacheBlob(cache: Map<string, Blob>, max: number, key: string, blob: Blob) {
  cache.delete(key)
  cache.set(key, blob)
  while (cache.size > max) {
    const oldestKey = cache.keys().next().value
    if (oldestKey == null) break
    cache.delete(oldestKey)
  }
}

export async function getImageAssetBlob(config: ImageTaskApiConfig, assetId: string): Promise<Blob> {
  const cached = engineBlobCache.get(assetId)
  if (cached) {
    // Refresh LRU recency without mutating the original entry.
    engineBlobCache.delete(assetId)
    engineBlobCache.set(assetId, cached)
    return cached
  }
  const blob = await (await taskFetch(config, `/v1/assets/${encodeURIComponent(assetId)}`)).blob()
  cacheBlob(engineBlobCache, MAX_ENGINE_BLOB_ENTRIES, assetId, blob)
  return blob
}

export async function getImageAssetThumbnailBlob(
  config: ImageTaskApiConfig,
  assetId: string,
  width = 320,
): Promise<Blob> {
  // Thumbnail cache is keyed by assetId only (width is constant in practice);
  // a different requested width simply misses and re-fetches.
  const cached = engineThumbnailCache.get(assetId)
  if (cached) {
    engineThumbnailCache.delete(assetId)
    engineThumbnailCache.set(assetId, cached)
    return cached
  }
  const blob = await (await taskFetch(
    config,
    `/v1/assets/${encodeURIComponent(assetId)}/thumbnail?width=${encodeURIComponent(String(width))}`,
  )).blob()
  cacheBlob(engineThumbnailCache, MAX_ENGINE_THUMBNAIL_ENTRIES, assetId, blob)
  return blob
}

export async function getImageAssetManifest(config: ImageTaskApiConfig, assetId: string): Promise<ImageAssetManifestV1> {
  return (await taskFetch(config, `/v1/assets/${encodeURIComponent(assetId)}?manifest=1`)).json()
}

export async function uploadImageAsset(config: ImageTaskApiConfig, png: Blob, fileName = 'source.png') {
  const response = await taskFetch(config, '/v1/assets/uploads', {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-file-name': fileName },
    body: png,
  })
  return response.json() as Promise<{ assetId: string }>
}

export async function cancelImageJob(config: ImageTaskApiConfig, id: string): Promise<ImageJobV1> {
  return (await taskFetch(config, `/v1/image-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })).json()
}

export async function retryImageJob(config: ImageTaskApiConfig, id: string): Promise<ImageJobV1> {
  return (await taskFetch(config, `/v1/image-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' })).json()
}

export async function executeImageTask(
  config: ImageTaskApiConfig,
  request: ImageJobRequestV1,
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    onJobCreated?: (job: ImageJobV1) => void | Promise<void>
    onJobUpdate?: (job: ImageJobV1) => void | Promise<void>
  } = {},
): Promise<{ job: ImageJobV1; image: Blob }> {
  const created = await createImageJob(config, request)
  await options.onJobCreated?.(created)
  const abort = () => { void cancelImageJob(config, created.id) }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const job = await waitForImageJob(config, created.id, { ...options, onUpdate: options.onJobUpdate })
    if (job.state !== 'succeeded' || !job.finalAssetId) {
      throw new Error(job.error?.message || `Image Task API job ended as ${job.state}`)
    }
    return { job, image: await getImageAssetBlob(config, job.finalAssetId) }
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}
