import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { extractRequestedImageCount } from '../../packages/image-job-core/index.mjs'

export { extractRequestedImageCount }

export const DIMENSIONS_BY_RATIO = Object.freeze({
  '1:1': '2880x2880',
  '2:1': '3840x1920',
  '3:2': '3456x2304',
  '2:3': '2304x3456',
  '16:9': '3840x2160',
  '9:16': '2160x3840',
  '4:3': '3200x2400',
  '3:4': '2400x3200',
  '21:9': '3840x1646',
  '4:5': '2400x3000',
  '5:4': '3000x2400',
  '3:5': '2160x3600',
  '5:3': '3600x2160',
})

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function extractStrictRatio(prompt) {
  const normalized = String(prompt || '').replace(/\uff1a/g, ':')
  const matches = [...normalized.matchAll(
    /(?:\u6bd4\u4f8b|\u753b\u5e45|\u5c3a\u5bf8|\u6a2a\u7248|\u7ad6\u7248|aspect(?:\s+ratio)?)?[^0-9]{0,12}(21:9|16:9|9:16|5:4|4:5|5:3|3:5|4:3|3:4|3:2|2:3|2:1|1:1)/gi,
  )]
  const ratio = matches.at(-1)?.[1] || null
  if (ratio && DIMENSIONS_BY_RATIO[ratio]) return ratio
  return null
}

export function expandReadyEntries(entries) {
  return entries.flatMap((entry) => {
    if (
      entry.promptStatus !== 'exact_prompt_recovered'
      || entry.duplicateOf
      || entry.generation?.status !== 'ready'
    ) return []
    validateReadyEntry(entry)
    const outputCount = extractRequestedImageCount(entry.prompt)
    return Array.from({ length: outputCount }, (_, outputIndex) => ({
      ...entry,
      outputIndex: outputIndex + 1,
      outputCount,
      itemKey: outputCount === 1
        ? String(entry.index)
        : `${entry.index}:${outputIndex + 1}`,
    }))
  })
}

export function validateReadyEntry(entry) {
  const label = Number.isInteger(entry?.index) ? `entry ${entry.index}` : 'manifest entry'
  if (!String(entry?.prompt || '').trim()) throw new Error(`${label} has no prompt`)
  if (!String(entry?.folderName || '').trim()) throw new Error(`${label} has no output folder`)
  const ratio = entry?.generation?.ratio
  if (!ratio || !DIMENSIONS_BY_RATIO[ratio]) {
    throw new Error(`${label} has no explicit supported ratio`)
  }
  if (entry.generation.dimensions !== DIMENSIONS_BY_RATIO[ratio]) {
    throw new Error(
      `${label} dimensions ${entry.generation.dimensions || 'missing'} do not match ratio ${ratio}`,
    )
  }
  return entry
}

export async function inspectPng(path, expected = {}) {
  const buffer = await readFile(path)
  const metadata = await sharp(buffer).metadata()
  if (metadata.format !== 'png') throw new Error(`asset is not PNG: ${path}`)
  if (!metadata.width || !metadata.height) throw new Error(`asset dimensions are unavailable: ${path}`)
  if (expected.width && metadata.width !== expected.width) {
    throw new Error(`unexpected asset width ${metadata.width}, expected ${expected.width}`)
  }
  if (expected.height && metadata.height !== expected.height) {
    throw new Error(`unexpected asset height ${metadata.height}, expected ${expected.height}`)
  }
  if (expected.ratio) {
    const [ratioWidth, ratioHeight] = expected.ratio.split(':').map(Number)
    if (metadata.width * ratioHeight !== metadata.height * ratioWidth) {
      throw new Error(`asset ratio ${metadata.width}:${metadata.height} does not match ${expected.ratio}`)
    }
  }
  const digest = sha256(buffer)
  if (expected.sha256 && expected.sha256 !== digest) throw new Error('asset SHA-256 mismatch')
  return {
    format: 'png',
    width: metadata.width,
    height: metadata.height,
    bytes: buffer.length,
    sha256: digest,
  }
}

export function classifyQaFailure(qa) {
  if (qa?.blankOrBroken) return { failureClass: 'asset_invalid', recoveryAction: 'route_fallback' }
  if (qa?.edgeClipping) return { failureClass: 'edge_clipping', recoveryAction: 'recompose' }
  if (qa?.backgroundConflict) return { failureClass: 'background_conflict', recoveryAction: 'preserve_background' }
  if (qa?.missingCoreStructure) return { failureClass: 'semantic_mismatch', recoveryAction: 'revise_with_qa' }
  return { failureClass: 'semantic_mismatch', recoveryAction: 'revise_with_qa' }
}

export function buildQaRevisionInstruction(qa) {
  const instructions = [
    'QUALITY REVISION:',
    'Revise the previous result while preserving the original requested subject, style, background, aspect ratio, and visual intent.',
    'Do not add a frame, matte, border, mockup sheet, neutral surround, or presentation background unless the original prompt explicitly requests it.',
  ]
  if (qa?.edgeClipping) {
    instructions.push(
      'Fix only the clipped meaningful content by recomposing or scaling the existing composition enough to keep it inside the canvas.',
      'Keep the original background full-bleed when it was full-bleed; do not shrink the whole artwork into a framed card.',
    )
  }
  if (qa?.backgroundConflict) {
    instructions.push('Restore the background requested by the original prompt and remove any unrequested border or neutral surround.')
  }
  if (qa?.missingCoreStructure) {
    instructions.push('Restore the missing core structure or subject identified by QA without redesigning unrelated parts.')
  }
  if (qa?.notes) instructions.push(`QA feedback: ${String(qa.notes).trim()}`)
  return instructions.join('\n')
}

export function shouldUseSolRevision(recoveryAction) {
  return ['safe_rewrite', 'recompose', 'preserve_background', 'revise_with_qa', 'provider_fallback']
    .includes(recoveryAction)
}
