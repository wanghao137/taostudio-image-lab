import { createWriteStream } from 'node:fs'
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
    prompt: z.string().min(1),
    ratio: z.enum(['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4', '21:9']),
    dimensions: z.string().regex(/^\d+x\d+$/),
    provider: z.string().min(1).default('mock'),
    model: z.string().min(1).default('mock-v1'),
    enhancement: z.enum(['auto', 'none', 'lanczos3', 'real-esrgan', 'hat']).default('auto'),
    contentClass: z.enum(['photo', 'illustration', 'text', 'logo', 'ui']).default('photo'),
    maxAttempts: z.number().int().min(1).max(5).default(3),
    sourceAssetId: z.string().optional(),
    testBehavior: z.enum(['fail', 'fail-once', 'timeout']).optional(),
  },
}, async (input) => {
  const response = await api('/v1/image-jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contractVersion: '1',
      idempotencyKey: input.idempotencyKey,
      input: { prompt: input.prompt, ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}) },
      composition: { ratio: input.ratio },
      generation: { provider: input.provider, model: input.model, ...(input.testBehavior ? { testBehavior: input.testBehavior } : {}) },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: input.dimensions, enhancement: input.enhancement, contentClass: input.contentClass },
      retry: { maxAttempts: input.maxAttempts },
    }),
  })
  return textResult({ replayed: response.headers.get('idempotency-replayed') === 'true', job: await response.json() })
})

server.registerTool('image_job_get', {
  description: 'Get an image job and its state transition events.',
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
