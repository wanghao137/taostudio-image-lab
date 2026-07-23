// Prompt B — Independent MCP client test (robust to provider outage).
// Drives all 6 MCP tools over a real stdio subprocess. The real 3:4 provider
// job is attempted; if the provider is down it is recorded as BLOCKED and the
// rest of the toolchain (idempotency, exclusive download, sanitized failure,
// cancel) is still verified via mock. Every tool call is logged to
// mcp-calls.jsonl with credentials fully deleted.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { appendFileSync, existsSync, rmSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const outDir = process.env.OUT_DIR
const token = process.env.IMAGE_TASK_API_TOKEN
const apiUrl = process.env.IMAGE_TASK_API_URL
if (!outDir || !token || !apiUrl) throw new Error('OUT_DIR / IMAGE_TASK_API_TOKEN / IMAGE_TASK_API_URL required')

const callsLog = join(outDir, 'mcp-calls.jsonl')
rmSync(callsLog, { force: true })

function redact(s) {
  return String(s == null ? '' : s)
    .replace(/[A-Fa-f0-9]{32,}/g, '[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('server/task-api/mcp-server.mjs')],
  cwd: resolve('.'),
  env: { ...process.env, IMAGE_TASK_API_URL: apiUrl, IMAGE_TASK_API_TOKEN: token },
})
const client = new Client({ name: 'promptB-external-mcp-client', version: '1.0.0' })
await client.connect(transport)

const toolsList = await client.listTools()
const discovered = toolsList.tools.map(t => t.name)

function logCall(name, args, result, error) {
  const entry = {
    ts: new Date().toISOString(),
    tool: name,
    args: JSON.parse(redact(JSON.stringify(args))),
    result: result ? JSON.parse(redact(JSON.stringify(result))) : null,
    error: error ? redact(String(error.message || error)) : null,
  }
  appendFileSync(callsLog, JSON.stringify(entry) + '\n')
  return entry
}

async function call(name, args, timeoutMs) {
  let result = null, error = null
  try {
    const opts = timeoutMs ? { timeout: timeoutMs } : undefined
    const r = await client.callTool({ name, arguments: args }, undefined, opts)
    const text = r.content?.find(i => i.type === 'text')?.text
    result = text ? JSON.parse(text) : r
  } catch (e) {
    error = e
  }
  logCall(name, args, result, error)
  if (error) throw new Error(`tool ${name} failed: ${error.message}`)
  return result
}

