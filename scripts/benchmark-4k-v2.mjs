#!/usr/bin/env node
/**
 * Production 4K v2 — Benchmark（benchmark:4k:v2）
 *
 * 与旧 benchmark:4k 的关键区别（docs/4k-quality-benchmark-v2.md 详述）：
 * 1. 不再用「候选滤镜自己制造退化再自己恢复」（循环偏置）：退化用与全体候选
 *    独立的 IM box filter 与 sharp mitchell 两种；
 * 2. 指标升级：全局 PSNR 之外，提供标准 8x8 分窗 SSIM（luma）、MS-SSIM、
 *    边缘 overshoot/undershoot、ΔE(CIE76) 色漂、alpha fringe 检查、
 *    精确尺寸断言、运行时间（median/P95）、确定性（同输入两跑字节+像素一致）；
 * 3. 候选包含真实浏览器实现（src/lib/lanczos.ts 同一纯函数核 + Worker 同款
 *    pre/post multiply），sharp 旧路径按事实标注「upscale≈cubic」，
 *    ImageMagick EWA 家族（LanczosSharp/LanczosRadius/Robidoux/Mitchell）；
 * 4. 数据集 = 合成边缘用例 + TaoStudio 真实历史生成图（--dataset-dir）。
 *
 * 用法：
 *   npm run benchmark:4k:v2                    # quick（合成 6 类 × 关键 scale + 真实 4 张）
 *   npm run benchmark:4k:v2 -- --full          # 全量 scale 矩阵 + 更多真实图
 *   npm run benchmark:4k:v2 -- --dataset-dir "F:/gpt生图/4K" --real 8
 *   TAOSTUDIO_IMAGE_MAGICK=0 npm run benchmark:4k:v2   # 无 sidecar 时跳过 IM 候选
 */

import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'

import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { lanczos3ResizeRGBA } from '../src/lib/lanczos.ts'
import {
  createResamplerTempDir,
  removeTempDir,
  resolveImageMagick,
  runImageMagickEwaResize,
} from '../server/task-api/resampler/imagemagick.mjs'

const args = process.argv.slice(2)
const FULL = args.includes('--full')
const datasetDirArg = args.find((a) => a.startsWith('--dataset-dir='))?.slice('--dataset-dir='.length)
  ?? (args[args.indexOf('--dataset-dir') + 1] ?? 'F:/gpt生图/4K')
const realCountArg = Number(args.find((a) => a.startsWith('--real='))?.slice('--real='.length)
  ?? (args[args.indexOf('--real') + 1] ?? (FULL ? 8 : 4)))

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'output', 'quality-benchmark-v2')

const ALL_SCALES = [1.1, 1.25, 1.5, 1.5625, 2.0, 2.25, 3.0]
const QUICK_SCALES = [1.5625, 2.25]
/** 合成 GT 基准盒（3.0× 后恰为生产 4K 预设：3456x2304 / 2400x3000 / 2160x3840） */
const SYNTH_BASES = [
  { name: 'photo-ish-gradient', width: 3456, height: 2304, kind: 'synthetic' },
  { name: 'poster-4x5', width: 2400, height: 3000, kind: 'synthetic' },
  { name: 'vertical-9x16', width: 2160, height: 3840, kind: 'synthetic' },
]

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ---------- 数据集 ----------

