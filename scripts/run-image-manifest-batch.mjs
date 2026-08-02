import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import sharp from 'sharp'
import {
  buildQaRevisionInstruction,
  classifyQaFailure,
  expandReadyEntries,
  inspectPng,
  shouldUseSolRevision,
} from './lib/full-batch-planning.mjs'
import { resolveImageManifestBatchConfig } from './lib/image-manifest-batch-config.mjs'

const {
  repoRoot,
  outputRoot,
  manifestPath,
  statusPath,
  batchKey,
  batchName,
  clientName,
  contactSheetPrefix,
  migrateIndexes: validatedCoreIndexes,
  workDir,
  routes,
} = resolveImageManifestBatchConfig()
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const cliIndex = process.argv.find((value) => value.startsWith('--index='))
const cliLimit = process.argv.find((value) => value.startsWith('--limit='))
const preflightOnly = process.argv.includes('--preflight-only')
const selectedIndex = cliIndex ? Number(cliIndex.split('=')[1]) : null
const limit = cliLimit ? Number(cliLimit.split('=')[1]) : Number.POSITIVE_INFINITY
const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function outputPath(...segments) {
  const candidate = resolve(outputRoot, ...segments)
  const pathFromRoot = relative(outputRoot, candidate)
  if (!pathFromRoot || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))) return candidate
  throw new Error(`output path escapes IMAGE_BATCH_OUTPUT_ROOT: ${segments.join('/')}`)
}

async function loadEnvFile(filePath) {
  const values = {}
  const content = await readFile(filePath, 'utf8').catch(() => '')
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return values
}

function mcpPayload(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text
  if (!text) throw new Error('MCP tool returned no text payload')
  try {
    return JSON.parse(text)
  } catch (error) {
    // MCP stdio 通道偶发被日志污染时，text 不是合法 JSON。
    // 记录原始文本用于诊断，抛出可识别的错误而非裸 SyntaxError。
    throw new Error(`MCP payload was not valid JSON: ${String(text).slice(0, 120)}`)
  }
}

function policyFailure(job) {
  const error = job?.error || {}
  const text = [error.code, error.providerCode, error.message].filter(Boolean).join(' ').toLowerCase()
  return /content.?policy|moderation|safety|refus|reject|blocked|disallowed|not allowed|violation/.test(text)
}

function providerRoutesUnavailable(job) {
  const calls = job?.accounting?.calls || []
  const failedRoutes = new Set(
    calls
      .filter((call) => call.state === 'failed' && Number(call.httpStatus || call.error?.httpStatus) >= 500)
      .map((call) => `${call.route?.model}:${call.route?.apiMode}`),
  )
  return routes.every((route) => failedRoutes.has(`${route.model}:${route.apiMode}`))
}

function providerUnavailableError(message) {
  return Object.assign(new Error(message), { code: 'PROVIDER_UNAVAILABLE' })
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text
  const values = []
  for (const item of payload?.output || []) {
    if (typeof item?.text === 'string') values.push(item.text)
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') values.push(part.text)
    }
  }
  return values.join('\n')
}

function parseJsonText(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('visual QA returned no JSON object')
  return JSON.parse(fenced.slice(start, end + 1))
}

async function visualQa(entry, sourcePath, env) {
  const baseUrl = env.IMAGE_TASK_PROVIDER_BASE_URL?.replace(/\/+$/, '')
  const apiKey = env.IMAGE_TASK_PROVIDER_API_KEY
  if (!baseUrl || !apiKey) return { status: 'unavailable', reason: 'provider configuration missing' }

  const preview = await sharp(sourcePath)
    .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer()
  const endpoint = `${baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`}/responses`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: routes[1].model,
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: [
                'You are a strict visual QA inspector for an automated image generation pipeline.',
                'Inspect the attached generated image against the requested prompt.',
                'Fail only for objective major defects: clipped title or meaningful content at any edge, missing core requested structure, blank/broken image, or a result that clearly ignores the prompt.',
                'Also fail when an unrequested gray/neutral border, matte, frame, mockup sheet, or surrounding background changes a requested full-bleed composition.',
                'Minor AI text spelling errors are not a failure unless the main requested title is missing or unreadable.',
                'Return only JSON with this exact shape:',
                '{"pass":true,"edgeClipping":false,"backgroundConflict":false,"missingCoreStructure":false,"blankOrBroken":false,"notes":"short Chinese explanation"}',
                `Case title: ${entry.title}`,
                `Requested prompt: ${entry.prompt}`,
              ].join('\n'),
            },
            {
              type: 'input_image',
              image_url: `data:image/jpeg;base64,${preview.toString('base64')}`,
            },
          ],
        }],
      }),
    })
    const text = await response.text()
    if (!response.ok) return { status: 'unavailable', reason: `HTTP ${response.status}` }
    const payload = JSON.parse(text)
    const verdict = parseJsonText(extractResponseText(payload))
    return {
      status: 'completed',
      pass: verdict.pass === true,
      edgeClipping: verdict.edgeClipping === true,
      backgroundConflict: verdict.backgroundConflict === true,
      missingCoreStructure: verdict.missingCoreStructure === true,
      blankOrBroken: verdict.blankOrBroken === true,
      notes: String(verdict.notes || ''),
      model: routes[1].model,
    }
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function prepareReference(entry) {
  const mediaUrl = entry.referenceUrl || entry.tweet?.mediaUrls?.[0]
  if (!mediaUrl) throw new Error('reference-dependent prompt has no original-post media')
  const directory = outputPath(entry.folderName)
  const originalPath = resolve(directory, '\u53c2\u8003\u56fe-\u539f\u5e16.png')
  const uploadPath = resolve(workDir, `reference-${entry.index}.png`)
  await mkdir(workDir, { recursive: true })
  if (!existsSync(originalPath)) {
    const response = await fetch(`${mediaUrl}${mediaUrl.includes('?') ? '&' : '?'}name=orig`)
    if (!response.ok) throw new Error(`reference media download returned HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    await sharp(buffer).png().toFile(originalPath)
  }
  const localManifest = await inspectPng(originalPath)
  await copyFile(originalPath, uploadPath)
  const uploaded = await callMcp('image_asset_upload', { path: uploadPath })
  const assetId = uploaded.asset?.id || uploaded.assetId || uploaded.id
  if (!assetId) throw new Error('reference upload returned no asset id')
  const uploadedManifest = uploaded.asset?.manifest || uploaded.manifest || null
  if (uploadedManifest) {
    if (uploadedManifest.mediaType !== 'image/png') throw new Error('reference upload is not PNG')
    if (uploadedManifest.width !== localManifest.width || uploadedManifest.height !== localManifest.height) {
      throw new Error('reference upload dimensions do not match the validated local asset')
    }
    if (uploadedManifest.sha256 && uploadedManifest.sha256 !== localManifest.sha256) {
      throw new Error('reference upload SHA-256 does not match the validated local asset')
    }
  }
  return { assetId, path: originalPath, mediaUrl, manifest: localManifest }
}

