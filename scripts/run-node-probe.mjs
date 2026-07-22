// MVP headless image probe.
//
// Proves a Node-direct client can produce 4K images on the same request
// contract as the production UI, for a single prompt across both API modes
// (images + responses). Outputs generated PNGs, captured request/response
// artifacts, and a contract-alignment report.
//
// Usage:  node scripts/run-node-probe.mjs
// Reads:  .env.local (IMAGE_API_KEY, IMAGE_API_BASE_URL)
// Env:    PROBE_PROMPT, PROBE_RATIO (default 3:4), PROBE_TIER (default 4K),
//         PROBE_MODEL_IMAGES (default gpt-image-2),
//         PROBE_MODEL_RESPONSES (default gpt-5.6-sol),
//         PROBE_SKIP_RESPONSES=1 to skip responses mode.

import fs from 'node:fs'
import path from 'node:path'

import { calculateImageSize, parseArParam } from './lib/size4k.mjs'
import { generateImages, generateResponses } from './lib/generateHeadless.mjs'
import { appendTargetAspectPromptHint, stripMidjourneySuffix } from './lib/targetAspectPrompt.mjs'
import { getExactImageSizeTarget, resizeBufferToExactSize } from './lib/exactImageSizeNode.mjs'
import { dataUrlToBuffer, describeImageFile, isDataUrl, verifyOutput } from './lib/verify.mjs'

const DEFAULT_PROMPT =
  'Impressionist oil painting in the style of Monet, summer lotus pond scenery, green lotus leaves covering the water, pink and white water lilies blooming one after another, reflections of flowers and sky on the lake surface, irises and lush wild plants growing on the bank, soft morning Tyndall light shining through misty woods, blending blue-purple and pink soft tones, sparkling water ripples, loose short brushstrokes, rich ambient light and shadow, hazy fog, thick impasto texture, dreamy translucent colors, peaceful pastoral scenery --ar 3:4 --v 6.0 --s 240'

const FIXED_CONFIG = {
  exact_size: true,
  quality: 'high',
  output_format: 'png',
  moderation: 'low',
  n: 1,
}

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

function makeProfile({ apiKey, baseUrl, model }) {
  return {
    id: `node-probe-${model}`,
    provider: 'openai',
    baseUrl,
    apiKey,
    model,
    timeout: 600,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    responseFormatB64Json: true,
    streamImages: false,
    streamPartialImages: 0,
  }
}

async function runMode({ mode, runFn, params, profile, expectedSize, outputDir, labelPrefix }) {
  const startedAt = Date.now()
  console.log(JSON.stringify({ event: 'mode_start', mode, model: profile.model, expectedSize }))
  const { requestBody, parsed, rawResponse } = await runFn()
  const wallElapsedMs = Date.now() - startedAt
  const target = getExactImageSizeTarget(params)
  const imageEntries = []
  for (let i = 0; i < parsed.images.length; i += 1) {
    const image = parsed.images[i]
    if (!isDataUrl(image)) {
      // Remote URL returned instead of base64; record but skip download in probe.
      imageEntries.push({ index: i, remoteUrl: image })
      continue
    }
    const rawBuffer = dataUrlToBuffer(image)
    const rawDesc = describeImageFile(rawBuffer, null)
    // Provider does not guarantee exact pixels — mirror the production app's
    // client-side exact-size resize (cover) so output matches the requested size.
    let finalBuffer = rawBuffer
    let exactSizeTransform = null
    if (target) {
      const resized = await resizeBufferToExactSize(rawBuffer, target, params.output_format)
      finalBuffer = resized.buffer
      if (resized.resized) {
        exactSizeTransform = resized.drawPlan
        // Preserve the provider-returned original for traceability.
        const origPath = path.join(outputDir, `${labelPrefix}-${mode}-raw-original.png`)
        fs.writeFileSync(origPath, rawBuffer)
      }
    }
    const filePath = path.join(outputDir, `${labelPrefix}-${mode}.png`)
    fs.writeFileSync(filePath, finalBuffer)
    const finalDesc = describeImageFile(finalBuffer, filePath)
    imageEntries.push({
      index: i,
      providerSize: { width: rawDesc.width, height: rawDesc.height },
      finalSize: { width: finalDesc.width, height: finalDesc.height },
      resized: target ? rawDesc.width !== target.width || rawDesc.height !== target.height : false,
      exactSizeTransform,
      ...finalDesc,
    })
  }
  fs.writeFileSync(
    path.join(outputDir, `${labelPrefix}-${mode}-request.json`),
    JSON.stringify({ mode, model: profile.model, requestBody, expectedSize, params }, null, 2),
    'utf8',
  )
  const meta = {
    actualParams: parsed.actualParams ?? null,
    actualParamsList: parsed.actualParamsList ?? null,
    revisedPrompts: parsed.revisedPrompts ?? null,
    rawImageUrls: parsed.rawImageUrls ?? null,
  }
  fs.writeFileSync(path.join(outputDir, `${labelPrefix}-${mode}-response-meta.json`), JSON.stringify(meta, null, 2), 'utf8')

  const verifications = imageEntries
    .filter((entry) => entry.filePath)
    .map((entry) => verifyOutput(entry, expectedSize, FIXED_CONFIG, parsed.actualParams))

  const ok = imageEntries.length > 0
    && imageEntries.every((entry) => entry.filePath)
    && verifications.every((v) => v && v.technicalVerified)

  return {
    mode,
    model: profile.model,
    ok,
    wallElapsedMs,
    expectedSize,
    imageCount: parsed.images.length,
    imageEntries,
    verifications,
    actualParams: parsed.actualParams ?? null,
    rawResponseKeys: Object.keys(rawResponse || {}),
    error: null,
  }
}

