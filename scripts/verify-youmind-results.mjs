import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { parseImageSize, ratioMatchesExactly } from '../packages/image-job-core/index.mjs'

const outputRoot = process.argv[2] ? resolve(process.argv[2]) : null
if (!outputRoot) throw new Error('usage: node scripts/verify-youmind-results.mjs <output-directory>')

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

async function inspectImage(path) {
  const buffer = await readFile(path)
  if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error(`${path} does not have a PNG signature`)
  const image = sharp(buffer)
  const metadata = await image.metadata()
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw new Error(`${path} is not a decodable PNG`)

  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3]
  const transparentEdges = {
    top: Array.from({ length: info.width }, (_, x) => alphaAt(x, 0)).every((alpha) => alpha === 0),
    bottom: Array.from({ length: info.width }, (_, x) => alphaAt(x, info.height - 1)).every((alpha) => alpha === 0),
    left: Array.from({ length: info.height }, (_, y) => alphaAt(0, y)).every((alpha) => alpha === 0),
    right: Array.from({ length: info.height }, (_, y) => alphaAt(info.width - 1, y)).every((alpha) => alpha === 0),
  }
  return {
    width: metadata.width,
    height: metadata.height,
    bytes: buffer.length,
    sha256: sha256(buffer),
    fullyTransparentEdges: Object.entries(transparentEdges).filter(([, transparent]) => transparent).map(([edge]) => edge),
  }
}

const manifest = JSON.parse(await readFile(resolve(outputRoot, 'inputs', 'youmind-prompts.json'), 'utf8'))
const verified = []
const failures = []

for (const task of manifest.tasks) {
  try {
    const taskDir = resolve(outputRoot, 'results', `${task.id}-${task.slug}`)
    const result = JSON.parse(await readFile(resolve(taskDir, 'result.json'), 'utf8'))
    if (result.status !== 'succeeded') throw new Error(`result state is ${result.status}`)
    const source = await inspectImage(result.sourcePath)
    const final = await inspectImage(result.finalPath)
    const target = parseImageSize(task.dimensions)
    if (final.width !== target.width || final.height !== target.height) {
      throw new Error(`final is ${final.width}x${final.height}, expected ${task.dimensions}`)
    }
    if (!ratioMatchesExactly(source, final)) {
      throw new Error(`ratio mismatch: source ${source.width}x${source.height}, final ${final.width}x${final.height}`)
    }
    if (source.fullyTransparentEdges.length || final.fullyTransparentEdges.length) {
      throw new Error(`fully transparent edge detected: source=${source.fullyTransparentEdges.join(',') || 'none'}, final=${final.fullyTransparentEdges.join(',') || 'none'}`)
    }
    if (result.verification?.source?.sha256 && source.sha256 !== result.verification.source.sha256) throw new Error('source SHA-256 differs from task evidence')
    if (result.verification?.final?.sha256 && final.sha256 !== result.verification.final.sha256) throw new Error('final SHA-256 differs from task evidence')
    verified.push({
      id: task.id,
      route: task.route,
      ratio: task.ratio,
      dimensions: task.dimensions,
      attempts: result.attempts ?? null,
      sourceTransform: result.sourceTransform ?? null,
      promptAudit: result.promptAudit ?? null,
      source,
      final,
    })
  } catch (error) {
    failures.push({ id: task.id, error: error instanceof Error ? error.message : String(error) })
  }
}

const report = {
  version: 1,
  verifiedAt: new Date().toISOString(),
  sourceManifest: resolve(outputRoot, 'inputs', 'youmind-prompts.json'),
  totals: { plannedTasks: manifest.tasks.length, verifiedTasks: verified.length, verifiedPngFiles: verified.length * 2, failedTasks: failures.length },
  routes: Object.fromEntries(['api', 'mcp', 'skill'].map((route) => [route, verified.filter((item) => item.route === route).length])),
  ratios: Object.fromEntries([...new Set(manifest.tasks.map((task) => task.ratio))].map((ratio) => [ratio, verified.filter((item) => item.ratio === ratio).length])),
  normalizedSources: verified.filter((item) => item.sourceTransform?.geometry === 'cover').length,
  promptOverrides: verified.filter((item) => item.promptAudit?.overrideApplied).length,
  failures,
  results: verified,
}
const reportPath = resolve(outputRoot, 'verification-report.json')
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify({ output: reportPath, totals: report.totals }, null, 2))
if (failures.length) process.exitCode = 1