async function synthImage(spec) {
  const { width, height, name } = spec
  switch (name) {
    case 'photo-ish-gradient':
      return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <defs><radialGradient id="sky" cx="0.3" cy="0.2" r="1.2">
          <stop offset="0" stop-color="#8ec5ff"/><stop offset="0.6" stop-color="#3b6ea5"/><stop offset="1" stop-color="#12253b"/>
        </radialGradient></defs>
        <rect width="100%" height="100%" fill="url(#sky)"/>
        <ellipse cx="${width * 0.62}" cy="${height * 0.42}" rx="${width * 0.22}" ry="${height * 0.3}" fill="#e8d9b0" opacity="0.85"/>
        <path d="M0 ${height * 0.78} Q ${width * 0.3} ${height * 0.66} ${width * 0.55} ${height * 0.8} T ${width} ${height * 0.72} L ${width} ${height} L 0 ${height} Z" fill="#1d3a24"/>
        <path d="M0 ${height * 0.84} Q ${width * 0.35} ${height * 0.74} ${width * 0.7} ${height * 0.87} T ${width} ${height * 0.82} L ${width} ${height} L 0 ${height} Z" fill="#0f2417"/>
      </svg>`)).png().toBuffer()
    case 'poster-4x5': {
      // 棋盘 + 单像素线 + 斜线：硬边缘混叠敏感
      const cell = 48
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="#f5f2ea"/>
        ${Array.from({ length: Math.ceil(height / cell) }, (_, row) => Array.from({ length: Math.ceil(width / cell) }, (_, col) =>
          (row + col) % 2 === 0 ? `<rect x="${col * cell}" y="${row * cell}" width="${cell}" height="${cell}" fill="#20242c"/>` : '',
        ).join('')).join('')}
        <rect x="0" y="${height * 0.74}" width="${width}" height="2" fill="#c8102e"/>
        <line x1="0" y1="${height * 0.76}" x2="${width}" y2="${height}" stroke="#0b7285" stroke-width="3"/>
        <text x="${width / 2}" y="${height * 0.35}" font-family="Arial" font-size="${Math.round(width * 0.08)}" font-weight="700" text-anchor="middle" fill="#1a1a1a">TaoStudio 4K</text>
        <text x="${width / 2}" y="${height * 0.43}" font-family="Arial" font-size="${Math.round(width * 0.03)}" text-anchor="middle" fill="#444">Production · 细节 · 文字 · 线条</text>
      </svg>`
      return sharp(Buffer.from(svg)).png().toBuffer()
    }
    case 'vertical-9x16': {
      // Siemens 星 + UI 网格 + 1px 线：莫尔条纹 / 振铃敏感
      const cx = width / 2
      const cy = height * 0.34
      const spokes = 36
      const r = Math.min(width, height) * 0.26
      const sectors = Array.from({ length: spokes }, (_, i) => {
        const a0 = (i * 2 * Math.PI) / spokes
        const a1 = ((i + 1) * 2 * Math.PI) / spokes
        return i % 2 === 0
          ? `<path d="M${cx} ${cy} L${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A${r} ${r} 0 0 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)} Z" fill="#111"/>`
          : ''
      }).join('')
      const lines = Array.from({ length: Math.floor(width / 24) }, (_, i) => `<line x1="${i * 24 + 12}" y1="${height * 0.66}" x2="${i * 24 + 12}" y2="${height}" stroke="#7a7a7a" stroke-width="1"/>`).join('')
      return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="#fafafa"/>${sectors}${lines}
        <rect x="${width * 0.08}" y="${height * 0.62}" width="${width * 0.84}" height="${height * 0.36}" fill="none" stroke="#333" stroke-width="2"/>
        <rect x="${width * 0.08}" y="${height * 0.62}" width="${width * 0.42}" height="${height * 0.18}" fill="#e7f5ff"/>
      </svg>`)).png().toBuffer()
    }
    default:
      throw new Error(`unknown synthetic spec ${name}`)
  }
}

async function buildRealDataset(dir, count) {
  let entries = []
  try {
    entries = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  } catch {
    return []
  }
  const picked = []
  const step = Math.max(1, Math.floor(entries.length / count))
  for (let i = 0; picked.length < count && i < entries.length; i += step) {
    picked.push({ entry: entries[i], path: join(dir, entries[i]) })
  }
  const loaded = []
  for (const item of picked) {
    try {
      const meta = await sharp(item.path).metadata()
      if (!meta.width || !meta.height || meta.width * meta.height > 8_294_400 || Math.max(meta.width, meta.height) > 3840) continue
      loaded.push({ name: `real-${meta.width}x${meta.height}-${item.entry.slice(0, 24)}`, path: item.path, kind: 'real', width: meta.width, height: meta.height })
      if (loaded.length >= count) break
    } catch {
      /* skip unreadable */
    }
  }
  return loaded
}

// ---------- 退化（独立于全体候选） ----------

async function degradeWithImageMagickBox(gtBuffer, lowW, lowH, imageMagick) {
  const tempDir = await createResamplerTempDir(join(tmpdir(), 'benchmark4k'))
  try {
    const inputPath = join(tempDir, 'in.png')
    const outputPath = join(tempDir, 'low.png')
    await writeFile(inputPath, gtBuffer)
    await runImageMagickEwaResize({
      executable: imageMagick.executable,
      inputPath,
      outputPath,
      targetWidth: lowW,
      targetHeight: lowH,
      filter: 'Box',
    })
    return readFile(outputPath)
  } finally {
    await removeTempDir(tempDir)
  }
}

async function degradeWithSharpMitchell(gtBuffer, lowW, lowH) {
  return sharp(gtBuffer).resize(lowW, lowH, { fit: 'fill', kernel: sharp.kernel.mitchell }).png().toBuffer()
}

// ---------- 候选 ----------

/** 浏览器生产实现：同一纯函数核 + Worker 同款 pre/post multiply */
async function candidateBrowserLanczos3(lowBuffer, targetW, targetH) {
  const { data, info } = await sharp(lowBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const px = new Uint8ClampedArray(data)
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]
    if (a !== 255 && a !== 0) {
      px[i] = (px[i] * a) / 255
      px[i + 1] = (px[i + 1] * a) / 255
      px[i + 2] = (px[i + 2] * a) / 255
    }
  }
  const resized = lanczos3ResizeRGBA(px, info.width, info.height, targetW, targetH)
  for (let i = 0; i < resized.length; i += 4) {
    const a = resized[i + 3]
    if (a !== 255 && a !== 0) {
      resized[i] = Math.min(255, Math.round((resized[i] * 255) / a))
      resized[i + 1] = Math.min(255, Math.round((resized[i + 1] * 255) / a))
      resized[i + 2] = Math.min(255, Math.round((resized[i + 2] * 255) / a))
    }
  }
  return sharp(Buffer.from(resized.buffer, resized.byteOffset, resized.byteLength), { raw: { width: targetW, height: targetH, channels: 4 } }).png().toBuffer()
}

/** 引擎旧路径（如实标注：libvips 放大将 lanczos3 kernel 映射为 cubic 插值） */
async function candidateSharpLanczos3Kernel(lowBuffer, targetW, targetH) {
  return sharp(lowBuffer).resize(targetW, targetH, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).png().toBuffer()
}

function makeImageMagickCandidate(filter) {
  return async (lowBuffer, targetW, targetH, imageMagick) => {
    const tempDir = await createResamplerTempDir(join(tmpdir(), 'benchmark4k'))
    try {
      const inputPath = join(tempDir, 'in.png')
      const outputPath = join(tempDir, 'out.png')
      await writeFile(inputPath, lowBuffer)
      await runImageMagickEwaResize({
        executable: imageMagick.executable,
        inputPath,
        outputPath,
        targetWidth: targetW,
        targetHeight: targetH,
        filter,
      })
      return readFile(outputPath)
    } finally {
      await removeTempDir(tempDir)
    }
  }
}

// ---------- 指标 ----------

async function rawRGBA(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

function lumaPlane({ data, width, height }) {
  const out = new Float32Array(width * height)
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]
  }
  return out
}

function psnrRGB(a, b) {
  let mse = 0
  const n = Math.min(a.data.length, b.data.length)
  for (let i = 0; i < n; i += 4) {
    mse += (a.data[i] - b.data[i]) ** 2 + (a.data[i + 1] - b.data[i + 1]) ** 2 + (a.data[i + 2] - b.data[i + 2]) ** 2
  }
  mse /= (n / 4) * 3
  return mse === 0 ? Infinity : 10 * Math.log10(255 ** 2 / mse)
}

function windowedSSIM(aPlane, bPlane, width, height, windowSize = 8, stride = 4) {
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  const a = aPlane
  const b = bPlane
  let total = 0
  let count = 0
  for (let y = 0; y + windowSize <= height; y += stride) {
    for (let x = 0; x + windowSize <= width; x += stride) {
      let ma = 0, mb = 0
      for (let j = 0; j < windowSize; j += 1) {
        for (let i2 = 0; i2 < windowSize; i2 += 1) {
          ma += a[(y + j) * width + x + i2]
          mb += b[(y + j) * width + x + i2]
        }
      }
      const n = windowSize * windowSize
      ma /= n; mb /= n
      let va = 0, vb = 0, cov = 0
      for (let j = 0; j < windowSize; j += 1) {
        for (let i2 = 0; i2 < windowSize; i2 += 1) {
          const da = a[(y + j) * width + x + i2] - ma
          const db = b[(y + j) * width + x + i2] - mb
          va += da * da
          vb += db * db
          cov += da * db
        }
      }
      va /= n - 1; vb /= n - 1; cov /= n - 1
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))
      count += 1
    }
  }
  return count ? total / count : 0
}

function downsample2(plane, width, height) {
  const w2 = Math.floor(width / 2)
  const h2 = Math.floor(height / 2)
  const out = new Float32Array(w2 * h2)
  for (let y = 0; y < h2; y += 1) {
    for (let x = 0; x < w2; x += 1) {
      out[y * w2 + x] = (plane[(2 * y) * width + 2 * x] + plane[(2 * y) * width + 2 * x + 1]
        + plane[(2 * y + 1) * width + 2 * x] + plane[(2 * y + 1) * width + 2 * x + 1]) / 4
    }
  }
  return { plane: out, width: w2, height: h2 }
}

/** 标准 5 尺度 MS-SSIM（luma，2x2 平均金字塔） */
function msSSIM(aPlane, bPlane, width, height) {
  const weights = [0.0448, 0.2856, 0.3001, 0.2363, 0.1333]
  let a = { plane: aPlane, width, height }
  let b = { plane: bPlane, width, height }
  let product = 1
  for (let scale = 0; scale < 5; scale += 1) {
    if (a.width < 16 || a.height < 16) break
    const ssim = windowedSSIM(a.plane, b.plane, a.width, a.height, 8, 8)
    product *= ssim ** weights[scale]
    if (scale < 4) {
      a = downsample2(a.plane, a.width, a.height)
      b = downsample2(b.plane, b.width, b.height)
    }
  }
  return product
}

function edgeOvershoot(gtPlane, candPlane, width, height) {
  const gt = gtPlane
  const cand = candPlane
  const sobel = (plane, x, y) => {
    const gx = -plane[(y - 1) * width + x - 1] - 2 * plane[y * width + x - 1] - plane[(y + 1) * width + x - 1]
      + plane[(y - 1) * width + x + 1] + 2 * plane[y * width + x + 1] + plane[(y + 1) * width + x + 1]
    const gy = -plane[(y - 1) * width + x - 1] - 2 * plane[(y - 1) * width + x] - plane[(y - 1) * width + x + 1]
      + plane[(y + 1) * width + x - 1] + 2 * plane[(y + 1) * width + x] + plane[(y + 1) * width + x + 1]
    return Math.hypot(gx, gy)
  }
  let edgePixels = 0
  let overshootSum = 0
  let undershootSum = 0
  let overshootMax = 0
  const r = 2
  for (let y = r; y < height - r; y += 2) {
    for (let x = r; x < width - r; x += 2) {
      if (sobel(gt, x, y) < 80) continue
      let mn = Infinity
      let mx = -Infinity
      for (let j = -r; j <= r; j += 1) {
        for (let i2 = -r; i2 <= r; i2 += 1) {
          const v = gt[(y + j) * width + x + i2]
          if (v < mn) mn = v
          if (v > mx) mx = v
        }
      }
      const c = cand[y * width + x]
      const over = Math.max(0, c - mx)
      const under = Math.max(0, mn - c)
      overshootSum += over
      undershootSum += under
      if (over > overshootMax) overshootMax = over
      edgePixels += 1
    }
  }
  if (!edgePixels) return { edgePixels: 0, meanOvershoot: 0, meanUndershoot: 0, maxOvershoot: 0 }
  return {
    edgePixels,
    meanOvershoot: overshootSum / edgePixels,
    meanUndershoot: undershootSum / edgePixels,
    maxOvershoot: overshootMax,
  }
}

function srgbToLinear(c) {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** ΔE76（采样 1/64 像素），返回平均与 P95 */
function colorDriftDE(a, b) {
  const n = Math.min(a.data.length, b.data.length)
  const deltas = []
  for (let i = 0; i < n; i += 4 * 8 * 8) {
    const la = rgbToLab(a.data[i], a.data[i + 1], a.data[i + 2])
    const lb = rgbToLab(b.data[i], b.data[i + 1], b.data[i + 2])
    deltas.push(Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]))
  }
  if (!deltas.length) return { meanDeltaE: 0, p95DeltaE: 0 }
  deltas.sort((x, y) => x - y)
  return {
    meanDeltaE: deltas.reduce((s, v) => s + v, 0) / deltas.length,
    p95DeltaE: deltas[Math.floor(deltas.length * 0.95)],
  }
}

function rgbToLab(r, g, b) {
  const rl = srgbToLinear(r), gl = srgbToLinear(g), bl = srgbToLinear(b)
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}

/** alpha fringe：半透明边缘像素的色相是否偏离 GT（黑边/白边检测，仅 alpha 用例） */
function alphaFringeScore(gt, cand) {
  let semi = 0
  let hueShift = 0
  const n = Math.min(gt.data.length, cand.data.length)
  for (let i = 0; i < n; i += 4) {
    const ga = gt.data[i + 3]
    if (ga <= 30 || ga >= 225) continue
    const ca = cand.data[i + 3]
    if (ca <= 30) continue
    // 归一到不透明再比色相（预乘/直乘差异不影响最终合成色）
    semi += 1
    hueShift += Math.hypot(gt.data[i] - cand.data[i], gt.data[i + 1] - cand.data[i + 1], gt.data[i + 2] - cand.data[i + 2])
  }
  return { semiTransparentPixels: semi, meanCompositeColorShift: semi ? hueShift / semi : 0 }
}

// ---------- 主流程 ----------

async function main() {
  const imageMagick = await resolveImageMagick()
  await rm(OUT_DIR, { recursive: true, force: true }).catch(() => {})
  await mkdir(OUT_DIR, { recursive: true })

  const candidates = [
    { id: 'browser-lanczos3', run: (low, w, h) => candidateBrowserLanczos3(low, w, h), requiresIM: false },
    { id: 'sharp-lanczos3-kernel(upscale≈cubic)', run: (low, w, h) => candidateSharpLanczos3Kernel(low, w, h), requiresIM: false },
    ...(imageMagick ? [
      { id: 'ewa-lanczos-sharp', run: (low, w, h, im) => makeImageMagickCandidate('LanczosSharp')(low, w, h, im), requiresIM: true },
      { id: 'ewa-lanczos-radius', run: (low, w, h, im) => makeImageMagickCandidate('LanczosRadius')(low, w, h, im), requiresIM: true },
      { id: 'ewa-robidoux', run: (low, w, h, im) => makeImageMagickCandidate('Robidoux')(low, w, h, im), requiresIM: true },
      { id: 'mitchell', run: (low, w, h, im) => makeImageMagickCandidate('Mitchell')(low, w, h, im), requiresIM: true },
    ] : []),
  ]

  const cases = []
  for (const base of SYNTH_BASES) {
    const buffer = await synthImage(base)
    const scales = FULL ? ALL_SCALES : QUICK_SCALES
    for (const scale of scales) {
      cases.push({ id: `${base.name}@${scale}x`, kind: base.kind, gt: buffer, width: base.width, height: base.height, scale })
    }
  }
  // 透明 alpha 专项（半透明主体 + 阴影渐变）
  {
    const size = 1200
    const alphaGt = await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
      input: Buffer.from(`<svg width="${size}" height="${size}">
        <circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.3}" fill="#ff5533" fill-opacity="0.92"/>
        <ellipse cx="${size / 2}" cy="${size * 0.78}" rx="${size * 0.26}" ry="${size * 0.05}" fill="#000000" fill-opacity="0.45"/>
        <rect x="${size * 0.12}" y="${size * 0.12}" width="${size * 0.2}" height="${size * 0.2}" fill="#33ddff" fill-opacity="0.55"/>
      </svg>`),
      top: 0, left: 0,
    }]).png().toBuffer()
    for (const scale of FULL ? [1.5625, 2.25] : [2.25]) {
      cases.push({ id: `alpha-composite@${scale}x`, kind: 'alpha', gt: alphaGt, width: size, height: size, scale })
    }
  }

  const realSet = await buildRealDataset(datasetDirArg, realCountArg)
  for (const real of realSet) {
    const buffer = await sharp(real.path).png().toBuffer()
    for (const scale of FULL ? ALL_SCALES : QUICK_SCALES) {
      const lowW = Math.round(real.width / scale)
      const lowH = Math.round(real.height / scale)
      if (lowW < 256 || lowH < 256) continue
      cases.push({ id: `${real.name}@${scale}x`, kind: 'real', gt: buffer, width: real.width, height: real.height, scale })
    }
  }

  const degradations = [
    { id: 'im-box', make: (gt, w, h) => degradeWithImageMagickBox(gt, w, h, imageMagick), available: Boolean(imageMagick) },
    { id: 'sharp-mitchell', make: (gt, w, h) => degradeWithSharpMitchell(gt, w, h), available: true },
  ].filter((d) => d.available)

  const results = []
  const runtimes = new Map()
  console.log(`benchmark-4k-v2  mode=${FULL ? 'full' : 'quick'}  imagemagick=${imageMagick ? imageMagick.version : 'unavailable'}  cases=${cases.length} degradations=${degradations.length} candidates=${candidates.length}`)

  for (const testCase of cases) {
    for (const degradation of degradations) {
      const lowW = Math.round(testCase.width / testCase.scale)
      const lowH = Math.round(testCase.height / testCase.scale)
      let lowBuffer
      try {
        lowBuffer = await degradation.make(testCase.gt, lowW, lowH)
      } catch (error) {
        results.push({ case: testCase.id, degradation: degradation.id, error: `degradation failed: ${error.message}` })
        continue
      }
      const gtRaw = await rawRGBA(testCase.gt)
      const gtLuma = lumaPlane(gtRaw)
      for (const candidate of candidates) {
        const started = performance.now()
        let outBuffer
        try {
          outBuffer = await candidate.run(lowBuffer, testCase.width, testCase.height, imageMagick)
        } catch (error) {
          results.push({ case: testCase.id, degradation: degradation.id, candidate: candidate.id, error: String(error.message).slice(0, 200) })
          continue
        }
        const elapsed = performance.now() - started
        const list = runtimes.get(candidate.id) ?? []
        list.push(elapsed)
        runtimes.set(candidate.id, list)

        const meta = await sharp(outBuffer).metadata()
        const exactDimensions = meta.width === testCase.width && meta.height === testCase.height
        const candRaw = exactDimensions ? await rawRGBA(outBuffer) : null
        const candLuma = candRaw ? lumaPlane(candRaw) : null
        const entry = {
          case: testCase.id,
          kind: testCase.kind,
          degradation: degradation.id,
          candidate: candidate.id,
          lowSize: `${lowW}x${lowH}`,
          targetSize: `${testCase.width}x${testCase.height}`,
          scale: testCase.scale,
          runtimeMs: Math.round(elapsed),
          exactDimensions,
          psnr: candRaw ? Number(psnrRGB(gtRaw, candRaw).toFixed(3)) : null,
          ssim: candLuma ? Number(windowedSSIM(gtLuma, candLuma, testCase.width, testCase.height).toFixed(5)) : null,
          msSsim: candLuma ? Number(msSSIM(gtLuma, candLuma, testCase.width, testCase.height).toFixed(5)) : null,
          ...((candLuma && testCase.kind !== 'alpha')
            ? { edge: Object.fromEntries(Object.entries(edgeOvershoot(gtLuma, candLuma, testCase.width, testCase.height)).map(([k, v]) => [k, Number(v.toFixed(3))])) }
            : {}),
          ...(candRaw ? { colorDrift: Object.fromEntries(Object.entries(colorDriftDE(gtRaw, candRaw)).map(([k, v]) => [k, Number(v.toFixed(3))])) } : {}),
          ...(testCase.kind === 'alpha' && candRaw
            ? { alphaFringe: Object.fromEntries(Object.entries(alphaFringeScore(gtRaw, candRaw)).map(([k, v]) => [k, Number(v.toFixed(3))])) }
            : {}),
        }
        results.push(entry)
      }
    }
  }

  // 确定性验证：代表用例两跑（字节 + 像素级）
  const determinism = { checked: false }
  if (imageMagick) {
    const probeCase = cases.find((c) => c.kind === 'synthetic')
    if (probeCase) {
      const low = await degradeWithSharpMitchell(probeCase.gt, Math.round(probeCase.width / 2), Math.round(probeCase.height / 2))
      const run = makeImageMagickCandidate('LanczosSharp')
      const a = await run(low, probeCase.width, probeCase.height, imageMagick)
      const b = await run(low, probeCase.width, probeCase.height, imageMagick)
      determinism.checked = true
      determinism.byteStable = sha256(a) === sha256(b)
      const ra = await rawRGBA(a)
      const rb = await rawRGBA(b)
      determinism.pixelStable = sha256(ra.data) === sha256(rb.data)
    }
  }

  // 汇总：每候选 × 每 kind 的指标均值
  const summaryByCandidate = {}
  for (const candidate of candidates) {
    const rows = results.filter((r) => r.candidate === candidate.id && r.exactDimensions)
    const avg = (pick) => {
      const values = rows.map(pick).filter((v) => typeof v === 'number' && Number.isFinite(v))
      return values.length ? Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(4)) : null
    }
    const list = (runtimes.get(candidate.id) ?? []).slice().sort((x, y) => x - y)
    summaryByCandidate[candidate.id] = {
      caseCount: rows.length,
      exactDimensionRate: rows.length ? rows.length / results.filter((r) => r.candidate === candidate.id).length : null,
      psnr: avg((r) => r.psnr),
      ssim: avg((r) => r.ssim),
      msSsim: avg((r) => r.msSsim),
      edgeOvershoot: avg((r) => r.edge?.meanOvershoot),
      edgeUndershoot: avg((r) => r.edge?.meanUndershoot),
      meanDeltaE: avg((r) => r.colorDrift?.meanDeltaE),
      runtimeMedianMs: list.length ? Math.round(list[Math.floor(list.length / 2)]) : null,
      runtimeP95Ms: list.length ? Math.round(list[Math.floor(list.length * 0.95)]) : null,
    }
  }

  const failures = results.filter((r) => r.error || r.exactDimensions === false)
  const report = {
    benchmark: 'benchmark-4k-v2',
    generatedAt: new Date().toISOString(),
    mode: FULL ? 'full' : 'quick',
    environment: {
      node: process.version,
      imagemagick: imageMagick ? { version: imageMagick.version, source: imageMagick.source ?? 'pinned-sidecar' } : null,
      datasetDir: datasetDirArg,
      realImages: realSet.length,
    },
    methodology: {
      degradation: 'independent of candidates: ImageMagick EWA Box filter + sharp mitchell (two independent pipelines; no candidate filter used to synthesize the low input)',
      gt: 'original full-resolution image; low = GT degraded by 1/scale; candidates reconstruct to exact GT dimensions and are compared to GT',
      metrics: 'full-image RGB PSNR; 8x8 windowed SSIM (stride 4, luma); 5-scale MS-SSIM (luma, 2x2 avg pyramid); sobel-thresholded edge over/undershoot vs 5x5 GT local range; ΔE76 color drift (1/64 sampled); alpha composite-color shift for alpha cases; exact-dimension assert; runtime median/P95; byte+pixel determinism probe',
      circularityNote: 'sharp-mitchell degradation shares its kernel family with the mitchell candidate — treat mitchell numbers on that degradation with care; im-box degradation favors no candidate',
      limitations: [
        'synthetic SVG content is not photography; real-image rows are the ground for perceptual ranking',
        'SSIM/MS-SSIM are computed at native resolution on luma; no viewing-distance model',
        'real-esrgan / hat (generative) intentionally excluded from deterministic benchmark scope',
      ],
    },
    determinism,
    summaryByCandidate,
    failures: failures.length,
    results,
  }

  await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2))

  const mdLines = [
    '# 4K Quality Benchmark v2',
    '',
    `生成时间：${report.generatedAt}　模式：${report.mode}　ImageMagick：${imageMagick ? imageMagick.version : '不可用（IM 候选已跳过）'}`,
    '',
    `用例 ${cases.length} × 退化 ${degradations.length} × 候选 ${candidates.length}；失败行 ${failures.length}。`,
    '',
    '| 候选 | PSNR↑ | SSIM↑ | MS-SSIM↑ | 过冲↓ | 欠冲↓ | ΔE↓ | 中位耗时ms | P95 ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const [id, s] of Object.entries(summaryByCandidate)) {
    mdLines.push(`| ${id} | ${s.psnr ?? '-'} | ${s.ssim ?? '-'} | ${s.msSsim ?? '-'} | ${s.edgeOvershoot ?? '-'} | ${s.edgeUndershoot ?? '-'} | ${s.meanDeltaE ?? '-'} | ${s.runtimeMedianMs ?? '-'} | ${s.runtimeP95Ms ?? '-'} |`)
  }
  mdLines.push('', `确定性（IM LanczosSharp 两跑）：byte=${determinism.byteStable} pixel=${determinism.pixelStable}`, '')
  await writeFile(join(OUT_DIR, 'report.md'), mdLines.join('\n'))

  console.log(mdLines.join('\n'))
  console.log(`\nreport: ${join(OUT_DIR, 'report.json')}`)
  if (failures.length) {
    console.log(`FAILURES: ${failures.length} 行（详见 report.json results[].error / exactDimensions）`)
    process.exitCode = 1
  }
}

await main()
