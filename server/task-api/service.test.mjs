import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskApi } from './service.mjs'

const running = []

function request(overrides = {}) {
  return {
    contractVersion: '1',
    idempotencyKey: `test-${crypto.randomUUID()}`,
    input: { prompt: 'contract test image' },
    composition: { ratio: '9:16' },
    generation: { provider: 'mock', model: 'mock-v1', baseSize: '720x1280' },
    output: { ratioMode: 'inherit', format: 'png', quality: 'high', enhancement: 'auto', contentClass: 'photo' },
    retry: { maxAttempts: 3 },
    ...overrides,
  }
}

async function start(options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'taostudio-task-api-'))
  const api = await createTaskApi({ stateDir, token: 'test-token', pollIntervalMs: 5, ...options })
  const address = await api.listen(0)
  const instance = { api, stateDir, url: address.url, closed: false }
  running.push(instance)
  return instance
}

function headers(extra = {}) { return { authorization: 'Bearer test-token', ...extra } }

async function create(url, payload) {
  const response = await fetch(`${url}/v1/image-jobs`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(payload) })
  return { response, body: await response.json() }
}

async function wait(url, id, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/v1/image-jobs/${id}`, { headers: headers() })
    const job = await response.json()
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  throw new Error(`job ${id} did not finish`)
}

afterEach(async () => {
  while (running.length) {
    const instance = running.pop()
    if (!instance.closed) await instance.api.close()
    await rm(instance.stateDir, { recursive: true, force: true })
  }
})

describe('local Image Task API', () => {
  it('requires bearer authentication', async () => {
    const { url } = await start()
    const response = await fetch(`${url}/v1/image-jobs/missing`)
    expect(response.status).toBe(401)
  })

  it('runs a mock job and stores traceable source/final PNG assets', async () => {
    const { url } = await start()
    const created = await create(url, request({ idempotencyKey: 'mock-success-001' }))
    expect(created.response.status).toBe(201)
    const job = await wait(url, created.body.id)
    expect(job.state).toBe('succeeded')
    expect(job.sourceAssetId).toMatch(/^asset_/)
    expect(job.finalAssetId).toMatch(/^asset_/)

    const sourceManifest = await (await fetch(`${url}/v1/assets/${job.sourceAssetId}?manifest=1`, { headers: headers() })).json()
    const finalResponse = await fetch(`${url}/v1/assets/${job.finalAssetId}`, { headers: headers() })
    const finalBuffer = Buffer.from(await finalResponse.arrayBuffer())
    const finalManifest = await (await fetch(`${url}/v1/assets/${job.finalAssetId}?manifest=1`, { headers: headers() })).json()
    expect(sourceManifest).toMatchObject({ kind: 'source', width: 720, height: 1280, ratio: '9:16' })
    expect(finalManifest).toMatchObject({ kind: 'final', width: 2160, height: 3840, ratio: '9:16', parentAssetId: job.sourceAssetId })
    expect(finalBuffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(createHash('sha256').update(finalBuffer).digest('hex')).toBe(finalManifest.sha256)
  })

  it('deduplicates concurrent creates and rejects key reuse with different input', async () => {
    const { url } = await start()
    const payload = request({ idempotencyKey: 'concurrent-idempotency-001' })
    const results = await Promise.all(Array.from({ length: 8 }, () => create(url, payload)))
    expect(new Set(results.map((result) => result.body.id)).size).toBe(1)
    expect(results.filter((result) => result.response.status === 201)).toHaveLength(1)
    const conflict = await create(url, { ...payload, input: { prompt: 'different prompt' } })
    expect(conflict.response.status).toBe(409)
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('cancels a queued job without generation', async () => {
    const { url } = await start({ concurrency: 0 })
    const created = await create(url, request({ idempotencyKey: 'cancel-queued-001' }))
    const response = await fetch(`${url}/v1/image-jobs/${created.body.id}/cancel`, { method: 'POST', headers: headers() })
    expect((await response.json()).state).toBe('cancelled')
  })

  it('times out and retries the same job without creating a duplicate', async () => {
    const { url } = await start({ providerTimeoutMs: 30 })
    const payload = request({
      idempotencyKey: 'timeout-retry-001',
      generation: { provider: 'mock', model: 'mock-v1', testBehavior: 'timeout' },
      retry: { maxAttempts: 2 },
    })
    const created = await create(url, payload)
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ state: 'failed', attempts: 2 })
    expect(job.error).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: false })
    const replay = await create(url, payload)
    expect(replay.body.id).toBe(created.body.id)
    expect(replay.response.headers.get('idempotency-replayed')).toBe('true')
  })

  it('recovers from a transient provider failure on the same job', async () => {
    const { url } = await start()
    const payload = request({
      idempotencyKey: 'transient-retry-001',
      generation: { provider: 'mock', model: 'mock-v1', baseSize: '720x1280', testBehavior: 'fail-once' },
      retry: { maxAttempts: 3 },
    })
    const created = await create(url, payload)
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ id: created.body.id, state: 'succeeded', attempts: 2 })
    expect(job.events.filter((event) => event.state === 'queued')).toHaveLength(2)
  })

  it('interrupts an active provider call when cancelled', async () => {
    const { url } = await start({ providerTimeoutMs: 20_000 })
    const created = await create(url, request({
      idempotencyKey: 'cancel-active-001',
      generation: { provider: 'mock', model: 'mock-v1', testBehavior: 'timeout' },
    }))
    const deadline = Date.now() + 5_000
    let active
    while (Date.now() < deadline) {
      active = await (await fetch(`${url}/v1/image-jobs/${created.body.id}`, { headers: headers() })).json()
      if (active.state === 'generating') break
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    }
    expect(active.state).toBe('generating')
    await fetch(`${url}/v1/image-jobs/${created.body.id}/cancel`, { method: 'POST', headers: headers() })
    expect(await wait(url, created.body.id)).toMatchObject({ state: 'cancelled' })
  })

  it('recovers an interrupted active job on restart', async () => {
    const first = await start({ concurrency: 0 })
    const created = await create(first.url, request({ idempotencyKey: 'recovery-001' }))
    first.api.repository.transition(created.body.id, 'validating')
    await first.api.close()
    first.closed = true
    const secondApi = await createTaskApi({ stateDir: first.stateDir, token: 'test-token', concurrency: 0 })
    expect(secondApi.recoveredJobs).toBe(1)
    expect(secondApi.repository.getJob(created.body.id).state).toBe('queued')
    secondApi.repository.close()
  })

  it('accepts immutable PNG uploads and uses the asset as a job source', async () => {
    const { url } = await start()
    const upload = await sharp({ create: { width: 1024, height: 768, channels: 4, background: '#22aa77' } }).png().toBuffer()
    const uploaded = await fetch(`${url}/v1/assets/uploads`, { method: 'POST', headers: headers({ 'content-type': 'image/png', 'x-file-name': 'source.png' }), body: upload })
    expect(uploaded.status).toBe(201)
    const asset = await uploaded.json()
    const replayedUpload = await fetch(`${url}/v1/assets/uploads`, { method: 'POST', headers: headers({ 'content-type': 'image/png', 'x-file-name': 'same.png' }), body: upload })
    expect(replayedUpload.status).toBe(200)
    expect((await replayedUpload.json()).assetId).toBe(asset.assetId)
    const payload = request({
      idempotencyKey: 'upload-source-001',
      input: { sourceAssetId: asset.assetId },
      composition: { ratio: '4:3' },
      generation: { provider: 'mock', model: 'unused' },
    })
    const created = await create(url, payload)
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ state: 'succeeded', sourceAssetId: asset.assetId })
    const stored = await readFile(join(running.at(-1).stateDir, 'assets', 'source', `${asset.assetId}.png`))
    expect(createHash('sha256').update(stored).digest('hex')).toBe(asset.manifest.sha256)
  })
})
