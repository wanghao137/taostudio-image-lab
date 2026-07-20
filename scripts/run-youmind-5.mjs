import { chromium } from 'playwright'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PROMPT_ORIGINS = [
  'https://cdn.jsdelivr.net/gh/YouMind-OpenLab/gpt-image-2-prompts-search@main/references',
  'https://raw.githubusercontent.com/YouMind-OpenLab/gpt-image-2-prompts-search/main/references',
]

const selections = [
  { id: 28909, category: 'social-media-post', ratio: '9:16', size: '2160x3840' },
  { id: 28700, category: 'infographic-edu-visual', ratio: '4:3', size: '3200x2400' },
  { id: 23424, category: 'game-asset', ratio: '16:9', size: '3840x2160' },
  { id: 27157, category: 'infographic-edu-visual', ratio: '1:1', size: '2880x2880' },
  { id: 28691, category: 'poster-flyer', ratio: '2:3', size: '2304x3456' },
]

const MATRIX_PROMPT = 'A single smooth white ceramic sphere resting on a matte light-gray studio surface, soft diffused daylight from the upper left, subtle natural shadow, minimalist product photography, clean neutral background, no text, no letters, no logos, no watermark, one object only.'

const matrixSelections = [
  { ratio: '9:16', size: '2160x3840' },
  { ratio: '16:9', size: '3840x2160' },
  { ratio: '1:1', size: '2880x2880' },
  { ratio: '4:3', size: '3200x2400' },
  { ratio: '3:4', size: '2400x3200' },
  { ratio: '2:3', size: '2304x3456' },
].flatMap((item) => [1, 2].map((repeat) => ({
  ...item,
  id: `matrix-${item.ratio.replace(':', 'x')}-r${repeat}`,
  title: `Capability matrix ${item.ratio} repeat ${repeat}`,
  prompt: MATRIX_PROMPT,
  sourceImage: null,
  repeat,
})))

const contentAbSelections = [
  { id: 28909, category: 'social-media-post', ratio: '9:16', size: '2160x3840' },
  { id: 28700, category: 'infographic-edu-visual', ratio: '4:3', size: '3200x2400' },
  { id: 23424, category: 'game-asset', ratio: '16:9', size: '3840x2160' },
  { id: 27157, category: 'infographic-edu-visual', ratio: '1:1', size: '2880x2880' },
  { id: 28691, category: 'poster-flyer', ratio: '2:3', size: '2304x3456' },
  { id: 28490, category: 'profile-avatar', ratio: '3:4', size: '2400x3200' },
  { id: 27889, category: 'social-media-post', ratio: '16:9', size: '3840x2160' },
  { id: 25039, category: 'infographic-edu-visual', ratio: '16:9', size: '3840x2160' },
  { id: 19674, category: 'youtube-thumbnail', ratio: '16:9', size: '3840x2160' },
  { id: 28799, category: 'comic-storyboard', ratio: '16:9', size: '3840x2160' },
  { id: 27170, category: 'ecommerce-main-image', ratio: '3:4', size: '2400x3200' },
  { id: 27429, category: 'game-asset', ratio: '16:9', size: '3840x2160' },
  { id: 23019, category: 'app-web-design', ratio: '16:9', size: '3840x2160' },
  { id: 23758, category: 'others', ratio: '3:2', size: '3456x2304' },
  { id: 21922, category: 'profile-avatar', ratio: '9:16', size: '2160x3840' },
]

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const env = {}
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function cleanPromptContent(text) {
  return String(text || '').replace(
    /\{argument\s+name="([^"]+)"(?:\s+default="([^"]*)")?\s*\}/gi,
    (_match, name, fallback) => fallback !== undefined ? fallback : name,
  )
}

async function fetchJsonWithFallback(relativePath) {
  const errors = []
  for (const origin of PROMPT_ORIGINS) {
    const url = `${origin}/${relativePath}`
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'TaoStudio-YouMind-5/1.0' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`All prompt origins failed: ${errors.join(' | ')}`)
}

async function loadPrompts(selectedRecords = selections) {
  const byCategory = new Map()
  const output = []
  for (const selection of selectedRecords) {
    if (selection.prompt) {
      output.push(selection)
      continue
    }
    if (!byCategory.has(selection.category)) {
      byCategory.set(selection.category, await fetchJsonWithFallback(`${selection.category}.json`))
    }
    const record = byCategory.get(selection.category).find((item) => Number(item.id) === selection.id)
    if (!record) throw new Error(`Prompt ${selection.id} not found in ${selection.category}`)
    if (record.needReferenceImages) throw new Error(`Prompt ${selection.id} unexpectedly requires reference images`)
    output.push({
      ...selection,
      title: record.title,
      prompt: cleanPromptContent(record.content),
      sourceImage: Array.isArray(record.sourceMedia) ? record.sourceMedia[0] : null,
    })
  }
  return output
}

