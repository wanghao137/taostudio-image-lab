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
  deriveExactSourceTarget,
  deriveInheritedTarget,
  parseImageSize,
  parseRatio,
  ratioMatchesExactly,
  ratioMatchesWithinOnePixel,
  resolveEnhancementPolicy,
  validateImageJobRequest,
  verifySourceFinalInvariant,
} from '../../packages/image-job-core/index.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const ACTIVE_STATES = ['validating', 'generating', 'source_ready', 'enhancing', 'finalizing']

function now() { return new Date().toISOString() }
function sha256(data) { return createHash('sha256').update(data).digest('hex') }
function safeProviderText(value) {
  if (typeof value !== 'string') return null
  return value
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|key|token)-[a-z0-9_-]{8,}\b/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300) || null
}

function providerPayloadError(payload, fallbackRetryable = true) {
  const body = payload && typeof payload === 'object' ? payload : {}
  const nested = body.error && typeof body.error === 'object' ? body.error : null
  const providerCode = safeProviderText(nested?.code ?? nested?.type ?? body.code ?? body.type)
  const providerMessage = safeProviderText(nested?.message ?? body.message)
  const classification = `${providerCode || ''} ${providerMessage || ''}`.toLowerCase()
  const permanent = /(content[_ -]?policy|moderation|safety|invalid[_ -]?request|authentication|authorization|permission|billing|quota|not[_ -]?found)/.test(classification)
  const transient = /(rate[_ -]?limit|timeout|temporar|overload|capacity|server|internal|upstream|gateway|unavailable|generation[_ -]?failed)/.test(classification)
  const error = Object.assign(new Error(
    providerCode ? `provider reported ${providerCode}${providerMessage ? `: ${providerMessage}` : ''}` : 'provider response did not contain an image',
  ), {
    code: 'PROVIDER_RESPONSE_ERROR',
    providerCode,
    retryable: permanent ? false : transient ? true : fallbackRetryable,
    diagnostics: { responseKeys: Object.keys(body).sort().slice(0, 20) },
  })
  return error
}

function providerPrompt(request) {
  const ratio = request.composition?.ratio
  if (!ratio) return request.input.prompt
  return `${request.input.prompt}\n\nHighest-priority canvas requirement: compose the complete image for an exact ${ratio} aspect ratio. Keep every essential subject and all required text inside the canvas safe area. This requirement overrides any conflicting aspect-ratio wording above.`
}

