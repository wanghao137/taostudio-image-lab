// Compose 4 x 16:9 finals into a 2x2 grid. Each cell 3840x2160 -> grid 7680x4320.
import sharp from 'sharp'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const outDir = process.env.OUT_DIR
const cells = [
  { id: 'p1', x: 0, y: 0, name: 'Prompt Engineer' },
  { id: 'p2', x: 3840, y: 0, name: 'Robot Engineer' },
  { id: 'p3', x: 0, y: 2160, name: 'Creative Process' },
  { id: 'p4', x: 3840, y: 2160, name: 'Nikola Tesla' },
]
const gridW = 7680, gridH = 4320
const gutter = 24 // thin gutter for clean separation
const cellW = 3840, cellH = 2160

// White background canvas, place 4 cells with small gutter.
const composites = []
for (const c of cells) {
  const f = join(outDir, `${c.id}-final.png`)
  if (!existsSync(f)) throw new Error('missing cell: ' + f)
  composites.push({ input: await sharp(f).resize(cellW, cellH).toBuffer(), left: c.x, top: c.y })
}

const outPath = join(outDir, 'grid-2x2.png')
await sharp({ create: { width: gridW, height: gridH, channels: 4, background: { r: 245, g: 245, b: 240, alpha: 1 } } })
  .composite(composites)
  .png()
  .toFile(outPath)

const meta = await sharp(outPath).metadata()
console.log('grid composed:', outPath)
console.log('dimensions:', meta.width + 'x' + meta.height, meta.format)
