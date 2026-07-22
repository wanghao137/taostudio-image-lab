import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import sharp from 'sharp'
import { createTaskApi } from '../server/task-api/service.mjs'
import { calculateImageSize, parseImageSize, ratioMatchesExactly } from '../packages/image-job-core/index.mjs'

const outputRoot = process.argv[2] ? resolve(process.argv[2]) : null
const skillRoot = process.argv[3] ? resolve(process.argv[3]) : null
if (!outputRoot || !skillRoot) {
  throw new Error('usage: node scripts/run-youmind-batch.mjs <output-directory> <independent-skill-directory>')
}

async function loadEnvironment(path) {
  const values = {}
  const content = await readFile(path, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return values
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function mcpPayload(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text
  if (!text) throw new Error('MCP tool returned no text payload')
  return JSON.parse(text)
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timeout = setTimeout(() => child.kill(), options.timeoutMs ?? 900_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`${basename(command)} exited ${code}: ${stderr || stdout}`))
    })
  })
}

const environment = await loadEnvironment(resolve('.env.local'))
const baseUrl = process.env.IMAGE_TASK_PROVIDER_BASE_URL || environment.IMAGE_API_BASE_URL
const apiKey = process.env.IMAGE_TASK_PROVIDER_API_KEY || environment.IMAGE_API_KEY
const model = process.env.IMAGE_TASK_PROVIDER_MODEL || 'gpt-image-2'
const maxAttempts = Number(process.env.YOUMIND_MAX_ATTEMPTS || 5)
const taskConcurrency = Number(process.env.YOUMIND_TASK_CONCURRENCY || 1)
const batchRunId = process.env.YOUMIND_RUN_ID || randomUUID()
if (!baseUrl || !apiKey) throw new Error('real provider configuration is unavailable')
if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new Error('YOUMIND_MAX_ATTEMPTS must be an integer from 1 to 5')
if (!Number.isInteger(taskConcurrency) || taskConcurrency < 1) throw new Error('YOUMIND_TASK_CONCURRENCY must be a positive integer')

const promptManifestPath = resolve(outputRoot, 'inputs', 'youmind-prompts.json')
const promptManifest = JSON.parse(await readFile(promptManifestPath, 'utf8'))
const promptOverridesPath = resolve(outputRoot, 'inputs', 'prompt-overrides.json')
const promptOverrides = await readFile(promptOverridesPath, 'utf8')
  .then(JSON.parse)
  .catch((error) => {
    if (error?.code === 'ENOENT') return { version: 1, overrides: {} }
    throw error
  })
if (promptOverrides.version !== 1 || !promptOverrides.overrides || typeof promptOverrides.overrides !== 'object') {
  throw new Error('prompt-overrides.json must contain version 1 and an overrides object')
}
const resultsRoot = resolve(outputRoot, 'results')
const stateDir = process.env.YOUMIND_STATE_DIR
  ? resolve(process.env.YOUMIND_STATE_DIR)
  : resolve(outputRoot, 'task-api-state')
await mkdir(resultsRoot, { recursive: true })

const token = randomUUID()
const taskApi = await createTaskApi({
  stateDir,
  token,
  concurrency: taskConcurrency,
  providerTimeoutMs: 300_000,
  providerRetryBaseMs: 15_000,
  providerConfig: { baseUrl, apiKey, model },
})
const address = await taskApi.listen(0)
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const mcpTransport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('server/task-api/mcp-server.mjs')],
  cwd: resolve('.'),
  env: { ...process.env, IMAGE_TASK_API_URL: address.url, IMAGE_TASK_API_TOKEN: token },
})
const mcpClient = new Client({ name: 'taostudio-youmind-batch', version: '1.0.0' })
await mcpClient.connect(mcpTransport)

