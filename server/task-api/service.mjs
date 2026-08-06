import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { unlinkSync, existsSync as existsSyncSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Agent, setGlobalDispatcher } from 'undici'
import sharp from 'sharp'

// Prevent undici's internal timeouts from firing before the engine's own
// AbortController timeout. The engine controls timeout via providerTimeoutMs;
// undici must not cut connections early. Set undici's own timers to 15 minutes
// so the engine's application-level timeout is always the primary gate.
setGlobalDispatcher(new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 }))

// Safe existence check that swallows errors from permission issues etc.
function existsSyncSafe(filePath) {
  try { return existsSyncSync(filePath) } catch { return false }
}
import {
  API_MODES,
  assertTransition,
  calculateImageSize,
  COMMON_IMAGE_RATIOS,
  CONTRACT_VERSION,
  createAssetManifest,
  deriveExactSourceTarget,
  deriveInheritedTarget,
  JOB_STATES,
  MANIFEST_VERSION,
  MAX_EDGE,
  MAX_PIXELS,
  parseImageSize,
  parseRatio,
  ratioMatchesExactly,
  ratioMatchesWithinOnePixel,
  resolveEnhancementPolicy,
  validateImageJobRequest,
  verifySourceFinalInvariant,
} from '../../packages/image-job-core/index.mjs'
import {
  buildQaRevisionPrompt,
  classifyQaVerdict,
  createProviderBatchAutomationEvaluator,
  expandBatchRequest,
  validateBatchAutomation,
} from './batch-automation.mjs'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const ACTIVE_STATES = ['validating', 'generating', 'source_ready', 'enhancing', 'finalizing']
const TERMINAL_JOB_STATES = ['succeeded', 'failed', 'cancelled']
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024
const DEFAULT_JOB_LIST_LIMIT = 30
const MAX_JOB_LIST_LIMIT = 100
const MAX_BATCH_ITEMS = 500
const MIN_RUNNER_LEASE_MS = 10_000
const MAX_RUNNER_LEASE_MS = 5 * 60_000
const ACCEPTED_ENHANCEMENTS = ['auto', 'none', 'lanczos3', 'real-esrgan', 'hat']
const QA_STATUSES = ['not_run', 'passed', 'failed', 'needs_review']
const ACCEPTANCE_STATUSES = ['pending', 'accepted', 'needs_review', 'rejected']
const HUMAN_REVIEW_STATUSES = ['not_ready', 'pending', 'approved', 'rejected', 'not_applicable']
const DEFAULT_ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(?::\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/,
]

function now() { return new Date().toISOString() }
function sha256(data) { return createHash('sha256').update(data).digest('hex') }
function jobCursor(job) {
  return Buffer.from(JSON.stringify({ createdAt: job.createdAt, id: job.id }), 'utf8').toString('base64url')
}
function parseJobCursor(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (typeof parsed?.createdAt !== 'string' || typeof parsed?.id !== 'string') throw new Error('invalid cursor payload')
    return parsed
  } catch {
    throw Object.assign(new Error('invalid job list cursor'), { statusCode: 400, code: 'INVALID_CURSOR' })
  }
}
function parseJobListLimit(value) {
  if (value === null) return DEFAULT_JOB_LIST_LIMIT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOB_LIST_LIMIT) {
    throw Object.assign(new Error(`limit must be an integer from 1 to ${MAX_JOB_LIST_LIMIT}`), { statusCode: 400, code: 'INVALID_LIMIT' })
  }
  return limit
}
function parsePageCursor(value, label) {
  if (value === null) return null
  const cursor = Number(value)
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw Object.assign(new Error(`invalid ${label} cursor`), { statusCode: 400, code: 'INVALID_CURSOR' })
  }
  return cursor
}
function validateBatchRequest(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['batch must be an object'] }
  if (typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length < 8 || value.idempotencyKey.length > 200) {
    errors.push('idempotencyKey must contain 8 to 200 characters')
  }
  if (value.logicalKey !== undefined && (typeof value.logicalKey !== 'string' || !value.logicalKey.trim() || value.logicalKey.length < 8 || value.logicalKey.length > 200)) {
    errors.push('logicalKey must contain 8 to 200 characters when provided')
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200)) {
    errors.push('name must be a non-empty string up to 200 characters')
  }
  if (value.outputRoot !== undefined && (typeof value.outputRoot !== 'string' || !value.outputRoot.trim())) {
    errors.push('outputRoot must be a non-empty string path')
  }
  errors.push(...validateBatchAutomation(value.automation))
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > MAX_BATCH_ITEMS) {
    errors.push(`items must contain 1 to ${MAX_BATCH_ITEMS} entries`)
  } else {
    const keys = new Set()
    value.items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`items[${index}] must be an object`)
        return
      }
      if (typeof item.itemKey !== 'string' || !item.itemKey.trim() || item.itemKey.length > 200) {
        errors.push(`items[${index}].itemKey must be a non-empty string up to 200 characters`)
      } else if (keys.has(item.itemKey)) {
        errors.push(`items[${index}].itemKey must be unique within the batch`)
      } else {
        keys.add(item.itemKey)
      }
      if (item.copies !== undefined && (!Number.isInteger(item.copies) || item.copies < 1 || item.copies > 10)) {
        errors.push(`items[${index}].copies must be an integer from 1 to 10`)
      }
      if (item.outputPath !== undefined && (typeof item.outputPath !== 'string' || !item.outputPath.trim())) {
        errors.push(`items[${index}].outputPath must be a non-empty string path`)
      }
      const validation = validateImageJobRequest(item.request)
      if (!validation.valid) {
        errors.push(...validation.errors.map((error) => `items[${index}].request: ${error}`))
      }
    })
  }
  return { valid: errors.length === 0, errors }
}
function validateBatchItemQa(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['QA record must be an object'] }
  if (!QA_STATUSES.includes(value.qaStatus)) errors.push(`qaStatus must be one of ${QA_STATUSES.join(', ')}`)
  if (value.failureClass !== undefined && (typeof value.failureClass !== 'string' || !value.failureClass.trim() || value.failureClass.length > 100)) {
    errors.push('failureClass must be a non-empty string up to 100 characters')
  }
  if (value.recoveryAction !== undefined && (typeof value.recoveryAction !== 'string' || !value.recoveryAction.trim() || value.recoveryAction.length > 100)) {
    errors.push('recoveryAction must be a non-empty string up to 100 characters')
  }
  if (value.detail !== undefined && (!value.detail || typeof value.detail !== 'object' || Array.isArray(value.detail))) {
    errors.push('detail must be an object')
  }
  return { valid: errors.length === 0, errors }
}
function validateBatchItemReview(value) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['human review must be an object'] }
  if (!['accepted', 'rejected'].includes(value.acceptanceStatus)) {
    errors.push('acceptanceStatus must be accepted or rejected')
  }
  if (value.detail !== undefined && (!value.detail || typeof value.detail !== 'object' || Array.isArray(value.detail))) {
    errors.push('detail must be an object')
  }
  return { valid: errors.length === 0, errors }
}
function validateRunnerLeaseRequest(value, requireLeaseMs = true) {
  const errors = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, errors: ['runner lease request must be an object'] }
  if (typeof value.owner !== 'string' || !value.owner.trim() || value.owner.length > 200) {
    errors.push('owner must be a non-empty string up to 200 characters')
  }
  if (requireLeaseMs && (!Number.isInteger(value.leaseMs) || value.leaseMs < MIN_RUNNER_LEASE_MS || value.leaseMs > MAX_RUNNER_LEASE_MS)) {
    errors.push(`leaseMs must be an integer from ${MIN_RUNNER_LEASE_MS} to ${MAX_RUNNER_LEASE_MS}`)
  }
  return { valid: errors.length === 0, errors }
}
function validateLogicalKeyRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.logicalKey !== 'string' || !value.logicalKey.trim() || value.logicalKey.length < 8 || value.logicalKey.length > 200) {
    return { valid: false, errors: ['logicalKey must contain 8 to 200 characters'] }
  }
  return { valid: true, errors: [] }
}
function taskApiCapabilities(providerConfig = {}) {
  return {
    service: 'taostudio-image-task-api',
    apiVersion: '1',
    contractVersion: CONTRACT_VERSION,
    manifestVersion: MANIFEST_VERSION,
    capabilities: {
      inputModes: ['prompt', 'source', 'edit'],
      apiModes: API_MODES,
      ratios: COMMON_IMAGE_RATIOS,
      generation: {
        defaultProvider: 'configured',
        defaultModel: typeof providerConfig.model === 'string' && providerConfig.model.trim()
          ? providerConfig.model.trim()
          : null,
      },
      output: {
        formats: ['png'],
        qualities: ['high'],
        acceptedEnhancements: ACCEPTED_ENHANCEMENTS,
        implementedEnhancements: ['lanczos3'],
        enhancementFallback: 'lanczos3',
        maxEdge: MAX_EDGE,
        maxPixels: MAX_PIXELS,
      },
      retry: { maxAttempts: 5 },
      upload: { mediaTypes: ['image/png'], maxBytes: UPLOAD_MAX_BYTES },
      jobs: { states: JOB_STATES, defaultListLimit: DEFAULT_JOB_LIST_LIMIT, maxListLimit: MAX_JOB_LIST_LIMIT },
      batches: {
        maxItems: MAX_BATCH_ITEMS,
        states: ['running', 'paused', 'completed'],
        qaStatuses: QA_STATUSES,
        acceptanceStatuses: ACCEPTANCE_STATUSES,
        humanReviewStatuses: HUMAN_REVIEW_STATUSES,
        automation: {
          supported: true,
          maxRevisions: 3,
          features: ['multi_output_expansion', 'safe_rewrite', 'visual_qa', 'human_review', 'optional_auto_revision'],
        },
      },
      events: { transport: 'sse' },
    },
  }
}
function createOriginMatcher(allowedOrigins = []) {
  const exactOrigins = new Set(allowedOrigins.map((value) => {
    const candidate = String(value).trim()
    if (!candidate) return ''
    try {
      return new URL(candidate).origin
    } catch {
      return candidate
    }
  }).filter(Boolean))
  return (origin) => {
    if (!origin) return null
    if (DEFAULT_ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) return origin
    return exactOrigins.has(origin) ? origin : null
  }
}
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
  const quota = /(billing|quota|insufficient[_ -]?credits?|credit[_ -]?balance)/.test(classification)
  const permanent = /(content[_ -]?policy|moderation|safety|invalid[_ -]?request|authentication|authorization|permission|not[_ -]?found)/.test(classification) || quota
  const transient = /(rate[_ -]?limit|timeout|temporar|overload|capacity|server|internal|upstream|gateway|unavailable|generation[_ -]?failed)/.test(classification)
  const contentPolicy = /(content[_ -]?policy|moderation|safety|refus|reject|blocked|disallowed|not allowed|violation)/.test(classification)
  const invalidInput = /(invalid[_ -]?request|not[_ -]?found)/.test(classification)
  const authentication = /(authentication|authorization|permission)/.test(classification)
  const error = Object.assign(new Error(
    providerCode ? `provider reported ${providerCode}${providerMessage ? `: ${providerMessage}` : ''}` : 'provider response did not contain an image',
  ), {
    code: 'PROVIDER_RESPONSE_ERROR',
    providerCode,
    retryable: permanent ? false : transient ? true : fallbackRetryable,
    fallbackEligible: contentPolicy || quota || transient || (!permanent && fallbackRetryable),
    failureClass: contentPolicy
      ? 'content_policy'
      : invalidInput
        ? 'invalid_input'
        : authentication
          ? 'authentication'
          : quota
            ? 'quota'
            : transient
              ? 'provider_transient'
              : 'provider_response',
    recoveryAction: contentPolicy
      ? 'safe_rewrite'
      : invalidInput
        ? 'fix_input'
        : authentication
          ? 'fix_configuration'
          : quota || transient
            ? 'route_fallback'
            : 'inspect_provider_response',
    diagnostics: { responseKeys: Object.keys(body).sort().slice(0, 20) },
  })
  return error
}

function routeFromRequest(request, routeIndex = 0) {
  const route = routeIndex === 1 ? request.generation?.fallback : request.generation
  return {
    provider: route?.provider,
    model: route?.model,
    apiMode: route?.apiMode || 'images',
  }
}

function requestForRoute(request, routeIndex) {
  const route = routeFromRequest(request, routeIndex)
  return {
    ...request,
    generation: {
      ...request.generation,
      provider: route.provider,
      model: route.model,
      apiMode: route.apiMode,
    },
  }
}

function fallbackEligible(error, stage) {
  if (stage !== 'generating') return false
  if (typeof error?.fallbackEligible === 'boolean') return error.fallbackEligible
  if (error?.name === 'AbortError') return true
  if (error?.httpStatus === 429 || error?.httpStatus === 408 || error?.httpStatus >= 500) return true
  return ['PROVIDER_TIMEOUT', 'PROVIDER_NETWORK_ERROR', 'PROVIDER_IMAGE_INVALID'].includes(error?.code)
}

