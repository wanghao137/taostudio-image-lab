import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import {
  assertTransition,
  calculateImageSize,
  createAssetManifest,
  deriveInheritedTarget,
  parseImageSize,
  ratioMatchesWithinOnePixel,
  resolveEnhancementPolicy,
  validateImageJobRequest,
  verifySourceFinalInvariant,
} from '../../packages/image-job-core/index.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const ACTIVE_STATES = ['validating', 'generating', 'source_ready', 'enhancing', 'finalizing']

function now() { return new Date().toISOString() }
function sha256(data) { return createHash('sha256').update(data).digest('hex') }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function atomicWrite(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { flag: 'wx' })
  await rename(temporary, path)
}

async function readBody(request, maxBytes = 25 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('request body is too large'), { statusCode: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function json(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, { ...JSON_HEADERS, ...extraHeaders })
  response.end(JSON.stringify(payload))
}

function safeEqual(left, right) {
  const a = Buffer.from(left || '')
  const b = Buffer.from(right || '')
  return a.length === b.length && timingSafeEqual(a, b)
}

export class TaskRepository {
  constructor(databasePath) {
    this.db = new DatabaseSync(databasePath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        source_asset_id TEXT,
        final_asset_id TEXT,
        error_json TEXT,
        result_json TEXT,
        available_at INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        state TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );
    `)
  }

  recoverInterruptedJobs() {
    const placeholders = ACTIVE_STATES.map(() => '?').join(',')
    const interrupted = this.db.prepare(`SELECT id,state FROM jobs WHERE state IN (${placeholders})`).all(...ACTIVE_STATES)
    for (const job of interrupted) {
      this.db.prepare("UPDATE jobs SET state='queued', available_at=0, updated_at=? WHERE id=?").run(now(), job.id)
      this.recordEvent(job.id, 'queued', { reason: 'recovered_after_restart', interruptedState: job.state })
    }
    return interrupted.length
  }

  createOrGetJob(request) {
    const requestJson = stableJson(request)
    const requestHash = sha256(requestJson)
    const existing = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key=?').get(request.idempotencyKey)
    if (existing) {
      if (existing.request_hash !== requestHash) throw Object.assign(new Error('idempotency key was already used with a different request'), { statusCode: 409 })
      if (existing.state === 'failed' && existing.attempts < existing.max_attempts) {
        this.transition(existing.id, 'queued', { error: null, availableAt: 0 })
      }
      return { job: this.getJob(existing.id), created: false }
    }
    const id = `job_${randomUUID()}`
    const timestamp = now()
    this.db.prepare(`INSERT INTO jobs (id,idempotency_key,request_hash,request_json,state,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, request.idempotencyKey, requestHash, requestJson, 'queued', request.retry?.maxAttempts ?? 3, timestamp, timestamp)
    this.recordEvent(id, 'queued', { reason: 'created' })
    return { job: this.getJob(id), created: true }
  }

  getJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)
    if (!row) return null
    return {
      id: row.id,
      contractVersion: '1',
      state: row.state,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      cancelRequested: Boolean(row.cancel_requested),
      sourceAssetId: row.source_asset_id,
      finalAssetId: row.final_asset_id,
      error: row.error_json ? JSON.parse(row.error_json) : null,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  getRequest(id) {
    const row = this.db.prepare('SELECT request_json FROM jobs WHERE id=?').get(id)
    return row ? JSON.parse(row.request_json) : null
  }

  claimNextJob() {
    const row = this.db.prepare("SELECT id FROM jobs WHERE state='queued' AND available_at<=? ORDER BY created_at LIMIT 1").get(Date.now())
    if (!row) return null
    const changed = this.db.prepare("UPDATE jobs SET state='validating', attempts=attempts+1, updated_at=? WHERE id=? AND state='queued'").run(now(), row.id)
    if (!changed.changes) return null
    this.recordEvent(row.id, 'validating', { reason: 'worker_claimed' })
    return this.getJob(row.id)
  }

  transition(id, nextState, options = {}) {
    const current = this.getJob(id)
    if (!current) throw new Error('job not found')
    assertTransition(current.state, nextState)
    const timestamp = now()
    this.db.prepare(`UPDATE jobs SET state=?, source_asset_id=COALESCE(?,source_asset_id), final_asset_id=COALESCE(?,final_asset_id), error_json=?, result_json=COALESCE(?,result_json), available_at=?, updated_at=? WHERE id=?`)
      .run(nextState, options.sourceAssetId ?? null, options.finalAssetId ?? null, options.error ? JSON.stringify(options.error) : null, options.result ? JSON.stringify(options.result) : null, options.availableAt ?? 0, timestamp, id)
    this.recordEvent(id, nextState, options.detail ?? null)
    return this.getJob(id)
  }

  requestCancel(id) {
    const job = this.getJob(id)
    if (!job) return null
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
    this.db.prepare('UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?').run(now(), id)
    if (job.state === 'queued') return this.transition(id, 'cancelled', { detail: { reason: 'cancelled_before_start' } })
    return this.getJob(id)
  }

  shouldCancel(id) { return Boolean(this.getJob(id)?.cancelRequested) }

  addAsset(manifest, filePath) {
    this.db.prepare('INSERT INTO assets (id,job_id,kind,file_path,manifest_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(manifest.assetId, manifest.jobId, manifest.kind, filePath, JSON.stringify(manifest), manifest.createdAt)
  }

  getAsset(id) {
    const row = this.db.prepare('SELECT * FROM assets WHERE id=?').get(id)
    return row ? { manifest: JSON.parse(row.manifest_json), filePath: row.file_path } : null
  }

  recordEvent(jobId, state, detail) {
    this.db.prepare('INSERT INTO job_events (job_id,state,detail_json,created_at) VALUES (?,?,?,?)')
      .run(jobId, state, detail ? JSON.stringify(detail) : null, now())
  }

  events(jobId) {
    return this.db.prepare('SELECT state,detail_json,created_at FROM job_events WHERE job_id=? ORDER BY id').all(jobId)
      .map((row) => ({ state: row.state, detail: row.detail_json ? JSON.parse(row.detail_json) : null, createdAt: row.created_at }))
  }

  close() { this.db.close() }
}

async function mockGenerate(request, signal, attempt) {
  if (request.generation?.testBehavior === 'timeout') {
    await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(resolvePromise, 60_000)
      signal.addEventListener('abort', () => {
        clearTimeout(timeout)
        reject(Object.assign(new Error('provider timeout'), { name: 'AbortError', retryable: true }))
      }, { once: true })
    })
  }
  if (request.generation?.testBehavior === 'fail') throw Object.assign(new Error('mock provider failure'), { retryable: true })
  if (request.generation?.testBehavior === 'fail-once' && attempt === 1) throw Object.assign(new Error('mock provider transient failure'), { retryable: true })
  const baseSize = request.generation?.baseSize || calculateImageSize('1K', request.composition.ratio)
  const dimensions = parseImageSize(baseSize)
  if (!dimensions) throw new Error('mock provider could not resolve base size')
  const svg = Buffer.from(`<svg width="${dimensions.width}" height="${dimensions.height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f4f4f0"/><rect x="5%" y="5%" width="90%" height="90%" fill="#1778f2"/><circle cx="50%" cy="50%" r="20%" fill="#ffffff"/></svg>`)
  return sharp(svg).png().toBuffer()
}