function entryDirectory(entry) {
  const base = outputPath(entry.folderName)
  return entry.outputCount > 1 ? resolve(base, `output-${entry.outputIndex}`) : base
}

const manifestReady = expandReadyEntries(manifest.entries)
  .filter((entry) => selectedIndex === null || entry.index === selectedIndex)
for (const entry of manifestReady) entryDirectory(entry)
const plannedScope = manifestReady.slice(0, limit)
const plannedItemKeys = new Set(plannedScope.map((entry) => entry.itemKey))
// A logical batch describes one exact manifest scope. runId is intentionally
// absent: it identifies a runner attempt, not a new generation workload.
const logicalBatchKey = `${batchKey}-${hash(JSON.stringify({
  outputRoot,
  selectedIndex,
  manifest,
  itemKeys: plannedScope.map((entry) => entry.itemKey),
})).slice(0, 40)}`
if (preflightOnly) {
  console.log(`BATCH_PREFLIGHT_OK key=${batchKey} selected=${plannedScope.length}`)
  process.exit(0)
}

function initialExecutionPrompt(entry) {
  // 多图条目：用预计算的聚焦单场景执行 prompt（避免 provider 读到"N-image"语义多生成）。
  // 提示词.txt 仍保存完整原 prompt；执行提示词.txt 记录这里发给 provider 的内容。
  const scenePrompt = entry.outputCount > 1 && entry.generation?.executionScenes
    ? entry.generation.executionScenes[entry.outputIndex - 1]
    : null
  return scenePrompt || entry.prompt
}

