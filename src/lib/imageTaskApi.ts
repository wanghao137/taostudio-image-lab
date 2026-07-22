export interface ImageTaskApiConfig {
  baseUrl: string
  token: string
}

export interface ImageJobRequestV1 {
  contractVersion: '1'
  idempotencyKey: string
  input: { prompt?: string; sourceAssetId?: string }
  composition: { ratio: string }
  generation: { provider: string; model: string; baseSize?: string }
  output: {
    ratioMode: 'inherit'
    format: 'png'
    quality: 'high'
    dimensions?: string
    enhancement: 'auto' | 'none' | 'lanczos3' | 'real-esrgan' | 'hat'
    contentClass?: 'photo' | 'illustration' | 'text' | 'logo' | 'ui'
  }
}

export interface ImageJobV1 {
  id: string
  state: 'queued' | 'validating' | 'generating' | 'source_ready' | 'enhancing' | 'finalizing' | 'succeeded' | 'failed' | 'cancelled'
  sourceAssetId?: string | null
  finalAssetId?: string | null
  error?: { code?: string; message?: string; retryable?: boolean } | null
}

export function readLocalImageTaskApiConfig(): ImageTaskApiConfig | null {
  const baseUrl = import.meta.env.VITE_IMAGE_TASK_API_URL?.trim()
  const token = import.meta.env.VITE_IMAGE_TASK_API_TOKEN?.trim()
  return baseUrl && token ? { baseUrl, token } : null
}

async function taskFetch(config: ImageTaskApiConfig, path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, config.baseUrl), {
    ...init,
    headers: { authorization: `Bearer ${config.token}`, ...init?.headers },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error?.message || `Image Task API returned HTTP ${response.status}`)
  }
  return response
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

export async function waitForImageJob(config: ImageTaskApiConfig, id: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ImageJobV1> {
  const deadline = Date.now() + (options.timeoutMs ?? 300_000)
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted()
    const job = await getImageJob(config, id)
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('Image Task API polling timed out')
}

export async function getImageAssetBlob(config: ImageTaskApiConfig, assetId: string): Promise<Blob> {
  return (await taskFetch(config, `/v1/assets/${encodeURIComponent(assetId)}`)).blob()
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
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ job: ImageJobV1; image: Blob }> {
  const created = await createImageJob(config, request)
  const abort = () => { void cancelImageJob(config, created.id) }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    const job = await waitForImageJob(config, created.id, options)
    if (job.state !== 'succeeded' || !job.finalAssetId) {
      throw new Error(job.error?.message || `Image Task API job ended as ${job.state}`)
    }
    return { job, image: await getImageAssetBlob(config, job.finalAssetId) }
  } finally {
    options.signal?.removeEventListener('abort', abort)
  }
}