async function api(path, init = {}) {
  const response = await fetch(new URL(path, address.url), {
    ...init,
    headers: { ...headers, ...init.headers },
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`)
  }
  return response
}

async function waitForJob(id, timeoutMs = 2_100_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const job = await (await api(`/v1/image-jobs/${encodeURIComponent(id)}`)).json()
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
  }
  throw new Error(`job ${id} did not finish before timeout`)
}

async function downloadApiAsset(assetId, outputPath) {
  const response = await api(`/v1/assets/${encodeURIComponent(assetId)}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(outputPath, buffer)
  const manifest = await (await api(`/v1/assets/${encodeURIComponent(assetId)}?manifest=1`)).json()
  return { buffer, manifest }
}

async function callMcp(name, args) {
  return mcpPayload(await mcpClient.callTool(
    { name, arguments: args },
    undefined,
    { timeout: 1_830_000, maxTotalTimeout: 1_830_000 },
  ))
}

async function verifyFiles(task, sourcePath, finalPath, sourceManifest = null, finalManifest = null) {
  const sourceBuffer = await readFile(sourcePath)
  const finalBuffer = await readFile(finalPath)
  const source = await sharp(sourceBuffer).metadata()
  const final = await sharp(finalBuffer).metadata()
  const target = parseImageSize(task.dimensions)
  if (source.format !== 'png' || final.format !== 'png') throw new Error('source and final must be PNG')
  if (final.width !== target.width || final.height !== target.height) {
    throw new Error(`final dimensions ${final.width}x${final.height} do not equal ${task.dimensions}`)
  }
  if (!ratioMatchesExactly(source, final)) {
    throw new Error(`ratio mismatch: source ${source.width}x${source.height}, final ${final.width}x${final.height}`)
  }
  const sourceHash = sha256(sourceBuffer)
  const finalHash = sha256(finalBuffer)
  if (sourceManifest?.sha256 && sourceManifest.sha256 !== sourceHash) throw new Error('source SHA-256 mismatch')
  if (finalManifest?.sha256 && finalManifest.sha256 !== finalHash) throw new Error('final SHA-256 mismatch')
  return {
    source: { width: source.width, height: source.height, bytes: sourceBuffer.length, sha256: sourceHash },
    final: { width: final.width, height: final.height, bytes: finalBuffer.length, sha256: finalHash },
    ratioPreserved: true,
  }
}

function resolvePrompt(task) {
  const override = promptOverrides.overrides[task.id]
  const originalPrompt = task.prompt.trim()
  if (!override) {
    const originalSha256 = sha256(Buffer.from(originalPrompt, 'utf8'))
    return {
      effectivePrompt: originalPrompt,
      audit: { overrideApplied: false, originalSha256, effectiveSha256: originalSha256, summary: null },
    }
  }
  if (typeof override.contextPrefix !== 'string' || !override.contextPrefix.trim() || typeof override.summary !== 'string' || !override.summary.trim()) {
    throw new Error(`prompt override ${task.id} requires non-empty contextPrefix and summary strings`)
  }
  if (override.replacements !== undefined && !Array.isArray(override.replacements)) {
    throw new Error(`prompt override ${task.id} replacements must be an array`)
  }
  let rewrittenPrompt = originalPrompt
  for (const [index, replacement] of (override.replacements || []).entries()) {
    if (typeof replacement?.from !== 'string' || !replacement.from || typeof replacement?.to !== 'string' || !replacement.to) {
      throw new Error(`prompt override ${task.id} replacement ${index + 1} requires from and to strings`)
    }
    if (!rewrittenPrompt.includes(replacement.from)) {
      throw new Error(`prompt override ${task.id} replacement ${index + 1} did not match the original prompt`)
    }
    rewrittenPrompt = rewrittenPrompt.replaceAll(replacement.from, replacement.to)
  }
  const effectivePrompt = `${override.contextPrefix.trim()}\n\n${rewrittenPrompt}`
  return {
    effectivePrompt,
    audit: {
      overrideApplied: true,
      originalSha256: sha256(Buffer.from(originalPrompt, 'utf8')),
      effectiveSha256: sha256(Buffer.from(effectivePrompt, 'utf8')),
      replacementCount: override.replacements?.length ?? 0,
      summary: override.summary.trim(),
    },
  }
}

async function runApiTask(task, taskDir, effectivePrompt) {
  const response = await api('/v1/image-jobs', {
    method: 'POST',
    body: JSON.stringify({
      contractVersion: '1',
      idempotencyKey: `youmind:${batchRunId}:api:${task.id}:${task.slug}`,
      input: { prompt: effectivePrompt },
      composition: { ratio: task.ratio },
      generation: { provider: 'configured', model, baseSize: calculateImageSize('1K', task.ratio) },
      output: { ratioMode: 'inherit', format: 'png', quality: 'high', dimensions: task.dimensions, enhancement: 'lanczos3', contentClass: task.contentClass },
      retry: { maxAttempts },
    }),
  })
  const created = await response.json()
  const job = await waitForJob(created.id)
  if (job.state !== 'succeeded') throw new Error(`API job failed: ${JSON.stringify(job.error)}`)
  const sourcePath = resolve(taskDir, 'source.png')
  const finalPath = resolve(taskDir, 'final.png')
  const source = await downloadApiAsset(job.sourceAssetId, sourcePath)
  const final = await downloadApiAsset(job.finalAssetId, finalPath)
  return {
    job,
    sourcePath,
    finalPath,
    sourceManifest: source.manifest,
    finalManifest: final.manifest,
    verification: await verifyFiles(task, sourcePath, finalPath, source.manifest, final.manifest),
  }
}

async function runMcpTask(task, taskDir, effectivePrompt) {
  const created = await callMcp('image_job_create', {
    idempotencyKey: `youmind:${batchRunId}:mcp:${task.id}:${task.slug}`,
    prompt: effectivePrompt,
    ratio: task.ratio,
    dimensions: task.dimensions,
    provider: 'configured',
    model,
    enhancement: 'lanczos3',
    contentClass: task.contentClass,
    maxAttempts,
  })
  let job
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      job = await callMcp('image_job_wait', { jobId: created.job.id, timeoutMs: 1_800_000 })
      break
    } catch (error) {
      if (attempt === 1) throw error
    }
  }
  if (job.state !== 'succeeded') throw new Error(`MCP job failed: ${JSON.stringify(job.error)}`)
  const sourcePath = resolve(taskDir, 'source.png')
  const finalPath = resolve(taskDir, 'final.png')
  const source = await callMcp('image_asset_download', { assetId: job.sourceAssetId, outputPath: sourcePath })
  const final = await callMcp('image_asset_download', { assetId: job.finalAssetId, outputPath: finalPath })
  return {
    job,
    sourcePath,
    finalPath,
    sourceManifest: source.manifest,
    finalManifest: final.manifest,
    verification: await verifyFiles(task, sourcePath, finalPath, source.manifest, final.manifest),
  }
}

