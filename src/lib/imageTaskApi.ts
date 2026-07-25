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
  generation: { provider: string; model: string; baseSize?: string; apiMode?: ApiMode }
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

export interface ImageJobEventV1 {
  state: ImageJobStateV1
  detail: Record<string, unknown> | null
  createdAt: string
}

export interface ImageJobV1 {
  id: string
  contractVersion: '1'
  request: ImageJobRequestV1
  state: ImageJobStateV1
  attempts: number
  maxAttempts: number
  cancelRequested: boolean
  sourceAssetId?: string | null
  finalAssetId?: string | null
  error?: { code?: string; message?: string; retryable?: boolean; stage?: string; providerCode?: string; httpStatus?: number } | null
  result?: { sourceAssetId?: string; finalAssetId?: string; manifestVersion?: string } | null
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
    events: { transport: 'polling' }
  }
}

export interface ImageJobListV1 {
  items: ImageJobV1[]
  nextCursor: string | null
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

export async function getImageAssetBlob(config: ImageTaskApiConfig, assetId: string): Promise<Blob> {
  return (await taskFetch(config, `/v1/assets/${encodeURIComponent(assetId)}`)).blob()
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