async function main() {
  const dotEnv = readDotEnv(path.join(process.cwd(), '.env.local'))
  const apiKey = (process.env.IMAGE_API_KEY || dotEnv.IMAGE_API_KEY || '').trim()
  const baseUrl = (process.env.IMAGE_API_BASE_URL || dotEnv.IMAGE_API_BASE_URL || '').trim()
  if (!apiKey || !baseUrl) throw new Error('Missing IMAGE_API_KEY or IMAGE_API_BASE_URL in .env.local')

  const rawPrompt = process.env.PROBE_PROMPT || DEFAULT_PROMPT
  const ratioFromAr = parseArParam(rawPrompt)
  const ratio = process.env.PROBE_RATIO || ratioFromAr || '3:4'
  const tier = process.env.PROBE_TIER || '4K'
  const size = calculateImageSize(tier, ratio)
  if (!size) throw new Error(`Could not calculate size for ratio ${ratio} at tier ${tier}`)
  const modelImages = (process.env.PROBE_MODEL_IMAGES || 'gpt-image-2').trim()
  const modelResponses = (process.env.PROBE_MODEL_RESPONSES || 'gpt-5.6-sol').trim()
  const skipResponses = process.env.PROBE_SKIP_RESPONSES === '1'

  // Prompt preprocessing mirrors the production path:
  //   1. strip Midjourney --ar/--v/--s suffixes (gateway returns HTML otherwise)
  //   2. append the target-aspect hint the app injects (store.ts:4887)
  const strippedPrompt = stripMidjourneySuffix(rawPrompt)
  const prompt = appendTargetAspectPromptHint(strippedPrompt, size)

  const params = { size, ...FIXED_CONFIG }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const outputDir = path.join(process.cwd(), 'output', `node-probe-${stamp}`)
  fs.mkdirSync(outputDir, { recursive: true })

  const labelPrefix = `lotus-${ratio.replace(':', 'x')}`
  console.log(JSON.stringify({ event: 'config', ratio, tier, size, modelImages, modelResponses, skipResponses, outputDir }))

  const profileImages = makeProfile({ apiKey, baseUrl, model: modelImages })
  const profileResponses = makeProfile({ apiKey, baseUrl, model: modelResponses })

  const results = []
  // images mode
  try {
    results.push(await runMode({
      mode: 'images',
      runFn: () => generateImages({ prompt, params, profile: profileImages }),
      params, profile: profileImages, expectedSize: size, outputDir, labelPrefix,
    }))
  } catch (error) {
    results.push({ mode: 'images', model: modelImages, ok: false, error: error instanceof Error ? error.message : String(error) })
    console.log(JSON.stringify({ event: 'mode_failed', mode: 'images', error: results.at(-1).error }))
  }

  // responses mode — wait for gateway cooldown after the (long) images request.
  if (!skipResponses) {
    const cooldownMs = Number(process.env.PROBE_COOLDOWN_MS || 20_000)
    if (cooldownMs > 0) {
      console.log(JSON.stringify({ event: 'cooldown', ms: cooldownMs }))
      await new Promise((resolve) => setTimeout(resolve, cooldownMs))
    }
    try {
      results.push(await runMode({
        mode: 'responses',
        runFn: () => generateResponses({ prompt, params, profile: profileResponses }),
        params, profile: profileResponses, expectedSize: size, outputDir, labelPrefix,
      }))
    } catch (error) {
      results.push({ mode: 'responses', model: modelResponses, ok: false, error: error instanceof Error ? error.message : String(error) })
      console.log(JSON.stringify({ event: 'mode_failed', mode: 'responses', error: results.at(-1).error }))
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    prompt,
    rawPrompt,
    promptPreprocessing: {
      strippedSuffix: rawPrompt !== strippedPrompt,
      addedAspectHint: prompt !== strippedPrompt,
    },
    ratio,
    tier,
    requestedSize: size,
    requestedConfig: { ...FIXED_CONFIG, codexCli: false },
    modelImages,
    modelResponses,
    skipResponses,
    outputDir,
    results,
    summary: {
      modesRun: results.length,
      modesOk: results.filter((r) => r.ok).length,
      contractAligned: results.filter((r) => r.ok).length === results.length && results.length > 0,
    },
  }
  fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify({
    event: 'report',
    outputDir,
    contractAligned: report.summary.contractAligned,
    modesOk: report.summary.modesOk,
    modesRun: report.summary.modesRun,
    perMode: results.map((r) => ({ mode: r.mode, ok: r.ok, error: r.error?.slice(0, 200) })),
  }))
  if (!report.summary.contractAligned) process.exitCode = 1
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'fatal', error: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
})
