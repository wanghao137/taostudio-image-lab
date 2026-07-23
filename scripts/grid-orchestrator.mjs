// 2x2 grid orchestrator via MCP path, with cross-mode fallback chain.
// Each cell tries a chain of {model, apiMode} targets; on terminal `failed`
// the next target is tried with a fresh idempotencyKey (old key is bound to
// the failed job). The canonical chain crosses from images mode (image
// models) to responses mode (text models that output images), e.g.
// gpt-image-2/images -> gpt-5.6-sol/responses.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { appendFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
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
const client = new Client({ name: 'grid-orchestrator', version: '1.0.0' })
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

const PROMPT_TEMPLATE = (input) => `2x2 grid cell concept — INPUT = "${input}". DECODE_PHENOMENON: Infer the tools, mental states, and environment of the INPUT. Translate these into physical, modular accessories. VISUAL_SYSTEM: TOY_KIT_EXPLODED_VIEW (Kaws/PopMart vinyl designer toy) + (Gundam runner sprue kit layout) + (Pastel Wes Anderson color palette). LAYOUT: 16:9. A flat-lay arrangement. The main figure representing the INPUT lies disassembled on a plastic runner frame. Around it, perfectly organized in molded plastic cavities, are its inferred "accessories" (e.g., tiny glowing screens, coffee cups, weighted chains for anxiety, etc.). EXECUTION: Everything must look like pristine, injection-molded matte and gloss vinyl. Include a small, elegant paper instruction manual folded in the corner. Flawless studio overhead lighting, satisfying geometric spacing, highly tactile. Single cell of a 2x2 grid, so leave clean margins and do not overlap neighboring cells.`

const PROFESSIONS = [
  { id: 'p1', name: 'The Modern Prompt Engineer' },
  { id: 'p2', name: 'Robot Engineer' },
  { id: 'p3', name: 'The Creative Process' },
  { id: 'p4', name: 'Nikola Tesla' },
]
const FINAL_SIZE = '3840x2160'

// Cross-mode fallback chain: first try an image model on the images endpoint,
// then a text model on the responses endpoint. Crossing modes is the point —
// a different model AND a different apiMode give a genuinely independent retry.
const FALLBACK_CHAIN = [
  { model: 'gpt-image-2', apiMode: 'images', baseSize: '1280x720' },
  { model: 'gpt-5.6-sol', apiMode: 'responses', baseSize: '1280x720' },
]

const results = []
const startedAt = new Date().toISOString()

try {
  for (const prof of PROFESSIONS) {
    const attemptLog = []
    let succeeded = false
    for (let ti = 0; ti < FALLBACK_CHAIN.length && !succeeded; ti++) {
      const target = FALLBACK_CHAIN[ti]
      const key = `grid-xmode:${prof.id}:${target.model}:${target.apiMode}:${FINAL_SIZE}:001`
      attemptLog.push({ ...target, key, t0: new Date().toISOString() })
      const create = await call('image_job_create', {
        idempotencyKey: key, prompt: PROMPT_TEMPLATE(prof.name), ratio: '16:9', dimensions: FINAL_SIZE,
        provider: 'configured', model: target.model, apiMode: target.apiMode,
        enhancement: 'lanczos3', contentClass: 'illustration', maxAttempts: 3,
      })
      const jobId = create.job.id
      let waited
      try {
        waited = await call('image_job_wait', { jobId, timeoutMs: 540000 }, 560000)
      } catch (e) {
        attemptLog[attemptLog.length - 1].waitError = String(e.message || e)
        continue
      }
      attemptLog[attemptLog.length - 1].state = waited.state
      attemptLog[attemptLog.length - 1].attempts = waited.attempts
      attemptLog[attemptLog.length - 1].error = waited.error || null
      attemptLog[attemptLog.length - 1].jobId = jobId
      if (waited.state === 'succeeded') {
        succeeded = true
        const src = await call('image_asset_download', { assetId: waited.sourceAssetId, outputPath: join(outDir, `${prof.id}-source.png`) })
        const fin = await call('image_asset_download', { assetId: waited.finalAssetId, outputPath: join(outDir, `${prof.id}-final.png`) })
        results.push({
          profession: prof.name, id: prof.id, success: true,
          finalModel: target.model, finalApiMode: target.apiMode, fallbacksUsed: ti,
          jobId, sourceAssetId: waited.sourceAssetId, finalAssetId: waited.finalAssetId,
          source: src.manifest, final: fin.manifest, attempts: waited.attempts,
          attemptChain: attemptLog,
        })
      }
      // else: failed -> loop to next fallback target (different model + apiMode)
    }
    if (!succeeded) {
      results.push({ profession: prof.name, id: prof.id, success: false, fallbacksUsed: FALLBACK_CHAIN.length, attemptChain: attemptLog })
    }
  }
} catch (e) {
  results.push({ fatal: true, error: redact(String(e.message || e)) })
} finally {
  await client.close()
}

const summary = {
  startedAt, finishedAt: new Date().toISOString(),
  finalSize: FINAL_SIZE, fallbackChain: FALLBACK_CHAIN,
  professions: PROFESSIONS.map(p => p.name),
  results,
  successCount: results.filter(r => r.success).length,
}
writeFileSync(join(outDir, 'grid-evidence.json'), JSON.stringify(summary, null, 2))
console.log('=== 2x2 grid (cross-mode fallback) summary ===')
for (const r of results) {
  if (r.fatal) { console.log('FATAL:', r.error); continue }
  const tag = r.success ? 'OK' : 'FAIL'
  const targetInfo = r.success ? `${r.finalModel}/${r.finalApiMode}${r.fallbacksUsed > 0 ? ` (cross-mode fallback #${r.fallbacksUsed})` : ''}` : 'all targets failed'
  console.log(`[${tag}] ${r.profession} -> ${targetInfo}`)
}
console.log(`success: ${summary.successCount}/${PROFESSIONS.length}`)