function createPersistedState({ apiKey, baseUrl, useProxy, size, apiMode, model }) {
  const profileId = `youmind-auto-${apiMode}-${useProxy ? 'proxy' : 'direct'}`
  const settings = {
    baseUrl,
    apiKey,
    model,
    timeout: 600,
    apiMode,
    codexCli: false,
    apiProxy: useProxy,
    streamImages: false,
    streamPartialImages: 0,
    customProviders: [],
    providerOrder: ['openai', 'fal'],
    clearInputAfterSubmit: false,
    persistInputOnRestart: true,
    reuseTaskApiProfileTemporarily: false,
    alwaysShowRetryButton: true,
    taskCompletionNotification: false,
    enterSubmit: false,
    referenceImageEditAction: 'ask',
    zipDownloadRoutes: ['task-selection', 'favorite-collection-selection'],
    agentScrollToBottomAfterSubmit: true,
    agentMaxToolRounds: 15,
    agentWebSearch: false,
    activeProfileId: profileId,
    profiles: [{
      id: profileId,
      name: useProxy ? 'YouMind 自动生成（代理）' : 'YouMind 自动生成（直连）',
      provider: 'openai',
      baseUrl,
      apiKey,
      model,
      timeout: 600,
      apiMode,
      codexCli: false,
      apiProxy: useProxy,
      responseFormatB64Json: true,
      streamImages: false,
      streamPartialImages: 0,
    }],
  }
  return {
    state: {
      settings,
      params: {
        size,
        exact_size: true,
        quality: 'high',
        output_format: 'png',
        output_compression: null,
        moderation: 'low',
        n: 1,
        transparent_output: false,
      },
      prompt: '',
      appMode: 'gallery',
      dismissedCodexCliPrompts: [],
    },
    version: 2,
  }
}

function dataUrlToBuffer(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '')
  if (!match) throw new Error('Generated image is not a data URL')
  return match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]))
}

async function readLatestTask(page) {
  return await page.evaluate(async () => {
    const request = (req) => new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('gpt-image-playground')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const tx = db.transaction(['tasks', 'images'], 'readonly')
    const tasks = await request(tx.objectStore('tasks').getAll())
    const latest = [...tasks].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null
    if (!latest) {
      db.close()
      return null
    }
    const images = []
    for (const id of latest.outputImages || []) {
      const image = await request(tx.objectStore('images').get(id))
      if (image) images.push({ id, dataUrl: image.dataUrl, width: image.width, height: image.height })
    }
    db.close()
    return {
      id: latest.id,
      status: latest.status,
      error: latest.error,
      elapsed: latest.elapsed,
      createdAt: latest.createdAt,
      finishedAt: latest.finishedAt,
      params: latest.params,
      actualParams: latest.actualParams,
      outputErrors: latest.outputErrors,
      images,
    }
  })
}

async function clickGenerate(page) {
  const buttons = page.locator('[data-input-bar] button:visible')
  const candidates = await buttons.evaluateAll((items) => items.map((button, index) => ({
    index,
    text: button.innerText,
    aria: button.getAttribute('aria-label'),
    disabled: button.disabled,
    className: String(button.className),
  })))
  const labelIndex = candidates.findLastIndex((item) =>
    !item.disabled && /生成|Generate|image/i.test(`${item.text} ${item.aria}`) && !/上传|Upload|Attach/i.test(`${item.text} ${item.aria}`),
  )
  const blueIndex = candidates.findLastIndex((item) => !item.disabled && /bg-blue-500/.test(item.className))
  const index = labelIndex >= 0 ? labelIndex : blueIndex
  if (index < 0) throw new Error('Could not find an enabled generation button')
  await buttons.nth(index).click({ timeout: 30_000 })
}