async function runSkillTask(task, taskDir, effectivePromptFile) {
  const finalPath = resolve(taskDir, 'final.png')
  const reportPath = resolve(taskDir, 'skill-report.json')
  await runProcess('py', [
    '-3', resolve(skillRoot, 'scripts', 'run_image_job.py'),
    '--backend', 'task-api',
    '--prompt-file', effectivePromptFile,
    '--model', model,
    '--provider', 'configured',
    '--size', task.dimensions,
    '--quality', 'high',
    '--output-format', 'png',
    '--content-class', task.contentClass,
    '--enhancement', 'lanczos3',
    '--idempotency-key', `youmind-${batchRunId}-skill-${task.id}-${task.slug}`,
    '--max-attempts', String(maxAttempts),
    '--out', finalPath,
    '--report', reportPath,
    '--force',
  ], {
    cwd: skillRoot,
    timeoutMs: 2_100_000,
    env: { ...process.env, IMAGE_TASK_API_URL: address.url, IMAGE_TASK_API_TOKEN: token },
  })
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  if (!['completed', 'succeeded'].includes(report.status)) throw new Error(`Skill job failed: ${report.status}`)
  const sourcePath = report.source?.path || report.source_path || report.source_out
  if (!sourcePath) throw new Error('Skill report did not include a source image path')
  const job = report.image_job_id ? await (await api(`/v1/image-jobs/${encodeURIComponent(report.image_job_id)}`)).json() : null
  return {
    job,
    report,
    sourcePath,
    finalPath,
    sourceManifest: report.source_manifest,
    finalManifest: report.final_manifest,
    verification: await verifyFiles(task, sourcePath, finalPath, report.source_manifest, report.final_manifest),
  }
}

const requestedIds = new Set((process.env.YOUMIND_TASK_IDS || '').split(',').map((value) => value.trim()).filter(Boolean))
const selectedTasks = requestedIds.size
  ? promptManifest.tasks.filter((task) => requestedIds.has(task.id))
  : promptManifest.tasks
if (!selectedTasks.length) throw new Error('YOUMIND_TASK_IDS did not match any manifest tasks')
const aggregate = {
  version: 1,
  runId: batchRunId,
  startedAt: new Date().toISOString(),
  sourceManifest: promptManifestPath,
  provider: { model, concurrency: taskConcurrency, maxAttempts },
  promptOverrides: { path: promptOverridesPath, configured: Object.keys(promptOverrides.overrides).length },
  totals: { planned: selectedTasks.length, succeeded: 0, failed: 0 },
  results: [],
}
const aggregatePath = resolve(outputRoot, 'batch-results.json')