function responseShape(text) {
  const trimmed = text.trimStart()
  return {
    responseBytes: Buffer.byteLength(text),
    responseKind: !trimmed ? 'empty' : trimmed.startsWith('<') ? 'html-like' : /^[{[]/.test(trimmed) ? 'json-like' : 'text-like',
    responseSha256: sha256(text),
  }
}

function providerNetworkError(error, phase, signal) {
  if (signal?.aborted) {
    return Object.assign(new Error('provider request aborted'), { name: 'AbortError', code: 'PROVIDER_TIMEOUT', retryable: true })
  }
  const networkCode = safeProviderText(error?.cause?.code ?? error?.code)
  return Object.assign(new Error(`provider network failed during ${phase}${networkCode ? `: ${networkCode}` : ''}`), {
    code: 'PROVIDER_NETWORK_ERROR',
    retryable: true,
    diagnostics: { phase, ...(networkCode ? { networkCode } : {}) },
  })
}

async function providerFetch(url, init, phase) {
  try {
    return await fetch(url, init)
  } catch (error) {
    throw providerNetworkError(error, phase, init?.signal)
  }
}

async function providerResponseText(response, signal) {
  try {
    return await response.text()
  } catch (error) {
    throw providerNetworkError(error, 'response-body', signal)
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function acquireStateDirectoryLock(stateDir) {
  const lockPath = join(stateDir, '.task-api.lock')
  const token = randomUUID()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await mkdir(lockPath)
      await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, token, createdAt: now() }), 'utf8')
      return async () => {
        const owner = await readFile(join(lockPath, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null)
        if (owner?.token === token) await rm(lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = await readFile(join(lockPath, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null)
      if (processIsRunning(owner?.pid)) {
        throw Object.assign(new Error(`task API state directory is already in use by process ${owner.pid}`), { code: 'STATE_DIR_LOCKED' })
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`
      try {
        await rename(lockPath, stalePath)
        await rm(stalePath, { recursive: true, force: true })
      } catch (renameError) {
        if (!['ENOENT', 'EACCES', 'EPERM'].includes(renameError?.code)) throw renameError
      }
    }
  }
  throw Object.assign(new Error('task API state directory lock could not be acquired'), { code: 'STATE_DIR_LOCKED' })
}
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
  const baseSize = request.generation?.baseSize || calculateImageSize('2K', request.composition.ratio)
  const dimensions = parseImageSize(baseSize)
  if (!dimensions) throw new Error('mock provider could not resolve base size')
  const svg = Buffer.from(`<svg width="${dimensions.width}" height="${dimensions.height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f4f4f0"/><rect x="5%" y="5%" width="90%" height="90%" fill="#1778f2"/><circle cx="50%" cy="50%" r="20%" fill="#ffffff"/></svg>`)
  return sharp(svg).png().toBuffer()
}

async function compatibleGenerate(request, providerConfig, signal) {
  if (!providerConfig.baseUrl || !providerConfig.apiKey) throw Object.assign(new Error('real provider configuration is unavailable'), { retryable: false })
  const normalizedBaseUrl = providerConfig.baseUrl.replace(/\/+$/, '')
  const endpoint = new URL(`${normalizedBaseUrl.endsWith('/v1') ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`}/images/generations`)
  const response = await providerFetch(endpoint, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${providerConfig.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: request.generation.model || providerConfig.model,
      prompt: providerPrompt(request),
      size: request.generation.baseSize || calculateImageSize('2K', request.composition.ratio),
      quality: 'high',
      output_format: 'png',
      n: 1,
    }),
  }, 'generation-request')
  const contentType = response.headers.get('content-type') || ''
  const responseText = await providerResponseText(response, signal)
  const isJson = contentType.toLowerCase().includes('application/json')
  if (!response.ok) {
    let errorPayload = null
    if (isJson) {
      try { errorPayload = JSON.parse(responseText) } catch { /* status remains the source of truth */ }
    }
    const error = errorPayload
      ? providerPayloadError(errorPayload, response.status === 429 || response.status >= 500)
      : Object.assign(new Error(`provider returned HTTP ${response.status}`), {
          code: 'PROVIDER_HTTP_ERROR',
          retryable: response.status === 429 || response.status >= 500,
          diagnostics: responseShape(responseText),
        })
    error.httpStatus = response.status
    throw error
  }
  if (!isJson) {
    throw Object.assign(new Error(`provider returned unexpected content type: ${contentType || 'missing'}`), {
      code: 'PROVIDER_RESPONSE_ERROR',
      retryable: true,
      diagnostics: { contentType: contentType || 'missing', ...responseShape(responseText) },
    })
  }
  let payload
  try {
    payload = JSON.parse(responseText)
  } catch {
    throw Object.assign(new Error('provider returned malformed JSON'), {
      code: 'PROVIDER_RESPONSE_ERROR',
      retryable: true,
      diagnostics: { contentType, ...responseShape(responseText) },
    })
  }
  const entry = payload?.data?.[0]
  if (entry?.b64_json) return Buffer.from(entry.b64_json, 'base64')
  if (entry?.url) {
    const imageResponse = await providerFetch(entry.url, { signal }, 'asset-download')
    if (!imageResponse.ok) throw Object.assign(new Error(`provider asset returned HTTP ${imageResponse.status}`), { retryable: true })
    try {
      return Buffer.from(await imageResponse.arrayBuffer())
    } catch (error) {
      throw providerNetworkError(error, 'asset-body', signal)
    }
  }
  throw providerPayloadError(payload, true)
}

// Image edit (image-to-image): POST /images/edits with multipart FormData.
// Sends the source image + prompt to the provider so it generates a NEW image
// based on the reference. Used when input.sourceAssetId + input.prompt are both
// present and apiMode === 'images'. Returns a raw image Buffer.
async function compatibleEdit(request, providerConfig, sourceBuffer, signal) {
  if (!providerConfig.baseUrl || !providerConfig.apiKey) throw Object.assign(new Error('real provider configuration is unavailable'), { retryable: false })
  const normalizedBaseUrl = providerConfig.baseUrl.replace(/\/+$/, '')
  const endpoint = new URL(`${normalizedBaseUrl.endsWith('/v1') ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`}/images/edits`)

  const formData = new FormData()
  formData.append('model', request.generation.model || providerConfig.model)
  formData.append('prompt', request.input.prompt)
  formData.append('size', request.generation.baseSize || calculateImageSize('2K', request.composition.ratio))
  formData.append('quality', 'high')
  formData.append('output_format', 'png')
  formData.append('n', '1')
  // Source image as PNG blob — the provider sees this as the reference to edit
  const imageBlob = new Blob([sourceBuffer], { type: 'image/png' })
  formData.append('image[]', imageBlob, 'source.png')

  const response = await providerFetch(endpoint, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${providerConfig.apiKey}` },
    body: formData,
  }, 'edit-request')

  const contentType = response.headers.get('content-type') || ''
  const responseText = await providerResponseText(response, signal)
  const isJson = contentType.toLowerCase().includes('application/json')
  if (!response.ok) {
    let errorPayload = null
    if (isJson) {
      try { errorPayload = JSON.parse(responseText) } catch { /* status remains the source of truth */ }
    }
    const error = errorPayload
      ? providerPayloadError(errorPayload, response.status === 429 || response.status >= 500)
      : Object.assign(new Error(`provider returned HTTP ${response.status}`), {
          code: 'PROVIDER_HTTP_ERROR',
          retryable: response.status === 429 || response.status >= 500,
          diagnostics: responseShape(responseText),
        })
    error.httpStatus = response.status
    throw error
  }
  if (!isJson) {
    throw Object.assign(new Error(`provider returned unexpected content type: ${contentType || 'missing'}`), {
      code: 'PROVIDER_RESPONSE_ERROR',
      retryable: true,
      diagnostics: { contentType: contentType || 'missing', ...responseShape(responseText) },
    })
  }
  let payload
  try {
    payload = JSON.parse(responseText)
  } catch {
    throw Object.assign(new Error('provider returned malformed JSON'), {
      code: 'PROVIDER_RESPONSE_ERROR',
      retryable: true,
      diagnostics: { contentType, ...responseShape(responseText) },
    })
  }
  const entry = payload?.data?.[0]
  if (entry?.b64_json) return Buffer.from(entry.b64_json, 'base64')
  if (entry?.url) {
    const imageResponse = await providerFetch(entry.url, { signal }, 'asset-download')
    if (!imageResponse.ok) throw Object.assign(new Error(`provider asset returned HTTP ${imageResponse.status}`), { retryable: true })
    try {
      return Buffer.from(await imageResponse.arrayBuffer())
    } catch (error) {
      throw providerNetworkError(error, 'asset-body', signal)
    }
  }
  throw providerPayloadError(payload, true)
}

// Extract base64 image bytes from a Responses API image_generation_call result.
// The result may be a bare base64 string or an object exposing one of several
// known keys, mirroring the frontend ResponsesOutputItem handling.
function responsesImageResultBase64(result) {
  if (typeof result === 'string') return result.trim() || undefined
  if (result && typeof result === 'object') {
    for (const key of ['b64_json', 'base64', 'image', 'data']) {
      if (typeof result[key] === 'string' && result[key].trim()) return result[key]
    }
  }
  return undefined
}

// Detect safety/refusal wording in Responses API output text. Mirrors the
// frontend isSafetyRefusalMessage classifier so refusals are treated as
// permanent rather than retried.
const SAFETY_REFUSAL_PATTERN = /content[_\s-]?policy|safety|moderation|moderated|refus|reject|blocked|disallowed|not allowed|inappropriate|violat|can(?:not|['\u2018\u2019]t)\s+(?:help|assist|comply|create|generate)|(?:unable|not able)\s+to\s+(?:help|assist|create|generate)|审核|安全|策略|政策|拒绝|不通过|违规|敏感|拦截|不合规|禁止/i

function responsesOutputTextMessages(output) {
  const messages = []
  if (!Array.isArray(output)) return messages
  for (const item of output) {
    if (typeof item?.text === 'string') messages.push(item.text)
    if (Array.isArray(item?.content)) {
      for (const part of item.content) {
        if (typeof part?.text === 'string') messages.push(part.text)
      }
    }
  }
  return messages
}

// Responses API image generation: POST /responses with an image_generation
// tool. Used by text models that expose image output through the Responses
// API (e.g. gpt-5.6-sol) when generation.apiMode === 'responses'. Returns a
// raw image Buffer that feeds the same normalize/enhance/finalize pipeline
// as images mode. When sourceBuffer is provided, switches to edit mode
// (action:'edit' + multimodal input with the reference image).
async function responsesGenerate(request, providerConfig, signal, sourceBuffer) {
  if (!providerConfig.baseUrl || !providerConfig.apiKey) throw Object.assign(new Error('real provider configuration is unavailable'), { retryable: false })
  const normalizedBaseUrl = providerConfig.baseUrl.replace(/\/+$/, '')
  const endpoint = new URL(`${normalizedBaseUrl.endsWith('/v1') ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`}/responses`)
  const isEdit = Buffer.isBuffer(sourceBuffer)
  const promptText = providerPrompt(request)
  // For edit mode, build multimodal input with the reference image as a data URL
  const inputPayload = isEdit
    ? [{
        role: 'user',
        content: [
          { type: 'input_text', text: promptText },
          { type: 'input_image', image_url: `data:image/png;base64,${sourceBuffer.toString('base64')}` },
        ],
      }]
    : promptText
  const response = await providerFetch(endpoint, {
    method: 'POST',
    signal,
    headers: { authorization: `Bearer ${providerConfig.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: request.generation.model || providerConfig.model,
      input: inputPayload,
      tools: [{
        type: 'image_generation',
        action: isEdit ? 'edit' : 'generate',
        size: request.generation.baseSize || calculateImageSize('2K', request.composition.ratio),
        output_format: 'png',
        quality: 'high',
        moderation: 'low',
      }],
      tool_choice: 'required',
    }),
  }, isEdit ? 'edit-request' : 'generation-request')
  const contentType = response.headers.get('content-type') || ''
  const responseText = await providerResponseText(response, signal)
  const isJson = contentType.toLowerCase().includes('application/json')
  if (!response.ok) {
    let errorPayload = null
    if (isJson) {
      try { errorPayload = JSON.parse(responseText) } catch { /* status remains the source of truth */ }
    }
    const error = errorPayload
      ? providerPayloadError(errorPayload, response.status === 429 || response.status >= 500)
      : Object.assign(new Error(`provider returned HTTP ${response.status}`), {
          code: 'PROVIDER_HTTP_ERROR',
          retryable: response.status === 429 || response.status >= 500,
          diagnostics: responseShape(responseText),
        })
    error.httpStatus = response.status
    throw error
  }
  if (!isJson) {
    throw Object.assign(new Error(`provider returned unexpected content type: ${contentType || 'missing'}`), {
      code: 'PROVIDER_RESPONSE_ERROR',
      retryable: true,
      diagnostics: { contentType: contentType || 'missing', ...responseShape(responseText) },
    })
  }
  let payload
  try {
    payload = JSON.parse(responseText)
  } catch {
    throw Object.assign(new Error('provider returned malformed JSON'), {
      code: 'PROVIDER_RESPONSE_ERROR',
      retryable: true,
      diagnostics: { contentType, ...responseShape(responseText) },
    })
  }
  const output = Array.isArray(payload?.output) ? payload.output : []
  // Find a completed image_generation_call and decode its bytes.
  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue
    if (item.status === 'failed') continue
    const b64 = responsesImageResultBase64(item.result)
    if (b64) return Buffer.from(b64, 'base64')
  }
  // No usable image. Surface the most informative failure: prefer a safety
  // refusal in output text, then the first failed image_generation_call's
  // error, then fall back to the raw payload. Refusals and explicit call
  // failures are permanent; an image-less response for any other reason is
  // treated as a transient response error so the worker can retry.
  const refusalText = responsesOutputTextMessages(output).find(text => SAFETY_REFUSAL_PATTERN.test(text))
  const failedCall = output.find(item => item?.type === 'image_generation_call' && item?.status === 'failed')
  if (refusalText || failedCall) {
    const errorSource = refusalText
      ? { error: { message: refusalText.slice(0, 300), code: 'content_policy' } }
      : (failedCall.error && typeof failedCall.error === 'object'
        ? { error: failedCall.error }
        : { error: { message: typeof failedCall.error === 'string' ? failedCall.error.slice(0, 300) : 'image_generation_call failed' } })
    throw providerPayloadError(errorSource, false)
  }
  throw providerPayloadError(payload, true)
}

