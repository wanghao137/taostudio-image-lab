import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const baseUrl = process.env.IMAGE_TASK_API_URL || 'http://127.0.0.1:9789'
const token = process.env.IMAGE_TASK_API_TOKEN
if (!token) throw new Error('IMAGE_TASK_API_TOKEN is required')

const PRESET_4K = {
  '1:1': '2880x2880', '2:1': '3840x1920', '3:2': '3456x2304', '2:3': '2304x3456', '16:9': '3840x2160',
  '9:16': '2160x3840', '4:3': '3200x2400', '3:4': '2400x3200', '21:9': '3840x1646',
  '4:5': '2400x3000', '5:4': '3000x2400', '3:5': '2160x3600', '5:3': '3600x2160',
}
const fallbackSchema = z.object({
  provider: z.string().min(1).default('configured'),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses']).default('responses'),
})
const batchAutomationSchema = z.object({
  enabled: z.boolean().default(true),
  maxRevisions: z.number().int().min(0).max(3).default(2),
  revisionRoute: z.object({
    provider: z.string().min(1).default('configured'),
    model: z.string().min(1),
    apiMode: z.literal('responses').default('responses'),
  }),
})
const batchItemSchema = z.object({
  itemKey: z.string().min(1).max(200),
  copies: z.number().int().min(1).max(10).optional(),
  outputPath: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  sourceAssetId: z.string().optional(),
  ratio: z.enum(['1:1', '2:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9', '4:5', '5:4', '3:5', '5:3']),
  dimensions: z.string().regex(/^\d+x\d+$/).optional(),
  provider: z.string().min(1).default('configured'),
  model: z.string().min(1),
  apiMode: z.enum(['images', 'responses']).optional(),
  fallback: fallbackSchema.optional(),
  enhancement: z.enum(['auto', 'none', 'lanczos3', 'real-esrgan', 'hat']).default('auto'),
  contentClass: z.enum(['photo', 'illustration', 'text', 'logo', 'ui']).default('photo'),
  maxAttempts: z.number().int().min(1).max(5).default(3),
})

function batchJobIdempotencyKey(batchKey, itemKey) {
  return `batch-job-${createHash('sha256').update(`${batchKey}\0${itemKey}`).digest('hex').slice(0, 48)}`
}

function requestFromBatchItem(batchKey, item) {
  return {
    contractVersion: '1',
    idempotencyKey: batchJobIdempotencyKey(batchKey, item.itemKey),
    input: {
      ...(item.prompt ? { prompt: item.prompt } : {}),
      ...(item.sourceAssetId ? { sourceAssetId: item.sourceAssetId } : {}),
    },
    composition: { ratio: item.ratio },
    generation: {
      provider: item.provider,
      model: item.model,
      ...(item.apiMode ? { apiMode: item.apiMode } : {}),
      ...(item.fallback ? { fallback: item.fallback } : {}),
    },
    output: {
      ratioMode: 'inherit',
      format: 'png',
      quality: 'high',
      dimensions: item.dimensions || PRESET_4K[item.ratio],
      enhancement: item.enhancement,
      contentClass: item.contentClass,
    },
    retry: { maxAttempts: item.maxAttempts },
  }
}

