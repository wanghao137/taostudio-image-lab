import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskApi } from './service.mjs'

const running = []
const providerServers = []

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
  while (providerServers.length) {
    await new Promise((resolvePromise) => providerServers.pop().close(resolvePromise))
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

  it('retries a malformed JSON gateway response on the same job', async () => {
    const png = await sharp({ create: { width: 720, height: 1280, channels: 4, background: '#336699' } }).png().toBuffer()
    let providerCalls = 0
    const provider = createServer((incoming, response) => {
      providerCalls += 1
      response.setHeader('content-type', 'application/json')
      if (providerCalls === 1) return void response.end('<!doctype html><title>temporary gateway response</title>')
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'test-model' } })
    const payload = request({
      idempotencyKey: 'malformed-json-retry-001',
      generation: { provider: 'configured', model: 'test-model', baseSize: '720x1280' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '2160x3840', enhancement: 'lanczos3', contentClass: 'photo' },
      retry: { maxAttempts: 3 },
    })
    const created = await create(url, payload)
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ id: created.body.id, state: 'succeeded', attempts: 2 })
    expect(providerCalls).toBe(2)
  })

  it('retries a provider response whose body terminates early', async () => {
    const png = await sharp({ create: { width: 720, height: 1280, channels: 4, background: '#426b8a' } }).png().toBuffer()
    let providerCalls = 0
    const provider = createServer((incoming, response) => {
      providerCalls += 1
      response.setHeader('content-type', 'application/json')
      if (providerCalls === 1) {
        response.setHeader('content-length', '4096')
        response.write('{"data":[')
        return void response.socket.destroy()
      }
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'test-model' } })
    const created = await create(url, request({
      idempotencyKey: 'terminated-body-retry-001',
      generation: { provider: 'configured', model: 'test-model', baseSize: '720x1280' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '2160x3840', enhancement: 'lanczos3', contentClass: 'photo' },
      retry: { maxAttempts: 3 },
    }))
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ id: created.body.id, state: 'succeeded', attempts: 2 })
    expect(job.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'failed', detail: expect.objectContaining({ code: 'PROVIDER_NETWORK_ERROR', retryable: true }) }),
    ]))
    expect(providerCalls).toBe(2)
  })

  it('retries an HTTP 200 provider response that contains no image', async () => {
    const png = await sharp({ create: { width: 1536, height: 1024, channels: 4, background: '#6688aa' } }).png().toBuffer()
    let providerCalls = 0
    const provider = createServer((incoming, response) => {
      providerCalls += 1
      response.setHeader('content-type', 'application/json')
      if (providerCalls === 1) return void response.end(JSON.stringify({ data: [] }))
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'test-model' } })
    const created = await create(url, request({
      idempotencyKey: 'empty-image-retry-001',
      composition: { ratio: '3:2' },
      generation: { provider: 'configured', model: 'test-model', baseSize: '1536x1024' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '3456x2304', enhancement: 'lanczos3', contentClass: 'photo' },
    }))
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ id: created.body.id, state: 'succeeded', attempts: 2 })
    expect(providerCalls).toBe(2)
  })

  it('does not retry a provider content policy error returned with HTTP 200', async () => {
    let providerCalls = 0
    const provider = createServer((incoming, response) => {
      providerCalls += 1
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { code: 'content_policy_violation', message: 'request was blocked' } }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'test-model' } })
    const created = await create(url, request({
      idempotencyKey: 'content-policy-no-retry-001',
      generation: { provider: 'configured', model: 'test-model', baseSize: '720x1280' },
    }))
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({
      state: 'failed',
      attempts: 1,
      error: { code: 'PROVIDER_RESPONSE_ERROR', providerCode: 'content_policy_violation', retryable: false },
    })
    expect(providerCalls).toBe(1)
  })

  it('normalizes a provider-native canvas to the requested source ratio before 4K enhancement', async () => {
    const png = await sharp({ create: { width: 1536, height: 1024, channels: 4, background: '#224466' } }).png().toBuffer()
    const provider = createServer((incoming, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'test-model' } })
    const created = await create(url, request({
      idempotencyKey: 'provider-ratio-normalization-001',
      composition: { ratio: '21:9' },
      generation: { provider: 'configured', model: 'test-model', baseSize: '1280x549' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '3840x1646', enhancement: 'lanczos3', contentClass: 'photo' },
    }))
    const job = await wait(url, created.body.id)
    expect(job.state).toBe('succeeded')
    const sourceManifest = await (await fetch(`${url}/v1/assets/${job.sourceAssetId}?manifest=1`, { headers: headers() })).json()
    const finalManifest = await (await fetch(`${url}/v1/assets/${job.finalAssetId}?manifest=1`, { headers: headers() })).json()
    expect(sourceManifest).toMatchObject({
      width: 1920,
      height: 823,
      transform: {
        geometry: 'cover',
        reason: 'provider-ratio-normalization',
        providerDimensions: { width: 1536, height: 1024 },
        requestedRatio: '21:9',
      },
    })
    expect(finalManifest).toMatchObject({ width: 3840, height: 1646, parentAssetId: job.sourceAssetId })
    expect(sourceManifest.width * finalManifest.height).toBe(finalManifest.width * sourceManifest.height)
    const finalBuffer = Buffer.from(await (await fetch(`${url}/v1/assets/${job.finalAssetId}`, { headers: headers() })).arrayBuffer())
    const finalStats = await sharp(finalBuffer).ensureAlpha().stats()
    expect(finalStats.channels[3].min).toBe(255)
  })

  it('normalizes a near-ratio provider canvas when it still conflicts with exact final pixels', async () => {
    const png = await sharp({ create: { width: 941, height: 1672, channels: 4, background: '#335577' } }).png().toBuffer()
    const provider = createServer((incoming, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'test-model' } })
    const created = await create(url, request({
      idempotencyKey: 'near-ratio-normalization-001',
      composition: { ratio: '9:16' },
      generation: { provider: 'configured', model: 'test-model', baseSize: '720x1280' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '2160x3840', enhancement: 'lanczos3', contentClass: 'photo' },
    }))
    const job = await wait(url, created.body.id)
    expect(job.state).toBe('succeeded')
    const sourceManifest = await (await fetch(`${url}/v1/assets/${job.sourceAssetId}?manifest=1`, { headers: headers() })).json()
    expect(sourceManifest).toMatchObject({
      width: 720,
      height: 1280,
      transform: {
        geometry: 'cover',
        providerDimensions: { width: 941, height: 1672 },
        requestedRatio: '9:16',
      },
    })
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
    await secondApi.close()
  })

  it('prevents two task API instances from driving the same state directory', async () => {
    const first = await start({ concurrency: 0 })
    await expect(createTaskApi({ stateDir: first.stateDir, token: 'other-token', concurrency: 0 })).rejects.toMatchObject({ code: 'STATE_DIR_LOCKED' })
    await first.api.close()
    first.closed = true
    const replacement = await createTaskApi({ stateDir: first.stateDir, token: 'replacement-token', concurrency: 0 })
    await replacement.close()
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
