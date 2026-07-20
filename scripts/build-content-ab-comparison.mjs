import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const args = process.argv.slice(2)
const imagesIndex = args.indexOf('--images')
const responsesIndex = args.indexOf('--responses')
if (imagesIndex < 1 || responsesIndex < 0 || responsesIndex <= imagesIndex) {
  throw new Error('Usage: node scripts/build-content-ab-comparison.mjs <output-dir> --images <reports...> --responses <reports...>')
}

const outputDir = path.resolve(args[0])
const imageReports = args.slice(imagesIndex + 1, responsesIndex)
const responseReports = args.slice(responsesIndex + 1)

function loadResults(reportPaths, mode) {
  const byId = new Map()
  for (const reportPath of reportPaths) {
    const absoluteReportPath = path.resolve(reportPath)
    const report = JSON.parse(fs.readFileSync(absoluteReportPath, 'utf8'))
    for (const result of report.results || []) {
      const id = String(result.id)
      const candidate = {
        ...result,
        mode,
        reportPath: absoluteReportPath,
        imagePath: result.imageFiles?.[0]?.filePath || null,
      }
      const existing = byId.get(id)
      if (!existing || (!existing.imagePath && candidate.imagePath)) byId.set(id, candidate)
    }
  }
  return byId
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  })[character])
}

async function buildCell(item, mode, width, height) {
  const labelHeight = 72
  const bodyHeight = height - labelHeight
  let body
  if (item?.imagePath && fs.existsSync(item.imagePath)) {
    body = await sharp(item.imagePath)
      .resize(width, bodyHeight, { fit: 'contain', background: '#ececec' })
      .png()
      .toBuffer()
  } else {
    const message = item?.error || 'No generated image'
    body = await sharp({ create: { width, height: bodyHeight, channels: 3, background: '#252525' } })
      .composite([{ input: Buffer.from(`<svg width="${width}" height="${bodyHeight}"><text x="30" y="70" fill="#ff8a80" font-size="28">FAILED</text><text x="30" y="115" fill="#ffffff" font-size="18">${escapeXml(message.slice(0, 90))}</text></svg>`) }])
      .png()
      .toBuffer()
  }
  const quality = item?.actualParams?.quality || 'none'
  const label = Buffer.from(`<svg width="${width}" height="${labelHeight}"><rect width="100%" height="100%" fill="#111827"/><text x="20" y="30" fill="#ffffff" font-size="22" font-weight="bold">${escapeXml(mode)}</text><text x="20" y="56" fill="#cbd5e1" font-size="16">actual quality: ${escapeXml(quality)} · ${item?.wallElapsedMs ? Math.round(item.wallElapsedMs / 1000) + 's' : 'failed'}</text></svg>`)
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite([{ input: label, top: 0, left: 0 }, { input: body, top: labelHeight, left: 0 }])
    .png()
    .toBuffer()
}

const images = loadResults(imageReports, 'Images / gpt-image-2')
const responses = loadResults(responseReports, 'Responses / gpt-5.6-sol')
const ids = [...new Set([...images.keys(), ...responses.keys()])]
  .filter((id) => !id.startsWith('matrix-'))
  .sort((a, b) => Number(b) - Number(a))

const manifest = ids.map((id) => ({
  id,
  title: images.get(id)?.title || responses.get(id)?.title || id,
  images: images.get(id) || null,
  responses: responses.get(id) || null,
}))

fs.mkdirSync(outputDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, 'comparison-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

const cellWidth = 900
const cellHeight = 650
const titleHeight = 64
const pairsPerSheet = 5
for (let start = 0; start < manifest.length; start += pairsPerSheet) {
  const group = manifest.slice(start, start + pairsPerSheet)
  const sheetHeight = group.length * (cellHeight + titleHeight)
  const composites = []
  for (let row = 0; row < group.length; row += 1) {
    const pair = group[row]
    const top = row * (cellHeight + titleHeight)
    const title = Buffer.from(`<svg width="${cellWidth * 2}" height="${titleHeight}"><rect width="100%" height="100%" fill="#f8fafc"/><text x="20" y="40" fill="#0f172a" font-size="24" font-weight="bold">${escapeXml(pair.id)} · ${escapeXml(pair.title)}</text></svg>`)
    composites.push({ input: title, top, left: 0 })
    composites.push({ input: await buildCell(pair.images, 'A · Images', cellWidth, cellHeight), top: top + titleHeight, left: 0 })
    composites.push({ input: await buildCell(pair.responses, 'B · Responses', cellWidth, cellHeight), top: top + titleHeight, left: cellWidth })
  }
  await sharp({ create: { width: cellWidth * 2, height: sheetHeight, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toFile(path.join(outputDir, `comparison-${Math.floor(start / pairsPerSheet) + 1}.jpg`))
}

console.log(JSON.stringify({ outputDir, pairCount: manifest.length, sheets: Math.ceil(manifest.length / pairsPerSheet) }))