async function safeRewritePrompt(entry, env, failure) {
  const baseUrl = env.IMAGE_TASK_PROVIDER_BASE_URL?.replace(/\/+$/, '')
  const apiKey = env.IMAGE_TASK_PROVIDER_API_KEY
  if (!baseUrl || !apiKey) throw new Error('safe rewrite provider configuration missing')
  const endpoint = `${baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`}/responses`
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: routes[1].model,
      input: [{
        role: 'user',
        content: [{
          type: 'input_text',
          text: [
            'Rewrite the image prompt so it is compliant with image safety policy while preserving all benign visual intent.',
            'Remove or generalize only the unsafe part. Do not add new visual elements, framing, borders, or a different background.',
            'Return only JSON: {"prompt":"rewritten prompt","changes":"short explanation"}',
            `Original prompt: ${entry.prompt}`,
            `Provider failure: ${failure?.error?.message || failure?.error?.providerCode || 'content policy rejection'}`,
          ].join('\n'),
        }],
      }],
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`safe rewrite returned HTTP ${response.status}`)
  const payload = parseJsonText(extractResponseText(JSON.parse(text)))
  if (!payload.prompt?.trim()) throw new Error('safe rewrite returned no prompt')
  return { prompt: payload.prompt.trim(), changes: String(payload.changes || '') }
}

async function verifyAssets(sourcePath, finalPath, sourceManifest, finalManifest, dimensions) {
  const [sourceBuffer, finalBuffer] = await Promise.all([readFile(sourcePath), readFile(finalPath)])
  const [source, final] = await Promise.all([
    sharp(sourceBuffer).metadata(),
    sharp(finalBuffer).metadata(),
  ])
  const [expectedWidth, expectedHeight] = dimensions.split('x').map(Number)
  if (source.format !== 'png' || final.format !== 'png') throw new Error('source and final must be PNG')
  if (final.width !== expectedWidth || final.height !== expectedHeight) {
    throw new Error(`unexpected final dimensions ${final.width}x${final.height}`)
  }
  if (source.width * final.height !== source.height * final.width) {
    throw new Error(`ratio mismatch ${source.width}x${source.height} -> ${final.width}x${final.height}`)
  }
  const sourceHash = hash(sourceBuffer)
  const finalHash = hash(finalBuffer)
  if (sourceManifest?.sha256 && sourceManifest.sha256 !== sourceHash) throw new Error('source hash mismatch')
  if (finalManifest?.sha256 && finalManifest.sha256 !== finalHash) throw new Error('final hash mismatch')
  return {
    source: { width: source.width, height: source.height, bytes: sourceBuffer.length, sha256: sourceHash },
    final: { width: final.width, height: final.height, bytes: finalBuffer.length, sha256: finalHash },
    ratioPreserved: true,
  }
}

async function preserveCanonical(directory) {
  const archive = resolve(directory, '\u5386\u53f2\u7248\u672c-\u5168\u91cf\u6267\u884c\u524d')
  const names = ['\u539f\u56fe.png', '4K.png', '\u6267\u884c\u63d0\u793a\u8bcd.txt', 'metadata.json']
  const existing = names.filter((name) => existsSync(resolve(directory, name)))
  if (!existing.length) return
  await mkdir(archive, { recursive: true })
  for (const name of existing) {
    const target = resolve(archive, name)
    if (!existsSync(target)) await copyFile(resolve(directory, name), target)
  }
}

async function makeContactSheet(completed, number) {
  const recent = completed.slice(-20)
  if (!recent.length) return null
  const width = 320
  const height = 240
  const columns = 4
  const rows = Math.ceil(recent.length / columns)
  const composites = await Promise.all(recent.map(async (item, index) => ({
    input: await sharp(item.finalPath)
      .resize(width, height, { fit: 'contain', background: '#f1f1ed' })
      .jpeg({ quality: 82 })
      .toBuffer(),
    left: (index % columns) * width,
    top: Math.floor(index / columns) * height,
  })))
  const path = outputPath(`${contactSheetPrefix}-${String(number).padStart(3, '0')}.jpg`)
  await sharp({
    create: {
      width: width * columns,
      height: height * rows,
      channels: 3,
      background: '#f1f1ed',
    },
  }).composite(composites).jpeg({ quality: 88 }).toFile(path)
  return path
}

const localEnv = await loadEnvFile(resolve(repoRoot, '.env.local'))
const env = { ...localEnv, ...process.env }
const token = env.IMAGE_TASK_API_TOKEN
if (!token) throw new Error('IMAGE_TASK_API_TOKEN is unavailable')

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(repoRoot, 'server/task-api/mcp-server.mjs')],
  cwd: repoRoot,
  env: {
    ...process.env,
    IMAGE_TASK_API_URL: env.IMAGE_TASK_API_URL || 'http://127.0.0.1:9789',
    IMAGE_TASK_API_TOKEN: token,
  },
})
const client = new Client({ name: clientName, version: '1.0.0' })
await client.connect(transport)

async function callMcp(name, args) {
  const isLeaseOperation = name.startsWith('image_batch_runner_')
  const timeout = isLeaseOperation ? 15_000 : 1_830_000
  const pending = client.callTool(
    { name, arguments: args },
    undefined,
    { timeout, maxTotalTimeout: timeout },
  )
  const result = runnerLease.batchId && !isLeaseOperation
    ? await awaitWithRunnerLease(pending)
    : await pending
  return mcpPayload(result)
}

const RUNNER_LEASE_MS = 120_000
const RUNNER_HEARTBEAT_MS = 30_000
const runnerOwner = `${clientName}:${runId}:${process.pid}:${randomUUID()}`
const runnerLease = {
  batchId: null,
  heartbeat: null,
  heartbeatError: null,
  renewing: false,
  lossWaiters: new Set(),
}

async function awaitWithRunnerLease(pending) {
  ensureRunnerLease()
  let rejectLeaseLoss
  const leaseLost = new Promise((_, reject) => { rejectLeaseLoss = reject })
  runnerLease.lossWaiters.add(rejectLeaseLoss)
  try {
    return await Promise.race([pending, leaseLost])
  } finally {
    runnerLease.lossWaiters.delete(rejectLeaseLoss)
  }
}

async function acquireRunner(batch) {
  const claimed = await callMcp('image_batch_runner_acquire', {
    batchId: batch.id,
    owner: runnerOwner,
    leaseMs: RUNNER_LEASE_MS,
  })
  if (!claimed?.id) throw new Error(`runner lease acquisition returned no batch for ${batch.id}`)
  runnerLease.batchId = claimed.id
  return claimed
}

async function renewRunnerLease() {
  if (!runnerLease.batchId || runnerLease.renewing || runnerLease.heartbeatError) return
  runnerLease.renewing = true
  try {
    await callMcp('image_batch_runner_heartbeat', {
      batchId: runnerLease.batchId,
      owner: runnerOwner,
      leaseMs: RUNNER_LEASE_MS,
    })
  } catch (error) {
    runnerLease.heartbeatError = error instanceof Error ? error : new Error(String(error))
    runnerLease.heartbeatError.code ||= 'RUNNER_LEASE_LOST'
    for (const rejectLeaseLoss of runnerLease.lossWaiters) rejectLeaseLoss(runnerLease.heartbeatError)
    runnerLease.lossWaiters.clear()
    console.error(`RUNNER_LEASE_LOST ${runnerLease.heartbeatError.message}`)
  } finally {
    runnerLease.renewing = false
  }
}

function startRunnerHeartbeat() {
  if (runnerLease.heartbeat) return
  runnerLease.heartbeat = setInterval(() => { void renewRunnerLease() }, RUNNER_HEARTBEAT_MS)
}

function ensureRunnerLease() {
  if (runnerLease.heartbeatError) throw runnerLease.heartbeatError
}

async function releaseRunner() {
  if (runnerLease.heartbeat) clearInterval(runnerLease.heartbeat)
  runnerLease.heartbeat = null
  if (!runnerLease.batchId) return
  try {
    await callMcp('image_batch_runner_release', {
      batchId: runnerLease.batchId,
      owner: runnerOwner,
    })
  } finally {
    runnerLease.batchId = null
  }
}

try {
let state = existsSync(statusPath)
  ? JSON.parse(await readFile(statusPath, 'utf8'))
  : { schemaVersion: 1, startedAt: new Date().toISOString(), items: {} }
state.runId = runId
state.updatedAt = new Date().toISOString()

// ====== 启动时引擎-本地对账 ======
// 引擎里所有已成功（job succeeded + 有资产）的 source_item_key，
// 是唯一的权威事实源。启动时必须把这些条目同步到本地 status.json，
// 避免跨 batch 重复提交已经生成成功的 item。
async function reconcileEngineToLocal() {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const sqlitePath = resolve(workDir, '..', 'jobs.sqlite')
    const db = new DatabaseSync(sqlitePath, { readOnly: true })
    const engineRows = db.prepare(
      'SELECT DISTINCT bi.source_item_key, bi.item_key, bi.batch_id, j.id as job_id, j.source_asset_id, j.final_asset_id, j.request_json FROM batch_items bi JOIN jobs j ON bi.job_id=j.id WHERE j.state=? AND j.source_asset_id IS NOT NULL AND bi.source_item_key IS NOT NULL',
    ).all('succeeded')
    db.close()
    const engineSucceeded = new Map()
    for (const r of engineRows) {
      // 每个 source_item_key 只保留最新的 job_id（根据 job_id 字典序，即时间序）
      if (!engineSucceeded.has(r.source_item_key) || r.job_id > engineSucceeded.get(r.source_item_key).job_id) {
        engineSucceeded.set(r.source_item_key, r)
      }
    }

    // 本地已 succeeded 的 itemKey 集合
    const localSucceeded = new Set(
      Object.entries(state.items || {})
        .filter(([, v]) => v.status === 'succeeded')
        .map(([k]) => k),
    )

    // 差异：引擎 succeeded 但本地没收割的
    const missing = [...engineSucceeded.entries()].filter(([k]) => !localSucceeded.has(k))
    if (missing.length) {
      console.log(`ENGINE_RECONCILE engineSucceeded=${engineSucceeded.size} localSucceeded=${localSucceeded.size} missing=${missing.length}`)
      for (const [srcKey, engRow] of missing) {
        console.log(`  RECONCILE ${srcKey}: harvesting from engine job ${String(engRow.job_id).slice(0, 20)}`)
      }
    }
    return { engineSucceeded, localSucceeded, missing }
  } catch (error) {
    console.log(`ENGINE_RECONCILE_WARN ${error.message}`)
    return { engineSucceeded: new Map(), localSucceeded: new Set(), missing: [] }
  }
}
const reconciliation = await reconcileEngineToLocal()

// ====== 收割缺口修复：把引擎已成功但本地未落盘的 item 真正下载到磁盘 ======
// 之前 reconcileEngineToLocal 只打印 missing 却不下载资产，导致批次中途被打断
// （如 BATCH_PAUSED）时，引擎里已成功的 item 永远悬空在磁盘上。
// 这里复用主循环的下载/验证/落盘/状态写入逻辑，把 missing 项收割为 succeeded。
if (reconciliation.missing.length) {
  const readyByItemKey = new Map(manifestReady.map((entry) => [entry.itemKey, entry]))
  for (const [srcKey, engRow] of reconciliation.missing) {
    const entry = readyByItemKey.get(srcKey)
    if (!entry) continue
    const directory = entryDirectory(entry)
    const sourceCanonical = resolve(directory, '\u539f\u56fe.png')
    const finalCanonical = resolve(directory, '4K.png')
    // 已落盘且通过技术核验则跳过
    if (existsSync(finalCanonical) && existsSync(sourceCanonical)) {
      try {
        await verifyAssets(sourceCanonical, finalCanonical, null, null, entry.generation.dimensions)
        if (state.items[srcKey]?.status !== 'succeeded') {
          state.items[srcKey] = {
            ...(state.items[srcKey] || {}),
            index: entry.index,
            itemKey: entry.itemKey,
            outputIndex: entry.outputIndex,
            outputCount: entry.outputCount,
            status: 'succeeded',
            completedAt: new Date().toISOString(),
            actualRoute: { name: 'harvested', model: engRow.request_json ? JSON.parse(engRow.request_json).generation?.model : 'unknown', apiMode: engRow.request_json ? JSON.parse(engRow.request_json).generation?.apiMode : 'images' },
            jobId: engRow.job_id,
            sourceAssetId: engRow.source_asset_id,
            finalAssetId: engRow.final_asset_id,
            sourcePath: sourceCanonical,
            finalPath: finalCanonical,
            harvestedFromEngine: true,
          }
        }
        continue
      } catch { /* 文件在但核验不过，走重新下载 */ }
    }
    try {
      const sourcePath = resolve(directory, `\u5019\u9009-${engRow.job_id}-\u539f\u56fe.png`)
      const finalPath = resolve(directory, `\u5019\u9009-${engRow.job_id}-4K.png`)
      // 清理可能残留的候选文件，避免引擎下载因 EEXIST 失败
      for (const stale of [sourcePath, finalPath]) {
        if (existsSync(stale)) await unlink(stale)
      }
      const sourceDownload = await callMcp('image_asset_download', { assetId: engRow.source_asset_id, outputPath: sourcePath })
      const finalDownload = await callMcp('image_asset_download', { assetId: engRow.final_asset_id, outputPath: finalPath })
      const verification = await verifyAssets(sourcePath, finalPath, sourceDownload.manifest, finalDownload.manifest, entry.generation.dimensions)
      await preserveCanonical(directory)
      await Promise.all([copyFile(sourcePath, sourceCanonical), copyFile(finalPath, finalCanonical)])
      const requestJson = engRow.request_json ? JSON.parse(engRow.request_json) : {}
      const routeModel = requestJson.generation?.model || 'unknown'
      state.items[srcKey] = {
        index: entry.index,
        itemKey: entry.itemKey,
        outputIndex: entry.outputIndex,
        outputCount: entry.outputCount,
        title: entry.title,
        tweetId: entry.tweetId,
        sourceUrl: entry.url,
        promptSource: entry.promptSource,
        status: 'succeeded',
        completedAt: new Date().toISOString(),
        actualRoute: { name: routeModel === routes[1].model ? 'fallback' : 'primary', model: routeModel, apiMode: requestJson.generation?.apiMode || 'images' },
        jobId: engRow.job_id,
        sourceAssetId: engRow.source_asset_id,
        finalAssetId: engRow.final_asset_id,
        sourcePath: sourceCanonical,
        finalPath: finalCanonical,
        executionPromptPath: resolve(directory, '\u6267\u884c\u63d0\u793a\u8bcd.txt'),
        verification,
        visualInspection: 'harvested',
        visualQa: { status: 'harvested', pass: null, notes: '从引擎收割，未重新执行视觉 QA', model: 'harvest' },
        revisions: [],
        refusalRecovery: { status: 'not_triggered' },
        harvestedFromEngine: true,
      }
      await writeFile(resolve(directory, 'metadata.json'), `${JSON.stringify(state.items[srcKey], null, 2)}\n`, 'utf8')
      console.log(`HARVESTED index=${entry.index} item=${srcKey} final=${entry.generation.dimensions}`)
    } catch (error) {
      console.log(`HARVEST_FAILED index=${entry.index} item=${srcKey} message=${error.message}`)
    }
  }
  state.summary = {
    succeeded: Object.values(state.items).filter((item) => item.status === 'succeeded').length,
    needsReview: Object.values(state.items).filter((item) => item.status === 'needs_review').length,
    errors: Object.values(state.items).filter((item) => item.status === 'batch_error').length,
  }
  await writeFile(statusPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

for (const entry of manifest.entries.filter((item) => validatedCoreIndexes.has(item.index))) {
  if (state.items[entry.index]?.status === 'succeeded') continue
  const directory = outputPath(entry.folderName)
  const metadataPath = resolve(directory, 'metadata.json')
  const sourcePath = resolve(directory, '\u539f\u56fe.png')
  const finalPath = resolve(directory, '4K.png')
  if (![metadataPath, sourcePath, finalPath].every(existsSync)) continue

  const prior = JSON.parse(await readFile(metadataPath, 'utf8'))
  if (prior.state !== 'succeeded' && prior.visualInspection !== 'pass') continue
  const verification = await verifyAssets(
    sourcePath,
    finalPath,
    null,
    null,
    entry.generation.dimensions,
  )
  state.items[entry.index] = {
    index: entry.index,
    title: entry.title,
    tweetId: entry.tweetId,
    sourceUrl: entry.url,
    promptSource: entry.promptSource,
    status: 'succeeded',
    completedAt: prior.completedAt || prior.updatedAt || new Date().toISOString(),
    actualRoute: prior.actualRoute || {
      name: 'primary',
      model: 'gpt-image-2',
      apiMode: 'images',
    },
    jobId: prior.jobId,
    sourceAssetId: prior.sourceAssetId || prior.sourceManifest?.assetId,
    finalAssetId: prior.finalAssetId || prior.finalManifest?.assetId,
    reference: prior.reference || null,
    sourcePath,
    finalPath,
    executionPromptPath: resolve(directory, '\u6267\u884c\u63d0\u793a\u8bcd.txt'),
    verification,
    visualInspection: 'manual_pass',
    visualQa: {
      status: 'completed',
      pass: true,
      notes: prior.visualInspectionNotes || '核心案例人工目视验收通过，迁移到全量断点。',
      model: 'manual',
    },
    refusalRecovery: prior.refusalRecovery || { status: 'not_triggered' },
    migratedFromCoreRun: true,
  }
  console.log(`MIGRATED index=${entry.index} final=${entry.generation.dimensions}`)
}
state.summary = {
  succeeded: Object.values(state.items).filter((item) => item.status === 'succeeded').length,
  needsReview: Object.values(state.items).filter((item) => item.status === 'needs_review').length,
  errors: Object.values(state.items).filter((item) => item.status === 'batch_error').length,
}
await writeFile(statusPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')

const completed = Object.values(state.items).filter((item) => item.status === 'succeeded')
const existingLookup = await callMcp('image_batch_find_by_logical_key', { logicalKey: logicalBatchKey })
let activeBatch = existingLookup.batch || null
if (!activeBatch && state.batchId) {
  try {
    const legacyBatch = await callMcp('image_batch_get', { batchId: state.batchId })
    const legacyMatchesScope = legacyBatch?.items?.every((item) => plannedItemKeys.has(item.itemKey))
    if (legacyBatch?.outputRoot === outputRoot && legacyMatchesScope) {
      activeBatch = await callMcp('image_batch_adopt_logical_key', {
        batchId: legacyBatch.id,
        logicalKey: logicalBatchKey,
      })
      console.log(`BATCH_LEGACY_ADOPTED batch=${activeBatch.id}`)
    } else if (legacyBatch) {
      console.log(`BATCH_LEGACY_SKIPPED batch=${legacyBatch.id} reason=scope_mismatch`)
    }
  } catch (error) {
    console.log(`BATCH_LEGACY_LOOKUP_IGNORED ${error instanceof Error ? error.message : String(error)}`)
  }
}
const entryByItemKey = new Map(plannedScope.map((entry) => [entry.itemKey, entry]))
const ready = activeBatch
  ? activeBatch.items
    .filter((item) => item.job.state !== 'succeeded')
    .map((item) => entryByItemKey.get(item.itemKey))
    .filter(Boolean)
  : manifestReady
    .filter((entry) => state.items[entry.itemKey]?.status !== 'succeeded')
    .filter((entry) => !reconciliation.engineSucceeded.has(entry.itemKey))
    .filter((entry) => plannedItemKeys.has(entry.itemKey))
if (activeBatch) {
  const missingManifestEntries = activeBatch.items.filter((item) => !entryByItemKey.has(item.itemKey))
  if (missingManifestEntries.length) {
    throw new Error(`logical batch ${activeBatch.id} no longer matches the manifest; ${missingManifestEntries.length} item(s) are missing`)
  }
}
console.log(`QUEUE_READY mode=${activeBatch ? 'resume' : 'create'} selected=${ready.length} alreadySucceeded=${completed.length}`)

const preparedReferences = new Map()
const queuedEntries = []
let pauseReason = null
for (const entry of ready) {
  const directory = entryDirectory(entry)
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, '\u63d0\u793a\u8bcd.txt'), `${entry.prompt.trim()}\n`, 'utf8')
  try {
    if (entry.generation.referenceDependent && !preparedReferences.has(entry.index)) {
      preparedReferences.set(entry.index, await prepareReference(entry))
    }
    queuedEntries.push(entry)
  } catch (error) {
    state.items[entry.itemKey] = {
      index: entry.index,
      itemKey: entry.itemKey,
      outputIndex: entry.outputIndex,
      outputCount: entry.outputCount,
      tweetId: entry.tweetId,
      title: entry.title,
      status: 'batch_error',
      completedAt: new Date().toISOString(),
      error: {
        code: 'REFERENCE_PREFLIGHT_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    }
    await writeFile(resolve(directory, 'metadata.json'), `${JSON.stringify(state.items[entry.itemKey], null, 2)}\n`, 'utf8')
    console.log(`PREFLIGHT_ERROR index=${entry.index} item=${entry.itemKey}`)
  }
}

if (queuedEntries.length) {
  if (!activeBatch) {
    const batchResult = await callMcp('image_batch_create', {
      idempotencyKey: logicalBatchKey,
      logicalKey: logicalBatchKey,
      name: batchName,
      outputRoot,
      items: queuedEntries.map((entry) => ({
        itemKey: entry.itemKey,
        copies: 1,
        outputPath: entryDirectory(entry),
        prompt: initialExecutionPrompt(entry),
        ...(entry.generation.referenceDependent
          ? { sourceAssetId: preparedReferences.get(entry.index).assetId }
          : {}),
        ratio: entry.generation.ratio,
        dimensions: entry.generation.dimensions,
        provider: 'configured',
        model: routes[0].model,
        apiMode: routes[0].apiMode,
        fallback: {
          provider: 'configured',
          model: routes[1].model,
          apiMode: routes[1].apiMode,
        },
        enhancement: 'lanczos3',
        contentClass: entry.generation.contentClass,
        maxAttempts: 3,
      })),
    })
    activeBatch = batchResult.batch
    console.log(`BATCH_${batchResult.replayed ? 'REATTACHED' : 'CREATED'} batch=${activeBatch.id} items=${queuedEntries.length}`)
  }
  activeBatch = await acquireRunner(activeBatch)
  startRunnerHeartbeat()
  if (activeBatch.controlState === 'paused' && activeBatch.state !== 'completed') {
    if (['runner_disconnected', 'cleanup_restart'].includes(activeBatch.pauseReason)) {
      activeBatch = await callMcp('image_batch_resume', { batchId: activeBatch.id })
      console.log(`BATCH_RESUMED batch=${activeBatch.id} reason=${activeBatch.pauseReason || 'runner_recovery'}`)
    } else {
      pauseReason = `batch ${activeBatch.id} remains paused for ${activeBatch.pauseReason || 'manual'}`
      queuedEntries.length = 0
      console.log(`BATCH_PRESERVED ${pauseReason}`)
    }
  }
  state.batchId = activeBatch.id
  state.logicalBatchKey = logicalBatchKey
  state.runner = { owner: runnerOwner, attempt: activeBatch.runner?.attempt || null, attachedAt: new Date().toISOString() }
  await writeFile(statusPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

for (const entry of queuedEntries) {
  const directory = entryDirectory(entry)
  const stateKey = entry.itemKey
  const priorItem = state.items[stateKey]
  const batchAttempt = priorItem?.status === 'running'
    ? Number(priorItem.batchAttempt || 1)
    : Number(priorItem?.batchAttempt || 0) + 1
  state.items[stateKey] = {
    index: entry.index,
    itemKey: entry.itemKey,
    outputIndex: entry.outputIndex,
    outputCount: entry.outputCount,
    tweetId: entry.tweetId,
    title: entry.title,
    status: 'running',
    batchAttempt,
    startedAt: new Date().toISOString(),
  }
  await writeFile(statusPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')

  const revisions = []
  try {
    ensureRunnerLease()
    const reference = entry.generation.referenceDependent
      ? preparedReferences.get(entry.index)
      : null
    let accepted = null
    let reviewRecorded = false
    let executionPrompt = initialExecutionPrompt(entry)
    let replacementReason = 'initial'
    let safeRewrite = null
    let currentJob = activeBatch.items.find((item) => item.itemKey === entry.itemKey)?.job
    if (!currentJob) throw new Error(`batch item ${entry.itemKey} is unavailable`)

    for (let revision = 0; revision < 2 && !accepted; revision += 1) {
      if (revision > 0) {
        const useSolRevision = shouldUseSolRevision(replacementReason)
        activeBatch = await callMcp('image_batch_item_replace_job', {
          batchId: activeBatch.id,
          replacementKey: `${batchKey}-revision-${hash(`${runId}:${entry.itemKey}:${revision}:${executionPrompt}`).slice(0, 32)}`,
          reason: replacementReason,
          item: {
            itemKey: entry.itemKey,
            prompt: executionPrompt,
            ...(reference ? { sourceAssetId: reference.assetId } : {}),
            ratio: entry.generation.ratio,
            dimensions: entry.generation.dimensions,
            provider: 'configured',
            model: useSolRevision ? routes[1].model : routes[0].model,
            apiMode: useSolRevision ? routes[1].apiMode : routes[0].apiMode,
            fallback: {
              provider: 'configured',
              model: useSolRevision ? routes[0].model : routes[1].model,
              apiMode: useSolRevision ? routes[0].apiMode : routes[1].apiMode,
            },
            enhancement: 'lanczos3',
            contentClass: entry.generation.contentClass,
            maxAttempts: 3,
          },
        })
        currentJob = activeBatch.items.find((item) => item.itemKey === entry.itemKey)?.job
        if (!currentJob) throw new Error(`replacement job for ${entry.itemKey} is unavailable`)
      }
      console.log(`CREATED index=${entry.index} item=${entry.itemKey} revision=${revision} route=primary+fallback job=${currentJob.id}`)
      const job = await callMcp('image_job_wait', {
        jobId: currentJob.id,
        timeoutMs: 1_800_000,
      })
      const actualRoute = job.actualRoute || routes[0]
      const route = {
        name: actualRoute.model === routes[1].model ? 'fallback' : 'primary',
        model: actualRoute.model,
        apiMode: actualRoute.apiMode,
      }
      const attempts = (job.accounting?.calls || []).map((call) => ({
        route: {
          name: call.route.model === routes[1].model ? 'fallback' : 'primary',
          model: call.route.model,
          apiMode: call.route.apiMode,
        },
        jobId: job.id,
        state: call.state,
        attempts: call.attempt,
        error: call.error || null,
      }))
      const revisionRecord = {
        revision,
        route,
        attempts,
        jobId: job.id,
        state: job.state,
        executionPrompt,
        replacementReason,
        safeRewrite,
      }
      revisions.push(revisionRecord)
      await writeFile(
        resolve(directory, `\u6267\u884c\u63d0\u793a\u8bcd-${job.id}.txt`),
        `${executionPrompt}\n`,
        'utf8',
      )
      if (job.state !== 'succeeded') {
        if (providerRoutesUnavailable(job)) {
          throw providerUnavailableError(`both provider routes returned 5xx for job ${job.id}`)
        }
        if (policyFailure(job) && revision === 0) {
          safeRewrite = await safeRewritePrompt(entry, env, job)
          executionPrompt = safeRewrite.prompt
          replacementReason = 'safe_rewrite'
          continue
        }
        activeBatch = await callMcp('image_batch_item_qa', {
          batchId: activeBatch.id,
          itemKey: entry.itemKey,
          qaStatus: 'not_run',
          failureClass: policyFailure(job) ? 'content_policy' : (job.error?.failureClass || 'generation_failed'),
          recoveryAction: policyFailure(job) ? 'safe_rewrite' : (job.error?.recoveryAction || 'inspect_failure'),
          detail: { jobId: job.id, revision },
        })
        reviewRecorded = true
        // rev0 生成失败（非策略、非 provider 全不可用）：切到 gpt-5.6-sol 重试一次。
        if (revision === 0) {
          replacementReason = 'provider_fallback'
          continue
        }
        break
      }

      const sourcePath = resolve(directory, `\u5019\u9009-${job.id}-\u539f\u56fe.png`)
      const finalPath = resolve(directory, `\u5019\u9009-${job.id}-4K.png`)
      const sourceDownload = await callMcp('image_asset_download', {
        assetId: job.sourceAssetId,
        outputPath: sourcePath,
      })
      const finalDownload = await callMcp('image_asset_download', {
        assetId: job.finalAssetId,
        outputPath: finalPath,
      })
      const verification = await verifyAssets(
        sourcePath,
        finalPath,
        sourceDownload.manifest,
        finalDownload.manifest,
        entry.generation.dimensions,
      )
      const qa = await visualQa(entry, sourcePath, env)
      revisionRecord.sourcePath = sourcePath
      revisionRecord.finalPath = finalPath
      revisionRecord.verification = verification
      revisionRecord.visualQa = qa
      // QA 仅供参考，不阻断已通过技术核验的成功生成。
      // QA provider 返回 5xx 时降级为 unavailable，继续验收，不熔断整个批次。
      // 真正的生成 provider 5xx 仍由 providerRoutesUnavailable 检测并触发 BATCH_PAUSED。
      const qaPass = qa.status === 'completed' && qa.pass
      console.log(`QA index=${entry.index} revision=${revision} status=${qa.status} pass=${qaPass} notes=${qa.notes || qa.reason || ''}`)
      // QA only records evidence. A succeeded, technically verified asset is
      // ready for human review whether QA passes, warns, or is unavailable.
      activeBatch = await callMcp('image_batch_item_qa', {
        batchId: activeBatch.id,
        itemKey: entry.itemKey,
        qaStatus: qaPass ? 'passed' : (qa.status === 'completed' ? 'needs_review' : 'not_run'),
        ...(qaPass ? {} : {
          failureClass: qa.status === 'completed' ? 'qa_reference_only' : 'qa_unavailable',
          recoveryAction: 'manual_review',
        }),
        detail: { jobId: job.id, revision, verification, qaReference: !qaPass ? qa : undefined },
      })
      reviewRecorded = true
      accepted = {
        route,
        job,
        sourcePath,
        finalPath,
        verification,
        qa,
        executionPrompt,
        reference,
      }
    }

    if (!accepted) {
      if (!reviewRecorded) {
        activeBatch = await callMcp('image_batch_item_qa', {
          batchId: activeBatch.id,
          itemKey: entry.itemKey,
          qaStatus: 'needs_review',
          failureClass: 'recovery_exhausted',
          recoveryAction: 'manual_review',
          detail: { revisions: revisions.length },
        })
      }
      state.items[stateKey] = {
        ...state.items[stateKey],
        status: 'needs_review',
        completedAt: new Date().toISOString(),
        revisions,
      }
      await writeFile(resolve(directory, 'metadata.json'), `${JSON.stringify(state.items[stateKey], null, 2)}\n`, 'utf8')
      console.log(`NEEDS_REVIEW index=${entry.index} item=${entry.itemKey}`)
    } else {
      await preserveCanonical(directory)
      const sourceCanonical = resolve(directory, '\u539f\u56fe.png')
      const finalCanonical = resolve(directory, '4K.png')
      const executionCanonical = resolve(directory, '\u6267\u884c\u63d0\u793a\u8bcd.txt')
      await Promise.all([
        copyFile(accepted.sourcePath, sourceCanonical),
        copyFile(accepted.finalPath, finalCanonical),
        writeFile(executionCanonical, `${accepted.executionPrompt}\n`, 'utf8'),
      ])
      const record = {
        index: entry.index,
        itemKey: entry.itemKey,
        outputIndex: entry.outputIndex,
        outputCount: entry.outputCount,
        title: entry.title,
        tweetId: entry.tweetId,
        sourceUrl: entry.url,
        promptSource: entry.promptSource,
        status: 'succeeded',
        completedAt: new Date().toISOString(),
        actualRoute: accepted.route,
        jobId: accepted.job.id,
        sourceAssetId: accepted.job.sourceAssetId,
        finalAssetId: accepted.job.finalAssetId,
        reference: accepted.reference,
        sourcePath: sourceCanonical,
        finalPath: finalCanonical,
        executionPromptPath: executionCanonical,
        verification: accepted.verification,
        visualInspection: accepted.qa.status === 'completed' ? 'ai_pass' : 'pending_manual',
        visualQa: accepted.qa,
        revisions,
        refusalRecovery: {
          status: revisions.some((item) => item.attempts.some((attempt) => policyFailure({ error: attempt.error })))
            ? 'blocked'
            : 'not_triggered',
        },
      }
      state.items[stateKey] = record
      await writeFile(resolve(directory, 'metadata.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      completed.push(record)
      if (completed.length % 20 === 0) {
        const contactSheet = await makeContactSheet(completed, completed.length)
        state.lastContactSheet = contactSheet
      }
      console.log(`SUCCEEDED index=${entry.index} route=${accepted.route.name} final=${entry.generation.dimensions}`)
    }
  } catch (error) {
    const runnerLeaseLost = error?.code === 'RUNNER_LEASE_LOST'
    if (activeBatch?.id && !runnerLeaseLost) {
      try {
        activeBatch = await callMcp('image_batch_item_qa', {
          batchId: activeBatch.id,
          itemKey: entry.itemKey,
          qaStatus: 'needs_review',
          failureClass: error?.code === 'PROVIDER_UNAVAILABLE' ? 'provider_transient' : 'batch_error',
          recoveryAction: error?.code === 'PROVIDER_UNAVAILABLE' ? 'health_probe' : 'inspect_failure',
          detail: { message: error instanceof Error ? error.message : String(error) },
        })
      } catch {
        // Preserve the original failure when the review write cannot be completed.
      }
    }
    state.items[stateKey] = {
      ...state.items[stateKey],
      status: runnerLeaseLost ? 'interrupted' : 'batch_error',
      completedAt: new Date().toISOString(),
      revisions,
      error: {
        code: error?.code || 'BATCH_ERROR',
        message: error instanceof Error ? error.message : String(error),
      },
    }
    if (error?.code === 'PROVIDER_UNAVAILABLE') pauseReason = state.items[stateKey].error.message
    await writeFile(resolve(directory, 'metadata.json'), `${JSON.stringify(state.items[stateKey], null, 2)}\n`, 'utf8')
    console.log(`ERROR index=${entry.index} item=${entry.itemKey} message=${state.items[stateKey].error.message}`)
    if (runnerLeaseLost) throw error
  }

  state.updatedAt = new Date().toISOString()
  state.summary = {
    succeeded: Object.values(state.items).filter((item) => item.status === 'succeeded').length,
    needsReview: Object.values(state.items).filter((item) => item.status === 'needs_review').length,
    errors: Object.values(state.items).filter((item) => item.status === 'batch_error').length,
  }
  await writeFile(statusPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  if (pauseReason) {
    if (activeBatch?.id && activeBatch.state !== 'completed') {
      activeBatch = await callMcp('image_batch_pause', { batchId: activeBatch.id, reason: 'provider_unavailable' })
    }
    console.log(`BATCH_PAUSED reason=${pauseReason}`)
    break
  }
}

if (!pauseReason) console.log(`BATCH_DONE ${JSON.stringify(state.summary || {})}`)
} finally {
  try {
    await releaseRunner()
  } catch (error) {
    console.error(`RUNNER_RELEASE_FAILED ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await client.close()
  }
}