async function api(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`)
  }
  return response
}

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

async function waitForJob(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await (await api(`/v1/image-jobs/${encodeURIComponent(id)}`)).json()
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error(`job ${id} did not reach a terminal state before timeout`)
}

const server = new McpServer({ name: 'taostudio-image-task-api', version: '1.0.0' })

server.registerTool('image_asset_upload', {
  description: 'Upload an immutable local PNG source asset. Re-uploading identical bytes returns the same asset id.',
  inputSchema: { path: z.string().min(1) },
}, async ({ path }) => {
  const absolutePath = resolve(path)
  const buffer = await readFile(absolutePath)
  const response = await api('/v1/assets/uploads', {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'x-file-name': basename(absolutePath) },
    body: buffer,
  })
  return textResult(await response.json())
})

server.registerTool('image_job_create', {
  description: 'Create one idempotent image job. Reuse the same idempotencyKey for retries of the same intent.',
  inputSchema: {
    idempotencyKey: z.string().min(8).max(200),
    prompt: z.string().min(1).optional(),
    ratio: z.enum(['1:1', '2:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9', '4:5', '5:4', '3:5', '5:3']),
    dimensions: z.string().regex(/^\d+x\d+$/).optional().describe(
      'Final output pixels. Optional — defaults to the 4K preset for the given ratio. '
      + '4K presets: 1:1=2880x2880 2:1=3840x1920 3:2=3456x2304 2:3=2304x3456 16:9=3840x2160 '
      + '9:16=2160x3840 4:3=3200x2400 3:4=2400x3200 21:9=3840x1646 '
      + '4:5=2400x3000 5:4=3000x2400 3:5=2160x3600 5:3=3600x2160.'
    ),
    provider: z.string().min(1).default('mock'),
    model: z.string().min(1).default('mock-v1'),
    apiMode: z.enum(['images', 'responses']).optional(),
    fallback: fallbackSchema.optional().describe(
      'Optional second route used only for eligible provider failures after the primary route budget is exhausted.',
    ),
    enhancement: z.enum(['auto', 'none', 'lanczos3', 'real-esrgan', 'hat']).default('auto'),
    contentClass: z.enum(['photo', 'illustration', 'text', 'logo', 'ui']).default('photo'),
    maxAttempts: z.number().int().min(1).max(5).default(3),
    sourceAssetId: z.string().optional(),
    testBehavior: z.enum(['fail', 'fail-once', 'timeout']).optional(),
  },
}, async (input) => {
  const dimensions = input.dimensions || PRESET_4K[input.ratio]
  const response = await api('/v1/image-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contractVersion: '1',
      idempotencyKey: input.idempotencyKey,
      input: { ...(input.prompt ? { prompt: input.prompt } : {}), ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}) },
      composition: { ratio: input.ratio },
      generation: {
        provider: input.provider,
        model: input.model,
        ...(input.apiMode ? { apiMode: input.apiMode } : {}),
        ...(input.fallback ? { fallback: input.fallback } : {}),
        ...(input.testBehavior ? { testBehavior: input.testBehavior } : {}),
      },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions, enhancement: input.enhancement, contentClass: input.contentClass },
      retry: { maxAttempts: input.maxAttempts },
    }),
  })
  return textResult({ replayed: response.headers.get('idempotency-replayed') === 'true', job: await response.json() })
})

server.registerTool('image_job_get', {
  description: 'Get an image job, state transition events, and the provider-call accounting ledger.',
  inputSchema: { jobId: z.string().min(1) },
}, async ({ jobId }) => textResult(await (await api(`/v1/image-jobs/${encodeURIComponent(jobId)}`)).json()))

server.registerTool('image_job_wait', {
  description: 'Wait for an image job to succeed, fail, or be cancelled.',
  inputSchema: { jobId: z.string().min(1), timeoutMs: z.number().int().min(100).max(1_800_000).default(1_200_000) },
}, async ({ jobId, timeoutMs }) => textResult(await waitForJob(jobId, timeoutMs)))

server.registerTool('image_job_cancel', {
  description: 'Request cancellation of a queued or active image job.',
  inputSchema: { jobId: z.string().min(1) },
}, async ({ jobId }) => textResult(await (await api(`/v1/image-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })).json()))

server.registerTool('image_job_retry', {
  description: 'Requeue a failed image job with a fresh attempt budget while preserving its event history.',
  inputSchema: { jobId: z.string().min(1) },
}, async ({ jobId }) => textResult(await (await api(`/v1/image-jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' })).json()))

server.registerTool('image_batch_create', {
  description: 'Create an idempotent server-side image batch. Every item becomes a durable job with a stable derived idempotency key.',
  inputSchema: {
    idempotencyKey: z.string().min(8).max(200),
    logicalKey: z.string().min(8).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    outputRoot: z.string().min(1).optional(),
    automation: batchAutomationSchema.optional(),
    items: z.array(batchItemSchema).min(1).max(500),
  },
}, async ({ idempotencyKey, logicalKey, name, outputRoot, automation, items }) => {
  const response = await api('/v1/image-batches', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey,
      ...(logicalKey ? { logicalKey } : {}),
      ...(name ? { name } : {}),
      ...(outputRoot ? { outputRoot } : {}),
      ...(automation ? { automation } : {}),
      items: items.map((item) => ({
        itemKey: item.itemKey,
        ...(item.copies ? { copies: item.copies } : {}),
        ...(item.outputPath ? { outputPath: item.outputPath } : {}),
        request: requestFromBatchItem(idempotencyKey, item),
      })),
    }),
  })
  return textResult({
    replayed: response.headers.get('idempotency-replayed') === 'true',
    batch: await response.json(),
  })
})

server.registerTool('image_batch_get', {
  description: 'Get a batch with aggregate progress, ordered items, jobs, and batch events.',
  inputSchema: { batchId: z.string().min(1) },
}, async ({ batchId }) => textResult(await (await api(`/v1/image-batches/${encodeURIComponent(batchId)}`)).json()))

server.registerTool('image_batch_find_by_logical_key', {
  description: 'Find the durable logical batch for a manifest run. Use this before creating a new batch after a runner restart.',
  inputSchema: { logicalKey: z.string().min(8).max(200) },
}, async ({ logicalKey }) => {
  const response = await fetch(new URL(`/v1/image-batches/by-logical-key/${encodeURIComponent(logicalKey)}`, baseUrl), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (response.status === 404) return textResult({ batch: null })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`)
  }
  return textResult({ batch: await response.json() })
})

server.registerTool('image_batch_adopt_logical_key', {
  description: 'Attach a stable logical key to a legacy batch selected from its persisted batchId. This migrates restart recovery without creating a duplicate batch.',
  inputSchema: { batchId: z.string().min(1), logicalKey: z.string().min(8).max(200) },
}, async ({ batchId, logicalKey }) => textResult(await (await api(
  `/v1/image-batches/${encodeURIComponent(batchId)}/logical-key`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logicalKey }) },
)).json()))

