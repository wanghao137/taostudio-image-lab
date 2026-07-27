import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
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

const commonSafety = [
  'MANDATORY FINAL COMPOSITION CHECK:',
  'Keep every meaningful subject, title, label, border and decoration fully inside the canvas.',
  'Before finalizing, inspect all four edges. If anything meaningful is clipped, shrink and recenter the complete composition.',
].join('\n')

const textSafety = [
  commonSafety,
  'Reserve at least 8% blank safe margin at the top and bottom and 5% at the left and right.',
  'No character, panel, frame, newspaper edge, poster edge or information block may touch or cross the canvas edge.',
].join('\n')

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
  return JSON.parse(text)
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
if (preflightOnly) {
  console.log(`BATCH_PREFLIGHT_OK key=${batchKey} selected=${manifestReady.slice(0, limit).length}`)
  process.exit(0)
}

function initialExecutionPrompt(entry) {
  const guard = entry.generation.contentClass === 'text' ? textSafety : commonSafety
  return [guard, entry.prompt].join('\n\n')
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
  return mcpPayload(await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: 1_830_000, maxTotalTimeout: 1_830_000 },
  ))
}

let state = existsSync(statusPath)
  ? JSON.parse(await readFile(statusPath, 'utf8'))
  : { schemaVersion: 1, startedAt: new Date().toISOString(), items: {} }
state.runId = runId
state.updatedAt = new Date().toISOString()

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

const ready = manifestReady
  .filter((entry) => state.items[entry.itemKey]?.status !== 'succeeded')
  .slice(0, limit)
const completed = Object.values(state.items).filter((item) => item.status === 'succeeded')
console.log(`QUEUE_READY selected=${ready.length} alreadySucceeded=${completed.length}`)

const preparedReferences = new Map()
const queuedEntries = []
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

let activeBatch = null
if (queuedEntries.length) {
  const batchResult = await callMcp('image_batch_create', {
    idempotencyKey: `${batchKey}-${runId}`,
    name: `${batchName} ${runId}`,
    items: queuedEntries.map((entry) => ({
      itemKey: entry.itemKey,
      copies: 1,
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
  state.batchId = activeBatch.id
  await writeFile(statusPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  console.log(`BATCH_CREATED batch=${activeBatch.id} items=${queuedEntries.length}`)
}

let pauseReason = null
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
          executionPrompt = [
            entry.generation.contentClass === 'text' ? textSafety : commonSafety,
            safeRewrite.prompt,
          ].join('\n\n')
          replacementReason = 'safe_rewrite'
          continue
        }
        activeBatch = await callMcp('image_batch_item_review', {
          batchId: activeBatch.id,
          itemKey: entry.itemKey,
          qaStatus: 'not_run',
          acceptanceStatus: 'rejected',
          failureClass: policyFailure(job) ? 'content_policy' : (job.error?.failureClass || 'generation_failed'),
          recoveryAction: policyFailure(job) ? 'safe_rewrite' : (job.error?.recoveryAction || 'inspect_failure'),
          detail: { jobId: job.id, revision },
        })
        reviewRecorded = true
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
      if (qa.status === 'unavailable' && /^HTTP 5\d\d$/.test(qa.reason || '')) {
        throw providerUnavailableError(`visual QA provider returned ${qa.reason}`)
      }
      const qaPass = qa.status === 'completed' && qa.pass
      console.log(`QA index=${entry.index} revision=${revision} status=${qa.status} pass=${qaPass} notes=${qa.notes || qa.reason || ''}`)
      if (qaPass) {
        activeBatch = await callMcp('image_batch_item_review', {
          batchId: activeBatch.id,
          itemKey: entry.itemKey,
          qaStatus: 'passed',
          acceptanceStatus: 'accepted',
          detail: { jobId: job.id, revision, verification },
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
      } else if (qa.status !== 'completed') {
        activeBatch = await callMcp('image_batch_item_review', {
          batchId: activeBatch.id,
          itemKey: entry.itemKey,
          qaStatus: 'needs_review',
          acceptanceStatus: 'needs_review',
          failureClass: 'qa_unavailable',
          recoveryAction: 'manual_review',
          detail: { jobId: job.id, revision, reason: qa.reason || 'visual QA unavailable' },
        })
        reviewRecorded = true
        break
      } else if (revision === 0) {
        const classification = classifyQaFailure(qa)
        executionPrompt = [
          entry.generation.contentClass === 'text' ? textSafety : commonSafety,
          buildQaRevisionInstruction(qa),
          entry.prompt,
        ].join('\n\n')
        replacementReason = classification.recoveryAction
      } else {
        const classification = classifyQaFailure(qa)
        activeBatch = await callMcp('image_batch_item_review', {
          batchId: activeBatch.id,
          itemKey: entry.itemKey,
          qaStatus: 'failed',
          acceptanceStatus: 'needs_review',
          ...classification,
          detail: { jobId: job.id, revision, qa },
        })
        reviewRecorded = true
      }
    }

    if (!accepted) {
      if (!reviewRecorded) {
        activeBatch = await callMcp('image_batch_item_review', {
          batchId: activeBatch.id,
          itemKey: entry.itemKey,
          qaStatus: 'needs_review',
          acceptanceStatus: 'needs_review',
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
    if (activeBatch?.id) {
      try {
        activeBatch = await callMcp('image_batch_item_review', {
          batchId: activeBatch.id,
          itemKey: entry.itemKey,
          qaStatus: 'needs_review',
          acceptanceStatus: 'needs_review',
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
      status: 'batch_error',
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
      activeBatch = await callMcp('image_batch_pause', { batchId: activeBatch.id })
    }
    console.log(`BATCH_PAUSED reason=${pauseReason}`)
    break
  }
}

await client.close()
if (!pauseReason) console.log(`BATCH_DONE ${JSON.stringify(state.summary || {})}`)