async function normalizeSourceCanvas(request, rawBuffer) {
  const metadata = await sharp(rawBuffer).metadata()
  if (!metadata.width || !metadata.height) {
    throw Object.assign(new Error('provider image dimensions are unavailable'), { code: 'PROVIDER_IMAGE_INVALID', retryable: true })
  }
  const providerDimensions = { width: metadata.width, height: metadata.height }
  const requestedRatio = parseRatio(request.composition?.ratio)
  const baseSize = request.generation?.baseSize || calculateImageSize('2K', request.composition?.ratio)
  const target = parseImageSize(baseSize)
  const outputTarget = parseImageSize(request.output?.dimensions)
  const ratioTarget = outputTarget || target
  if (!requestedRatio || (ratioTarget && ratioMatchesExactly(providerDimensions, ratioTarget))) {
    if (metadata.format === 'png') return { buffer: rawBuffer, transform: null }
    return {
      buffer: await sharp(rawBuffer).png().toBuffer(),
      transform: { geometry: 'format-only', providerDimensions, requestedRatio: request.composition?.ratio ?? null },
    }
  }

  if (!target || !ratioMatchesWithinOnePixel(requestedRatio, target) || (outputTarget && !ratioMatchesWithinOnePixel(target, outputTarget))) {
    throw Object.assign(new Error('generation base size conflicts with the requested composition ratio'), { retryable: false })
  }
  const exactTarget = outputTarget ? deriveExactSourceTarget(target, outputTarget) : target
  const buffer = await sharp(rawBuffer)
    .resize(exactTarget.width, exactTarget.height, { fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer()
  return {
    buffer,
    transform: {
      geometry: 'cover',
      reason: 'provider-ratio-normalization',
      providerDimensions,
      exactPixels: exactTarget,
      requestedRatio: request.composition.ratio,
    },
  }
}

export class TaskWorkerPool {
  constructor(options) {
    this.repository = options.repository
    this.assetRoot = options.assetRoot
    this.providerConfig = options.providerConfig ?? {}
    this.concurrency = options.concurrency ?? 1
    this.pollIntervalMs = options.pollIntervalMs ?? 50
    this.providerTimeoutMs = options.providerTimeoutMs ?? 300_000
    this.providerRetryBaseMs = options.providerRetryBaseMs ?? 500
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
      const isEditMode = request.input.sourceAssetId && request.input.prompt
      if (isEditMode) {
        // Image-to-image (edit): read the uploaded reference image, send it to
        // the provider's edit endpoint with the prompt, and use the returned
        // NEW image as the source canvas.
        const existing = this.repository.getAsset(request.input.sourceAssetId)
        if (!existing) throw Object.assign(new Error('source asset not found'), { retryable: false })
        const referenceBuffer = await readFile(existing.filePath)
        const controller = new AbortController()
        this.controllers.set(jobId, controller)
        const timeout = setTimeout(() => controller.abort(new Error('provider timeout')), this.providerTimeoutMs)
        let sourceBuffer
        let sourceTransform = null
        try {
          const apiMode = request.generation.apiMode || 'images'
          const providerBuffer = request.generation.provider === 'mock'
            ? await mockGenerate(request, controller.signal, this.repository.getJob(jobId).attempts)
            : apiMode === 'responses'
              ? await responsesGenerate(request, this.providerConfig, controller.signal, referenceBuffer)
              : await compatibleEdit(request, this.providerConfig, referenceBuffer, controller.signal)
          const normalized = await normalizeSourceCanvas(request, providerBuffer)
          sourceBuffer = normalized.buffer
          sourceTransform = normalized.transform
        } finally {
          clearTimeout(timeout)
          this.controllers.delete(jobId)
        }
        sourceManifest = await this.createStoredAsset(jobId, 'source', sourceBuffer, existing.manifest.assetId, sourceTransform)
      } else if (request.input.sourceAssetId) {
        // Source-only (no prompt): use the uploaded asset directly as the source
        // canvas, normalizing ratio locally. No provider call. Backward compatible.
        const existing = this.repository.getAsset(request.input.sourceAssetId)
        if (!existing) throw Object.assign(new Error('source asset not found'), { retryable: false })
        const rawBuffer = await readFile(existing.filePath)
        const normalized = await normalizeSourceCanvas(request, rawBuffer)
        sourceManifest = normalized.transform
          ? await this.createStoredAsset(jobId, 'source', normalized.buffer, existing.manifest.assetId, normalized.transform)
          : existing.manifest
      } else {
        const controller = new AbortController()
        this.controllers.set(jobId, controller)
        const timeout = setTimeout(() => controller.abort(new Error('provider timeout')), this.providerTimeoutMs)
        let sourceBuffer
        let sourceTransform = null
        try {
          const apiMode = request.generation.apiMode || 'images'
          const providerBuffer = request.generation.provider === 'mock'
            ? await mockGenerate(request, controller.signal, this.repository.getJob(jobId).attempts)
            : apiMode === 'responses'
              ? await responsesGenerate(request, this.providerConfig, controller.signal)
              : await compatibleGenerate(request, this.providerConfig, controller.signal)
          const normalized = await normalizeSourceCanvas(request, providerBuffer)
          sourceBuffer = normalized.buffer
          sourceTransform = normalized.transform
        } finally {
          clearTimeout(timeout)
          this.controllers.delete(jobId)
        }
        sourceManifest = await this.createStoredAsset(jobId, 'source', sourceBuffer, null, sourceTransform)
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
      if (!target || !ratioMatchesExactly(sourceDimensions, target)) {
        throw Object.assign(new Error('inherit ratio conflict'), { retryable: false })
      }
      const finalBuffer = await sharp(sourceBuffer)
        .resize(target.width, target.height, { fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
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
      if (!ACTIVE_STATES.includes(current.state)) return
      if (current.cancelRequested) return void this.repository.transition(jobId, 'cancelled')
      const retryable = error?.retryable !== false && current.attempts < current.maxAttempts
      const detail = {
        code: error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : error?.code || 'JOB_FAILED',
        message: error instanceof Error ? error.message : String(error),
        stage,
        retryable,
      }
      if (error?.providerCode) detail.providerCode = error.providerCode
      if (error?.httpStatus) detail.httpStatus = error.httpStatus
      if (error?.diagnostics) detail.diagnostics = error.diagnostics
      this.repository.transition(jobId, 'failed', { error: detail, detail })
      if (retryable) {
        const delay = Math.min(this.providerRetryBaseMs * (2 ** (current.attempts - 1)), this.providerRetryBaseMs * 4)
        this.repository.transition(jobId, 'queued', { availableAt: Date.now() + delay, detail: { reason: 'automatic_retry', delay } })
      }
    }
  }
}

export async function createTaskApi(options = {}) {
  const stateDir = resolve(options.stateDir ?? '.local-task-api')
  const assetRoot = join(stateDir, 'assets')
  await mkdir(stateDir, { recursive: true })
  const releaseStateLock = await acquireStateDirectoryLock(stateDir)
  await mkdir(assetRoot, { recursive: true })
  let repository
  try {
    repository = new TaskRepository(join(stateDir, 'jobs.sqlite'))
  } catch (error) {
    await releaseStateLock()
    throw error
  }
  const recoveredJobs = repository.recoverInterruptedJobs()
  const token = options.token || randomBytes(24).toString('hex')
  const workerPool = new TaskWorkerPool({
    repository,
    assetRoot,
    concurrency: options.concurrency,
    providerConfig: options.providerConfig,
    providerTimeoutMs: options.providerTimeoutMs,
    providerRetryBaseMs: options.providerRetryBaseMs,
  })

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

  let closed = false
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
      if (closed) return
      closed = true
      await workerPool.stop()
      if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise))
      repository.close()
      await releaseStateLock()
    },
    async destroy() {
      await this.close()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}