async function saveSourceImage(url, filePath) {
  if (!url) return null
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    fs.writeFileSync(filePath, Buffer.from(await response.arrayBuffer()))
    return filePath
  } catch (error) {
    return `source image download failed: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function runOne(browser, promptRecord, options) {
  const startedAt = Date.now()
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  const persisted = createPersistedState({ ...options, size: promptRecord.size })
  await context.addInitScript((payload) => {
    localStorage.setItem('gpt-image-playground', JSON.stringify(payload))
  }, persisted)
  const page = await context.newPage()
  let generationRequest = null
  page.on('request', (request) => {
    if (request.method() !== 'POST') return
    try {
      const body = request.postDataJSON()
      if (!body || typeof body !== 'object' || (!body.model && !body.prompt)) return
      const tool = Array.isArray(body.tools) && body.tools[0] && typeof body.tools[0] === 'object'
        ? body.tools[0]
        : body
      generationRequest = {
        path: new URL(request.url()).pathname,
        model: body.model ?? null,
        apiMode: Array.isArray(body.tools) ? 'responses' : 'images',
        toolType: tool.type ?? null,
        size: tool.size ?? null,
        exact_size: tool.exact_size ?? null,
        quality: tool.quality ?? null,
        output_format: tool.output_format ?? null,
        moderation: tool.moderation ?? null,
        n: tool.n ?? body.n ?? null,
      }
    } catch {
      // Ignore non-JSON POST requests.
    }
  })
  try {
    await page.goto(options.targetUrl, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.locator('[contenteditable="true"]').first().fill(promptRecord.prompt, { timeout: 30_000 })
    await clickGenerate(page)
    console.log(JSON.stringify({ event: 'submitted', id: promptRecord.id, title: promptRecord.title, size: promptRecord.size }))

    let latest = null
    let lastStatus = ''
    while (Date.now() - startedAt < 10 * 60 * 1000) {
      await page.waitForTimeout(5_000)
      latest = await readLatestTask(page)
      const status = latest ? `${latest.status}:${latest.images.length}` : 'no-task'
      if (status !== lastStatus) {
        console.log(JSON.stringify({
          event: 'progress',
          id: promptRecord.id,
          wallElapsedMs: Date.now() - startedAt,
          status: latest?.status || null,
          outputs: latest?.images.length || 0,
          error: latest?.error ? String(latest.error).slice(0, 300) : null,
        }))
        lastStatus = status
      }
      if (latest && latest.status !== 'running') break
    }

    if (!latest) latest = await readLatestTask(page)
    const prefix = `${String(promptRecord.id)}-${promptRecord.ratio.replace(':', 'x')}`
    const screenshotPath = path.join(options.outputDir, `${prefix}-app.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    const imageFiles = []
    for (let index = 0; index < (latest?.images || []).length; index += 1) {
      const image = latest.images[index]
      const filePath = path.join(options.outputDir, `${prefix}-generated-${index + 1}.png`)
      const buffer = dataUrlToBuffer(image.dataUrl)
      fs.writeFileSync(filePath, buffer)
      imageFiles.push({
        filePath,
        width: image.width,
        height: image.height,
        bytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        pngSignature: buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      })
    }
    const sourcePath = await saveSourceImage(
      promptRecord.sourceImage,
      path.join(options.outputDir, `${prefix}-source.jpg`),
    )
    const [expectedWidth, expectedHeight] = promptRecord.size.split('x').map(Number)
    const exactDimensions = imageFiles.length > 0 && imageFiles.every(
      (image) => image.width === expectedWidth && image.height === expectedHeight,
    )
    const strictConfigVerified = generationRequest?.quality === 'high'
      && generationRequest?.output_format === 'png'
      && generationRequest?.moderation === 'low'
      && latest?.actualParams?.quality === 'high'
      && latest?.actualParams?.output_format === 'png'
      && exactDimensions
    const technicalVerified = generationRequest?.output_format === 'png'
      && generationRequest?.moderation === 'low'
      && latest?.actualParams?.output_format === 'png'
      && exactDimensions
      && imageFiles.every((image) => image.pngSignature)
    return {
      ...promptRecord,
      ok: latest?.status === 'done'
        && imageFiles.length > 0
        && (options.requireActualHigh ? strictConfigVerified : technicalVerified),
      status: latest?.status || 'timeout',
      error: latest?.error || null,
      elapsed: latest?.elapsed || null,
      wallElapsedMs: Date.now() - startedAt,
      requestedSize: promptRecord.size,
      requestedConfig: {
        apiMode: options.apiMode,
        model: options.model,
        codexCli: false,
        exact_size: true,
        quality: 'high',
        output_format: 'png',
        moderation: 'low',
      },
      generationRequest,
      actualParams: latest?.actualParams || null,
      exactDimensions,
      technicalVerified,
      strictConfigVerified,
      outputErrors: latest?.outputErrors || null,
      imageFiles,
      sourcePath,
      screenshotPath,
    }
  } finally {
    await context.close()
  }
}