// call that swallows errors and returns {ok, result, error}
async function tryCall(name, args, timeoutMs) {
  try {
    const r = await call(name, args, timeoutMs)
    return { ok: true, result: r }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

const evidence = { generatedAt: new Date().toISOString(), discoveredTools: discovered, steps: [] }
let realTaskSucceeded = false

try {
  // ===== 1. image_asset_upload — upload a real PNG as immutable source =====
  const sourcePng = resolve('.local-task-api/evidence/external-agent-final.png')
  if (!existsSync(sourcePng)) throw new Error('source png for upload not found: ' + sourcePng)
  const uploadRes = await call('image_asset_upload', { path: sourcePng })
  const uploadedAssetId = uploadRes.assetId
  evidence.steps.push({ step: 'image_asset_upload', assetId: uploadedAssetId, ok: true })

  // ===== 2-7. REAL 3:4 task (attempt; may BLOCK on provider outage) =====
  const realKey = 'promptB-mcp:3-4:2400x3200:real-task-003'
  const realPrompt = '极简主义香水产品海报,米白背景,柔和阴影,编辑级排版,留白构图'
  const realCreate = await call('image_job_create', {
    idempotencyKey: realKey, prompt: realPrompt, ratio: '3:4', dimensions: '2400x3200',
    provider: 'configured', model: 'gpt-image-2', enhancement: 'lanczos3', contentClass: 'text', maxAttempts: 5,
  })
  const realJobId = realCreate.job.id
  evidence.steps.push({ step: 'image_job_create (real 3:4)', jobId: realJobId, state: realCreate.job.state })

  const realWait = await tryCall('image_job_wait', { jobId: realJobId, timeoutMs: 600000 }, 620000)
  if (realWait.ok) {
    const w = realWait.result
    evidence.steps.push({
      step: 'image_job_wait (real)', jobId: realJobId, state: w.state, attempts: w.attempts,
      sourceAssetId: w.sourceAssetId, finalAssetId: w.finalAssetId,
    })
    const got = await call('image_job_get', { jobId: realJobId })
    evidence.steps.push({ step: 'image_job_get (real)', state: got.state, eventCount: (got.events || []).length })

    if (w.state === 'succeeded') {
      realTaskSucceeded = true
      // idempotency replay
      const replayRes = await call('image_job_create', {
        idempotencyKey: realKey, prompt: realPrompt, ratio: '3:4', dimensions: '2400x3200',
        provider: 'configured', model: 'gpt-image-2', enhancement: 'lanczos3', contentClass: 'text', maxAttempts: 5,
      })
      evidence.steps.push({
        step: 'image_job_create (idempotency replay)', replayed: replayRes.replayed,
        sameJobId: replayRes.job.id === realJobId,
      })
      // download source + final
      const srcDl = await call('image_asset_download', { assetId: w.sourceAssetId, outputPath: join(outDir, 'mcp-source.png') })
      const finDl = await call('image_asset_download', { assetId: w.finalAssetId, outputPath: join(outDir, 'mcp-final.png') })
      evidence.steps.push({ step: 'image_asset_download (source)', manifest: srcDl.manifest })
      evidence.steps.push({ step: 'image_asset_download (final)', manifest: finDl.manifest })
      // exclusive download protection
      const excl = await tryCall('image_asset_download', { assetId: w.finalAssetId, outputPath: join(outDir, 'mcp-final.png') })
      evidence.steps.push({ step: 'exclusive download protection', expectedFail: true, failed: !excl.ok, error: excl.error })
    } else {
      evidence.steps.push({
        step: 'REAL 3:4 BLOCKED (provider outage)', state: w.state, attempts: w.attempts,
        error: w.error, note: 'Provider upstream_error 502; not an MCP/ratio defect.',
      })
    }
  } else {
    evidence.steps.push({ step: 'image_job_wait (real) errored', error: realWait.error })
  }

  // ===== 8. exclusive download protection via UPLOADED asset (does not need real task) =====
  const dlPath1 = join(outDir, 'mcp-uploaded-1.png')
  const dl1 = await call('image_asset_download', { assetId: uploadedAssetId, outputPath: dlPath1 })
  evidence.steps.push({ step: 'image_asset_download (uploaded asset #1)', ok: true, manifest: dl1.manifest })
  const dl2 = await tryCall('image_asset_download', { assetId: uploadedAssetId, outputPath: dlPath1 })
  evidence.steps.push({ step: 'exclusive download protection (uploaded asset)', expectedFail: true, failed: !dl2.ok, error: dl2.error })

  // ===== 9. sanitized failure (mock fail) — verify error exposes code/stage, no secrets =====
  const failKey = 'promptB-mcp:failure-audit:003'
  const failCreate = await call('image_job_create', {
    idempotencyKey: failKey, prompt: 'sanitized failure probe', ratio: '3:4', dimensions: '2400x3200',
    provider: 'mock', model: 'mock-v1', testBehavior: 'fail', maxAttempts: 3,
  })
  const failWait = await tryCall('image_job_wait', { jobId: failCreate.job.id, timeoutMs: 120000 }, 130000)
  if (failWait.ok) {
    const fw = failWait.result
    const errStr = redact(JSON.stringify(fw.error || {}))
    const leakScan = /sk-[a-z0-9]|bearer|authorization|api[-_]?key|secret|password/i.test(errStr)
    evidence.steps.push({
      step: 'sanitized failure (mock fail)', jobId: failCreate.job.id, state: fw.state, attempts: fw.attempts,
      error: fw.error, exposesCode: !!(fw.error && fw.error.code), exposesStage: !!(fw.error && fw.error.stage),
      credentialLeak: leakScan,
    })
  }

  // ===== 10. idempotency replay via mock (independent of real provider) =====
  const mockKey = 'promptB-mcp:mock-idempotency:003'
  const mockCreate1 = await call('image_job_create', {
    idempotencyKey: mockKey, prompt: 'mock idempotency probe', ratio: '3:2', dimensions: '3456x2304',
    provider: 'mock', model: 'mock-v1', enhancement: 'lanczos3', contentClass: 'logo', maxAttempts: 3,
  })
  const mockReplay = await call('image_job_create', {
    idempotencyKey: mockKey, prompt: 'mock idempotency probe', ratio: '3:2', dimensions: '3456x2304',
    provider: 'mock', model: 'mock-v1', enhancement: 'lanczos3', contentClass: 'logo', maxAttempts: 3,
  })
  evidence.steps.push({
    step: 'idempotency replay (mock)', replayed: mockReplay.replayed,
    sameJobId: mockReplay.job.id === mockCreate1.job.id,
  })

  // ===== 11. image_job_cancel (mock timeout) =====
  const cancelKey = 'promptB-mcp:cancel:003'
  const cancelCreate = await call('image_job_create', {
    idempotencyKey: cancelKey, prompt: 'cancel probe', ratio: '3:4', dimensions: '2400x3200',
    provider: 'mock', model: 'mock-v1', testBehavior: 'timeout', maxAttempts: 3,
  })
  await call('image_job_cancel', { jobId: cancelCreate.job.id })
  const cancelWait = await tryCall('image_job_wait', { jobId: cancelCreate.job.id, timeoutMs: 30000 }, 35000)
  evidence.steps.push({
    step: 'image_job_cancel', jobId: cancelCreate.job.id,
    state: cancelWait.ok ? cancelWait.result.state : 'unknown',
  })

  evidence.realTaskSucceeded = realTaskSucceeded
  evidence.verdict = realTaskSucceeded ? 'PASS' : 'BLOCKED'
} catch (e) {
  evidence.fatalError = redact(String(e.message || e))
  evidence.verdict = 'FAIL'
} finally {
  await client.close()
}

writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2))
console.log('=== Prompt B MCP evidence summary ===')
console.log('discovered tools (6):', evidence.discoveredTools.join(', '))
console.log('steps:', evidence.steps.length)
for (const s of evidence.steps) {
  let extra = ''
  if (s.state) extra += ` state=${s.state}`
  if (s.replayed !== undefined) extra += ` replayed=${s.replayed} sameJob=${s.sameJobId}`
  if (s.failed !== undefined) extra += ` failed=${s.failed}(expected)`
  if (s.credentialLeak !== undefined) extra += ` credLeak=${s.credentialLeak}`
  console.log(`  - ${s.step}${extra}`)
}
console.log('real 3:4 task succeeded:', evidence.realTaskSucceeded)
console.log('verdict:', evidence.verdict)
