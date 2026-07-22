import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import sharp from 'sharp'
import { calculateImageSize, deriveExactSourceTarget, parseImageSize, ratioMatchesExactly, ratioMatchesWithinOnePixel } from '../packages/image-job-core/index.mjs'

const outputRoot = process.argv[2] ? resolve(process.argv[2]) : null
const archiveRoot = process.argv[3] ? resolve(process.argv[3]) : null
if (!outputRoot || !archiveRoot) {
  throw new Error('usage: node scripts/repair-youmind-exact-ratios.mjs <output-directory> <archive-directory>')
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
const manifest = JSON.parse(await readFile(resolve(outputRoot, 'inputs', 'youmind-prompts.json'), 'utf8'))
const repaired = []

for (const task of manifest.tasks) {
  const taskDir = resolve(outputRoot, 'results', `${task.id}-${task.slug}`)
  const resultPath = resolve(taskDir, 'result.json')
  const result = await readFile(resultPath, 'utf8').then(JSON.parse).catch(() => null)
  if (result?.status !== 'succeeded') continue

  const sourceBuffer = await readFile(result.sourcePath)
  const finalBuffer = await readFile(result.finalPath)
  const sourceMetadata = await sharp(sourceBuffer).metadata()
  const finalMetadata = await sharp(finalBuffer).metadata()
  const source = { width: sourceMetadata.width, height: sourceMetadata.height }
  const final = { width: finalMetadata.width, height: finalMetadata.height }
  if (ratioMatchesExactly(source, final)) continue
  if (!ratioMatchesWithinOnePixel(source, final)) throw new Error(`${task.id} is not eligible for integer-ratio repair`)

  const expectedFinal = parseImageSize(task.dimensions)
  if (final.width !== expectedFinal.width || final.height !== expectedFinal.height) throw new Error(`${task.id} final dimensions are not ${task.dimensions}`)
  const base = parseImageSize(calculateImageSize('1K', task.ratio))
  const exactSource = deriveExactSourceTarget(base, expectedFinal)
  const archiveDir = resolve(archiveRoot, basename(taskDir))
  await mkdir(archiveDir, { recursive: true })
  await copyFile(result.sourcePath, resolve(archiveDir, 'source-pre-exact.png'))
  await copyFile(result.finalPath, resolve(archiveDir, 'final-pre-exact.png'))
  await copyFile(resultPath, resolve(archiveDir, 'result-pre-exact.json'))

  const normalizedSource = await sharp(sourceBuffer)
    .resize(exactSource.width, exactSource.height, { fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer()
  const normalizedFinal = await sharp(normalizedSource)
    .resize(expectedFinal.width, expectedFinal.height, { fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer()
  await mkdir(dirname(result.sourcePath), { recursive: true })
  await writeFile(result.sourcePath, normalizedSource)
  await writeFile(result.finalPath, normalizedFinal)

  const next = {
    ...result,
    sourceTransform: {
      geometry: 'cover',
      reason: 'integer-ratio-normalization',
      inputDimensions: source,
      exactPixels: exactSource,
      priorTransform: result.sourceTransform ?? null,
    },
    verification: {
      source: { ...exactSource, bytes: normalizedSource.length, sha256: sha256(normalizedSource) },
      final: { ...expectedFinal, bytes: normalizedFinal.length, sha256: sha256(normalizedFinal) },
      ratioPreserved: true,
      integerRatioExact: true,
    },
    repairedAt: new Date().toISOString(),
  }
  await writeFile(resultPath, JSON.stringify(next, null, 2), 'utf8')
  repaired.push({ id: task.id, sourceBefore: source, sourceAfter: exactSource, final: expectedFinal })
}

const reportPath = resolve(archiveRoot, 'repair-report.json')
await mkdir(archiveRoot, { recursive: true })
await writeFile(reportPath, JSON.stringify({ version: 1, repairedAt: new Date().toISOString(), repaired }, null, 2), 'utf8')
console.log(JSON.stringify({ output: reportPath, repaired }, null, 2))
