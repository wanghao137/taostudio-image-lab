import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskApi, TaskRepository } from './service.mjs'

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

async function waitBatch(url, id, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/v1/image-batches/${id}`, { headers: headers() })
    const batch = await response.json()
    if (batch.state === 'completed') return batch
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
  throw new Error(`batch ${id} did not finish`)
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

describe('local Image Task API', { testTimeout: 30_000 }, () => {
  it('migrates legacy jobs with route tracking defaults', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'taostudio-task-api-migration-'))
    const databasePath = join(stateDir, 'jobs.sqlite')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE jobs (
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
      )
    `)
    const payload = request({ idempotencyKey: 'legacy-route-migration-001' })
    legacy.prepare('INSERT INTO jobs (id,idempotency_key,request_hash,request_json,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run('job_legacy', payload.idempotencyKey, 'legacy-hash', JSON.stringify(payload), 'queued', new Date().toISOString(), new Date().toISOString())
    legacy.close()

    const repository = new TaskRepository(databasePath)
    expect(repository.getJob('job_legacy')).toMatchObject({
      attempts: 0,
      routeIndex: 0,
      routeAttempts: 0,
      actualRoute: { provider: 'mock', model: 'mock-v1', apiMode: 'images' },
    })
    repository.db.prepare(`
      INSERT INTO provider_calls (job_id,attempt,route_index,provider,model,api_mode,state,started_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run('job_legacy', 1, 0, 'mock', 'mock-v1', 'images', 'started', new Date().toISOString())
    repository.recoverInterruptedJobs()
    expect(repository.db.prepare('SELECT state,error_json FROM provider_calls WHERE job_id=?').get('job_legacy')).toMatchObject({
      state: 'interrupted',
    })
    repository.close()
    await rm(stateDir, { recursive: true, force: true })
  })

  it('recovers interrupted batch automation claims after a service restart', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'taostudio-task-api-automation-restart-'))
    const databasePath = join(stateDir, 'jobs.sqlite')
    const firstRepository = new TaskRepository(databasePath)
    const created = firstRepository.createOrGetBatch({
      idempotencyKey: 'batch-automation-restart-001',
      automation: {
        enabled: true,
        maxRevisions: 2,
        revisionRoute: { provider: 'mock', model: 'mock-qa', apiMode: 'responses' },
      },
      items: [{
        itemKey: 'restart-item',
        request: request({ idempotencyKey: 'batch-automation-restart-job-001' }),
      }],
    }).batch
    firstRepository.db.prepare("UPDATE jobs SET state='failed' WHERE id=?").run(created.items[0].job.id)
    firstRepository.db.prepare("UPDATE batch_items SET automation_state='processing' WHERE batch_id=? AND item_key=?")
      .run(created.id, 'restart-item')
    firstRepository.close()

    const recoveredRepository = new TaskRepository(databasePath)
    const recovered = recoveredRepository.claimNextBatchAutomationItem()
    expect(recovered).toMatchObject({
      batch: { id: created.id },
      item: {
        itemKey: 'restart-item',
        automationState: 'processing',
        acceptanceStatus: 'pending',
        job: { state: 'failed' },
      },
    })
    recoveredRepository.close()
    await rm(stateDir, { recursive: true, force: true })
  })

  it('requires bearer authentication', async () => {
    const { url } = await start()
    const response = await fetch(`${url}/v1/image-jobs/missing`)
    expect(response.status).toBe(401)
  })

  it('allows only local or explicitly configured browser origins', async () => {
    const { url } = await start({
      concurrency: 0,
      allowedOrigins: ['https://image.taostudioai.com/'],
    })

    const configured = await fetch(`${url}/v1/capabilities`, {
      headers: headers({ origin: 'https://image.taostudioai.com' }),
    })
    expect(configured.headers.get('access-control-allow-origin')).toBe('https://image.taostudioai.com')

    const local = await fetch(`${url}/v1/capabilities`, {
      headers: headers({ origin: 'http://localhost:9527' }),
    })
    expect(local.headers.get('access-control-allow-origin')).toBe('http://localhost:9527')

    const unknown = await fetch(`${url}/v1/capabilities`, {
      headers: headers({ origin: 'https://untrusted.example' }),
    })
    expect(unknown.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('reports implemented capabilities without advertising fallback enhancers as native', async () => {
    const { url } = await start({ concurrency: 0, providerConfig: { model: 'configured-image-model' } })
    const response = await fetch(`${url}/v1/capabilities`, { headers: headers() })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      service: 'taostudio-image-task-api',
      apiVersion: '1',
      contractVersion: '1',
      capabilities: {
        inputModes: ['prompt', 'source', 'edit'],
        apiModes: ['images', 'responses'],
        generation: {
          defaultProvider: 'configured',
          defaultModel: 'configured-image-model',
        },
        output: {
          acceptedEnhancements: ['auto', 'none', 'lanczos3', 'real-esrgan', 'hat'],
          implementedEnhancements: ['lanczos3'],
          enhancementFallback: 'lanczos3',
        },
        jobs: { defaultListLimit: 30, maxListLimit: 100 },
        batches: {
          qaStatuses: ['not_run', 'passed', 'failed', 'needs_review'],
          acceptanceStatuses: ['pending', 'accepted', 'needs_review', 'rejected'],
          automation: {
            supported: true,
            maxRevisions: 3,
            features: ['multi_output_expansion', 'safe_rewrite', 'visual_qa', 'automatic_acceptance'],
          },
        },
      },
    })
  })

  it('lists jobs with request context, state filtering, and an opaque cursor', async () => {
    const { url } = await start({ concurrency: 0 })
    const created = await Promise.all([
      create(url, request({ idempotencyKey: 'list-jobs-001', input: { prompt: 'first list prompt' } })),
      create(url, request({ idempotencyKey: 'list-jobs-002', input: { prompt: 'second list prompt' } })),
      create(url, request({ idempotencyKey: 'list-jobs-003', input: { prompt: 'third list prompt' } })),
    ])
    const expectedIds = new Set(created.map((result) => result.body.id))

    const firstPageResponse = await fetch(`${url}/v1/image-jobs?state=queued&limit=2`, { headers: headers() })
    const firstPage = await firstPageResponse.json()
    expect(firstPageResponse.status).toBe(200)
    expect(firstPage.items).toHaveLength(2)
    expect(firstPage.items[0].request.input.prompt).toMatch(/list prompt$/)
    expect(firstPage.nextCursor).toEqual(expect.any(String))
    expect(firstPage.stats).toMatchObject({
      total: 3,
      queued: 3,
      matching: 3,
      byState: { queued: 3 },
    })

    const secondPageResponse = await fetch(`${url}/v1/image-jobs?state=queued&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers: headers() })
    const secondPage = await secondPageResponse.json()
    expect(secondPageResponse.status).toBe(200)
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.nextCursor).toBeNull()
    expect(new Set([...firstPage.items, ...secondPage.items].map((job) => job.id))).toEqual(expectedIds)

    const invalidCursor = await fetch(`${url}/v1/image-jobs?cursor=not-a-cursor`, { headers: headers() })
    expect(invalidCursor.status).toBe(400)
    expect((await invalidCursor.json()).error.code).toBe('INVALID_CURSOR')
  })

  it('creates an idempotent batch with ordered durable jobs and derived progress', async () => {
    const { url } = await start({ concurrency: 0 })
    const payload = {
      idempotencyKey: 'batch-create-001',
      name: 'Contract batch',
      items: [
        { itemKey: 'first', request: request({ idempotencyKey: 'batch-create-job-001', input: { prompt: 'first batch prompt' } }) },
        { itemKey: 'second', request: request({ idempotencyKey: 'batch-create-job-002', input: { prompt: 'second batch prompt' } }) },
      ],
    }
    const first = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
    })
    const created = await first.json()
    expect(first.status).toBe(201)
    expect(created).toMatchObject({
      name: 'Contract batch',
      state: 'running',
      stats: { total: 2, queued: 2, terminal: 0 },
      items: [
        { itemKey: 'first', position: 0, job: { request: { input: { prompt: 'first batch prompt' } } } },
        { itemKey: 'second', position: 1, job: { request: { input: { prompt: 'second batch prompt' } } } },
      ],
    })
    expect(new Set(created.items.map((item) => item.job.id)).size).toBe(2)

    const replay = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
    })
    expect(replay.status).toBe(200)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect((await replay.json()).id).toBe(created.id)

    const conflict = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ ...payload, name: 'Different batch input' }),
    })
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).error.code).toBe('BATCH_IDEMPOTENCY_CONFLICT')
  })

  it('pauses queued batch jobs without interrupting work and resumes claiming', async () => {
    const { url, api } = await start({ concurrency: 0, batchWatchdogEnabled: false })
    const payload = {
      idempotencyKey: 'batch-pause-001',
      items: [
        { itemKey: 'only', request: request({ idempotencyKey: 'batch-pause-job-001' }) },
      ],
    }
    const created = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
    }).then((response) => response.json())

    const paused = await fetch(`${url}/v1/image-batches/${created.id}/pause`, {
      method: 'POST',
      headers: headers(),
    }).then((response) => response.json())
    expect(paused).toMatchObject({ state: 'paused', controlState: 'paused', stats: { queued: 1 } })
    expect(api.repository.claimNextJob()).toBeNull()

    const resumed = await fetch(`${url}/v1/image-batches/${created.id}/resume`, {
      method: 'POST',
      headers: headers(),
    }).then((response) => response.json())
    expect(resumed).toMatchObject({ state: 'running', controlState: 'running' })
    const claimed = api.repository.claimNextJob()
    expect(claimed).toMatchObject({ state: 'validating' })

    await fetch(`${url}/v1/image-batches/${created.id}/pause`, { method: 'POST', headers: headers() })
    api.repository.transition(claimed.id, 'generating')
    api.repository.transition(claimed.id, 'source_ready')
    api.repository.transition(claimed.id, 'enhancing')
    api.repository.transition(claimed.id, 'finalizing')
    api.repository.transition(claimed.id, 'succeeded')
    expect(api.repository.getBatch(created.id)).toMatchObject({
      state: 'completed',
      controlState: 'paused',
      stats: { succeeded: 1, terminal: 1 },
    })
  })

  it('retries all failed batch jobs with fresh attempt budgets and resumes the batch', async () => {
    const { url, api } = await start({ concurrency: 0 })
    const created = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: 'batch-retry-001',
        items: [
          {
            itemKey: 'failed-item',
            request: request({ idempotencyKey: 'batch-retry-job-001', retry: { maxAttempts: 1 } }),
          },
        ],
      }),
    }).then((response) => response.json())
    const claimed = api.repository.claimNextJob()
    api.repository.transition(claimed.id, 'failed', {
      error: { code: 'PROVIDER_NETWORK_ERROR', message: 'test failure', retryable: false },
    })

    const retried = await fetch(`${url}/v1/image-batches/${created.id}/retry-failed`, {
      method: 'POST',
      headers: headers(),
    }).then((response) => response.json())
    expect(retried).toMatchObject({
      state: 'running',
      stats: { queued: 1, failed: 0 },
      items: [{ itemKey: 'failed-item', job: { id: claimed.id, state: 'queued', attempts: 0 } }],
    })
    expect(retried.events.at(-1)).toMatchObject({ event: 'retry_failed', detail: { retried: 1 } })
    expect(api.repository.events(claimed.id).some((event) => event.detail?.reason === 'manual_retry')).toBe(true)
  })

  it('auto-resumes a paused batch after the cooldown window when there are no recent provider failures', async () => {
    const { url, api } = await start({
      concurrency: 0,
      batchWatchdogPollIntervalMs: 30,
      batchWatchdogCooldownMs: 0,
      batchWatchdogMaxAttempts: 5,
    })
    const created = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: 'batch-watchdog-resume-001',
        items: [
          { itemKey: 'failed-item', request: request({ idempotencyKey: 'watchdog-job-001', retry: { maxAttempts: 1 } }) },
          { itemKey: 'queued-item', request: request({ idempotencyKey: 'watchdog-job-002' }) },
        ],
      }),
    }).then((response) => response.json())
    const claimed = api.repository.claimNextJob()
    api.repository.transition(claimed.id, 'failed', {
      error: { code: 'PROVIDER_NETWORK_ERROR', message: 'simulated 502', retryable: false },
    })
    api.repository.setBatchControlState(created.id, 'paused')
    expect(api.repository.getBatch(created.id).controlState).toBe('paused')

    // Watchdog runs every 30ms with 0ms cooldown; should auto-resume within ~500ms
    const deadline = Date.now() + 2000
    let resumed = false
    while (Date.now() < deadline) {
      const batch = api.repository.getBatch(created.id)
      if (batch.controlState === 'running') { resumed = true; break }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
    }
    expect(resumed).toBe(true)
    const batch = api.repository.getBatch(created.id)
    expect(batch.stats.queued).toBe(2)
    expect(batch.events.some((event) => event.event === 'auto_resume_attempt')).toBe(true)
  })

  it('does not auto-resume when there are recent provider failures within the cooldown window', async () => {
    const { url, api } = await start({
      concurrency: 0,
      batchWatchdogPollIntervalMs: 30,
      batchWatchdogCooldownMs: 3_600_000,
      batchWatchdogMaxAttempts: 5,
    })
    const created = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: 'batch-watchdog-cooldown-001',
        items: [
          { itemKey: 'cool-failed-item', request: request({ idempotencyKey: 'watchdog-cool-job-001', retry: { maxAttempts: 1 } }) },
          { itemKey: 'cool-queued-item', request: request({ idempotencyKey: 'watchdog-cool-job-002' }) },
        ],
      }),
    }).then((response) => response.json())
    const claimed = api.repository.claimNextJob()
    const callId = api.repository.startProviderCall(claimed)
    api.repository.finishProviderCall(callId, { state: 'failed', httpStatus: 502, error: { code: 'upstream_error' } })
    api.repository.transition(claimed.id, 'failed', {
      error: { code: 'PROVIDER_NETWORK_ERROR', message: 'recent 502', retryable: false },
    })
    api.repository.setBatchControlState(created.id, 'paused')

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    expect(api.repository.getBatch(created.id).controlState).toBe('paused')
  })

  it('stops auto-resuming after reaching maxAttempts', async () => {
    const { url, api } = await start({
      concurrency: 0,
      batchWatchdogPollIntervalMs: 30,
      batchWatchdogCooldownMs: 0,
      batchWatchdogMaxAttempts: 2,
    })
    const created = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: 'batch-watchdog-max-001',
        items: [
          { itemKey: 'max-item', request: request({ idempotencyKey: 'watchdog-max-job-001' }) },
          { itemKey: 'max-item-2', request: request({ idempotencyKey: 'watchdog-max-job-002' }) },
        ],
      }),
    }).then((response) => response.json())
    api.repository.setBatchControlState(created.id, 'paused')

    // Watchdog auto-resumes; re-pause after each resume to drive attempts up to maxAttempts (2)
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const batch = api.repository.getBatch(created.id)
      if (batch.controlState === 'running') {
        const attempts = api.repository.countBatchResumeAttempts(created.id)
        if (attempts >= 2) break
        api.repository.setBatchControlState(created.id, 'paused')
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
    }
    expect(api.repository.countBatchResumeAttempts(created.id)).toBe(2)
    // Re-pause and verify it does NOT auto-resume further (at max)
    api.repository.setBatchControlState(created.id, 'paused')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    expect(api.repository.countBatchResumeAttempts(created.id)).toBe(2)
  })

  it('does not run the watchdog when disabled', async () => {
    const { url, api } = await start({
      concurrency: 0,
      batchWatchdogEnabled: false,
      batchWatchdogPollIntervalMs: 30,
    })
    const created = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: 'batch-watchdog-disabled-001',
        items: [{ itemKey: 'off-item', request: request({ idempotencyKey: 'watchdog-off-job-001' }) }],
      }),
    }).then((response) => response.json())
    api.repository.setBatchControlState(created.id, 'paused')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))
    expect(api.repository.getBatch(created.id).controlState).toBe('paused')
    expect(api.repository.countBatchResumeAttempts(created.id)).toBe(0)
  })

  it('tracks batch QA, acceptance, and replacement job history independently from generation state', async () => {
    const { url, api } = await start({ concurrency: 0 })
    const created = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: 'batch-acceptance-001',
        items: [
          {
            itemKey: 'reviewed-item',
            request: request({ idempotencyKey: 'batch-acceptance-job-001' }),
          },
        ],
      }),
    }).then((response) => response.json())
    const firstJob = api.repository.claimNextJob()
    api.repository.transition(firstJob.id, 'generating')
    api.repository.transition(firstJob.id, 'source_ready')
    api.repository.transition(firstJob.id, 'enhancing')
    api.repository.transition(firstJob.id, 'finalizing')
    api.repository.transition(firstJob.id, 'succeeded')

    // QA 仅作参考，不阻断验收：job succeeded 即可 accepted，qaStatus=failed 也允许（记为参考）。
    const qaFailedButAccepted = await fetch(`${url}/v1/image-batches/${created.id}/items/reviewed-item/review`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ qaStatus: 'failed', acceptanceStatus: 'accepted' }),
    })
    expect(qaFailedButAccepted.status).toBe(200)

    const reviewed = await fetch(`${url}/v1/image-batches/${created.id}/items/reviewed-item/review`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        qaStatus: 'passed',
        acceptanceStatus: 'accepted',
        detail: { visualQa: 'passed', assetInvariant: 'passed' },
      }),
    }).then((response) => response.json())
    expect(reviewed).toMatchObject({
      state: 'completed',
      acceptanceState: 'accepted',
      stats: { succeeded: 1, accepted: 1, qaPassed: 1, acceptancePending: 0 },
      items: [{
        itemKey: 'reviewed-item',
        revision: 0,
        generationStatus: 'succeeded',
        qaStatus: 'passed',
        acceptanceStatus: 'accepted',
        jobHistory: [{ revision: 0, reason: 'initial', job: { id: firstJob.id } }],
      }],
    })

    const replacementRequest = request({
      idempotencyKey: 'batch-acceptance-job-002',
      input: { prompt: 'revised after QA feedback' },
    })
    const replaced = await fetch(`${url}/v1/image-batches/${created.id}/items/reviewed-item/job`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ reason: 'qa_revision', request: replacementRequest }),
    }).then((response) => response.json())
    expect(replaced).toMatchObject({
      state: 'running',
      acceptanceState: 'pending',
      stats: { queued: 1, accepted: 0, acceptancePending: 1, qaNotRun: 1 },
      items: [{
        itemKey: 'reviewed-item',
        revision: 1,
        qaStatus: 'not_run',
        acceptanceStatus: 'pending',
        job: { request: { input: { prompt: 'revised after QA feedback' } } },
        jobHistory: [
          { revision: 0, job: { id: firstJob.id } },
          { revision: 1, reason: 'qa_revision' },
        ],
      }],
    })
    expect(replaced.items[0].job.id).not.toBe(firstJob.id)
    expect(replaced.events.at(-1)).toMatchObject({
      event: 'item_job_replaced',
      detail: { itemKey: 'reviewed-item', revision: 1, previousJobId: firstJob.id },
    })
  })

  it('expands multi-output prompts and automatically accepts every QA-passed item', async () => {
    const evaluator = {
      rewrite: async () => ({ prompt: 'unused rewrite', changes: '' }),
      qa: async () => ({
        pass: true,
        edgeClipping: false,
        backgroundConflict: false,
        missingCoreStructure: false,
        blankOrBroken: false,
        notes: 'pass',
        model: 'mock-qa',
      }),
    }
    const { url } = await start({ batchAutomationEvaluator: evaluator })
    const response = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: 'batch-automation-expand-001',
        automation: {
          enabled: true,
          maxRevisions: 2,
          revisionRoute: { provider: 'mock', model: 'mock-qa', apiMode: 'responses' },
        },
        items: [{
          itemKey: 'poster',
          request: request({
            idempotencyKey: 'batch-automation-expand-job-001',
            input: { prompt: 'Generate 2 poster images' },
          }),
        }],
      }),
    })
    const created = await response.json()
    expect(response.status).toBe(201)
    expect(created).toMatchObject({
      automation: { enabled: true },
      stats: { total: 2 },
      items: [
        { itemKey: 'poster:1', sourceItemKey: 'poster', outputIndex: 1, outputCount: 2 },
        { itemKey: 'poster:2', sourceItemKey: 'poster', outputIndex: 2, outputCount: 2 },
      ],
    })

    const completed = await waitBatch(url, created.id)
    expect(completed).toMatchObject({
      state: 'completed',
      acceptanceState: 'accepted',
      stats: { total: 2, succeeded: 2, accepted: 2, qaPassed: 2, acceptancePending: 0 },
    })
    expect(completed.items.every((item) => item.automationState === 'done')).toBe(true)
    expect(completed.items.every((item) => item.job.request.input.prompt.includes('not a contact sheet'))).toBe(true)
  })

  it('automatically rewrites a policy-rejected item and accepts the recovered revision', async () => {
    let rewrites = 0
    const evaluator = {
      rewrite: async () => {
        rewrites += 1
        return { prompt: 'A compliant documentary poster', changes: 'generalized unsafe detail' }
      },
      qa: async () => ({
        pass: true,
        edgeClipping: false,
        backgroundConflict: false,
        missingCoreStructure: false,
        blankOrBroken: false,
        notes: 'recovered',
        model: 'mock-qa',
      }),
    }
    const { url } = await start({ batchAutomationEvaluator: evaluator })
    const created = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: 'batch-automation-policy-001',
        automation: {
          enabled: true,
          maxRevisions: 2,
          revisionRoute: { provider: 'mock', model: 'mock-qa', apiMode: 'responses' },
        },
        items: [{
          itemKey: 'policy',
          request: request({
            idempotencyKey: 'batch-automation-policy-job-001',
            input: { prompt: 'policy-sensitive source prompt' },
            generation: { provider: 'mock', model: 'mock-v1', testBehavior: 'content-policy' },
            retry: { maxAttempts: 1 },
          }),
        }],
      }),
    }).then((response) => response.json())

    const completed = await waitBatch(url, created.id)
    expect(rewrites).toBe(1)
    expect(completed).toMatchObject({
      state: 'completed',
      acceptanceState: 'accepted',
      stats: { total: 1, succeeded: 1, accepted: 1, qaPassed: 1 },
      items: [{
        itemKey: 'policy',
        revision: 1,
        acceptanceStatus: 'accepted',
        job: { request: { input: { prompt: 'A compliant documentary poster' } } },
        jobHistory: [
          { revision: 0, reason: 'initial', job: { state: 'failed' } },
          { revision: 1, reason: 'safe_rewrite', job: { state: 'succeeded' } },
        ],
      }],
    })
  })

  it('automatically revises a QA failure and preserves revision evidence', async () => {
    let inspections = 0
    const evaluator = {
      rewrite: async () => ({ prompt: 'unused rewrite', changes: '' }),
      qa: async () => {
        inspections += 1
        return inspections === 1
          ? {
              pass: false,
              edgeClipping: true,
              backgroundConflict: false,
              missingCoreStructure: false,
              blankOrBroken: false,
              notes: 'title clipped',
              model: 'mock-qa',
            }
          : {
              pass: true,
              edgeClipping: false,
              backgroundConflict: false,
              missingCoreStructure: false,
              blankOrBroken: false,
              notes: 'fixed',
              model: 'mock-qa',
            }
      },
    }
    const { url } = await start({ batchAutomationEvaluator: evaluator })
    const created = await fetch(`${url}/v1/image-batches`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: 'batch-automation-qa-001',
        automation: {
          enabled: true,
          maxRevisions: 2,
          revisionRoute: { provider: 'mock', model: 'mock-qa', apiMode: 'responses' },
        },
        items: [{
          itemKey: 'qa',
          request: request({ idempotencyKey: 'batch-automation-qa-job-001' }),
        }],
      }),
    }).then((response) => response.json())

    const completed = await waitBatch(url, created.id)
    expect(inspections).toBe(2)
    expect(completed).toMatchObject({
      state: 'completed',
      stats: { accepted: 1, qaPassed: 1 },
      items: [{
        itemKey: 'qa',
        revision: 1,
        acceptanceStatus: 'accepted',
        jobHistory: [
          { revision: 0, reason: 'initial' },
          { revision: 1, reason: 'recompose' },
        ],
      }],
    })
    expect(completed.items[0].job.request.input.prompt).toContain('Keep a requested full-bleed background full-bleed')
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

  it('manually retries a failed job with a fresh attempt budget and preserved history', async () => {
    const { url } = await start({ providerTimeoutMs: 30 })
    const created = await create(url, request({
      idempotencyKey: 'manual-retry-001',
      generation: { provider: 'mock', model: 'mock-v1', testBehavior: 'fail' },
      retry: { maxAttempts: 2 },
    }))
    const firstFailure = await wait(url, created.body.id)
    expect(firstFailure).toMatchObject({ state: 'failed', attempts: 2 })

    const retryResponse = await fetch(`${url}/v1/image-jobs/${created.body.id}/retry`, {
      method: 'POST',
      headers: headers(),
    })
    expect(retryResponse.status).toBe(200)
    expect((await retryResponse.json()).id).toBe(created.body.id)

    const secondFailure = await wait(url, created.body.id)
    expect(secondFailure).toMatchObject({ state: 'failed', attempts: 2 })
    const manualRetryEvent = secondFailure.events.find((event) => event.detail?.reason === 'manual_retry')
    expect(manualRetryEvent).toMatchObject({
      state: 'queued',
      detail: {
        previousAttempts: 2,
        previousError: expect.objectContaining({ code: 'JOB_FAILED' }),
      },
    })
  })

  it('rejects manual retry for a non-failed job', async () => {
    const { url } = await start({ concurrency: 0 })
    const created = await create(url, request({ idempotencyKey: 'manual-retry-conflict-001' }))
    const response = await fetch(`${url}/v1/image-jobs/${created.body.id}/retry`, {
      method: 'POST',
      headers: headers(),
    })
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('JOB_NOT_RETRYABLE')
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

  it('falls back to a second route on the same job after the primary route exhausts its budget', async () => {
    const png = await sharp({ create: { width: 720, height: 1280, channels: 4, background: '#4c7899' } }).png().toBuffer()
    const calls = []
    const provider = createServer((incoming, response) => {
      calls.push(incoming.url)
      response.setHeader('content-type', 'application/json')
      if (incoming.url === '/v1/images/generations') {
        response.statusCode = 503
        return void response.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'temporary gateway outage' } }))
      }
      response.end(JSON.stringify({
        output: [{ type: 'image_generation_call', status: 'completed', result: png.toString('base64') }],
        usage: { total_tokens: 7 },
      }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key' } })
    const payload = request({
      idempotencyKey: 'route-fallback-success-001',
      generation: {
        provider: 'configured',
        model: 'primary-image-model',
        apiMode: 'images',
        baseSize: '720x1280',
        fallback: { provider: 'configured', model: 'fallback-response-model', apiMode: 'responses' },
      },
      retry: { maxAttempts: 2 },
    })
    const created = await create(url, payload)
    const job = await wait(url, created.body.id)

    expect(job).toMatchObject({
      id: created.body.id,
      state: 'succeeded',
      attempts: 3,
      routeIndex: 1,
      routeAttempts: 1,
      actualRoute: { provider: 'configured', model: 'fallback-response-model', apiMode: 'responses' },
      result: {
        actualRoute: { provider: 'configured', model: 'fallback-response-model', apiMode: 'responses' },
      },
      accounting: {
        calls: [
          { attempt: 1, routeIndex: 0, state: 'failed', httpStatus: 503 },
          { attempt: 2, routeIndex: 0, state: 'failed', httpStatus: 503 },
          { attempt: 3, routeIndex: 1, state: 'succeeded' },
        ],
      },
    })
    expect(job.accounting.calls[2].usage).toEqual({ total_tokens: 7 })
    expect(calls).toEqual(['/v1/images/generations', '/v1/images/generations', '/v1/responses'])
    expect(job.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        state: 'queued',
        detail: expect.objectContaining({
          reason: 'route_fallback',
          from: expect.objectContaining({ model: 'primary-image-model', apiMode: 'images' }),
          to: expect.objectContaining({ model: 'fallback-response-model', apiMode: 'responses' }),
        }),
      }),
    ]))

    const replay = await create(url, payload)
    expect(replay.body.id).toBe(job.id)
    expect(replay.response.headers.get('idempotency-replayed')).toBe('true')
    expect(calls).toHaveLength(3)
  })

  it('terminates after the fallback route also exhausts its own budget', async () => {
    let providerCalls = 0
    const provider = createServer((incoming, response) => {
      providerCalls += 1
      response.statusCode = 503
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { code: 'upstream_unavailable', message: 'still unavailable' } }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key' } })
    const created = await create(url, request({
      idempotencyKey: 'route-fallback-failure-001',
      generation: {
        provider: 'configured',
        model: 'primary-image-model',
        apiMode: 'images',
        baseSize: '720x1280',
        fallback: { provider: 'configured', model: 'fallback-response-model', apiMode: 'responses' },
      },
      retry: { maxAttempts: 1 },
    }))
    const job = await wait(url, created.body.id)

    expect(job).toMatchObject({ state: 'failed', attempts: 2, routeIndex: 1, routeAttempts: 1 })
    expect(job.events.filter((event) => event.detail?.reason === 'route_fallback')).toHaveLength(1)
    expect(providerCalls).toBe(2)
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

  it('falls back to the secondary route for a content policy error, then terminates if that also fails', async () => {
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
      idempotencyKey: 'content-policy-fallback-001',
      generation: {
        provider: 'configured',
        model: 'test-model',
        baseSize: '720x1280',
        fallback: { provider: 'configured', model: 'fallback-model', apiMode: 'responses' },
      },
    }))
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({
      state: 'failed',
      error: {
        code: 'PROVIDER_RESPONSE_ERROR',
        providerCode: 'content_policy_violation',
        retryable: false,
        failureClass: 'content_policy',
        recoveryAction: 'safe_rewrite',
      },
    })
    expect(job.routeIndex).toBe(1)
    expect(job.events.some((event) => event.detail?.reason === 'route_fallback')).toBe(true)
    const replay = await create(url, request({
      idempotencyKey: 'content-policy-fallback-001',
      generation: {
        provider: 'configured',
        model: 'test-model',
        baseSize: '720x1280',
        fallback: { provider: 'configured', model: 'fallback-model', apiMode: 'responses' },
      },
    }))
    expect(replay.body.id).toBe(job.id)
    expect(providerCalls).toBe(2)
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

  it('routes generation.apiMode responses through /responses and decodes the image_generation_call', async () => {
    const png = await sharp({ create: { width: 720, height: 1280, channels: 4, background: '#cc7755' } }).png().toBuffer()
    let requests = []
    const provider = createServer((incoming, response) => {
      let body = ''
      incoming.on('data', (chunk) => { body += chunk })
      incoming.on('end', () => {
        requests.push({ url: incoming.url, body })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          id: 'resp_test',
          status: 'completed',
          output: [
            { id: 'ig_test', type: 'image_generation_call', status: 'completed', result: png.toString('base64') },
          ],
        }))
      })
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'gpt-5.6-sol' } })
    const created = await create(url, request({
      idempotencyKey: 'responses-mode-success-001',
      generation: { provider: 'configured', model: 'gpt-5.6-sol', baseSize: '720x1280', apiMode: 'responses' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '2160x3840', enhancement: 'lanczos3', contentClass: 'photo' },
      retry: { maxAttempts: 3 },
    }))
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ state: 'succeeded' })
    expect(job.sourceAssetId).toMatch(/^asset_/)
    expect(job.finalAssetId).toMatch(/^asset_/)
    // The request must have hit /responses (not /images/generations).
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('/v1/responses')
    const parsed = JSON.parse(requests[0].body)
    expect(parsed.tools[0]).toMatchObject({ type: 'image_generation', action: 'generate', size: '720x1280', output_format: 'png' })
    expect(parsed.tool_choice).toBe('required')
    const finalManifest = await (await fetch(`${url}/v1/assets/${job.finalAssetId}?manifest=1`, { headers: headers() })).json()
    expect(finalManifest).toMatchObject({ width: 2160, height: 3840, ratio: '9:16', parentAssetId: job.sourceAssetId })
  })

  it('treats a failed image_generation_call in responses mode as a permanent content-policy error', async () => {
    const provider = createServer((incoming, response) => {
      response.setHeader('content-type', 'application/json')
      // HTTP 200 but the image_generation_call failed — Responses API reports
      // refusals inside output, not via status codes.
      response.end(JSON.stringify({
        status: 'completed',
        output: [
          { id: 'ig_fail', type: 'image_generation_call', status: 'failed', error: { code: 'content_policy_violation', message: 'image blocked by safety' } },
        ],
      }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'gpt-5.6-sol' } })
    const created = await create(url, request({
      idempotencyKey: 'responses-mode-failed-001',
      generation: { provider: 'configured', model: 'gpt-5.6-sol', baseSize: '720x1280', apiMode: 'responses' },
      retry: { maxAttempts: 3 },
    }))
    const job = await wait(url, created.body.id)
    expect(job.state).toBe('failed')
    expect(job.error).toMatchObject({ code: 'PROVIDER_RESPONSE_ERROR', providerCode: 'content_policy_violation', retryable: false })
  })

  it('retries a responses-mode transient gateway error on the same job', async () => {
    const png = await sharp({ create: { width: 720, height: 1280, channels: 4, background: '#5588cc' } }).png().toBuffer()
    let providerCalls = 0
    const provider = createServer((incoming, response) => {
      providerCalls += 1
      response.setHeader('content-type', 'application/json')
      if (providerCalls === 1) return void response.end('<!doctype html><title>temporary gateway response</title>')
      response.end(JSON.stringify({ status: 'completed', output: [{ type: 'image_generation_call', status: 'completed', result: png.toString('base64') }] }))
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'gpt-5.6-sol' } })
    const created = await create(url, request({
      idempotencyKey: 'responses-mode-retry-001',
      generation: { provider: 'configured', model: 'gpt-5.6-sol', baseSize: '720x1280', apiMode: 'responses' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '2160x3840', enhancement: 'lanczos3', contentClass: 'photo' },
      retry: { maxAttempts: 3 },
    }))
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ state: 'succeeded', attempts: 2 })
    expect(providerCalls).toBe(2)
  })

  it('rejects an invalid generation.apiMode value', async () => {
    const { url } = await start()
    const created = await create(url, request({
      idempotencyKey: 'invalid-api-mode-001',
      generation: { provider: 'configured', model: 'gpt-image-2', apiMode: 'bogus' },
    }))
    expect(created.response.status).toBe(400)
    expect(created.body.error.details).toEqual(expect.arrayContaining([expect.stringMatching(/apiMode/)]))
  })

  it('routes an edit-mode job (sourceAssetId + prompt) through /images/edits', async () => {
    const png = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#3388cc' } }).png().toBuffer()
    let editRequests = []
    const provider = createServer((incoming, response) => {
      let chunks = []
      incoming.on('data', (chunk) => { chunks.push(chunk) })
      incoming.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        editRequests.push({ url: incoming.url, contentType: incoming.headers['content-type'] || '', bodyStart: body.slice(0, 200) })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
      })
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'gpt-image-2' } })

    // Upload a reference image
    const refPng = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#cc4422' } }).png().toBuffer()
    const uploaded = await fetch(`${url}/v1/assets/uploads`, { method: 'POST', headers: headers({ 'content-type': 'image/png', 'x-file-name': 'ref.png' }), body: refPng })
    expect(uploaded.status).toBe(201)
    const asset = await uploaded.json()

    // Edit mode: sourceAssetId + prompt together triggers image-to-image
    const created = await create(url, request({
      idempotencyKey: 'edit-mode-images-001',
      input: { sourceAssetId: asset.assetId, prompt: 'make it look like a watercolor painting' },
      composition: { ratio: '1:1' },
      generation: { provider: 'configured', model: 'gpt-image-2', baseSize: '1024x1024', apiMode: 'images' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '2160x2160', enhancement: 'lanczos3', contentClass: 'photo' },
      retry: { maxAttempts: 3 },
    }))
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ state: 'succeeded' })
    // The request must have hit /images/edits (not /images/generations).
    expect(editRequests).toHaveLength(1)
    expect(editRequests[0].url).toBe('/v1/images/edits')
    // The request must be multipart/form-data (not JSON).
    expect(editRequests[0].contentType).toMatch(/multipart\/form-data/)
    // Source and final must exist and be ratio-matched.
    expect(job.sourceAssetId).toMatch(/^asset_/)
    expect(job.finalAssetId).toMatch(/^asset_/)
    const finalManifest = await (await fetch(`${url}/v1/assets/${job.finalAssetId}?manifest=1`, { headers: headers() })).json()
    expect(finalManifest).toMatchObject({ width: 2160, height: 2160, ratio: '1:1' })
  })

  it('routes an edit-mode job through /responses with action edit and multimodal input', async () => {
    const png = await sharp({ create: { width: 720, height: 1280, channels: 4, background: '#55aa55' } }).png().toBuffer()
    let editRequests = []
    const provider = createServer((incoming, response) => {
      let body = ''
      incoming.on('data', (chunk) => { body += chunk })
      incoming.on('end', () => {
        editRequests.push({ url: incoming.url, body })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          id: 'resp_edit',
          status: 'completed',
          output: [{ id: 'ig_edit', type: 'image_generation_call', status: 'completed', result: png.toString('base64') }],
        }))
      })
    })
    await new Promise((resolvePromise) => provider.listen(0, '127.0.0.1', resolvePromise))
    providerServers.push(provider)
    const providerUrl = `http://127.0.0.1:${provider.address().port}`
    const { url } = await start({ providerConfig: { baseUrl: providerUrl, apiKey: 'test-key', model: 'gpt-5.6-sol' } })

    const refPng = await sharp({ create: { width: 720, height: 1280, channels: 4, background: '#9933cc' } }).png().toBuffer()
    const uploaded = await fetch(`${url}/v1/assets/uploads`, { method: 'POST', headers: headers({ 'content-type': 'image/png', 'x-file-name': 'ref.png' }), body: refPng })
    const asset = await uploaded.json()

    const created = await create(url, request({
      idempotencyKey: 'edit-mode-responses-001',
      input: { sourceAssetId: asset.assetId, prompt: 'transform into a vintage poster' },
      composition: { ratio: '9:16' },
      generation: { provider: 'configured', model: 'gpt-5.6-sol', baseSize: '720x1280', apiMode: 'responses' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '2160x3840', enhancement: 'lanczos3', contentClass: 'photo' },
      retry: { maxAttempts: 3 },
    }))
    const job = await wait(url, created.body.id)
    expect(job).toMatchObject({ state: 'succeeded' })
    expect(editRequests).toHaveLength(1)
    expect(editRequests[0].url).toBe('/v1/responses')
    const parsed = JSON.parse(editRequests[0].body)
    // The tool action must be 'edit' (not 'generate').
    expect(parsed.tools[0]).toMatchObject({ type: 'image_generation', action: 'edit' })
    // The input must be a multimodal array (not a plain string).
    expect(Array.isArray(parsed.input)).toBe(true)
    expect(parsed.input[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'input_text' }),
      expect.objectContaining({ type: 'input_image' }),
    ]))
  })

  it('still routes a source-only job (no prompt) through local normalization, not the provider', async () => {
    const { url } = await start()
    const refPng = await sharp({ create: { width: 1024, height: 768, channels: 4, background: '#2244aa' } }).png().toBuffer()
    const uploaded = await fetch(`${url}/v1/assets/uploads`, { method: 'POST', headers: headers({ 'content-type': 'image/png', 'x-file-name': 'ref.png' }), body: refPng })
    const asset = await uploaded.json()
    // sourceAssetId WITHOUT prompt — backward-compatible local scaling path.
    const created = await create(url, request({
      idempotencyKey: 'source-only-compat-001',
      input: { sourceAssetId: asset.assetId },
      composition: { ratio: '4:3' },
      generation: { provider: 'configured', model: 'unused-no-call' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: '2160x1620', enhancement: 'lanczos3', contentClass: 'photo' },
      retry: { maxAttempts: 3 },
    }))
    const job = await wait(url, created.body.id)
    // Must succeed without any provider call (provider is 'configured' but no baseUrl set).
    expect(job).toMatchObject({ state: 'succeeded', sourceAssetId: asset.assetId, accounting: { calls: [] } })
  })

  it('does not account an edit that fails before contacting the provider', async () => {
    const { url } = await start()
    const created = await create(url, request({
      idempotencyKey: 'edit-missing-source-001',
      input: { prompt: 'edit this image', sourceAssetId: 'asset_missing' },
    }))
    const job = await wait(url, created.body.id)

    expect(job).toMatchObject({
      state: 'failed',
      error: { message: 'source asset not found' },
      accounting: { calls: [] },
    })
  })

  it('defaults to 2K generation and 4K final when neither baseSize nor dimensions is provided', async () => {
    const { url } = await start()
    // Omit generation.baseSize AND output.dimensions — engine should default to 2K source + inherited 4K final.
    const created = await create(url, {
      contractVersion: '1',
      idempotencyKey: 'default-tier-2k-to-4k-001',
      input: { prompt: 'default tier test' },
      composition: { ratio: '3:4' },
      generation: { provider: 'mock', model: 'mock-v1' },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', enhancement: 'lanczos3', contentClass: 'photo' },
      retry: { maxAttempts: 3 },
    })
    const job = await wait(url, created.body.id)
    expect(job.state).toBe('succeeded')
    const sourceManifest = await (await fetch(`${url}/v1/assets/${job.sourceAssetId}?manifest=1`, { headers: headers() })).json()
    const finalManifest = await (await fetch(`${url}/v1/assets/${job.finalAssetId}?manifest=1`, { headers: headers() })).json()
    // Source should be the 2K preset for 3:4 = 1536x2048
    expect(sourceManifest).toMatchObject({ width: 1536, height: 2048, ratio: '3:4' })
    // Final should be the inherited 4K target for 3:4 = 2400x3200
    expect(finalManifest).toMatchObject({ width: 2400, height: 3200, ratio: '3:4' })
    // Cross-product invariant must hold
    expect(sourceManifest.width * finalManifest.height).toBe(finalManifest.width * sourceManifest.height)
  })
})