const runnerLeaseSchema = {
  batchId: z.string().min(1),
  owner: z.string().min(1).max(200),
}

server.registerTool('image_batch_runner_acquire', {
  description: 'Acquire the exclusive lease to operate one logical batch. A second runner is rejected until the lease expires.',
  inputSchema: { ...runnerLeaseSchema, leaseMs: z.number().int().min(10_000).max(300_000) },
}, async ({ batchId, owner, leaseMs }) => textResult(await (await api(
  `/v1/image-batches/${encodeURIComponent(batchId)}/runner/acquire`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner, leaseMs }) },
)).json()))

server.registerTool('image_batch_runner_heartbeat', {
  description: 'Renew the exclusive lease held by this runner while it waits for jobs or processes assets.',
  inputSchema: { ...runnerLeaseSchema, leaseMs: z.number().int().min(10_000).max(300_000) },
}, async ({ batchId, owner, leaseMs }) => textResult(await (await api(
  `/v1/image-batches/${encodeURIComponent(batchId)}/runner/heartbeat`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner, leaseMs }) },
)).json()))

server.registerTool('image_batch_runner_release', {
  description: 'Release this runner lease after a normal batch exit. Expired leases are also recoverable by a later runner.',
  inputSchema: runnerLeaseSchema,
}, async ({ batchId, owner }) => textResult(await (await api(
  `/v1/image-batches/${encodeURIComponent(batchId)}/runner/release`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner }) },
)).json()))

server.registerTool('image_batch_pause', {
  description: 'Pause a batch. Active jobs continue; queued jobs stop being claimed. Pass reason to distinguish manual vs system pauses.',
  inputSchema: { batchId: z.string().min(1), reason: z.string().optional() },
}, async ({ batchId, reason }) => {
  const fetchOptions = { method: 'POST' }
  if (reason) {
    fetchOptions.body = JSON.stringify({ reason })
    fetchOptions.headers = { 'content-type': 'application/json' }
  }
  return textResult(await (await api(`/v1/image-batches/${encodeURIComponent(batchId)}/pause`, fetchOptions)).json())
})

server.registerTool('image_batch_resume', {
  description: 'Resume a paused batch.',
  inputSchema: { batchId: z.string().min(1) },
}, async ({ batchId }) => textResult(await (await api(`/v1/image-batches/${encodeURIComponent(batchId)}/resume`, { method: 'POST' })).json()))

server.registerTool('image_batch_retry_failed', {
  description: 'Requeue every failed job in a batch with fresh attempt budgets and resume the batch.',
  inputSchema: { batchId: z.string().min(1) },
}, async ({ batchId }) => textResult(await (await api(`/v1/image-batches/${encodeURIComponent(batchId)}/retry-failed`, { method: 'POST' })).json()))

server.registerTool('image_batch_item_qa', {
  description: 'Record advisory visual QA for one terminal batch item. QA never confirms delivery or replaces an item by itself.',
  inputSchema: {
    batchId: z.string().min(1),
    itemKey: z.string().min(1).max(200),
    qaStatus: z.enum(['not_run', 'passed', 'failed', 'needs_review']),
    failureClass: z.string().min(1).max(100).optional(),
    recoveryAction: z.string().min(1).max(100).optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  },
}, async ({ batchId, itemKey, ...review }) => textResult(await (await api(
  `/v1/image-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemKey)}/qa`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(review),
  },
)).json()))

server.registerTool('image_batch_item_review', {
  description: 'Record a human delivery decision for one succeeded batch item.',
  inputSchema: {
    batchId: z.string().min(1),
    itemKey: z.string().min(1).max(200),
    acceptanceStatus: z.enum(['accepted', 'rejected']),
    detail: z.record(z.string(), z.unknown()).optional(),
  },
}, async ({ batchId, itemKey, ...review }) => textResult(await (await api(
  `/v1/image-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemKey)}/review`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(review),
  },
)).json()))

server.registerTool('image_batch_item_replace_job', {
  description: 'Attach a new revision job to a terminal batch item while preserving its prior job history.',
  inputSchema: {
    batchId: z.string().min(1),
    replacementKey: z.string().min(8).max(200),
    reason: z.string().min(1).max(200),
    item: batchItemSchema,
  },
}, async ({ batchId, replacementKey, reason, item }) => textResult(await (await api(
  `/v1/image-batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(item.itemKey)}/job`,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reason,
      request: requestFromBatchItem(replacementKey, item),
    }),
  },
)).json()))

server.registerTool('image_asset_download', {
  description: 'Download a completed source or final asset to a local PNG path.',
  inputSchema: { assetId: z.string().min(1), outputPath: z.string().min(1) },
}, async ({ assetId, outputPath }) => {
  const response = await api(`/v1/assets/${encodeURIComponent(assetId)}`)
  const absolutePath = resolve(outputPath)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(absolutePath, { flags: 'wx' }))
  const manifest = await (await api(`/v1/assets/${encodeURIComponent(assetId)}?manifest=1`)).json()
  return textResult({ outputPath: absolutePath, manifest })
})

await server.connect(new StdioServerTransport())
