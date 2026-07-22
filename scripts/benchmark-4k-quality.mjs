import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'

const execute = promisify(execFile)
const outputRoot = resolve('output/quality-benchmark')
await mkdir(outputRoot, { recursive: true })

const realInputs = [
  join(homedir(), 'Downloads', 'task-mr61foj71n85i-source.png'),
  join(homedir(), 'Downloads', 'task-mr5xi1utjvf9y-source.png'),
]

const synthetic = join(outputRoot, 'synthetic-text-logo-reference.png')
await sharp(Buffer.from(`<svg width="1536" height="1024" xmlns="http://www.w3.org/2000/svg">
  <rect width="1536" height="1024" fill="#f7f7f4"/>
  <rect x="88" y="88" width="1360" height="848" rx="16" fill="#1677ff"/>
  <text x="150" y="370" font-family="Arial" font-size="160" font-weight="700" fill="white">TaoStudio 4K</text>
  <text x="150" y="560" font-family="Arial" font-size="72" fill="white">TEXT / LOGO / UI MUST STAY EXACT</text>
  <path d="M160 720 H1370" stroke="#fff" stroke-width="12"/>
</svg>`)).png().toFile(synthetic)

const inputs = [...realInputs, synthetic]

function metrics(reference, candidate) {
  if (reference.length !== candidate.length) throw new Error('metric buffers differ in length')
  let sumSquared = 0
  let meanReference = 0
  let meanCandidate = 0
  for (let index = 0; index < reference.length; index += 1) {
    const left = reference[index]
    const right = candidate[index]
    const delta = left - right
    sumSquared += delta * delta
    meanReference += left
    meanCandidate += right
  }
  const count = reference.length
  meanReference /= count
  meanCandidate /= count
  let varianceReference = 0
  let varianceCandidate = 0
  let covariance = 0
  for (let index = 0; index < count; index += 1) {
    const left = reference[index] - meanReference
    const right = candidate[index] - meanCandidate
    varianceReference += left * left
    varianceCandidate += right * right
    covariance += left * right
  }
  varianceReference /= count - 1
  varianceCandidate /= count - 1
  covariance /= count - 1
  const mse = sumSquared / count
  const c1 = (0.01 * 255) ** 2
  const c2 = (0.03 * 255) ** 2
  const ssim = ((2 * meanReference * meanCandidate + c1) * (2 * covariance + c2))
    / ((meanReference ** 2 + meanCandidate ** 2 + c1) * (varianceReference + varianceCandidate + c2))
  return { mse, psnr: mse === 0 ? null : 10 * Math.log10((255 ** 2) / mse), ssim }
}

async function rawRgb(path) {
  return sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
}

async function runExternalCandidate(name, commandTemplate, lowPath, outputPath) {
  if (!commandTemplate) return { name, status: 'no-go', reason: 'candidate command/model is not configured' }
  const [command, ...parts] = commandTemplate.split(' ')
  const args = parts.map((part) => part.replace('{input}', lowPath).replace('{output}', outputPath))
  const started = performance.now()
  try {
    await execute(command, args, { timeout: 300_000 })
    return { name, status: 'ok', elapsedMs: performance.now() - started, outputPath }
  } catch (error) {
    return { name, status: 'no-go', elapsedMs: performance.now() - started, reason: error instanceof Error ? error.message : String(error) }
  }
}

const samples = []
for (const [index, input] of inputs.entries()) {
  const metadata = await sharp(input).metadata().catch(() => null)
  if (!metadata?.width || !metadata.height) continue
  const referencePath = join(outputRoot, `sample-${index + 1}-reference.png`)
  const lowPath = join(outputRoot, `sample-${index + 1}-low.png`)
  const lanczosPath = join(outputRoot, `sample-${index + 1}-lanczos3.png`)
  await sharp(input).png().toFile(referencePath)
  await sharp(input).resize(Math.max(1, Math.round(metadata.width / 4)), Math.max(1, Math.round(metadata.height / 4)), { kernel: sharp.kernel.lanczos3 }).png().toFile(lowPath)
  const started = performance.now()
  await sharp(lowPath).resize(metadata.width, metadata.height, { kernel: sharp.kernel.lanczos3, fit: 'fill' }).png().toFile(lanczosPath)
  const elapsedMs = performance.now() - started
  const [reference, lanczos] = await Promise.all([rawRgb(referencePath), rawRgb(lanczosPath)])
  const score = metrics(reference.data, lanczos.data)
  const realEsrganPath = join(outputRoot, `sample-${index + 1}-real-esrgan.png`)
  const hatPath = join(outputRoot, `sample-${index + 1}-hat.png`)
  const candidates = [
    { name: 'lanczos3', status: 'ok', elapsedMs, outputPath: lanczosPath, ...score },
    await runExternalCandidate('real-esrgan', process.env.REALESRGAN_BENCHMARK_COMMAND, lowPath, realEsrganPath),
    await runExternalCandidate('hat', process.env.HAT_BENCHMARK_COMMAND, lowPath, hatPath),
  ]
  for (const candidate of candidates) {
    if (candidate.status !== 'ok' || candidate.name === 'lanczos3') continue
    const rendered = await rawRgb(candidate.outputPath)
    Object.assign(candidate, metrics(reference.data, rendered.data))
  }
  samples.push({ input, width: metadata.width, height: metadata.height, lowWidth: Math.round(metadata.width / 4), lowHeight: Math.round(metadata.height / 4), candidates })
}

const fullScaleSource = samples[0]?.input
let fullScale = null
if (fullScaleSource) {
  const target = { width: 3456, height: 2304 }
  const outputPath = join(outputRoot, 'full-3x2-3456x2304-lanczos3.png')
  const started = performance.now()
  await sharp(fullScaleSource).resize(target.width, target.height, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toFile(outputPath)
  fullScale = { source: fullScaleSource, target, elapsedMs: performance.now() - started, outputPath }
}

const report = {
  generatedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.version, gpu: 'none detected', inference: 'CPU' },
  methodology: '4x downsample then reconstruct against the original; global RGB PSNR/SSIM; same pixels and output dimensions',
  samples,
  fullScale,
  operationalDecision: {
    default: 'lanczos3',
    generativeForbiddenFor: ['text', 'logo', 'ui'],
    aiFallback: 'lanczos3',
    realEsrgan: process.env.REALESRGAN_BENCHMARK_COMMAND ? 'measured' : 'no-go: model command unavailable',
    hat: process.env.HAT_BENCHMARK_COMMAND ? 'measured' : 'no-go: model command unavailable',
  },
}
await writeFile(join(outputRoot, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
