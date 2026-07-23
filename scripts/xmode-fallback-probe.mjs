// Cross-mode fallback probe: force the first chain link to fail (mock fail),
// verify the orchestrator falls over to the second link (real responses mode)
// and produces a valid image. Proves the cross-mode fallback works end-to-end.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { appendFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const outDir = process.env.OUT_DIR
const token = process.env.IMAGE_TASK_API_TOKEN
const apiUrl = process.env.IMAGE_TASK_API_URL
if (!outDir || !token || !apiUrl) throw new Error('OUT_DIR / IMAGE_TASK_API_TOKEN / IMAGE_TASK_API_URL required')
mkdirSync(outDir, { recursive: true })

const callsLog = join(outDir, 'mcp-calls.jsonl')
rmSync(callsLog, { force: true })
function redact(s) { return String(s == null ? '' : s).replace(/[A-Fa-f0-9]{32,}/g, '[REDACTED]').replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[REDACTED]').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]') }
function logCall(tool, args, result, error) {
  appendFileSync(callsLog, JSON.stringify({ ts: new Date().toISOString(), tool, args: JSON.parse(redact(JSON.stringify(args))), result: result ? JSON.parse(redact(JSON.stringify(result))) : null, error: error ? redact(String(error.message || error)) : null }) + '\n')
}

const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('server/task-api/mcp-server.mjs')], cwd: resolve('.'), env: { ...process.env, IMAGE_TASK_API_URL: apiUrl, IMAGE_TASK_API_TOKEN: token } })
const client = new Client({ name: 'xmode-fallback-probe', version: '1.0.0' })
await client.connect(transport)
async function call(name, args, timeoutMs) {
  let result = null, error = null
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined)
    const text = r.content?.find(i => i.type === 'text')?.text
    result = text ? JSON.parse(text) : r
  } catch (e) { error = e }
  logCall(name, args, result, error)
  if (error) throw new Error(`${name} failed: ${error.message}`)
  return result
}

// Chain: link 1 deterministically fails (mock provider), link 2 is real
// gpt-5.6-sol on responses mode. If cross-mode fallback works, the final
// image comes from link 2.
const CHAIN = [
  { label: 'link1-mock-fail', model: 'mock-v1', apiMode: 'images', provider: 'mock', testBehavior: 'fail' },
  { label: 'link2-real-responses', model: 'gpt-5.6-sol', apiMode: 'responses', provider: 'configured' },
]

const evidence = { startedAt: new Date().toISOString(), chain: CHAIN.map(c => ({ model: c.model, apiMode: c.apiMode, provider: c.provider })), attempts: [] }
try {
  let succeeded = false
  for (let i = 0; i < CHAIN.length && !succeeded; i++) {
    const t = CHAIN[i]
    const key = `xmode-probe:link${i + 1}:${t.model}:${t.apiMode}:001`
    const createArgs = {
      idempotencyKey: key, prompt: '极简绿色盆栽植物特写,柔和自然光,产品摄影,米白背景', ratio: '1:1', dimensions: '2880x2880',
      provider: t.provider, model: t.model, apiMode: t.apiMode,
      enhancement: 'lanczos3', contentClass: 'photo', maxAttempts: 3,
    }
    if (t.testBehavior) createArgs.testBehavior = t.testBehavior
    const create = await call('image_job_create', createArgs)
    const waited = await call('image_job_wait', { jobId: create.job.id, timeoutMs: 540000 }, 560000)
    evidence.attempts.push({
      link: t.label, model: t.model, apiMode: t.apiMode, provider: t.provider,
      jobId: create.job.id, state: waited.state, attempts: waited.attempts,
      error: waited.error ? { code: waited.error.code, providerCode: waited.error.providerCode, retryable: waited.error.retryable } : null,
    })
    console.log(`link ${i + 1} (${t.model}/${t.apiMode}): ${waited.state}${waited.error ? ' err=' + waited.error.code : ''}`)
    if (waited.state === 'succeeded') {
      succeeded = true
      evidence.succeededOnLink = i + 1
      evidence.fallbacksUsed = i
      const src = await call('image_asset_download', { assetId: waited.sourceAssetId, outputPath: join(outDir, 'fallback-source.png') })
      const fin = await call('image_asset_download', { assetId: waited.finalAssetId, outputPath: join(outDir, 'fallback-final.png') })
      evidence.finalModel = t.model
      evidence.finalApiMode = t.apiMode
      evidence.source = { width: src.manifest.width, height: src.manifest.height, sha256: src.manifest.sha256 }
      evidence.final = { width: fin.manifest.width, height: fin.manifest.height, sha256: fin.manifest.sha256 }
      evidence.jobId = create.job.id
    }
  }
  evidence.crossModeFallbackWorked = succeeded && evidence.succeededOnLink > 1 && evidence.attempts[0].state === 'failed'
  evidence.verdict = evidence.crossModeFallbackWorked ? 'PASS' : (succeeded ? 'NO-FALLBACK-NEEDED' : 'FAIL')
} catch (e) {
  evidence.fatalError = redact(String(e.message || e))
  evidence.verdict = 'BLOCKED'
} finally {
  await client.close()
}
evidence.finishedAt = new Date().toISOString()
writeFileSync(join(outDir, 'fallback-probe-evidence.json'), JSON.stringify(evidence, null, 2))
console.log('=== cross-mode fallback probe ===')
console.log('attempts:', evidence.attempts.length)
evidence.attempts.forEach(a => console.log(`  ${a.link}: ${a.state} (${a.model}/${a.apiMode})`))
console.log('cross-mode fallback worked:', evidence.crossModeFallbackWorked)
console.log('final model/apiMode:', evidence.finalModel + '/' + evidence.finalApiMode)
console.log('verdict:', evidence.verdict)