function classifyFailure(error, stage) {
  if (error?.failureClass && error?.recoveryAction) {
    return { failureClass: error.failureClass, recoveryAction: error.recoveryAction }
  }
  if (stage === 'validating') return { failureClass: 'invalid_input', recoveryAction: 'fix_input' }
  if (error?.name === 'AbortError' || error?.code === 'PROVIDER_TIMEOUT') {
    return { failureClass: 'provider_timeout', recoveryAction: 'route_fallback' }
  }
  if (error?.code === 'PROVIDER_NETWORK_ERROR' || error?.httpStatus === 429 || error?.httpStatus >= 500) {
    return { failureClass: 'provider_transient', recoveryAction: 'route_fallback' }
  }
  if (error?.code === 'PROVIDER_IMAGE_INVALID') {
    return { failureClass: 'invalid_asset', recoveryAction: 'route_fallback' }
  }
  return { failureClass: 'job_failure', recoveryAction: 'inspect' }
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
  const networkCode = safeProviderText(error?.cause?.code ?? error?.code)
  // UND_ERR_HEADERS_TIMEOUT means undici dropped the connection because the
  // provider didn't send response headers in time. Treat it like an abort —
  // the image may have been generated on the provider side, so use the same
  // retryable timeout classification as an explicit AbortController abort.
  if (signal?.aborted || networkCode === 'UND_ERR_HEADERS_TIMEOUT') {
    return Object.assign(
      new Error(`provider request aborted${networkCode ? ` (${networkCode})` : ''}`),
      { name: 'AbortError', code: 'PROVIDER_TIMEOUT', retryable: true },
    )
  }
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

// Shared response-decoding + error-classification for the three OpenAI-compatible
// provider call shapes (images/generations, images/edits, responses). Reads the
// body, classifies a non-OK HTTP status or a non-JSON/malformed body into the
// same typed error vocabulary, and returns the parsed JSON payload on success.
// The per-call success-path extraction (b64_json vs responses output) stays in
// each caller; only the error taxonomy is shared.
async function decodeProviderJsonResponse(response, signal) {
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
  try {
    return JSON.parse(responseText)
  } catch {
    throw Object.assign(new Error('provider returned malformed JSON'), {
      code: 'PROVIDER_RESPONSE_ERROR',
      retryable: true,
      diagnostics: { contentType, ...responseShape(responseText) },
    })
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
    this.changeListeners = new Set()
    this.db = new DatabaseSync(databasePath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        route_index INTEGER NOT NULL DEFAULT 0,
        route_attempts INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        logical_key TEXT,
        request_hash TEXT NOT NULL,
        name TEXT,
        automation_json TEXT,
        control_state TEXT NOT NULL DEFAULT 'running',
        runner_owner TEXT,
        runner_lease_expires_at INTEGER NOT NULL DEFAULT 0,
        runner_heartbeat_at TEXT,
        runner_attempt INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batch_items (
        batch_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        source_item_key TEXT NOT NULL,
        position INTEGER NOT NULL,
        output_index INTEGER NOT NULL DEFAULT 1,
        output_count INTEGER NOT NULL DEFAULT 1,
        job_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 0,
        automation_state TEXT NOT NULL DEFAULT 'idle',
        qa_status TEXT NOT NULL DEFAULT 'not_run',
        acceptance_status TEXT NOT NULL DEFAULT 'pending',
        failure_class TEXT,
        recovery_action TEXT,
        review_json TEXT,
        human_review_status TEXT NOT NULL DEFAULT 'not_ready',
        human_review_json TEXT,
        output_path TEXT,
        PRIMARY KEY (batch_id,item_key),
        UNIQUE (batch_id,position),
        FOREIGN KEY (batch_id) REFERENCES batches(id),
        FOREIGN KEY (job_id) REFERENCES jobs(id)
      );
      CREATE TABLE IF NOT EXISTS batch_item_jobs (
        batch_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        job_id TEXT NOT NULL UNIQUE,
        reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (batch_id,item_key,revision),
        FOREIGN KEY (batch_id,item_key) REFERENCES batch_items(batch_id,item_key),
        FOREIGN KEY (job_id) REFERENCES jobs(id)
      );
      CREATE TABLE IF NOT EXISTS batch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id TEXT NOT NULL,
        event TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (batch_id) REFERENCES batches(id)
      );
      CREATE TABLE IF NOT EXISTS provider_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        route_index INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        api_mode TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        usage_json TEXT,
        error_json TEXT,
        http_status INTEGER,
        UNIQUE (job_id, attempt),
        FOREIGN KEY (job_id) REFERENCES jobs(id)
      );
    `)
    const jobColumns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name))
    if (!jobColumns.has('route_index')) this.db.exec('ALTER TABLE jobs ADD COLUMN route_index INTEGER NOT NULL DEFAULT 0')
    if (!jobColumns.has('route_attempts')) this.db.exec('ALTER TABLE jobs ADD COLUMN route_attempts INTEGER NOT NULL DEFAULT 0')
    // P1-8: Priority column for batch job ordering (higher = claimed first)
    if (!jobColumns.has('priority')) this.db.exec('ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
    const batchColumns = new Set(this.db.prepare('PRAGMA table_info(batches)').all().map((column) => column.name))
    if (!batchColumns.has('automation_json')) this.db.exec('ALTER TABLE batches ADD COLUMN automation_json TEXT')
    if (!batchColumns.has('pause_reason')) this.db.exec('ALTER TABLE batches ADD COLUMN pause_reason TEXT')
    if (!batchColumns.has('output_root')) this.db.exec('ALTER TABLE batches ADD COLUMN output_root TEXT')
    if (!batchColumns.has('logical_key')) this.db.exec('ALTER TABLE batches ADD COLUMN logical_key TEXT')
    if (!batchColumns.has('runner_owner')) this.db.exec('ALTER TABLE batches ADD COLUMN runner_owner TEXT')
    if (!batchColumns.has('runner_lease_expires_at')) this.db.exec('ALTER TABLE batches ADD COLUMN runner_lease_expires_at INTEGER NOT NULL DEFAULT 0')
    if (!batchColumns.has('runner_heartbeat_at')) this.db.exec('ALTER TABLE batches ADD COLUMN runner_heartbeat_at TEXT')
    if (!batchColumns.has('runner_attempt')) this.db.exec('ALTER TABLE batches ADD COLUMN runner_attempt INTEGER NOT NULL DEFAULT 0')
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS batches_logical_key_unique ON batches(logical_key) WHERE logical_key IS NOT NULL')
    const batchItemColumns = new Set(this.db.prepare('PRAGMA table_info(batch_items)').all().map((column) => column.name))
    const hasHumanReviewJson = batchItemColumns.has('human_review_json')
    const hasHumanReviewStatus = batchItemColumns.has('human_review_status')
    if (!batchItemColumns.has('source_item_key')) this.db.exec("ALTER TABLE batch_items ADD COLUMN source_item_key TEXT NOT NULL DEFAULT ''")
    if (!batchItemColumns.has('output_index')) this.db.exec('ALTER TABLE batch_items ADD COLUMN output_index INTEGER NOT NULL DEFAULT 1')
    if (!batchItemColumns.has('output_count')) this.db.exec('ALTER TABLE batch_items ADD COLUMN output_count INTEGER NOT NULL DEFAULT 1')
    if (!batchItemColumns.has('automation_state')) this.db.exec("ALTER TABLE batch_items ADD COLUMN automation_state TEXT NOT NULL DEFAULT 'idle'")
    if (!batchItemColumns.has('revision')) this.db.exec('ALTER TABLE batch_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
    if (!batchItemColumns.has('qa_status')) this.db.exec("ALTER TABLE batch_items ADD COLUMN qa_status TEXT NOT NULL DEFAULT 'not_run'")
    if (!batchItemColumns.has('acceptance_status')) this.db.exec("ALTER TABLE batch_items ADD COLUMN acceptance_status TEXT NOT NULL DEFAULT 'pending'")
    if (!batchItemColumns.has('failure_class')) this.db.exec('ALTER TABLE batch_items ADD COLUMN failure_class TEXT')
    if (!batchItemColumns.has('recovery_action')) this.db.exec('ALTER TABLE batch_items ADD COLUMN recovery_action TEXT')
    if (!batchItemColumns.has('review_json')) this.db.exec('ALTER TABLE batch_items ADD COLUMN review_json TEXT')
    if (!hasHumanReviewStatus) this.db.exec("ALTER TABLE batch_items ADD COLUMN human_review_status TEXT NOT NULL DEFAULT 'not_ready'")
    if (!hasHumanReviewJson) this.db.exec('ALTER TABLE batch_items ADD COLUMN human_review_json TEXT')
    if (!batchItemColumns.has('output_path')) this.db.exec('ALTER TABLE batch_items ADD COLUMN output_path TEXT')
    this.db.exec("UPDATE batch_items SET source_item_key=item_key WHERE source_item_key=''")
    this.db.exec("UPDATE batch_items SET automation_state='idle' WHERE automation_state='processing'")
    if (!hasHumanReviewStatus) {
      // Earlier versions had no durable human decision. Do not infer approval
      // from an AI or runner write; make successful records reviewable again.
      this.db.exec(`
        UPDATE batch_items
        SET human_review_status=CASE
          WHEN (SELECT state FROM jobs WHERE jobs.id=batch_items.job_id)='succeeded' THEN 'pending'
          WHEN (SELECT state FROM jobs WHERE jobs.id=batch_items.job_id) IN ('failed','cancelled') THEN 'not_applicable'
          ELSE 'not_ready'
        END,
        acceptance_status=CASE
          WHEN (SELECT state FROM jobs WHERE jobs.id=batch_items.job_id)='succeeded' THEN 'needs_review'
          WHEN (SELECT state FROM jobs WHERE jobs.id=batch_items.job_id) IN ('failed','cancelled') THEN 'rejected'
          ELSE 'pending'
        END
      `)
    }
    this.db.exec(`
      INSERT OR IGNORE INTO batch_item_jobs (batch_id,item_key,revision,job_id,reason,created_at)
      SELECT bi.batch_id,bi.item_key,bi.revision,bi.job_id,'legacy_backfill',b.created_at
      FROM batch_items bi
      JOIN batches b ON b.id=bi.batch_id
    `)

    // QA-passed terminal items are delivery-safe by policy. Older versions
    // left every successful item pending human review; promote only those
    // with explicit QA evidence and never overwrite a human rejection.
    const legacyQaPassed = this.db.prepare(`
      SELECT bi.batch_id,bi.item_key,bi.revision,j.id AS job_id
      FROM batch_items bi
      JOIN jobs j ON j.id=bi.job_id
      WHERE j.state='succeeded'
        AND bi.qa_status='passed'
        AND bi.acceptance_status!='rejected'
        AND bi.human_review_status NOT IN ('approved','rejected')
    `).all()
    if (legacyQaPassed.length) {
      const decidedAt = now()
      const update = this.db.prepare(`
        UPDATE batch_items
        SET acceptance_status='accepted',human_review_status='approved',human_review_json=?
        WHERE batch_id=? AND item_key=?
      `)
      for (const item of legacyQaPassed) {
        update.run(JSON.stringify({
          actor: 'system',
          decision: 'qa_passed_auto_accepted',
          decidedAt,
          jobId: item.job_id,
          revision: item.revision,
          migrated: true,
        }), item.batch_id, item.item_key)
        this.recordBatchEvent(item.batch_id, 'item_qa_auto_accepted', {
          itemKey: item.item_key,
          revision: item.revision,
          jobId: item.job_id,
          reason: 'qa_passed_migration',
        })
      }
    }
  }

  recoverInterruptedJobs() {
    this.db.prepare("UPDATE provider_calls SET state='interrupted', completed_at=?, error_json=? WHERE state='started'")
      .run(now(), JSON.stringify({ code: 'WORKER_RESTARTED', message: 'provider call was interrupted by worker restart' }))
    const placeholders = ACTIVE_STATES.map(() => '?').join(',')
    const interrupted = this.db.prepare(`SELECT id,state,route_attempts,attempts FROM jobs WHERE state IN (${placeholders})`).all(...ACTIVE_STATES)
    for (const job of interrupted) {
      // A crash mid-flight means the in-progress attempt never completed, so
      // the accumulated route_attempts must not be carried forward — otherwise
      // the next claim would push a twice-retried job straight past its
      // maxAttempts ceiling and fail it permanently on the first post-restart
      // try. Reset route_attempts (and clear the stale error) so the job gets a
      // clean retry budget, matching manual retryJob() semantics.
      this.db.prepare("UPDATE jobs SET state='queued', route_attempts=0, error_json=NULL, available_at=0, updated_at=? WHERE id=?").run(now(), job.id)
      this.recordEvent(job.id, 'queued', {
        reason: 'recovered_after_restart',
        interruptedState: job.state,
        previousRouteAttempts: job.route_attempts,
        previousAttempts: job.attempts,
      })
    }
    return interrupted.length
  }

  createOrGetJob(request) {
    const requestJson = stableJson(request)
    const requestHash = sha256(requestJson)
    const existing = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key=?').get(request.idempotencyKey)
    if (existing) {
      if (existing.request_hash !== requestHash) throw Object.assign(new Error('idempotency key was already used with a different request'), { statusCode: 409 })
      return { job: this.getJob(existing.id), created: false }
    }
    const id = `job_${randomUUID()}`
    const timestamp = now()
    this.db.prepare(`INSERT INTO jobs (id,idempotency_key,request_hash,request_json,state,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, request.idempotencyKey, requestHash, requestJson, 'queued', request.retry?.maxAttempts ?? 3, timestamp, timestamp)
    this.recordEvent(id, 'queued', { reason: 'created' })
    return { job: this.getJob(id), created: true }
  }

  getJob(id, options = {}) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id)
    return row ? this.jobFromRow(row, options) : null
  }

  jobFromRow(row, options = {}) {
    const request = JSON.parse(row.request_json)
    const routeIndex = row.route_index ?? 0
    const accounting = options.includeAccounting ? this.providerCallAccounting(row.id) : null
    return {
      id: row.id,
      contractVersion: '1',
      request,
      state: row.state,
      attempts: row.attempts,
      routeIndex,
      routeAttempts: row.route_attempts ?? row.attempts,
      maxAttempts: row.max_attempts,
      actualRoute: routeFromRequest(request, routeIndex),
      cancelRequested: Boolean(row.cancel_requested),
      sourceAssetId: row.source_asset_id,
      finalAssetId: row.final_asset_id,
      error: row.error_json ? JSON.parse(row.error_json) : null,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      ...(accounting ? { accounting } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  providerCallAccounting(jobId) {
    const rows = this.db.prepare('SELECT * FROM provider_calls WHERE job_id=? ORDER BY attempt').all(jobId)
    return {
      calls: rows.map((row) => ({
        id: row.id,
        attempt: row.attempt,
        routeIndex: row.route_index,
        route: { provider: row.provider, model: row.model, apiMode: row.api_mode },
        state: row.state,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        usage: row.usage_json ? JSON.parse(row.usage_json) : null,
        error: row.error_json ? JSON.parse(row.error_json) : null,
        httpStatus: row.http_status,
      })),
    }
  }

  startProviderCall(job) {
    const route = job.actualRoute
    const result = this.db.prepare(`
      INSERT INTO provider_calls (job_id,attempt,route_index,provider,model,api_mode,state,started_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(job.id, job.attempts, job.routeIndex, route.provider, route.model, route.apiMode, 'started', now())
    return Number(result.lastInsertRowid)
  }

  finishProviderCall(id, options = {}) {
    this.db.prepare(`
      UPDATE provider_calls
      SET state=?, completed_at=?, usage_json=?, error_json=?, http_status=?
      WHERE id=?
    `).run(
      options.state,
      now(),
      options.usage ? JSON.stringify(options.usage) : null,
      options.error ? JSON.stringify(options.error) : null,
      options.httpStatus ?? null,
      id,
    )
  }

  listJobs(options = {}) {
    const limit = options.limit ?? DEFAULT_JOB_LIST_LIMIT
    const cursor = options.cursor ?? null
    const state = options.state ?? null
    const clauses = []
    const parameters = []
    if (state) {
      clauses.push('state=?')
      parameters.push(state)
    }
    if (cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...parameters, limit + 1)
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => this.jobFromRow(row))
    const stateRows = this.db.prepare('SELECT state,COUNT(*) AS count FROM jobs GROUP BY state').all()
    const byState = Object.fromEntries(JOB_STATES.map((jobState) => [jobState, 0]))
    for (const row of stateRows) byState[row.state] = Number(row.count)
    const total = Object.values(byState).reduce((sum, count) => sum + count, 0)
    const terminal = byState.succeeded + byState.failed + byState.cancelled
    return {
      items,
      nextCursor: hasMore && items.length ? jobCursor(items[items.length - 1]) : null,
      stats: {
        total,
        terminal,
        active: total - terminal - byState.queued,
        queued: byState.queued,
        succeeded: byState.succeeded,
        failed: byState.failed,
        cancelled: byState.cancelled,
        byState,
        matching: state ? byState[state] : total,
      },
    }
  }

  createOrGetBatch(request) {
    const requestJson = stableJson(request)
    const requestHash = sha256(requestJson)
    const logicalKey = request.logicalKey?.trim() || null
    if (logicalKey) {
      const existingLogical = this.db.prepare('SELECT id FROM batches WHERE logical_key=?').get(logicalKey)
      if (existingLogical) return { batch: this.getBatch(existingLogical.id), created: false, logicalReused: true }
    }
    const existing = this.db.prepare('SELECT * FROM batches WHERE idempotency_key=?').get(request.idempotencyKey)
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw Object.assign(new Error('batch idempotency key was already used with different input'), {
          statusCode: 409,
          code: 'BATCH_IDEMPOTENCY_CONFLICT',
        })
      }
      return { batch: this.getBatch(existing.id), created: false }
    }

    const id = `batch_${randomUUID()}`
    const timestamp = now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // A second runner can reach this point after the optimistic read above. The
      // immediate transaction makes the logical-key check and first claim atomic.
      if (logicalKey) {
        const existingLogical = this.db.prepare('SELECT id FROM batches WHERE logical_key=?').get(logicalKey)
        if (existingLogical) {
          this.db.exec('COMMIT')
          return { batch: this.getBatch(existingLogical.id), created: false, logicalReused: true }
        }
      }
      for (const item of request.items) {
        const sourceItemKey = item.sourceItemKey || item.itemKey
        const claimed = this.activeSourceItemClaim(sourceItemKey)
        if (claimed) {
          throw Object.assign(new Error(`source item ${sourceItemKey} is already active in batch ${claimed.batchName || claimed.batchId}`), {
            statusCode: 409,
            code: 'SOURCE_ITEM_ALREADY_CLAIMED',
          })
        }
      }
      this.db.prepare('INSERT INTO batches (id,idempotency_key,logical_key,request_hash,name,automation_json,output_root,control_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          request.idempotencyKey,
          logicalKey,
          requestHash,
          request.name?.trim() || null,
          request.automation ? JSON.stringify(request.automation) : null,
          request.outputRoot?.trim() || null,
          'running',
          timestamp,
          timestamp,
        )
      request.items.forEach((item, position) => {
        const result = this.createOrGetJob(item.request)
        try {
          this.db.prepare(`
            INSERT INTO batch_items (
              batch_id,item_key,source_item_key,position,output_index,output_count,job_id,output_path
            ) VALUES (?,?,?,?,?,?,?,?)
          `).run(
            id,
            item.itemKey,
            item.sourceItemKey || item.itemKey,
            position,
            item.outputIndex || 1,
            item.outputCount || 1,
            result.job.id,
            item.outputPath?.trim() || null,
          )
          this.db.prepare('INSERT INTO batch_item_jobs (batch_id,item_key,revision,job_id,reason,created_at) VALUES (?,?,?,?,?,?)')
            .run(id, item.itemKey, 0, result.job.id, 'initial', timestamp)
        } catch (error) {
          if (String(error?.message || '').includes('UNIQUE constraint failed: batch_items.job_id')) {
            throw Object.assign(new Error(`job ${result.job.id} already belongs to another batch`), {
              statusCode: 409,
              code: 'JOB_ALREADY_BATCHED',
            })
          }
          throw error
        }
      })
      this.recordBatchEvent(id, 'created', { itemCount: request.items.length })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { batch: this.getBatch(id), created: true }
  }

  getBatchByLogicalKey(logicalKey) {
    const row = this.db.prepare('SELECT id FROM batches WHERE logical_key=?').get(logicalKey)
    return row ? this.getBatch(row.id) : null
  }

  adoptBatchLogicalKey(id, logicalKey) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT logical_key FROM batches WHERE id=?').get(id)
      if (!row) {
        this.db.exec('COMMIT')
        return null
      }
      if (row.logical_key && row.logical_key !== logicalKey) {
        throw Object.assign(new Error('batch already belongs to a different logical key'), {
          statusCode: 409,
          code: 'BATCH_LOGICAL_KEY_CONFLICT',
        })
      }
      const claimed = this.db.prepare('SELECT id FROM batches WHERE logical_key=?').get(logicalKey)
      if (claimed && claimed.id !== id) {
        throw Object.assign(new Error('logical key already belongs to another batch'), {
          statusCode: 409,
          code: 'BATCH_LOGICAL_KEY_CONFLICT',
        })
      }
      if (!row.logical_key) {
        this.db.prepare('UPDATE batches SET logical_key=?,updated_at=? WHERE id=?').run(logicalKey, now(), id)
        this.recordBatchEvent(id, 'logical_key_adopted', { logicalKey })
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getBatch(id)
  }

  activeSourceItemClaim(sourceItemKey, excludeBatchId = null) {
    const terminalPlaceholders = TERMINAL_JOB_STATES.map(() => '?').join(',')
    const exclusion = excludeBatchId ? 'AND bi.batch_id<>?' : ''
    const parameters = [sourceItemKey, ...TERMINAL_JOB_STATES]
    if (excludeBatchId) parameters.push(excludeBatchId)
    const row = this.db.prepare(`
      SELECT bi.batch_id AS batch_id,b.name AS batch_name,j.id AS job_id,j.state AS job_state
      FROM batch_items bi
      JOIN batches b ON b.id=bi.batch_id
      JOIN jobs j ON j.id=bi.job_id
      WHERE bi.source_item_key=?
        AND j.state NOT IN (${terminalPlaceholders})
        ${exclusion}
      ORDER BY j.created_at DESC
      LIMIT 1
    `).get(...parameters)
    return row ? {
      batchId: row.batch_id,
      batchName: row.batch_name,
      jobId: row.job_id,
      jobState: row.job_state,
    } : null
  }

  acquireBatchRunner(id, owner, leaseMs) {
    const timestamp = now()
    const nowMs = Date.now()
    const expiresAtMs = nowMs + leaseMs
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM batches WHERE id=?').get(id)
      if (!row) {
        this.db.exec('COMMIT')
        return null
      }
      const currentExpiry = Number(row.runner_lease_expires_at || 0)
      if (row.runner_owner && row.runner_owner !== owner && currentExpiry > nowMs) {
        throw Object.assign(new Error(`batch runner lease is held until ${new Date(currentExpiry).toISOString()}`), {
          statusCode: 409,
          code: 'RUNNER_LEASE_HELD',
        })
      }
      const nextAttempt = Number(row.runner_attempt || 0) + (row.runner_owner === owner && currentExpiry > nowMs ? 0 : 1)
      this.db.prepare(`
        UPDATE batches
        SET runner_owner=?,runner_lease_expires_at=?,runner_heartbeat_at=?,runner_attempt=?,updated_at=?
        WHERE id=?
      `).run(owner, expiresAtMs, timestamp, nextAttempt, timestamp, id)
      this.recordBatchEvent(id, 'runner_acquired', {
        owner,
        attempt: nextAttempt,
        leaseExpiresAt: new Date(expiresAtMs).toISOString(),
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getBatch(id)
  }

  heartbeatBatchRunner(id, owner, leaseMs) {
    const timestamp = now()
    const nowMs = Date.now()
    const expiresAtMs = nowMs + leaseMs
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT runner_owner,runner_lease_expires_at FROM batches WHERE id=?').get(id)
      if (!row) {
        this.db.exec('COMMIT')
        return null
      }
      if (row.runner_owner !== owner) {
        throw Object.assign(new Error('batch runner lease belongs to another runner'), {
          statusCode: 409,
          code: 'RUNNER_LEASE_HELD',
        })
      }
      if (Number(row.runner_lease_expires_at || 0) <= nowMs) {
        throw Object.assign(new Error('batch runner lease has expired'), {
          statusCode: 409,
          code: 'RUNNER_LEASE_EXPIRED',
        })
      }
      this.db.prepare('UPDATE batches SET runner_lease_expires_at=?,runner_heartbeat_at=?,updated_at=? WHERE id=?')
        .run(expiresAtMs, timestamp, timestamp, id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getBatch(id)
  }

  releaseBatchRunner(id, owner) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT runner_owner FROM batches WHERE id=?').get(id)
      if (!row) {
        this.db.exec('COMMIT')
        return null
      }
      if (row.runner_owner && row.runner_owner !== owner) {
        throw Object.assign(new Error('batch runner lease belongs to another runner'), {
          statusCode: 409,
          code: 'RUNNER_LEASE_HELD',
        })
      }
      if (row.runner_owner === owner) {
        this.db.prepare('UPDATE batches SET runner_owner=NULL,runner_lease_expires_at=0,runner_heartbeat_at=NULL,updated_at=? WHERE id=?')
          .run(now(), id)
        this.recordBatchEvent(id, 'runner_released', { owner })
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getBatch(id)
  }

  listBatches(limit = DEFAULT_JOB_LIST_LIMIT) {
    const rows = this.db.prepare('SELECT * FROM batches ORDER BY created_at DESC,id DESC LIMIT ?').all(limit)
    return rows.map((row) => this.getBatchSummaryFromRow(row))
  }

  getBatchSummary(id) {
    const row = this.db.prepare('SELECT * FROM batches WHERE id=?').get(id)
    return row ? this.getBatchSummaryFromRow(row) : null
  }

  getBatchItemPage(id, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100)
    const position = Number.isInteger(options.position) ? options.position : -1
    const rows = this.db.prepare(`
      SELECT bi.item_key,bi.source_item_key,bi.position,bi.output_index,bi.output_count,
             bi.revision,bi.automation_state,bi.qa_status,bi.acceptance_status,
             bi.failure_class,bi.recovery_action,bi.review_json,bi.human_review_status,bi.human_review_json,bi.output_path,j.*
      FROM batch_items bi
      JOIN jobs j ON j.id=bi.job_id
      WHERE bi.batch_id=? AND bi.position>?
      ORDER BY bi.position
      LIMIT ?
    `).all(id, position, limit + 1)
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const keys = pageRows.map((row) => row.item_key)
    const historyByItem = new Map()
    if (keys.length) {
      const placeholders = keys.map(() => '?').join(',')
      const histories = this.db.prepare(`
        SELECT bij.item_key,bij.revision,bij.reason,bij.created_at,j.*
        FROM batch_item_jobs bij
        JOIN jobs j ON j.id=bij.job_id
        WHERE bij.batch_id=? AND bij.item_key IN (${placeholders})
        ORDER BY bij.item_key,bij.revision
      `).all(id, ...keys)
      for (const history of histories) {
        const values = historyByItem.get(history.item_key) || []
        values.push({ revision: history.revision, reason: history.reason, createdAt: history.created_at, job: this.jobFromRow(history) })
        historyByItem.set(history.item_key, values)
      }
    }
    const items = pageRows.map((item) => {
      const job = this.jobFromRow(item)
      return {
        itemKey: item.item_key,
        sourceItemKey: item.source_item_key || item.item_key,
        position: item.position,
        outputIndex: item.output_index || 1,
        outputCount: item.output_count || 1,
        revision: item.revision,
        automationState: item.automation_state,
        generationStatus: job.state === 'succeeded' ? 'succeeded' : job.state === 'failed' ? 'failed' : job.state === 'cancelled' ? 'cancelled' : ACTIVE_STATES.includes(job.state) ? 'running' : 'pending',
        qaStatus: item.qa_status,
        acceptanceStatus: item.acceptance_status,
        failureClass: item.failure_class || job.error?.failureClass || null,
        recoveryAction: item.recovery_action || job.error?.recoveryAction || null,
        review: item.review_json ? JSON.parse(item.review_json) : null,
        humanReviewStatus: item.human_review_status,
        humanReview: item.human_review_json ? JSON.parse(item.human_review_json) : null,
        outputPath: item.output_path || null,
        job,
        jobHistory: historyByItem.get(item.item_key) || [],
      }
    })
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM batch_items WHERE batch_id=?').get(id)?.count || 0)
    return { items, nextCursor: hasMore && items.length ? String(items[items.length - 1].position) : null, total }
  }

  getBatchEventPage(id, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 100)
    const beforeId = Number.isInteger(options.beforeId) ? options.beforeId : Number.MAX_SAFE_INTEGER
    const rows = this.db.prepare(`
      SELECT id,event,detail_json,created_at
      FROM batch_events
      WHERE batch_id=? AND id<?
      ORDER BY id DESC
      LIMIT ?
    `).all(id, beforeId, limit + 1)
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({ event: row.event, detail: row.detail_json ? JSON.parse(row.detail_json) : null, createdAt: row.created_at }))
    const total = Number(this.db.prepare('SELECT COUNT(*) AS count FROM batch_events WHERE batch_id=?').get(id)?.count || 0)
    return { items, nextCursor: hasMore ? String(rows[limit - 1].id) : null, total }
  }

  getBatchSummaryFromRow(row) {
    const counters = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN j.state IN ('succeeded','failed','cancelled') THEN 1 ELSE 0 END) AS terminal,
        SUM(CASE WHEN j.state='queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN j.state='succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN j.state='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN j.state='cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN bi.acceptance_status='accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN bi.acceptance_status='needs_review' THEN 1 ELSE 0 END) AS needs_review,
        SUM(CASE WHEN bi.acceptance_status='rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN bi.acceptance_status='pending' THEN 1 ELSE 0 END) AS acceptance_pending,
        SUM(CASE WHEN bi.human_review_status='pending' THEN 1 ELSE 0 END) AS human_review_pending,
        SUM(CASE WHEN bi.human_review_status='approved' THEN 1 ELSE 0 END) AS human_review_approved,
        SUM(CASE WHEN bi.human_review_status='rejected' THEN 1 ELSE 0 END) AS human_review_rejected,
        SUM(CASE WHEN bi.qa_status='passed' THEN 1 ELSE 0 END) AS qa_passed,
        SUM(CASE WHEN bi.qa_status='failed' THEN 1 ELSE 0 END) AS qa_failed,
        SUM(CASE WHEN bi.qa_status='needs_review' THEN 1 ELSE 0 END) AS qa_needs_review,
        SUM(CASE WHEN bi.qa_status='not_run' THEN 1 ELSE 0 END) AS qa_not_run,
        GROUP_CONCAT(DISTINCT json_extract(j.request_json,'$.generation.model')) AS models,
        GROUP_CONCAT(DISTINCT json_extract(j.request_json,'$.output.dimensions')) AS dimensions,
        GROUP_CONCAT(DISTINCT COALESCE(bi.failure_class,json_extract(j.error_json,'$.failureClass'))) AS failure_classes,
        MAX(j.updated_at) AS latest_job_update
      FROM batch_items bi
      JOIN jobs j ON j.id=bi.job_id
      WHERE bi.batch_id=?
    `).get(row.id)
    const number = (value) => Number(value || 0)
    const total = number(counters.total)
    const terminal = number(counters.terminal)
    const queued = number(counters.queued)
    const accepted = number(counters.accepted)
    const needsReview = number(counters.needs_review)
    const rejected = number(counters.rejected)
    const acceptancePending = number(counters.acceptance_pending)
    const state = terminal === total
      ? 'completed'
      : row.control_state === 'paused'
        ? 'paused'
        : row.control_state === 'archived'
          ? 'archived'
          : 'running'
    const runnerLeaseExpiresAt = Number(row.runner_lease_expires_at || 0)
    return {
      id: row.id,
      name: row.name,
      logicalKey: row.logical_key || null,
      automation: row.automation_json ? JSON.parse(row.automation_json) : { enabled: false },
      outputRoot: row.output_root || null,
      state,
      controlState: row.control_state,
      pauseReason: row.pause_reason || null,
      runner: {
        active: Boolean(row.runner_owner) && runnerLeaseExpiresAt > Date.now(),
        owner: row.runner_owner || null,
        attempt: Number(row.runner_attempt || 0),
        heartbeatAt: row.runner_heartbeat_at || null,
        leaseExpiresAt: runnerLeaseExpiresAt ? new Date(runnerLeaseExpiresAt).toISOString() : null,
      },
      acceptanceState: acceptancePending > 0
        ? 'pending'
        : needsReview > 0
          ? 'needs_review'
          : rejected > 0
            ? 'rejected'
            : 'accepted',
      facets: {
        models: String(counters.models || '').split(',').filter(Boolean),
        dimensions: String(counters.dimensions || '').split(',').filter(Boolean),
        failureClasses: String(counters.failure_classes || '').split(',').filter(Boolean),
      },
      stats: {
        total,
        terminal,
        active: total - terminal - queued,
        queued,
        succeeded: number(counters.succeeded),
        failed: number(counters.failed),
        cancelled: number(counters.cancelled),
        accepted,
        needsReview,
        rejected,
        acceptancePending,
        humanReviewPending: number(counters.human_review_pending),
        humanReviewApproved: number(counters.human_review_approved),
        humanReviewRejected: number(counters.human_review_rejected),
        qaPassed: number(counters.qa_passed),
        qaFailed: number(counters.qa_failed),
        qaNeedsReview: number(counters.qa_needs_review),
        qaNotRun: number(counters.qa_not_run),
      },
      createdAt: row.created_at,
      updatedAt: counters.latest_job_update && counters.latest_job_update > row.updated_at
        ? counters.latest_job_update
        : row.updated_at,
    }
  }

  getBatch(id) {
    const row = this.db.prepare('SELECT * FROM batches WHERE id=?').get(id)
    if (!row) return null
    const automation = row.automation_json ? JSON.parse(row.automation_json) : { enabled: false }
    const itemRows = this.db.prepare(`
      SELECT bi.item_key,bi.source_item_key,bi.position,bi.output_index,bi.output_count,
             bi.revision,bi.automation_state,bi.qa_status,bi.acceptance_status,
             bi.failure_class,bi.recovery_action,bi.review_json,bi.human_review_status,bi.human_review_json,bi.output_path,j.*
      FROM batch_items bi
      JOIN jobs j ON j.id=bi.job_id
      WHERE bi.batch_id=?
      ORDER BY bi.position
    `).all(id)
    const historyRows = this.db.prepare(`
      SELECT bij.item_key,bij.revision,bij.reason,bij.created_at,j.*
      FROM batch_item_jobs bij
      JOIN jobs j ON j.id=bij.job_id
      WHERE bij.batch_id=?
      ORDER BY bij.item_key,bij.revision
    `).all(id)
    const historyByItem = new Map()
    for (const history of historyRows) {
      const values = historyByItem.get(history.item_key) || []
      values.push({
        revision: history.revision,
        reason: history.reason,
        createdAt: history.created_at,
        job: this.jobFromRow(history),
      })
      historyByItem.set(history.item_key, values)
    }
    const items = itemRows.map((item) => {
      const job = this.jobFromRow(item)
      return {
        itemKey: item.item_key,
        sourceItemKey: item.source_item_key || item.item_key,
        position: item.position,
        outputIndex: item.output_index || 1,
        outputCount: item.output_count || 1,
        revision: item.revision,
        automationState: item.automation_state,
        generationStatus: job.state === 'succeeded'
          ? 'succeeded'
          : job.state === 'failed'
            ? 'failed'
            : job.state === 'cancelled'
              ? 'cancelled'
              : ACTIVE_STATES.includes(job.state)
                ? 'running'
                : 'pending',
        qaStatus: item.qa_status,
        acceptanceStatus: item.acceptance_status,
        failureClass: item.failure_class || job.error?.failureClass || null,
        recoveryAction: item.recovery_action || job.error?.recoveryAction || null,
        review: item.review_json ? JSON.parse(item.review_json) : null,
        humanReviewStatus: item.human_review_status,
        humanReview: item.human_review_json ? JSON.parse(item.human_review_json) : null,
        outputPath: item.output_path || null,
        job,
        jobHistory: historyByItem.get(item.item_key) || [],
      }
    })
    const counts = Object.fromEntries(JOB_STATES.map((state) => [state, 0]))
    items.forEach((item) => { counts[item.job.state] += 1 })
    const terminal = counts.succeeded + counts.failed + counts.cancelled
    const acceptanceCounts = Object.fromEntries(ACCEPTANCE_STATUSES.map((status) => [status, 0]))
    const qaCounts = Object.fromEntries(QA_STATUSES.map((status) => [status, 0]))
    items.forEach((item) => {
      acceptanceCounts[item.acceptanceStatus] += 1
      qaCounts[item.qaStatus] += 1
    })
    const state = terminal === items.length
      ? 'completed'
      : row.control_state === 'paused'
        ? 'paused'
        : 'running'
    const updatedAt = items.reduce(
      (latest, item) => item.job.updatedAt > latest ? item.job.updatedAt : latest,
      row.updated_at,
    )
    const runnerLeaseExpiresAt = Number(row.runner_lease_expires_at || 0)
    return {
      id: row.id,
      name: row.name,
      logicalKey: row.logical_key || null,
      automation,
      outputRoot: row.output_root || null,
      state,
      controlState: row.control_state,
      pauseReason: row.pause_reason || null,
      runner: {
        active: Boolean(row.runner_owner) && runnerLeaseExpiresAt > Date.now(),
        owner: row.runner_owner || null,
        attempt: Number(row.runner_attempt || 0),
        heartbeatAt: row.runner_heartbeat_at || null,
        leaseExpiresAt: runnerLeaseExpiresAt ? new Date(runnerLeaseExpiresAt).toISOString() : null,
      },
      acceptanceState: acceptanceCounts.pending > 0
        ? 'pending'
        : acceptanceCounts.needs_review > 0
          ? 'needs_review'
          : acceptanceCounts.rejected > 0
            ? 'rejected'
            : 'accepted',
      stats: {
        total: items.length,
        terminal,
        active: items.length - terminal - counts.queued,
        queued: counts.queued,
        succeeded: counts.succeeded,
        failed: counts.failed,
        cancelled: counts.cancelled,
        accepted: acceptanceCounts.accepted,
        needsReview: acceptanceCounts.needs_review,
        rejected: acceptanceCounts.rejected,
        acceptancePending: acceptanceCounts.pending,
        qaPassed: qaCounts.passed,
        qaFailed: qaCounts.failed,
        qaNeedsReview: qaCounts.needs_review,
        qaNotRun: qaCounts.not_run,
        humanReviewPending: items.filter((item) => item.humanReviewStatus === 'pending').length,
        humanReviewApproved: items.filter((item) => item.humanReviewStatus === 'approved').length,
        humanReviewRejected: items.filter((item) => item.humanReviewStatus === 'rejected').length,
      },
      items,
      events: this.batchEvents(id),
      createdAt: row.created_at,
      updatedAt,
    }
  }

  cancelActiveBatchJobs(batchId) {
    // Request cooperative cancellation for all in-flight (non-terminal,
    // non-queued) jobs in this batch.  Queued jobs are already gated by
    // claimNextJob's control_state check, so they don't need cancellation.
    // In-flight jobs are checked via shouldCancel() at each stage boundary
    // inside process(), so setting cancel_requested lets them exit gracefully
    // at the next checkpoint rather than burning provider calls that are
    // doomed to fail (e.g. when the provider is down).
    const activeJobs = this.db.prepare(`
      SELECT j.id FROM jobs j
      JOIN batch_items bi ON bi.job_id = j.id
      WHERE bi.batch_id = ? AND j.state IN ('validating','generating','source_ready','enhancing','finalizing')
    `).all(batchId)
    for (const job of activeJobs) {
      this.db.prepare('UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?').run(now(), job.id)
    }
    return activeJobs.length
  }

  setBatchControlState(id, controlState, reason) {
    const batch = this.getBatch(id)
    if (!batch) return null
    if (batch.state === 'completed') {
      throw Object.assign(new Error('completed batch cannot change control state'), {
        statusCode: 409,
        code: 'BATCH_COMPLETED',
      })
    }
    if (batch.controlState !== controlState) {
      const detailJson = reason ? JSON.stringify({ reason }) : null
      this.db.prepare('UPDATE batches SET control_state=?,pause_reason=?,updated_at=? WHERE id=?').run(controlState, reason || null, now(), id)
      // When pausing, cascade cancellation to in-flight jobs so they don't
      // continue burning provider calls that will fail.  This prevents the
      // scenario where a provider outage causes dozens of jobs to be marked
      // "failed" permanently when they should have been cleanly cancelled.
      let cancelledInFlight = 0
      if (controlState === 'paused') {
        cancelledInFlight = this.cancelActiveBatchJobs(id)
      }
      const eventDetail = detailJson ? JSON.parse(detailJson) : {}
      if (cancelledInFlight > 0) eventDetail.cancelledInFlight = cancelledInFlight
      this.recordBatchEvent(id, controlState, Object.keys(eventDetail).length ? eventDetail : null)
    }
    return this.getBatch(id)
  }

  retryFailedBatchJobs(id) {
    const batch = this.getBatch(id)
    if (!batch) return null
    let retried = 0
    for (const item of batch.items) {
      if (item.job.state !== 'failed') continue
      this.retryJob(item.job.id)
      this.db.prepare(`
        UPDATE batch_items
        SET automation_state='idle',qa_status='not_run',acceptance_status='pending',human_review_status='not_ready',
            failure_class=NULL,recovery_action=NULL,review_json=NULL,human_review_json=NULL
        WHERE batch_id=? AND item_key=?
      `).run(id, item.itemKey)
      retried += 1
    }
    if (retried) {
      this.db.prepare("UPDATE batches SET control_state='running',pause_reason=NULL,updated_at=? WHERE id=?").run(now(), id)
      this.recordBatchEvent(id, 'retry_failed', { retried })
    }
    return this.getBatch(id)
  }

  retryCancelledBatchJobs(id) {
    const batch = this.getBatchSummary(id)
    if (!batch) return null
    const rows = this.db.prepare(`
      SELECT bi.item_key,bi.revision,j.request_json,j.id AS previous_job_id
      FROM batch_items bi
      JOIN jobs j ON j.id=bi.job_id
      WHERE bi.batch_id=? AND j.state='cancelled'
      ORDER BY bi.position
    `).all(id)
    if (!rows.length) return this.getBatch(id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const request = JSON.parse(row.request_json)
        request.idempotencyKey = `cancelled-recovery:${randomUUID()}`
        const result = this.createOrGetJob(request)
        const revision = Number(row.revision) + 1
        this.db.prepare(`
          UPDATE batch_items
          SET job_id=?,revision=?,automation_state='idle',qa_status='not_run',acceptance_status='pending',human_review_status='not_ready',
              failure_class=NULL,recovery_action=NULL,review_json=NULL,human_review_json=NULL
          WHERE batch_id=? AND item_key=?
        `).run(result.job.id, revision, id, row.item_key)
        this.db.prepare('INSERT INTO batch_item_jobs (batch_id,item_key,revision,job_id,reason,created_at) VALUES (?,?,?,?,?,?)')
          .run(id, row.item_key, revision, result.job.id, 'cancelled_recovery', now())
      }
      this.db.prepare("UPDATE batches SET control_state='running',pause_reason=NULL,updated_at=? WHERE id=?").run(now(), id)
      this.recordBatchEvent(id, 'retry_cancelled', { retried: rows.length })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getBatch(id)
  }

  syncBatchItemExecutionProjection(jobId, job) {
    const linked = this.db.prepare(`
      SELECT bi.batch_id,bi.item_key,b.automation_json
      FROM batch_items bi
      JOIN batches b ON b.id=bi.batch_id
      WHERE bi.job_id=?
    `).get(jobId)
    if (!linked) return

    const automation = linked.automation_json ? JSON.parse(linked.automation_json) : { enabled: false }
    if (job.state === 'queued' || ACTIVE_STATES.includes(job.state)) {
      this.db.prepare(`
        UPDATE batch_items
        SET automation_state='idle',qa_status='not_run',acceptance_status='pending',human_review_status='not_ready',
            failure_class=NULL,recovery_action=NULL,review_json=NULL,human_review_json=NULL
        WHERE batch_id=? AND item_key=? AND job_id=?
      `).run(linked.batch_id, linked.item_key, jobId)
      return
    }

    if (automation.enabled) return
    if (job.state === 'succeeded') {
      this.db.prepare(`
        UPDATE batch_items
        SET automation_state='done',
            acceptance_status=CASE
              WHEN human_review_status='approved' THEN 'accepted'
              WHEN human_review_status='rejected' THEN 'rejected'
              ELSE 'needs_review'
            END,
            human_review_status=CASE
              WHEN human_review_status IN ('approved','rejected') THEN human_review_status
              ELSE 'pending'
            END
        WHERE batch_id=? AND item_key=? AND job_id=?
      `).run(linked.batch_id, linked.item_key, jobId)
      return
    }

    if (['failed', 'cancelled'].includes(job.state)) {
      this.db.prepare(`
        UPDATE batch_items
        SET automation_state='done',qa_status='not_run',acceptance_status='rejected',human_review_status='not_applicable',
            failure_class=COALESCE(failure_class,?),recovery_action=COALESCE(recovery_action,?)
        WHERE batch_id=? AND item_key=? AND job_id=?
      `).run(
        job.error?.failureClass || (job.state === 'cancelled' ? 'cancelled' : 'generation_failed'),
        job.error?.recoveryAction || (job.state === 'cancelled' ? 'manual_restart' : 'inspect_failure'),
        linked.batch_id,
        linked.item_key,
        jobId,
      )
    }
  }

  recordBatchItemTechnicalReady(id, itemKey, detail) {
    const batch = this.getBatch(id)
    const item = batch?.items.find((candidate) => candidate.itemKey === itemKey)
    if (!item) return null
    if (item.job.state !== 'succeeded') {
      throw Object.assign(new Error('technical ready records require a succeeded job'), {
        statusCode: 409,
        code: 'BATCH_ITEM_NOT_READY',
      })
    }
    this.db.prepare(`
      UPDATE batch_items
      SET automation_state='done',review_json=?
      WHERE batch_id=? AND item_key=? AND job_id=?
    `).run(detail ? JSON.stringify(detail) : null, id, itemKey, item.job.id)
    this.db.prepare('UPDATE batches SET updated_at=? WHERE id=?').run(now(), id)
    this.recordBatchEvent(id, 'item_technical_ready', {
      itemKey,
      revision: item.revision,
      jobId: item.job.id,
    })
    return this.getBatch(id)
  }

  listPausedBatchIds() {
    // Only auto-resume batches that were paused by the system (e.g. provider_unavailable),
    // not batches manually paused by the user. Manual pauses have pause_reason='manual' or NULL.
    return this.db.prepare("SELECT id FROM batches WHERE control_state='paused' AND pause_reason IS NOT NULL AND pause_reason!='manual'").all().map((row) => row.id)
  }

  recentProviderFailures(batchId, sinceIso) {
    const row = this.db.prepare(`
      SELECT COUNT(*) as c
      FROM provider_calls pc
      JOIN batch_items bi ON bi.job_id=pc.job_id
      WHERE bi.batch_id=? AND pc.state='failed' AND pc.completed_at>=?
    `).get(batchId, sinceIso)
    return row ? row.c : 0
  }

  countBatchResumeAttempts(batchId) {
    const rows = this.db.prepare(`
      SELECT detail_json FROM batch_events
      WHERE batch_id=? AND event='auto_resume_attempt'
      ORDER BY id
    `).all(batchId)
    return rows.length
  }

  recordBatchResumeAttempt(batchId, attempt) {
    this.recordBatchEvent(batchId, 'auto_resume_attempt', { attempt })
  }

  recordBatchItemQa(id, itemKey, review) {
    const batch = this.getBatch(id)
    const item = batch?.items.find((candidate) => candidate.itemKey === itemKey)
    if (!item) return null
    if (!TERMINAL_JOB_STATES.includes(item.job.state)) {
      throw Object.assign(new Error('QA requires a terminal batch item job'), {
        statusCode: 409,
        code: 'BATCH_ITEM_NOT_TERMINAL',
      })
    }
    const systemAutoApproval = item.humanReviewStatus === 'approved'
      && item.humanReview?.actor === 'system'
    const hasHumanDecision = item.humanReviewStatus === 'rejected'
      || (item.humanReviewStatus === 'approved' && !systemAutoApproval)
    const autoAccepted = review.qaStatus === 'passed'
      && item.job.state === 'succeeded'
      && !hasHumanDecision
    const humanReviewStatus = hasHumanDecision
      ? item.humanReviewStatus
      : autoAccepted
        ? 'approved'
        : item.job.state === 'succeeded'
          ? 'pending'
          : 'not_applicable'
    const acceptanceStatus = humanReviewStatus === 'approved'
      ? 'accepted'
      : humanReviewStatus === 'rejected' || humanReviewStatus === 'not_applicable'
        ? 'rejected'
        : 'needs_review'
    const humanReview = autoAccepted
      ? {
          actor: 'system',
          decision: 'qa_passed_auto_accepted',
          decidedAt: now(),
          jobId: item.job.id,
          revision: item.revision,
      }
      : systemAutoApproval
        ? null
        : item.humanReview || null
    this.db.prepare(`
      UPDATE batch_items
      SET automation_state='done',qa_status=?,acceptance_status=?,human_review_status=?,failure_class=?,recovery_action=?,review_json=?,human_review_json=?
      WHERE batch_id=? AND item_key=?
    `).run(
      review.qaStatus,
      acceptanceStatus,
      humanReviewStatus,
      review.failureClass?.trim() || null,
      review.recoveryAction?.trim() || null,
      review.detail ? JSON.stringify(review.detail) : null,
      humanReview ? JSON.stringify(humanReview) : null,
      id,
      itemKey,
    )
    this.db.prepare('UPDATE batches SET updated_at=? WHERE id=?').run(now(), id)
    this.recordBatchEvent(id, 'item_qa_recorded', {
      itemKey,
      revision: item.revision,
      jobId: item.job.id,
      qaStatus: review.qaStatus,
      acceptanceStatus,
      humanReviewStatus,
      ...(autoAccepted ? { decision: 'qa_passed_auto_accepted' } : {}),
      failureClass: review.failureClass || null,
      recoveryAction: review.recoveryAction || null,
    })
    return this.getBatch(id)
  }

  reviewBatchItem(id, itemKey, review) {
    const batch = this.getBatch(id)
    const item = batch?.items.find((candidate) => candidate.itemKey === itemKey)
    if (!item) return null
    if (!['accepted', 'rejected'].includes(review.acceptanceStatus)) {
      throw Object.assign(new Error('human review must accept or reject an item'), {
        statusCode: 400,
        code: 'INVALID_HUMAN_REVIEW_STATUS',
      })
    }
    if (item.job.state !== 'succeeded') {
      throw Object.assign(new Error('human review requires a succeeded job'), {
        statusCode: 409,
        code: 'BATCH_ITEM_NOT_ACCEPTABLE',
      })
    }
    this.db.prepare(`
      UPDATE batch_items
      SET acceptance_status=?,human_review_status=?,human_review_json=?
      WHERE batch_id=? AND item_key=?
    `).run(
      review.acceptanceStatus,
      review.acceptanceStatus === 'accepted' ? 'approved' : 'rejected',
      review.detail ? JSON.stringify(review.detail) : JSON.stringify({ actor: 'human' }),
      id,
      itemKey,
    )
    this.db.prepare('UPDATE batches SET updated_at=? WHERE id=?').run(now(), id)
    this.recordBatchEvent(id, 'item_human_reviewed', {
      itemKey,
      revision: item.revision,
      jobId: item.job.id,
      acceptanceStatus: review.acceptanceStatus,
    })
    return this.getBatch(id)
  }

  replaceBatchItemJob(id, itemKey, request, reason) {
    const batch = this.getBatch(id)
    const item = batch?.items.find((candidate) => candidate.itemKey === itemKey)
    if (!item) return null
    if (!['succeeded', 'failed', 'cancelled'].includes(item.job.state)) {
      throw Object.assign(new Error('batch item job must be terminal before replacement'), {
        statusCode: 409,
        code: 'BATCH_ITEM_JOB_ACTIVE',
      })
    }
    const revision = item.revision + 1
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.createOrGetJob(request)
      this.db.prepare(`
        UPDATE batch_items
        SET job_id=?,revision=?,automation_state='idle',qa_status='not_run',acceptance_status='pending',human_review_status='not_ready',
            failure_class=NULL,recovery_action=NULL,review_json=NULL,human_review_json=NULL
        WHERE batch_id=? AND item_key=?
      `).run(result.job.id, revision, id, itemKey)
      this.db.prepare('INSERT INTO batch_item_jobs (batch_id,item_key,revision,job_id,reason,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, itemKey, revision, result.job.id, reason?.trim() || 'replacement', now())
      this.db.prepare("UPDATE batches SET control_state='running',updated_at=? WHERE id=?").run(now(), id)
      this.recordBatchEvent(id, 'item_job_replaced', {
        itemKey,
        revision,
        previousJobId: item.job.id,
        jobId: result.job.id,
        reason: reason?.trim() || 'replacement',
      })
      this.db.exec('COMMIT')
      return this.getBatch(id)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  claimNextBatchAutomationItem() {
    const row = this.db.prepare(`
      SELECT bi.batch_id,bi.item_key
      FROM batch_items bi
      JOIN batches b ON b.id=bi.batch_id
      JOIN jobs j ON j.id=bi.job_id
      WHERE b.control_state='running'
        AND b.automation_json IS NOT NULL
        AND json_extract(b.automation_json,'$.enabled')=1
        AND bi.automation_state='idle'
        AND bi.acceptance_status='pending'
        AND j.state IN ('succeeded','failed','cancelled')
      ORDER BY b.created_at,bi.position
      LIMIT 1
    `).get()
    if (!row) return null
    const changed = this.db.prepare(`
      UPDATE batch_items
      SET automation_state='processing'
      WHERE batch_id=? AND item_key=? AND automation_state='idle'
    `).run(row.batch_id, row.item_key)
    if (!changed.changes) return null
    const batch = this.getBatch(row.batch_id)
    const item = batch?.items.find((candidate) => candidate.itemKey === row.item_key)
    return batch && item ? { batch, item } : null
  }

  resetBatchAutomationItem(id, itemKey) {
    this.db.prepare(`
      UPDATE batch_items
      SET automation_state='idle'
      WHERE batch_id=? AND item_key=? AND automation_state='processing'
    `).run(id, itemKey)
  }

  isCurrentBatchAutomationClaim(id, itemKey, jobId) {
    const row = this.db.prepare(`
      SELECT job_id,automation_state,acceptance_status
      FROM batch_items
      WHERE batch_id=? AND item_key=?
    `).get(id, itemKey)
    return row?.job_id === jobId
      && row.automation_state === 'processing'
      && row.acceptance_status === 'pending'
  }

  getRequest(id) {
    const row = this.db.prepare('SELECT request_json FROM jobs WHERE id=?').get(id)
    return row ? JSON.parse(row.request_json) : null
  }

  claimNextJob() {
    const row = this.db.prepare(`
      SELECT j.id
      FROM jobs j
      LEFT JOIN batch_items bi ON bi.job_id=j.id
      LEFT JOIN batches b ON b.id=bi.batch_id
      WHERE j.state='queued'
        AND j.available_at<=?
        AND (bi.job_id IS NULL OR b.control_state='running')
      ORDER BY j.priority DESC, j.created_at
      LIMIT 1
    `).get(Date.now())
    if (!row) return null
    const changed = this.db.prepare("UPDATE jobs SET state='validating', attempts=attempts+1, route_attempts=route_attempts+1, updated_at=? WHERE id=? AND state='queued'").run(now(), row.id)
    if (!changed.changes) return null
    this.recordEvent(row.id, 'validating', { reason: 'worker_claimed' })
    return this.getJob(row.id)
  }

  transition(id, nextState, options = {}, mutation = {}) {
    const current = this.getJob(id)
    if (!current) throw new Error('job not found')
    assertTransition(current.state, nextState)
    const timestamp = now()
    this.db.prepare(`UPDATE jobs SET state=?, attempts=CASE WHEN ? THEN 0 ELSE attempts END, route_index=COALESCE(?,route_index), route_attempts=CASE WHEN ? THEN 0 ELSE route_attempts END, cancel_requested=CASE WHEN ? THEN 0 ELSE cancel_requested END, source_asset_id=COALESCE(?,source_asset_id), final_asset_id=COALESCE(?,final_asset_id), error_json=?, result_json=COALESCE(?,result_json), available_at=?, updated_at=? WHERE id=?`)
      .run(nextState, mutation.resetAttempts === true ? 1 : 0, mutation.routeIndex ?? null, mutation.resetRouteAttempts === true ? 1 : 0, mutation.clearCancel === true ? 1 : 0, options.sourceAssetId ?? null, options.finalAssetId ?? null, options.error ? JSON.stringify(options.error) : null, options.result ? JSON.stringify(options.result) : null, options.availableAt ?? 0, timestamp, id)
    this.recordEvent(id, nextState, options.detail ?? null)
    const next = this.getJob(id)
    // Skip the batch projection for an intermediate state that is immediately
    // followed by another transition (e.g. the transient `failed` recorded
    // solely to satisfy the state machine before an automatic retry/fallback
    // requeues the job). Running the projection on that phantom `failed` would
    // momentarily mark the batch item as `rejected`, then flip it back on the
    // immediate requeue — a visible lie to SSE listeners and the funnel stats.
    if (options.skipProjection !== true) this.syncBatchItemExecutionProjection(id, next)
    return next
  }

  requestCancel(id) {
    const job = this.getJob(id)
    if (!job) return null
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
    this.db.prepare('UPDATE jobs SET cancel_requested=1, updated_at=? WHERE id=?').run(now(), id)
    if (job.state === 'queued') return this.transition(id, 'cancelled', { detail: { reason: 'cancelled_before_start' } })
    return this.getJob(id)
  }

  retryJob(id) {
    const job = this.getJob(id)
    if (!job) return null
    if (job.state !== 'failed') {
      throw Object.assign(new Error(`job in ${job.state} state cannot be retried`), {
        statusCode: 409,
        code: 'JOB_NOT_RETRYABLE',
      })
    }
    return this.transition(id, 'queued', {
      error: null,
      detail: {
        reason: 'manual_retry',
        previousAttempts: job.attempts,
        previousError: job.error,
      },
      availableAt: 0,
    }, { resetAttempts: true, routeIndex: 0, resetRouteAttempts: true, clearCancel: true })
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

  // P0-3: Asset garbage collection — deletes asset files and rows for jobs
  // whose assets have already been copied to their output directory (harvested).
  // Returns the number of asset files removed.
  pruneHarvestedAssets(batchId = null) {
    let query = `
      SELECT a.id, a.file_path, a.job_id, a.kind FROM assets a
      JOIN jobs j ON j.id = a.job_id
      WHERE j.state = 'succeeded'
    `
    const params = []
    if (batchId) {
      query += ` AND EXISTS (SELECT 1 FROM batch_items bi WHERE bi.job_id = a.job_id AND bi.batch_id = ?)`
      params.push(batchId)
    }
    const candidates = this.db.prepare(query).all(...params)
    let removed = 0
    for (const asset of candidates) {
      // Only prune if the harvest target file actually exists on disk —
      // output_path is set at batch creation, not when the asset is copied.
      // Checking existence prevents deleting the only copy of an asset whose
      // harvest copy hasn't been written yet (e.g. runner crashed mid-harvest).
      const bi = this.db.prepare('SELECT output_path FROM batch_items WHERE job_id=?').get(asset.job_id)
      if (!bi?.output_path) continue
      const harvestFinal = join(bi.output_path, asset.kind === 'source' ? '原图.png' : '4K.png')
      if (!existsSyncSafe(harvestFinal)) continue
      try { unlinkSync(asset.file_path) } catch { /* file already gone */ }
      this.db.prepare('DELETE FROM assets WHERE id=?').run(asset.id)
      removed += 1
    }
    return removed
  }

  // P0-3: Also delete orphaned assets not referenced by any job (e.g. from
  // crash recovery, cancelled jobs, or old revisions). Excludes upload assets
  // (jobId='upload') which are user-uploaded reference images still in active use.
  pruneOrphanedAssets() {
    const orphans = this.db.prepare(`
      SELECT a.id, a.file_path FROM assets a
      LEFT JOIN jobs j ON j.id = a.job_id
      WHERE a.job_id != 'upload'
        AND (j.id IS NULL OR j.state IN ('failed', 'cancelled'))
    `).all()
    let removed = 0
    for (const row of orphans) {
      try { unlinkSync(row.file_path) } catch { /* file already gone */ }
      this.db.prepare('DELETE FROM assets WHERE id=?').run(row.id)
      removed += 1
    }
    return removed
  }

  // P2-14: Aggregate provider health stats from the provider_calls table.
  getProviderHealth(sinceIso = null) {
    const since = sinceIso || new Date(Date.now() - 3600_000).toISOString()
    const rows = this.db.prepare(`
      SELECT
        provider, model,
        COUNT(*) AS total,
        SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed,
        AVG(CASE WHEN completed_at IS NOT NULL AND started_at IS NOT NULL
            THEN (julianday(completed_at) - julianday(started_at)) * 86400000 ELSE NULL END) AS avg_ms,
        MAX(started_at) AS last_call
      FROM provider_calls
      WHERE completed_at >= ?
      GROUP BY provider, model
      ORDER BY total DESC
    `).all(since)
    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      total: r.total,
      succeeded: r.succeeded,
      failed: r.failed,
      successRate: r.total > 0 ? r.succeeded / r.total : null,
      avgLatencyMs: r.avg_ms ? Math.round(r.avg_ms) : null,
      lastCall: r.last_call,
    }))
  }

  // P2-11: Archive a completed batch (soft-delete from active list).
  archiveBatch(id) {
    const batch = this.getBatch(id)
    if (!batch) return null
    this.db.prepare("UPDATE batches SET control_state='archived', updated_at=? WHERE id=?").run(now(), id)
    this.recordBatchEvent(id, 'archived', null)
    return this.getBatch(id)
  }

  // P2-11: Delete a batch and all its items, events, and job history.
  // Assets are NOT deleted here — use pruneHarvestedAssets first.
  deleteBatch(id) {
    const batch = this.getBatch(id)
    if (!batch) return null
    const jobIds = this.db.prepare('SELECT job_id FROM batch_items WHERE batch_id=?').all(id).map((r) => r.job_id)
    this.db.prepare('DELETE FROM batch_item_jobs WHERE batch_id=?').run(id)
    this.db.prepare('DELETE FROM batch_items WHERE batch_id=?').run(id)
    this.db.prepare('DELETE FROM batch_events WHERE batch_id=?').run(id)
    for (const jobId of jobIds) {
      this.db.prepare('DELETE FROM job_events WHERE job_id=?').run(jobId)
      this.db.prepare('DELETE FROM provider_calls WHERE job_id=?').run(jobId)
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(jobId)
    }
    this.db.prepare('DELETE FROM batches WHERE id=?').run(id)
    return { deleted: true, jobsRemoved: jobIds.length }
  }

  getBatchItemByJobId(jobId) {
    return this.db.prepare(
      'SELECT batch_id, item_key, revision, output_path FROM batch_items WHERE job_id=?',
    ).get(jobId) || null
  }

  recordEvent(jobId, state, detail) {
    this.db.prepare('INSERT INTO job_events (job_id,state,detail_json,created_at) VALUES (?,?,?,?)')
      .run(jobId, state, detail ? JSON.stringify(detail) : null, now())
    this.notifyChange({ kind: 'job', id: jobId, state })
  }

  events(jobId) {
    return this.db.prepare('SELECT state,detail_json,created_at FROM job_events WHERE job_id=? ORDER BY id').all(jobId)
      .map((row) => ({ state: row.state, detail: row.detail_json ? JSON.parse(row.detail_json) : null, createdAt: row.created_at }))
  }

  recordBatchEvent(batchId, event, detail) {
    this.db.prepare('INSERT INTO batch_events (batch_id,event,detail_json,created_at) VALUES (?,?,?,?)')
      .run(batchId, event, detail ? JSON.stringify(detail) : null, now())
    this.notifyChange({ kind: 'batch', id: batchId, event })
  }

  batchEvents(batchId) {
    return this.db.prepare('SELECT event,detail_json,created_at FROM batch_events WHERE batch_id=? ORDER BY id').all(batchId)
      .map((row) => ({ event: row.event, detail: row.detail_json ? JSON.parse(row.detail_json) : null, createdAt: row.created_at }))
  }

  onChange(listener) {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  notifyChange(change) {
    for (const listener of this.changeListeners) listener(change)
  }

  close() {
    this.changeListeners.clear()
    this.db.close()
  }
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
  if (request.generation?.testBehavior === 'content-policy') {
    throw Object.assign(new Error('mock content policy rejection'), {
      retryable: false,
      failureClass: 'content_policy',
      recoveryAction: 'safe_rewrite',
    })
  }
  if (request.generation?.testBehavior === 'fail') throw Object.assign(new Error('mock provider failure'), { retryable: true })
  if (request.generation?.testBehavior === 'fail-once' && attempt === 1) throw Object.assign(new Error('mock provider transient failure'), { retryable: true })
  const baseSize = request.generation?.baseSize || calculateImageSize('2K', request.composition.ratio)
  const dimensions = parseImageSize(baseSize)
  if (!dimensions) throw new Error('mock provider could not resolve base size')
  const svg = Buffer.from(`<svg width="${dimensions.width}" height="${dimensions.height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f4f4f0"/><rect x="5%" y="5%" width="90%" height="90%" fill="#1778f2"/><circle cx="50%" cy="50%" r="20%" fill="#ffffff"/></svg>`)
  return { buffer: await sharp(svg).png().toBuffer(), usage: { source: 'mock', images: 1 } }
}

async function compatibleGenerate(request, providerConfig, signal) {
  if (!providerConfig.baseUrl || !providerConfig.apiKey) throw Object.assign(new Error('real provider configuration is unavailable'), {
    code: 'PROVIDER_UNAVAILABLE',
    retryable: false,
    fallbackEligible: true,
  })
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
  const payload = await decodeProviderJsonResponse(response, signal)
  const entry = payload?.data?.[0]
  if (entry?.b64_json) return { buffer: Buffer.from(entry.b64_json, 'base64'), usage: payload.usage ?? null }
  if (entry?.url) {
    const imageResponse = await providerFetch(entry.url, { signal }, 'asset-download')
    if (!imageResponse.ok) throw Object.assign(new Error(`provider asset returned HTTP ${imageResponse.status}`), { retryable: true })
    try {
      return { buffer: Buffer.from(await imageResponse.arrayBuffer()), usage: payload.usage ?? null }
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
  if (!providerConfig.baseUrl || !providerConfig.apiKey) throw Object.assign(new Error('real provider configuration is unavailable'), {
    code: 'PROVIDER_UNAVAILABLE',
    retryable: false,
    fallbackEligible: true,
  })
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

  const payload = await decodeProviderJsonResponse(response, signal)
  const entry = payload?.data?.[0]
  if (entry?.b64_json) return { buffer: Buffer.from(entry.b64_json, 'base64'), usage: payload.usage ?? null }
  if (entry?.url) {
    const imageResponse = await providerFetch(entry.url, { signal }, 'asset-download')
    if (!imageResponse.ok) throw Object.assign(new Error(`provider asset returned HTTP ${imageResponse.status}`), { retryable: true })
    try {
      return { buffer: Buffer.from(await imageResponse.arrayBuffer()), usage: payload.usage ?? null }
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
  if (!providerConfig.baseUrl || !providerConfig.apiKey) throw Object.assign(new Error('real provider configuration is unavailable'), {
    code: 'PROVIDER_UNAVAILABLE',
    retryable: false,
    fallbackEligible: true,
  })
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
  const payload = await decodeProviderJsonResponse(response, signal)
  const output = Array.isArray(payload?.output) ? payload.output : []
  // Find a completed image_generation_call and decode its bytes.
  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue
    if (item.status === 'failed') continue
    const b64 = responsesImageResultBase64(item.result)
    if (b64) return { buffer: Buffer.from(b64, 'base64'), usage: payload.usage ?? null }
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
    let providerCallId = null
    let providerCallFinished = false
    try {
      const request = this.repository.getRequest(jobId)
      const validation = validateImageJobRequest(request)
      if (!validation.valid) throw Object.assign(new Error(validation.errors.join('; ')), { retryable: false })
      if (this.repository.shouldCancel(jobId)) return void this.repository.transition(jobId, 'cancelled')
      const claimedJob = this.repository.getJob(jobId)
      const effectiveRequest = requestForRoute(request, claimedJob.routeIndex)
      const isEditMode = effectiveRequest.input.sourceAssetId && effectiveRequest.input.prompt

      this.repository.transition(jobId, 'generating')
      stage = 'generating'
      let sourceManifest
      if (isEditMode) {
        // Image-to-image (edit): read the uploaded reference image, send it to
        // the provider's edit endpoint with the prompt, and use the returned
        // NEW image as the source canvas.
        const existing = this.repository.getAsset(effectiveRequest.input.sourceAssetId)
        if (!existing) throw Object.assign(new Error('source asset not found'), { retryable: false })
        const referenceBuffer = await readFile(existing.filePath)
        const controller = new AbortController()
        this.controllers.set(jobId, controller)
        const timeout = setTimeout(() => controller.abort(new Error('provider timeout')), this.providerTimeoutMs)
        let sourceBuffer
        let sourceTransform = null
        try {
          const apiMode = effectiveRequest.generation.apiMode || 'images'
          providerCallId = this.repository.startProviderCall(claimedJob)
          const providerResult = effectiveRequest.generation.provider === 'mock'
            ? await mockGenerate(effectiveRequest, controller.signal, this.repository.getJob(jobId).routeAttempts)
            : apiMode === 'responses'
              ? await responsesGenerate(effectiveRequest, this.providerConfig, controller.signal, referenceBuffer)
              : await compatibleEdit(effectiveRequest, this.providerConfig, referenceBuffer, controller.signal)
          this.repository.finishProviderCall(providerCallId, { state: 'succeeded', usage: providerResult.usage })
          providerCallFinished = true
          const normalized = await normalizeSourceCanvas(effectiveRequest, providerResult.buffer)
          sourceBuffer = normalized.buffer
          sourceTransform = normalized.transform
        } finally {
          clearTimeout(timeout)
          this.controllers.delete(jobId)
        }
        sourceManifest = await this.createStoredAsset(jobId, 'source', sourceBuffer, existing.manifest.assetId, sourceTransform)
      } else if (effectiveRequest.input.sourceAssetId) {
        // Source-only (no prompt): use the uploaded asset directly as the source
        // canvas, normalizing ratio locally. No provider call. Backward compatible.
        const existing = this.repository.getAsset(effectiveRequest.input.sourceAssetId)
        if (!existing) throw Object.assign(new Error('source asset not found'), { retryable: false })
        const rawBuffer = await readFile(existing.filePath)
        const normalized = await normalizeSourceCanvas(effectiveRequest, rawBuffer)
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
          const apiMode = effectiveRequest.generation.apiMode || 'images'
          providerCallId = this.repository.startProviderCall(claimedJob)
          const providerResult = effectiveRequest.generation.provider === 'mock'
            ? await mockGenerate(effectiveRequest, controller.signal, this.repository.getJob(jobId).routeAttempts)
            : apiMode === 'responses'
              ? await responsesGenerate(effectiveRequest, this.providerConfig, controller.signal)
              : await compatibleGenerate(effectiveRequest, this.providerConfig, controller.signal)
          this.repository.finishProviderCall(providerCallId, { state: 'succeeded', usage: providerResult.usage })
          providerCallFinished = true
          const normalized = await normalizeSourceCanvas(effectiveRequest, providerResult.buffer)
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
        result: {
          sourceAssetId: sourceManifest.assetId,
          finalAssetId: finalManifest.assetId,
          manifestVersion: '1',
          actualRoute: this.repository.getJob(jobId).actualRoute,
        },
      })
      // A successful non-automation item is technically ready, not human
      // accepted. Preserve the asset evidence and send it to human review.
      // This also keeps output files available after watchdog recovery.
      const batchItem = this.repository.getBatchItemByJobId(jobId)
      if (batchItem) {
        const batch = this.repository.getBatch(batchItem.batch_id)
        if (batch && !batch.automation.enabled) {
          const succeededJob = this.repository.getJob(jobId)
          const sourceAsset = succeededJob.sourceAssetId ? this.repository.getAsset(succeededJob.sourceAssetId) : null
          const finalAsset = succeededJob.finalAssetId ? this.repository.getAsset(succeededJob.finalAssetId) : null
          // If the item declares an output directory, copy both PNGs there so
          // the user-facing files are immediately available on disk without
          // needing the runner to harvest them.
          let harvestedFiles = null
          const outputPath = batchItem.output_path || null
          if (outputPath && sourceAsset?.filePath && finalAsset?.filePath) {
            try {
              await mkdir(outputPath, { recursive: true })
              const sourceDest = join(outputPath, '\u539f\u56fe.png')
              const finalDest = join(outputPath, '4K.png')
              await copyFile(sourceAsset.filePath, sourceDest)
              await copyFile(finalAsset.filePath, finalDest)
              harvestedFiles = { sourcePath: sourceDest, finalPath: finalDest }
            } catch {
              /* output directory copy failure is non-fatal; assets remain in engine store */
            }
          }
          this.repository.recordBatchItemTechnicalReady(batchItem.batch_id, batchItem.item_key, {
            jobId,
            revision: batchItem.revision ?? 0,
            sourceAssetId: succeededJob.sourceAssetId || null,
            sourceAssetPath: sourceAsset?.filePath || null,
            finalAssetId: succeededJob.finalAssetId || null,
            finalAssetPath: finalAsset?.filePath || null,
            ...(harvestedFiles ? { harvestedFiles } : {}),
          })
        }
      }
    } catch (error) {
      const current = this.repository.getJob(jobId)
      if (!current || ['cancelled', 'succeeded'].includes(current.state)) return
      if (!ACTIVE_STATES.includes(current.state)) return
      if (current.cancelRequested) return void this.repository.transition(jobId, 'cancelled')
      const retryable = error?.retryable !== false && current.routeAttempts < current.maxAttempts
      const canFallback = current.routeIndex === 0
        && Boolean(current.request.generation?.fallback)
        && fallbackEligible(error, stage)
      const detail = {
        code: error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : error?.code || 'JOB_FAILED',
        message: error instanceof Error ? error.message : String(error),
        stage,
        retryable,
        fallbackEligible: canFallback,
        route: current.actualRoute,
        routeAttempt: current.routeAttempts,
        totalAttempt: current.attempts,
        ...classifyFailure(error, stage),
      }
      if (error?.providerCode) detail.providerCode = error.providerCode
      if (error?.httpStatus) detail.httpStatus = error.httpStatus
      if (error?.diagnostics) detail.diagnostics = error.diagnostics
      if (providerCallId && !providerCallFinished) {
        this.repository.finishProviderCall(providerCallId, {
          state: 'failed',
          error: detail,
          httpStatus: error?.httpStatus,
        })
        providerCallFinished = true
      }
      // Record the failure as an event + error_json (it is a real observation
      // of a failed attempt), but mark it transient via skipProjection so the
      // batch item is NOT momentarily marked `rejected` before the immediate
      // requeue below flips it back. The subsequent `queued` transition carries
      // the authoritative retry/fallback reason and runs the projection on the
      // real, durable next state.
      const transient = retryable || canFallback
      this.repository.transition(jobId, 'failed', { error: detail, detail, skipProjection: transient })
      if (retryable) {
        const delay = Math.min(this.providerRetryBaseMs * (2 ** (current.routeAttempts - 1)), this.providerRetryBaseMs * 4)
        this.repository.transition(jobId, 'queued', {
          availableAt: Date.now() + delay,
          detail: { reason: 'automatic_retry', delay, route: current.actualRoute, transientFailure: detail },
        })
      } else if (canFallback) {
        const fallbackRoute = routeFromRequest(current.request, 1)
        this.repository.transition(jobId, 'queued', {
          availableAt: 0,
          detail: {
            reason: 'route_fallback',
            from: current.actualRoute,
            to: fallbackRoute,
            previousError: detail,
          },
        }, { routeIndex: 1, resetRouteAttempts: true })
      }
    }
  }
}

function batchRevisionRequest(batch, item, prompt, reason) {
  const current = item.job.request
  const route = batch.automation.revisionRoute
  const originalRoute = routeFromRequest(current, 0)
  const generation = { ...current.generation }
  delete generation.testBehavior
  return {
    ...current,
    idempotencyKey: `batch-revision-${sha256(`${batch.id}\0${item.itemKey}\0${item.revision + 1}\0${reason}\0${prompt}`).slice(0, 48)}`,
    input: { ...current.input, prompt },
    generation: {
      ...generation,
      provider: route.provider,
      model: route.model,
      apiMode: route.apiMode,
      fallback: originalRoute,
    },
  }
}

export class TaskBatchAutomationPool {
  constructor(options) {
    this.repository = options.repository
    this.evaluator = options.evaluator
    this.pollIntervalMs = options.pollIntervalMs ?? 50
    this.concurrency = Math.max(1, Math.min(4, options.concurrency ?? 1))
    this.running = false
    this.loops = []
  }

  start() {
    if (this.running) return
    this.running = true
    this.loops = Array.from({ length: this.concurrency }, () => this.loop())
  }

  async stop() {
    this.running = false
    await Promise.allSettled(this.loops)
  }

  async loop() {
    while (this.running) {
      const candidate = this.repository.claimNextBatchAutomationItem()
      if (!candidate) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, this.pollIntervalMs))
        continue
      }
      await this.process(candidate)
    }
  }

  async process({ batch, item }) {
    const route = batch.automation.revisionRoute
    const maxRevisions = batch.automation.maxRevisions ?? 2
    const autoRevise = batch.automation.autoRevise === true
    const originalPrompt = item.jobHistory[0]?.job.request.input.prompt || item.job.request.input.prompt
    try {
      if (item.job.state === 'cancelled') {
        this.repository.recordBatchItemQa(batch.id, item.itemKey, {
          qaStatus: 'not_run',
          failureClass: 'cancelled',
          recoveryAction: 'manual_restart',
          detail: { jobId: item.job.id, revision: item.revision, automated: true },
        })
        return
      }

      if (item.job.state === 'failed') {
        const contentPolicy = item.job.error?.failureClass === 'content_policy'
          || item.job.error?.recoveryAction === 'safe_rewrite'
        if (contentPolicy && autoRevise && item.revision < maxRevisions) {
          const rewrite = await this.evaluator.rewrite({
            prompt: originalPrompt,
            error: item.job.error,
            route,
          })
          if (!this.repository.isCurrentBatchAutomationClaim(batch.id, item.itemKey, item.job.id)) return
          this.repository.replaceBatchItemJob(
            batch.id,
            item.itemKey,
            batchRevisionRequest(batch, item, rewrite.prompt, 'safe_rewrite'),
            'safe_rewrite',
          )
          return
        }
        this.repository.recordBatchItemQa(batch.id, item.itemKey, {
          qaStatus: 'not_run',
          failureClass: item.job.error?.failureClass || 'generation_failed',
          recoveryAction: contentPolicy ? 'manual_policy_review' : (item.job.error?.recoveryAction || 'inspect_failure'),
          detail: {
            jobId: item.job.id,
            revision: item.revision,
            automated: true,
            recoveryExhausted: contentPolicy && item.revision >= maxRevisions,
          },
        })
        return
      }

      const finalAsset = this.repository.getAsset(item.job.finalAssetId)
      if (!finalAsset) throw Object.assign(new Error('final asset is unavailable for visual QA'), {
        code: 'BATCH_AUTOMATION_ASSET_MISSING',
      })
      const imageBuffer = await readFile(finalAsset.filePath)
      const qa = await this.evaluator.qa({
        prompt: originalPrompt,
        imageBuffer,
        route,
        job: item.job,
      })
      if (!this.repository.isCurrentBatchAutomationClaim(batch.id, item.itemKey, item.job.id)) return
      if (qa.pass) {
        this.repository.recordBatchItemQa(batch.id, item.itemKey, {
          qaStatus: 'passed',
          detail: {
            jobId: item.job.id,
            revision: item.revision,
            automated: true,
            qa,
            finalManifest: finalAsset.manifest,
          },
        })
        return
      }

      const classification = classifyQaVerdict(qa)
      if (autoRevise && item.revision < maxRevisions) {
        this.repository.recordBatchEvent(batch.id, 'qa_auto_revision_requested', {
          itemKey: item.itemKey,
          revision: item.revision,
          jobId: item.job.id,
          qa,
          ...classification,
        })
        this.repository.replaceBatchItemJob(
          batch.id,
          item.itemKey,
          batchRevisionRequest(
            batch,
            item,
            buildQaRevisionPrompt(originalPrompt, qa),
            classification.recoveryAction,
          ),
          classification.recoveryAction,
        )
        return
      }
      this.repository.recordBatchItemQa(batch.id, item.itemKey, {
        qaStatus: 'needs_review',
        ...classification,
        detail: {
          jobId: item.job.id,
          revision: item.revision,
          automated: true,
          recoveryExhausted: true,
          qa,
        },
      })
    } catch (error) {
      if (!this.repository.isCurrentBatchAutomationClaim(batch.id, item.itemKey, item.job.id)) return
      try {
        this.repository.recordBatchItemQa(batch.id, item.itemKey, {
          qaStatus: 'needs_review',
          failureClass: error?.httpStatus >= 500 ? 'provider_transient' : 'qa_unavailable',
          recoveryAction: error?.httpStatus >= 500 ? 'health_probe' : 'manual_review',
          detail: {
            jobId: item.job.id,
            revision: item.revision,
            automated: true,
            code: error?.code || 'BATCH_AUTOMATION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      } catch {
        this.repository.resetBatchAutomationItem(batch.id, item.itemKey)
      }
    }
  }
}

export class BatchResumeWatchdog {
  constructor(options) {
    this.repository = options.repository
    this.enabled = options.enabled ?? true
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000
    this.cooldownMs = options.cooldownMs ?? 120_000
    this.maxAttempts = options.maxAttempts ?? 5
    this.running = false
    this.loops = []
    this.wakePoll = null
  }

  start() {
    if (this.running || !this.enabled) return
    this.running = true
    this.loops = [this.loop()]
  }

  async stop() {
    this.running = false
    this.wakePoll?.()
    await Promise.allSettled(this.loops)
  }

  async waitForNextScan() {
    await new Promise((resolvePromise) => {
      const timeout = setTimeout(() => {
        this.wakePoll = null
        resolvePromise()
      }, this.pollIntervalMs)
      this.wakePoll = () => {
        clearTimeout(timeout)
        this.wakePoll = null
        resolvePromise()
      }
    })
  }

  async loop() {
    while (this.running) {
      try {
        await this.scan()
      } catch { /* swallow; next tick retries */ }
      if (!this.running) break
      await this.waitForNextScan()
    }
  }

  async scan() {
    const pausedIds = this.repository.listPausedBatchIds()
    if (!pausedIds.length) return
    const sinceIso = new Date(Date.now() - this.cooldownMs).toISOString()
    for (const id of pausedIds) {
      const attempts = this.repository.countBatchResumeAttempts(id)
      if (attempts >= this.maxAttempts) continue
      const failures = this.repository.recentProviderFailures(id, sinceIso)
      if (failures > 0) continue
      this.repository.recordBatchResumeAttempt(id, attempts + 1)
      const before = this.repository.getBatch(id)
      const failedCount = before?.stats?.failed ?? 0
      if (failedCount > 0) {
        this.repository.retryFailedBatchJobs(id)
      } else {
        this.repository.setBatchControlState(id, 'running')
      }
      this.repository.recordBatchEvent(id, 'auto_resumed', { attempt: attempts + 1, failedRetried: failedCount })
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
    pollIntervalMs: options.pollIntervalMs,
    providerConfig: options.providerConfig,
    providerTimeoutMs: options.providerTimeoutMs,
    providerRetryBaseMs: options.providerRetryBaseMs,
  })
  const batchAutomationPool = new TaskBatchAutomationPool({
    repository,
    evaluator: options.batchAutomationEvaluator || createProviderBatchAutomationEvaluator({
      providerConfig: options.providerConfig,
      timeoutMs: options.batchAutomationTimeoutMs,
    }),
    concurrency: options.batchAutomationConcurrency,
    pollIntervalMs: options.pollIntervalMs,
  })
  const batchWatchdog = new BatchResumeWatchdog({
    repository,
    enabled: options.batchWatchdogEnabled ?? true,
    pollIntervalMs: options.batchWatchdogPollIntervalMs ?? options.pollIntervalMs ?? 60_000,
    cooldownMs: options.batchWatchdogCooldownMs ?? 120_000,
    maxAttempts: options.batchWatchdogMaxAttempts ?? 5,
  })
  const matchAllowedOrigin = createOriginMatcher(options.allowedOrigins)

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin
    const cors = matchAllowedOrigin(origin)
    if (cors) {
      response.setHeader('access-control-allow-origin', cors)
      response.setHeader('vary', 'Origin')
      response.setHeader('access-control-allow-headers', 'authorization,content-type,x-file-name')
      response.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS')
    }
    if (request.method === 'OPTIONS') return void response.writeHead(204).end()
    if (!safeEqual(request.headers.authorization, `Bearer ${token}`)) return void json(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } })
    const url = new URL(request.url || '/', 'http://localhost')
    try {
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        response.write('event: ready\ndata: {}\n\n')
        const unsubscribe = repository.onChange((change) => {
          if (!response.destroyed) response.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`)
        })
        const heartbeat = setInterval(() => {
          if (!response.destroyed) response.write(': heartbeat\n\n')
        }, 15_000)
        request.once('close', () => {
          clearInterval(heartbeat)
          unsubscribe()
        })
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
        return void json(response, 200, taskApiCapabilities(options.providerConfig))
      }
      if (request.method === 'GET' && url.pathname === '/v1/image-jobs') {
        const state = url.searchParams.get('state')
        if (state && !JOB_STATES.includes(state)) {
          throw Object.assign(new Error(`state must be one of ${JOB_STATES.join(', ')}`), { statusCode: 400, code: 'INVALID_STATE' })
        }
        const result = repository.listJobs({
          limit: parseJobListLimit(url.searchParams.get('limit')),
          cursor: parseJobCursor(url.searchParams.get('cursor')),
          state,
        })
        return void json(response, 200, result)
      }
      if (request.method === 'POST' && url.pathname === '/v1/assets/uploads') {
        if (request.headers['content-type']?.split(';')[0] !== 'image/png') return void json(response, 415, { error: { code: 'PNG_REQUIRED', message: 'v1 uploads accept image/png' } })
        const buffer = await readBody(request, UPLOAD_MAX_BYTES)
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
      if (request.method === 'POST' && url.pathname === '/v1/image-batches') {
        const body = JSON.parse((await readBody(request, 5 * 1024 * 1024)).toString('utf8'))
        const expanded = expandBatchRequest(body)
        const validation = validateBatchRequest(expanded)
        if (!validation.valid) return void json(response, 400, { error: { code: 'INVALID_BATCH', details: validation.errors } })
        const result = repository.createOrGetBatch(expanded)
        return void json(response, result.created ? 201 : 200, result.batch, { 'idempotency-replayed': result.created ? 'false' : 'true' })
      }
      if (request.method === 'GET' && url.pathname === '/v1/image-batches') {
        const limit = parseJobListLimit(url.searchParams.get('limit'))
        return void json(response, 200, { items: repository.listBatches(limit) })
      }
      const batchSummaryMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/summary$/)
      if (request.method === 'GET' && batchSummaryMatch) {
        const batch = repository.getBatchSummary(batchSummaryMatch[1])
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchItemsMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/items$/)
      if (request.method === 'GET' && batchItemsMatch) {
        const batch = repository.getBatchSummary(batchItemsMatch[1])
        if (!batch) return void json(response, 404, { error: { code: 'NOT_FOUND' } })
        return void json(response, 200, repository.getBatchItemPage(batchItemsMatch[1], {
          limit: parseJobListLimit(url.searchParams.get('limit')),
          position: parsePageCursor(url.searchParams.get('cursor'), 'batch item'),
        }))
      }
      const batchEventsMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/events$/)
      if (request.method === 'GET' && batchEventsMatch) {
        const batch = repository.getBatchSummary(batchEventsMatch[1])
        if (!batch) return void json(response, 404, { error: { code: 'NOT_FOUND' } })
        return void json(response, 200, repository.getBatchEventPage(batchEventsMatch[1], {
          limit: parseJobListLimit(url.searchParams.get('limit')),
          beforeId: parsePageCursor(url.searchParams.get('cursor'), 'batch event'),
        }))
      }
      const batchByLogicalKeyMatch = url.pathname.match(/^\/v1\/image-batches\/by-logical-key\/([^/]+)$/)
      if (request.method === 'GET' && batchByLogicalKeyMatch) {
        const batch = repository.getBatchByLogicalKey(decodeURIComponent(batchByLogicalKeyMatch[1]))
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)$/)
      if (request.method === 'GET' && batchMatch) {
        const batch = repository.getBatch(batchMatch[1])
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchRunnerMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/runner\/(acquire|heartbeat|release)$/)
      if (request.method === 'POST' && batchRunnerMatch) {
        const action = batchRunnerMatch[2]
        const body = JSON.parse((await readBody(request, 4096)).toString('utf8'))
        const validation = validateRunnerLeaseRequest(body, action !== 'release')
        if (!validation.valid) return void json(response, 400, { error: { code: 'INVALID_RUNNER_LEASE', details: validation.errors } })
        const batchId = batchRunnerMatch[1]
        const owner = body.owner.trim()
        const batch = action === 'acquire'
          ? repository.acquireBatchRunner(batchId, owner, body.leaseMs)
          : action === 'heartbeat'
            ? repository.heartbeatBatchRunner(batchId, owner, body.leaseMs)
            : repository.releaseBatchRunner(batchId, owner)
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchLogicalKeyMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/logical-key$/)
      if (request.method === 'POST' && batchLogicalKeyMatch) {
        const body = JSON.parse((await readBody(request, 4096)).toString('utf8'))
        const validation = validateLogicalKeyRequest(body)
        if (!validation.valid) return void json(response, 400, { error: { code: 'INVALID_LOGICAL_KEY', details: validation.errors } })
        const batch = repository.adoptBatchLogicalKey(batchLogicalKeyMatch[1], body.logicalKey.trim())
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchControlMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/(pause|resume)$/)
      if (request.method === 'POST' && batchControlMatch) {
        const isPause = batchControlMatch[2] === 'pause'
        let reason = null
        if (isPause) {
          try {
            const body = JSON.parse((await readBody(request, 4096)).toString('utf8'))
            reason = body?.reason || null
          } catch { /* no body or not JSON; reason stays null → treated as manual pause */ }
        }
        const batch = repository.setBatchControlState(batchControlMatch[1], isPause ? 'paused' : 'running', reason || undefined)
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchRetryMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/(retry-failed|retry-cancelled)$/)
      if (request.method === 'POST' && batchRetryMatch) {
        const batch = batchRetryMatch[2] === 'retry-failed'
          ? repository.retryFailedBatchJobs(batchRetryMatch[1])
          : repository.retryCancelledBatchJobs(batchRetryMatch[1])
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchItemQaMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/items\/([^/]+)\/qa$/)
      if (request.method === 'POST' && batchItemQaMatch) {
        const body = JSON.parse((await readBody(request, 1024 * 1024)).toString('utf8'))
        const validation = validateBatchItemQa(body)
        if (!validation.valid) return void json(response, 400, { error: { code: 'INVALID_BATCH_ITEM_QA', details: validation.errors } })
        const batch = repository.recordBatchItemQa(
          batchItemQaMatch[1],
          decodeURIComponent(batchItemQaMatch[2]),
          body,
        )
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchItemReviewMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/items\/([^/]+)\/review$/)
      if (request.method === 'POST' && batchItemReviewMatch) {
        const body = JSON.parse((await readBody(request, 1024 * 1024)).toString('utf8'))
        const validation = validateBatchItemReview(body)
        if (!validation.valid) return void json(response, 400, { error: { code: 'INVALID_BATCH_ITEM_REVIEW', details: validation.errors } })
        const batch = repository.reviewBatchItem(
          batchItemReviewMatch[1],
          decodeURIComponent(batchItemReviewMatch[2]),
          body,
        )
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchItemJobMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/items\/([^/]+)\/job$/)
      if (request.method === 'POST' && batchItemJobMatch) {
        const body = JSON.parse((await readBody(request, 1024 * 1024)).toString('utf8'))
        const validation = validateImageJobRequest(body.request)
        if (!validation.valid) return void json(response, 400, { error: { code: 'INVALID_JOB', details: validation.errors } })
        if (body.reason !== undefined && (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 200)) {
          return void json(response, 400, { error: { code: 'INVALID_REPLACEMENT_REASON', message: 'reason must be a non-empty string up to 200 characters' } })
        }
        const batch = repository.replaceBatchItemJob(
          batchItemJobMatch[1],
          decodeURIComponent(batchItemJobMatch[2]),
          body.request,
          body.reason,
        )
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      // P2-11: Batch archive/delete endpoints
      const batchArchiveMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)\/archive$/)
      if (request.method === 'POST' && batchArchiveMatch) {
        const batch = repository.archiveBatch(batchArchiveMatch[1])
        return void (batch ? json(response, 200, batch) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const batchDeleteMatch = url.pathname.match(/^\/v1\/image-batches\/([^/]+)$/)
      if (request.method === 'DELETE' && batchDeleteMatch) {
        const result = repository.deleteBatch(batchDeleteMatch[1])
        return void (result ? json(response, 200, result) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      // P0-3: Asset GC endpoint
      if (request.method === 'POST' && url.pathname === '/v1/assets/prune') {
        const body = JSON.parse((await readBody(request, 4096)).toString('utf8').trim() || '{}')
        const harvested = repository.pruneHarvestedAssets(body.batchId || null)
        const orphaned = body.includeOrphans ? repository.pruneOrphanedAssets() : 0
        return void json(response, 200, { prunedHarvested: harvested, prunedOrphaned: orphaned })
      }
      // P2-14: Provider health monitoring
      if (request.method === 'GET' && url.pathname === '/v1/provider-health') {
        return void json(response, 200, { providers: repository.getProviderHealth() })
      }
      const jobMatch = url.pathname.match(/^\/v1\/image-jobs\/([^/]+)$/)
      if (request.method === 'GET' && jobMatch) {
        const job = repository.getJob(jobMatch[1], { includeAccounting: true })
        return void (job ? json(response, 200, { ...job, events: repository.events(job.id) }) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const cancelMatch = url.pathname.match(/^\/v1\/image-jobs\/([^/]+)\/cancel$/)
      if (request.method === 'POST' && cancelMatch) {
        const job = repository.requestCancel(cancelMatch[1])
        if (job) workerPool.cancel(job.id)
        return void (job ? json(response, 200, job) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
      }
      const retryMatch = url.pathname.match(/^\/v1\/image-jobs\/([^/]+)\/retry$/)
      if (request.method === 'POST' && retryMatch) {
        const job = repository.retryJob(retryMatch[1])
        return void (job ? json(response, 200, { ...job, events: repository.events(job.id) }) : json(response, 404, { error: { code: 'NOT_FOUND' } }))
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
      const thumbnailMatch = url.pathname.match(/^\/v1\/assets\/([^/]+)\/thumbnail$/)
      if (request.method === 'GET' && thumbnailMatch) {
        const asset = repository.getAsset(thumbnailMatch[1])
        if (!asset) return void json(response, 404, { error: { code: 'NOT_FOUND' } })
        const requestedWidth = Number(url.searchParams.get('width') || 320)
        const width = Number.isInteger(requestedWidth) ? Math.max(96, Math.min(requestedWidth, 768)) : 320
        const buffer = await sharp(asset.filePath)
          .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 76 })
          .toBuffer()
        response.writeHead(200, {
          'content-type': 'image/webp',
          'content-length': buffer.length,
          'cache-control': 'private, max-age=300',
        })
        return void response.end(buffer)
      }
      json(response, 404, { error: { code: 'NOT_FOUND' } })
    } catch (error) {
      const statusCode = error?.statusCode || (error instanceof SyntaxError ? 400 : 500)
      const code = error?.code || (statusCode === 409 ? 'IDEMPOTENCY_CONFLICT' : statusCode === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR')
      json(response, statusCode, { error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  })

  let closed = false
  return {
    token,
    recoveredJobs,
    repository,
    workerPool,
    batchAutomationPool,
    batchWatchdog,
    async listen(port = 0, host = '127.0.0.1') {
      await new Promise((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolvePromise)
      })
      workerPool.start()
      batchAutomationPool.start()
      batchWatchdog.start()
      const address = server.address()
      return { host, port: address.port, url: `http://${host}:${address.port}` }
    },
    async close() {
      if (closed) return
      closed = true
      await batchWatchdog.stop()
      await batchAutomationPool.stop()
      await workerPool.stop()
      if (server.listening) {
        const closing = new Promise((resolvePromise) => server.close(resolvePromise))
        server.closeAllConnections?.()
        await closing
      }
      repository.close()
      await releaseStateLock()
    },
    async destroy() {
      await this.close()
      await rm(stateDir, { recursive: true, force: true })
    },
  }
}
