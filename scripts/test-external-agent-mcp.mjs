import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const token = process.env.IMAGE_TASK_API_TOKEN
if (!token) throw new Error('IMAGE_TASK_API_TOKEN is required')
const outputRoot = resolve('.local-task-api/evidence')
await mkdir(outputRoot, { recursive: true })
const outputPath = resolve(outputRoot, 'external-agent-final.png')
await rm(outputPath, { force: true })

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('server/task-api/mcp-server.mjs')],
  cwd: resolve('.'),
  env: { ...process.env, IMAGE_TASK_API_URL: process.env.IMAGE_TASK_API_URL || 'http://127.0.0.1:9789', IMAGE_TASK_API_TOKEN: token },
})
const client = new Client({ name: 'taostudio-external-agent-e2e', version: '1.0.0' })
await client.connect(transport)

function payload(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text
  if (!text) throw new Error('MCP tool returned no text payload')
  return JSON.parse(text)
}

async function call(name, args) { return payload(await client.callTool({ name, arguments: args })) }

try {
  const common = {
    idempotencyKey: 'external-agent-e2e-success-001',
    prompt: 'External agent MCP contract test',
    ratio: '3:2',
    dimensions: '3456x2304',
    provider: 'mock',
    model: 'mock-v1',
    enhancement: 'lanczos3',
    contentClass: 'logo',
  }
  const first = await call('image_job_create', common)
  const completed = await call('image_job_wait', { jobId: first.job.id, timeoutMs: 120_000 })
  const replay = await call('image_job_create', common)
  if (!replay.replayed || replay.job.id !== first.job.id) throw new Error('MCP idempotency check failed')
  const downloaded = await call('image_asset_download', { assetId: completed.finalAssetId, outputPath })

  const failing = await call('image_job_create', {
    ...common,
    idempotencyKey: 'external-agent-e2e-failure-001',
    testBehavior: 'fail',
  })
  const failed = await call('image_job_wait', { jobId: failing.job.id, timeoutMs: 120_000 })
  if (failed.state !== 'failed') throw new Error('MCP failure path did not fail')

  const cancellable = await call('image_job_create', {
    ...common,
    idempotencyKey: 'external-agent-e2e-cancel-001',
    testBehavior: 'timeout',
  })
  await call('image_job_cancel', { jobId: cancellable.job.id })
  const cancelled = await call('image_job_wait', { jobId: cancellable.job.id, timeoutMs: 30_000 })
  if (cancelled.state !== 'cancelled') throw new Error('MCP cancellation path was not cancelled')

  const evidence = {
    generatedAt: new Date().toISOString(),
    success: {
      firstJobId: first.job.id,
      replayJobId: replay.job.id,
      replayed: replay.replayed,
      state: completed.state,
      sourceAssetId: completed.sourceAssetId,
      finalAssetId: completed.finalAssetId,
      final: { width: downloaded.manifest.width, height: downloaded.manifest.height, ratio: downloaded.manifest.ratio, sha256: downloaded.manifest.sha256 },
      outputPath,
    },
    failure: { jobId: failed.id, state: failed.state, attempts: failed.attempts, error: failed.error },
    cancellation: { jobId: cancelled.id, state: cancelled.state },
  }
  await writeFile(resolve(outputRoot, 'external-agent-evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await client.close()
}