async function main() {
  const dotEnv = readDotEnv(path.join(process.cwd(), '.env.local'))
  const apiKey = (process.env.IMAGE_API_KEY || dotEnv.IMAGE_API_KEY || '').trim()
  const baseUrl = (process.env.IMAGE_API_BASE_URL || dotEnv.IMAGE_API_BASE_URL || '').trim()
  if (!apiKey || !baseUrl) throw new Error('Missing IMAGE_API_KEY or IMAGE_API_BASE_URL in .env.local')

  const targetUrl = process.env.AUTO_RUN_TARGET_URL || 'https://image.taostudioai.com/'
  const useProxy = process.env.AUTO_RUN_PROXY === 'true'
  const apiMode = process.env.AUTO_RUN_API_MODE === 'responses' ? 'responses' : 'images'
  const model = (process.env.AUTO_RUN_MODEL || (apiMode === 'responses' ? 'gpt-5.6-sol' : 'gpt-image-2')).trim()
  const suite = process.env.AUTO_RUN_SUITE === 'matrix'
    ? 'matrix'
    : process.env.AUTO_RUN_SUITE === 'content-ab'
    ? 'content-ab'
    : 'youmind'
  const suiteRecords = suite === 'matrix'
    ? matrixSelections
    : suite === 'content-ab'
    ? contentAbSelections
    : selections
  const requestedIds = new Set((process.env.AUTO_RUN_IDS || '').split(',').map((value) => value.trim()).filter(Boolean))
  const selectedRecords = requestedIds.size
    ? suiteRecords.filter((item) => requestedIds.has(String(item.id)))
    : suiteRecords
  if (!selectedRecords.length) throw new Error('No prompt records matched AUTO_RUN_IDS')
  const requireActualHigh = process.env.AUTO_RUN_REQUIRE_HIGH === 'true'
  const offset = Math.max(0, Math.min(selectedRecords.length - 1, Number(process.env.AUTO_RUN_OFFSET || 0)))
  const limit = Math.max(1, Math.min(selectedRecords.length - offset, Number(process.env.AUTO_RUN_LIMIT || selectedRecords.length)))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, '-')
  const outputDir = path.join(process.cwd(), 'output', `${suite}-${apiMode}-${safeModel}-${stamp}`)
  fs.mkdirSync(outputDir, { recursive: true })

  const prompts = (await loadPrompts(selectedRecords)).slice(offset, offset + limit)
  fs.writeFileSync(path.join(outputDir, 'selected-prompts.json'), JSON.stringify(prompts, null, 2), 'utf8')
  const browser = await chromium.launch({ headless: true })
  const results = []
  const reportPath = path.join(outputDir, 'report.json')
  const writeReport = (completed = false) => {
    const report = {
      generatedAt: new Date().toISOString(),
      completed,
      suite,
      targetUrl,
      useProxy,
      apiMode,
      model,
      offset,
      limit,
      requestedConfig: {
        apiMode,
        model,
        codexCli: false,
        exact_size: true,
        quality: 'high',
        output_format: 'png',
        moderation: 'low',
        requireActualHigh,
      },
      outputDir,
      plannedCount: prompts.length,
      completedCount: results.length,
      generatedImageCount: results.filter((item) => item.status === 'done' && item.imageFiles?.length > 0).length,
      successCount: results.filter((item) => item.ok).length,
      failureCount: results.filter((item) => !item.ok).length,
      results,
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
    return report
  }
  writeReport(false)
  try {
    for (const promptRecord of prompts) {
      try {
        const result = await runOne(browser, promptRecord, { apiKey, baseUrl, targetUrl, useProxy, apiMode, model, requireActualHigh, outputDir })
        results.push(result)
        writeReport(false)
        console.log(JSON.stringify({ event: 'completed', id: result.id, ok: result.ok, status: result.status, images: result.imageFiles }))
      } catch (error) {
        const result = {
          ...promptRecord,
          ok: false,
          status: 'runner_error',
          error: error instanceof Error ? error.message : String(error),
        }
        results.push(result)
        writeReport(false)
        console.log(JSON.stringify({ event: 'failed', id: result.id, error: result.error }))
      }
    }
  } finally {
    await browser.close()
  }
  const report = writeReport(true)
  console.log(JSON.stringify({ event: 'report', reportPath, successCount: report.successCount, failureCount: report.failureCount }))
  if (report.successCount !== prompts.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'fatal', error: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
})
