import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createTaskApi } from '../server/task-api/service.mjs'

async function loadEnvironment(path) {
  const values = {}
  const content = await readFile(path, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return values
}

const environment = await loadEnvironment(resolve('.env.local'))
const baseUrl = process.env.IMAGE_TASK_PROVIDER_BASE_URL || environment.IMAGE_API_BASE_URL
const apiKey = process.env.IMAGE_TASK_PROVIDER_API_KEY || environment.IMAGE_API_KEY
if (!baseUrl || !apiKey) throw new Error('real provider configuration is unavailable')

const stateDir = resolve('.local-task-api-real-smoke')
await rm(stateDir, { recursive: true, force: true })
const taskApi = await createTaskApi({
  stateDir,
  token: 'real-smoke-local-token',
  concurrency: 1,
  providerTimeoutMs: 300_000,
  providerConfig: { baseUrl, apiKey, model: process.env.IMAGE_TASK_PROVIDER_MODEL || 'gpt-image-2' },
})
const address = await taskApi.listen(0)
const headers = { authorization: 'Bearer real-smoke-local-token', 'content-type': 'application/json' }
try {
  const createdResponse = await fetch(`${address.url}/v1/image-jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contractVersion: '1',
      idempotencyKey: `real-smoke-${Date.now()}`,
      input: { prompt: 'A minimal blue ceramic cube on a neutral light gray studio background, centered product photograph.' },
      composition: { ratio: '1:1' },
      generation: { provider: 'configured', model: process.env.IMAGE_TASK_PROVIDER_MODEL || 'gpt-image-2', baseSize: '1024x1024' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '1024x1024', enhancement: 'lanczos3', contentClass: 'photo' },
      retry: { maxAttempts: 1 },
    }),
  })
  const created = await createdResponse.json()
  const deadline = Date.now() + 320_000
  let job = created
  while (!['succeeded', 'failed', 'cancelled'].includes(job.state) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    job = await (await fetch(`${address.url}/v1/image-jobs/${created.id}`, { headers })).json()
  }
  if (job.state !== 'succeeded') throw new Error(`real smoke failed: ${JSON.stringify(job.error)}`)
  const source = await (await fetch(`${address.url}/v1/assets/${job.sourceAssetId}?manifest=1`, { headers })).json()
  const final = await (await fetch(`${address.url}/v1/assets/${job.finalAssetId}?manifest=1`, { headers })).json()
  console.log(JSON.stringify({
    jobId: job.id,
    state: job.state,
    attempts: job.attempts,
    source: { assetId: source.assetId, width: source.width, height: source.height, ratio: source.ratio, sha256: source.sha256 },
    final: { assetId: final.assetId, width: final.width, height: final.height, ratio: final.ratio, sha256: final.sha256, parentAssetId: final.parentAssetId },
  }, null, 2))
} finally {
  await taskApi.close()
}