async function runTask(task) {
  const taskDir = resolve(resultsRoot, `${task.id}-${task.slug}`)
  await mkdir(taskDir, { recursive: true })
  const { effectivePrompt, audit: promptAudit } = resolvePrompt(task)
  const originalPromptPath = resolve(taskDir, 'original-prompt.txt')
  const effectivePromptPath = resolve(taskDir, 'effective-prompt.txt')
  await writeFile(originalPromptPath, `${task.prompt.trim()}\n`, 'utf8')
  await writeFile(effectivePromptPath, `${effectivePrompt}\n`, 'utf8')
  const resultPath = resolve(taskDir, 'result.json')
  const existing = await readFile(resultPath, 'utf8').then(JSON.parse).catch(() => null)
  if (existing?.status === 'succeeded' && !promptAudit.overrideApplied) {
    const verification = await verifyFiles(task, existing.sourcePath, existing.finalPath)
    const verifiedExisting = { ...existing, promptAudit, verification }
    await writeFile(resultPath, JSON.stringify(verifiedExisting, null, 2), 'utf8')
    aggregate.results.push(verifiedExisting)
    aggregate.totals.succeeded += 1
    console.log(`[${aggregate.totals.succeeded + aggregate.totals.failed}/${aggregate.totals.planned}] SKIP ${task.id} ${task.route} ${task.ratio} ${task.title}`)
    return
  }
  const startedAt = new Date().toISOString()
  try {
    const runner = task.route === 'api' ? runApiTask : task.route === 'mcp' ? runMcpTask : runSkillTask
    const result = await runner(task, taskDir, task.route === 'skill' ? effectivePromptPath : effectivePrompt)
    const evidence = {
      id: task.id,
      title: task.title,
      sourceUrl: task.sourceUrl,
      route: task.route,
      ratio: task.ratio,
      dimensions: task.dimensions,
      contentClass: task.contentClass,
      promptAudit,
      status: 'succeeded',
      startedAt,
      finishedAt: new Date().toISOString(),
      jobId: result.job?.id || result.report?.image_job_id || result.report?.task_api?.job_id,
      attempts: result.job?.attempts,
      sourcePath: result.sourcePath,
      finalPath: result.finalPath,
      sourceTransform: result.sourceManifest?.transform ?? null,
      verification: result.verification,
    }
    await writeFile(resultPath, JSON.stringify(evidence, null, 2), 'utf8')
    aggregate.results.push(evidence)
    aggregate.totals.succeeded += 1
    console.log(`[${aggregate.totals.succeeded + aggregate.totals.failed}/${aggregate.totals.planned}] PASS ${task.id} ${task.route} ${task.ratio} ${task.title}`)
  } catch (error) {
    const evidence = {
      id: task.id,
      title: task.title,
      sourceUrl: task.sourceUrl,
      route: task.route,
      ratio: task.ratio,
      dimensions: task.dimensions,
      contentClass: task.contentClass,
      promptAudit,
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }
    await writeFile(resultPath, JSON.stringify(evidence, null, 2), 'utf8')
    aggregate.results.push(evidence)
    aggregate.totals.failed += 1
    console.error(`[${aggregate.totals.succeeded + aggregate.totals.failed}/${aggregate.totals.planned}] FAIL ${task.id} ${task.route} ${task.ratio}: ${evidence.error}`)
  } finally {
    aggregate.results.sort((left, right) => left.id.localeCompare(right.id))
    await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2), 'utf8')
  }
}

try {
  const byRoute = new Map(['api', 'mcp', 'skill'].map((route) => [route, selectedTasks.filter((task) => task.route === route)]))
  await Promise.all([...byRoute.values()].map(async (tasks) => {
    for (const task of tasks) await runTask(task)
  }))
} finally {
  aggregate.finishedAt = new Date().toISOString()
  aggregate.results.sort((left, right) => left.id.localeCompare(right.id))
  await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2), 'utf8')
  await mcpClient.close()
  await taskApi.close()
}

if (aggregate.totals.failed) process.exitCode = 1
console.log(JSON.stringify({ output: aggregatePath, totals: aggregate.totals }, null, 2))