async function compatibleGenerate(request, providerConfig, signal) {
  if (!providerConfig.baseUrl || !providerConfig.apiKey) throw Object.assign(new Error('real provider configuration is unavailable'), { retryable: false })
  const normalizedBaseUrl = providerConfig.baseUrl.replace(/\/+$/, '')
  const endpoint = new URL(`${normalizedBaseUrl.endsWith('/v1') ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`}/images/generations`)
  const response = await fetch(endpoint, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${providerConfig.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: request.generation.model || providerConfig.model,
      prompt: request.input.prompt,
      size: request.generation.baseSize || calculateImageSize('1K', request.composition.ratio),
      quality: 'high',
      output_format: 'png',
      n: 1,
    }),
  })
  if (!response.ok) throw Object.assign(new Error(`provider returned HTTP ${response.status}`), { retryable: response.status === 429 || response.status >= 500 })
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) {
    throw Object.assign(new Error(`provider returned unexpected content type: ${contentType || 'missing'}`), { retryable: false })
  }
  const payload = await response.json()
  const entry = payload?.data?.[0]
  if (entry?.b64_json) return Buffer.from(entry.b64_json, 'base64')
  if (entry?.url) {
    const imageResponse = await fetch(entry.url, { signal })
    if (!imageResponse.ok) throw Object.assign(new Error(`provider asset returned HTTP ${imageResponse.status}`), { retryable: true })
    return Buffer.from(await imageResponse.arrayBuffer())
  }
  throw Object.assign(new Error('provider response did not contain an image'), { retryable: false })
}

export class TaskWorkerPool {
  constructor(options) {
    this.repository = options.repository
    this.assetRoot = options.assetRoot
    this.providerConfig = options.providerConfig ?? {}
    this.concurrency = options.concurrency ?? 2
    this.pollIntervalMs = options.pollIntervalMs ?? 50
    this.providerTimeoutMs = options.providerTimeoutMs ?? 180_000
    this.running = false
    this.loops = []
    this.controllers = new Map()
  }

  start() {
    if (this.running) return
    this.running = true
    this.loops = Array.from({ length: this.concurrency }, () => this.loop())
  }

  async stop() {
    this.running = false
    for (const controller of this.controllers.values()) controller.abort(new Error('worker shutdown'))
    await Promise.allSettled(this.loops)
  }

  cancel(jobId) {
    this.controllers.get(jobId)?.abort(new Error('job cancelled'))
  }

  async loop() {
    while (this.running) {
      const job = this.repository.claimNextJob()
      if (!job) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, this.pollIntervalMs))
        continue
      }
      await this.process(job.id)
    }
  }

  async createStoredAsset(jobId, kind, buffer, parentAssetId = null, transform = null) {
    const metadata = await sharp(buffer).metadata()
    if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw new Error(`${kind} asset must be a readable PNG`)
    const assetId = `asset_${randomUUID()}`
    const directory = join(this.assetRoot, kind)
    await mkdir(directory, { recursive: true })
    const filePath = join(directory, `${assetId}.png`)
    await atomicWrite(filePath, buffer)
    const manifest = createAssetManifest({
      assetId, jobId, kind, parentAssetId, mediaType: 'image/png', width: metadata.width,
      height: metadata.height, bytes: buffer.length, sha256: sha256(buffer),
      createdAt: now(), transform, storagePath: `asset://${assetId}`,
    })
    this.repository.addAsset(manifest, filePath)
    return manifest
  }

  async process(jobId) {
    let stage = 'validating'
    try {
      const request = this.repository.getRequest(jobId)
      const validation = validateImageJobRequest(request)
      if (!validation.valid) throw Object.assign(new Error(validation.errors.join('; ')), { retryable: false })
      if (this.repository.shouldCancel(jobId)) return void this.repository.transition(jobId, 'cancelled')

      this.repository.transition(jobId, 'generating')
      stage = 'generating'
      let sourceManifest
      if (request.input.sourceAssetId) {
        const existing = this.repository.getAsset(request.input.sourceAssetId)
        if (!existing) throw Object.assign(new Error('source asset not found'), { retryable: false })
        sourceManifest = existing.manifest
      } else {
        const controller = new AbortController()
        this.controllers.set(jobId, controller)
        const timeout = setTimeout(() => controller.abort(new Error('provider timeout')), this.providerTimeoutMs)
        let sourceBuffer
        try {
          sourceBuffer = request.generation.provider === 'mock'
            ? await mockGenerate(request, controller.signal, this.repository.getJob(jobId).attempts)
            : await compatibleGenerate(request, this.providerConfig, controller.signal)
        } finally {
          clearTimeout(timeout)
          this.controllers.delete(jobId)
        }
        sourceManifest = await this.createStoredAsset(jobId, 'source', sourceBuffer)
      }
      this.repository.transition(jobId, 'source_ready', { sourceAssetId: sourceManifest.assetId })
      if (this.repository.shouldCancel(jobId)) return void this.repository.transition(jobId, 'cancelled')

      const policy = resolveEnhancementPolicy(request.output.contentClass ?? 'photo', request.output.enhancement)
      this.repository.transition(jobId, 'enhancing', { detail: { policy } })
      stage = 'enhancing'
      const sourceAsset = this.repository.getAsset(sourceManifest.assetId)
      const sourceBuffer = await readFile(sourceAsset.filePath)
      const sourceDimensions = { width: sourceManifest.width, height: sourceManifest.height }
      const target = request.output.dimensions
        ? parseImageSize(request.output.dimensions)
        : deriveInheritedTarget(sourceDimensions)
      if (!target || !ratioMatchesWithinOnePixel(sourceDimensions, target)) {
        throw Object.assign(new Error('inherit ratio conflict'), { retryable: false })
      }
      const finalBuffer = await sharp(sourceBuffer)
        .resize(target.width, target.height, { fit: 'contain', kernel: sharp.kernel.lanczos3, background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()

      this.repository.transition(jobId, 'finalizing')
      stage = 'finalizing'
      const finalManifest = await this.createStoredAsset(jobId, 'final', finalBuffer, sourceManifest.assetId, {
        geometry: 'inherit', exactPixels: target, requestedEnhancement: request.output.enhancement,
        appliedEnhancement: policy.selected === 'lanczos3' ? 'lanczos3' : 'lanczos3-fallback',
      })
      const invariant = verifySourceFinalInvariant(sourceManifest, finalManifest)
      if (!invariant.valid) throw Object.assign(new Error(invariant.errors.join('; ')), { retryable: false })
      if (this.repository.shouldCancel(jobId)) return void this.repository.transition(jobId, 'cancelled')
      this.repository.transition(jobId, 'succeeded', {
        finalAssetId: finalManifest.assetId,
        result: { sourceAssetId: sourceManifest.assetId, finalAssetId: finalManifest.assetId, manifestVersion: '1' },
      })
    } catch (error) {
      const current = this.repository.getJob(jobId)
      if (!current || ['cancelled', 'succeeded'].includes(current.state)) return
      if (current.cancelRequested) return void this.repository.transition(jobId, 'cancelled')
      const retryable = error?.retryable !== false && current.attempts < current.maxAttempts
      const detail = { code: error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'JOB_FAILED', message: error instanceof Error ? error.message : String(error), stage, retryable }
      this.repository.transition(jobId, 'failed', { error: detail })
      if (retryable) {
        const delay = Math.min(500 * (2 ** (current.attempts - 1)), 5_000)
        this.repository.transition(jobId, 'queued', { availableAt: Date.now() + delay, detail: { reason: 'automatic_retry', delay } })
      }
    }
  }
}

export async function createTaskApi(options = {}) {
  const stateDir = resolve(options.stateDir ?? '.local-task-api')
  const assetRoot = join(stateDir, 'assets')
  await mkdir(assetRoot, { recursive: true })
  const repository = new TaskRepository(join(stateDir, 'jobs.sqlite'))
  const recoveredJobs = repository.recoverInterruptedJobs()
  const token = options.token || randomBytes(24).toString('hex')
  const workerPool = new TaskWorkerPool({ repository, assetRoot, concurrency: options.concurrency, providerConfig: options.providerConfig, providerTimeoutMs: options.providerTimeoutMs })

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin
    const cors = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null
    if (cors) {
      response.setHeader('access-control-allow-origin', cors)
      response.setHeader('vary', 'Origin')
      response.setHeader('access-control-allow-headers', 'authorization,content-type,x-file-name')
      response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    }
    if (request.method === 'OPTIONS') return void response.writeHead(204).end()
    if (!safeEqual(request.headers.authorization, `Bearer ${token}`)) return void json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } })
    const url = new URL(request.url || '/', 'http://localhost')
    try {
      if (request.method === 'POST' && url.pathname === '/v1/assets/uploads') {
        if (request.headers['content-type']?.split(';')[0] !== 'image/png') return void json(response, 415, { error: { code: 'PNG_REQUIRED', message: 'v1 uploads accept image/png' } })
        const buffer = await readBody(request)
        const metadata = await sharp(buffer).metadata()
        if (metadata.format !== 'png' || !metadata.width || !metadata.height) return void json(response, 400, { error: { code: 'INVALID_PNG', message: 'invalid PNG upload' } })
        const digest = sha256(buffer)
        const uploadId = `upload_${digest}`
        const existing = repository.getAsset(uploadId)
        if (existing) return void json(response, 200, { assetId: uploadId, manifest: existing.manifest }, { 'idempotency-replayed': 'true' })
        const filePath = join(assetRoot, 'source', `${uploadId}.png`)
        await mkdir(join(assetRoot, 'source'), { recursive: true })
        await atomicWrite(filePath, buffer)
        const manifest = createAssetManifest({ assetId: uploadId, jobId: 'upload', kind: 'source', parentAssetId: null, mediaType: 'image/png', width: metadata.width, height: metadata.height, bytes: buffer.length, sha256: digest, storagePath: `asset://${uploadId}`, originalFileName: basename(String(request.headers['x-file-name'] || 'upload.png')), createdAt: now() })
        repository.addAsset(manifest, filePath)
        return void json(response, 201, { assetId: uploadId, manifest })
      }
      if (request.method === 'POST' && url.pathname === '/v1/image-jobs') {
        const body = JSON.parse((await readBody(request, 1024 * 1024)).toString('utf8'))
        const validation = validateImageJobRequest(body)
        if (!validation.valid) return void json(response, 400, { error: { code: 'INVALID_JOB', details: validation.errors } })
        const result = repository.createOrGetJob(body)
        return void json(response, result.created ? 201 : 200, result.job, { 'idempotency-replayed': result.created ? 'false' : 'true' })
      }
      const jobMatch = url.pathname.match(/^\/v1\/image-jobs\/([^/]+)$/)
      if (request.method === 'GET' && jobMatch) {
        const job = repository.getJob(jobMatch[1])
        return void (job ? json(response, 200, { ...job, events: repository.events(job.id) }) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const cancelMatch = url.pathname.match(/^\/v1\/image-jobs\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && cancelMatch) {
        const job = repository.requestCancel(cancelMatch[1])
        if (job) workerPool.cancel(job.id)
        return void (job ? json(response, 200, job) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const assetMatch = url.pathname.match(/^\/v1\/assets\/([^/]+)$/)
      if (request.method === 'GET' && assetMatch) {
        const asset = repository.getAsset(assetMatch[1])
        if (!asset) return void json(response, 404, { error: { code: 'NOT_FOUND' } })
        if (url.searchParams.get('manifest') === '1') return void json(response, 200, asset.manifest)
        const buffer = await readFile(asset.filePath)
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': buffer.length, 'cache-control': 'private, immutable', etag: `"${asset.manifest.sha256}"` })
        return void response.end(buffer)
      }
      json(response, 404, { error: { code: 'NOT_FOUND' } })
    } catch (error) {
      json(response, error?.statusCode || 500, { error: { code: error?.statusCode === 409 ? 'IDEMPOTENCY_CONFLICT' : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } })
    }
  })

  return {
    token,
    recoveredJobs,
    repository,
    workerPool,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolvePromise)
      })
      workerPool.start()
      const address = server.address()
      return { host, port: address.port, url: `http://${host}:${address.port}` }
    },
    async close() {
      await workerPool.stop()
      await new Promise((resolvePromise) => server.close(resolvePromise))
      repository.close()
    },
    async destroy() {
      await this.close()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}
