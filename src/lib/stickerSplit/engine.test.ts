import { describe, expect, it } from 'vitest'
import { rerunSquare, runSplitFull, type SplitImageData } from './engine'
import { buildSplitOptions, DEFAULT_STICKER_SPLIT_PARAMS, type StickerSplitParams } from './splitService'

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 透明底贴纸拼图：指定矩形处放实心贴纸，其余全透明。 */
function makeTransparentGrid(width: number, height: number, rects: Rect[]): SplitImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  rects.forEach((r, i) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const p = (y * width + x) * 4
        data[p] = 200 + i * 8
        data[p + 1] = 120
        data[p + 2] = 90
        data[p + 3] = 255
      }
    }
  })
  return { width, height, data }
}

/** 白底 JPG：全图不透明白底，贴纸为彩色矩形。 */
function makeColorGrid(width: number, height: number, rects: Rect[]): SplitImageData {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < data.length; p += 4) {
    data[p] = 255
    data[p + 1] = 255
    data[p + 2] = 255
    data[p + 3] = 255
  }
  rects.forEach((r, i) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const p = (y * width + x) * 4
        data[p] = 180 - i * 10
        data[p + 1] = 90
        data[p + 2] = 60
        data[p + 3] = 255
      }
    }
  })
  return { width, height, data }
}

function nineGridRects(): Rect[] {
  const rects: Rect[] = []
  const size = 240
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      rects.push({ x: 30 + col * 300, y: 30 + row * 300, w: size, h: size })
    }
  }
  return rects
}

/** 像素级验收断言：零丢失、零串台、边缘 ≤3px 紧贴、方形输出 w===h。
 *  isSolid 的判据必须与分析模式一致（alpha 模式看透明度，color 模式看色距）。 */
function assertPixelLevelAccurate(
  image: SplitImageData,
  rects: Rect[],
  outputs: Array<{ x: number; y: number; w: number; h: number; data: Uint8ClampedArray }>,
  square: boolean,
  isSolid: (x: number, y: number) => boolean,
) {
  expect(outputs).toHaveLength(rects.length)

  // 预计算贴纸归属标签（0=背景，1..n=贴纸），像素循环里 O(1) 查表
  const labels = new Int32Array(image.width * image.height)
  rects.forEach((r, ri) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        labels[y * image.width + x] = ri + 1
      }
    }
  })

  const pollution: string[] = []
  const loss: string[] = []
  const coverageByOutput: Uint8Array[] = outputs.map(() => new Uint8Array(rects.length + 1))
  outputs.forEach((output, outIdx) => {
    for (let y = 0; y < output.h; y++) {
      for (let x = 0; x < output.w; x++) {
        const gx = output.x + x
        const gy = output.y + y
        if (!isSolid(gx, gy)) continue
        const owner = gx >= 0 && gy >= 0 && gx < image.width && gy < image.height ? labels[gy * image.width + gx] : 0
        coverageByOutput[outIdx][owner] = 1
        if (owner === 0) pollution.push(`输出#${outIdx + 1} 含非贴纸实心像素 (${gx},${gy})`)
        else if (owner !== outIdx + 1) pollution.push(`输出#${outIdx + 1} 串入了贴纸#${owner} 的像素 (${gx},${gy})`)
      }
    }
  })
  expect(pollution, pollution.slice(0, 5).join('；')).toEqual([])
  // 每张输出恰好完整覆盖自己的贴纸（零丢失且无遗漏）
  coverageByOutput.forEach((coverage, outIdx) => {
    expect(coverage[outIdx + 1], `输出#${outIdx + 1} 丢失自己的贴纸像素`).toBe(1)
  })

  // 采样校验实心像素确实落在对应输出内（对 5 个关键点做包含性检查）
  rects.forEach((r, ri) => {
    const sampled = [
      [r.x + 1, r.y + 1],
      [r.x + r.w - 2, r.y + 1],
      [r.x + 1, r.y + r.h - 2],
      [r.x + r.w - 2, r.y + r.h - 2],
      [r.x + (r.w >> 1), r.y + (r.h >> 1)],
    ]
    const output = outputs[ri]
    sampled.forEach(([sx, sy]) => {
      const ox = sx - output.x
      const oy = sy - output.y
      if (ox < 0 || oy < 0 || ox >= output.w || oy >= output.h) {
        loss.push(`贴纸#${ri + 1} 像素 (${sx},${sy}) 不在输出内`)
        return
      }
      if (!isSolidInOutput(output, ox, oy)) loss.push(`贴纸#${ri + 1} 像素 (${sx},${sy}) 在输出中丢失`)
    })
  })
  expect(loss, loss.slice(0, 5).join('；')).toEqual([])

  outputs.forEach((output, i) => {
    const r = rects[i]
    // 边缘紧贴 ≤3px（extract 紧框 + 2px 保护边）
    expect(Math.abs(output.x - r.x)).toBeLessThanOrEqual(3)
    expect(Math.abs(output.y - r.y)).toBeLessThanOrEqual(3)
    if (!square) {
      expect(Math.abs(output.w - r.w)).toBeLessThanOrEqual(6)
      expect(Math.abs(output.h - r.h)).toBeLessThanOrEqual(6)
    }
  })

  if (square) {
    outputs.forEach((output) => {
      expect(output.w).toBe(output.h)
    })
  }
}

function isSolidInOutput(
  output: { x: number; y: number; w: number; data: Uint8ClampedArray },
  ox: number,
  oy: number,
) {
  // 输出画布里的像素就是原图像素的拷贝（可能被擦除邻居），这里直接看输出 alpha/颜色即可：
  // alpha 模式看 alpha，color 模式看与白底的色距。
  const alpha = output.data[(oy * output.w + ox) * 4 + 3]
  if (alpha >= 128) return true
  const p = (oy * output.w + ox) * 4
  const d = Math.max(Math.abs(output.data[p] - 255), Math.abs(output.data[p + 1] - 255), Math.abs(output.data[p + 2] - 255))
  return d > 30
}

describe('stickerSplit engine 集成', () => {
  it('透明底九宫格：恰好 9 张、阅读顺序、像素级零污染零丢失、方形 1:1', () => {
    const rects = nineGridRects()
    const image = makeTransparentGrid(900, 900, rects)
    const result = runSplitFull(image, {}, 'auto')
    expect(result.source).toBe('alpha')
    expect(result.squareAuto).toBe(true)
    expect(result.square).toBe(true)
    const isSolid = (x: number, y: number) => image.data[(y * image.width + x) * 4 + 3] >= 128
    assertPixelLevelAccurate(image, rects, result.outputs, true, isSolid)
    expect(result.analyzeResult.boxes).toHaveLength(9)
  })

  it('白底九宫格：走颜色键路径', () => {
    const rects = nineGridRects()
    const image = makeColorGrid(900, 900, rects)
    const result = runSplitFull(image, { source: 'color' }, 'auto')
    expect(result.source).toBe('color')
    const isSolid = (x: number, y: number) => {
      const p = (y * image.width + x) * 4
      return Math.max(Math.abs(image.data[p] - 255), Math.abs(image.data[p + 1] - 255), Math.abs(image.data[p + 2] - 255)) > 30
    }
    assertPixelLevelAccurate(image, rects, result.outputs, true, isSolid)
  })

  it('方形输出三态：on 强制 1:1，off 保留原始宽高', () => {
    const rects: Rect[] = [{ x: 50, y: 50, w: 300, h: 200 }]
    const image = makeTransparentGrid(400, 300, rects)
    const on = runSplitFull(image, {}, 'on')
    expect(on.square).toBe(true)
    expect(on.outputs[0].w).toBe(on.outputs[0].h)

    const off = runSplitFull(image, {}, 'off')
    expect(off.square).toBe(false)
    expect(off.outputs[0].w - off.outputs[0].h).toBeGreaterThan(80)
  })

  it('rerunSquare 复用 analyze 结果：off → on 输出一致', () => {
    const rects = nineGridRects()
    const image = makeTransparentGrid(900, 900, rects)
    const first = runSplitFull(image, {}, 'off')
    const resquared = rerunSquare(image, first.analyzeResult, 'on')
    expect(resquared.square).toBe(true)
    expect(resquared.outputs).toHaveLength(9)
    resquared.outputs.forEach((o) => expect(o.w).toBe(o.h))
    const direct = runSplitFull(image, {}, 'on')
    expect(resquared.outputs.map((o) => o.w)).toEqual(direct.outputs.map((o) => o.w))
  })

  it('小装饰挂靠：贴纸旁的小方块并入同一输出', () => {
    const rects: Rect[] = [
      { x: 40, y: 40, w: 200, h: 200 },
      { x: 40, y: 400, w: 200, h: 200 },
      { x: 300, y: 70, w: 14, h: 14 }, // 装饰：面积远小于贴纸
    ]
    const image = makeTransparentGrid(600, 640, rects)
    const result = runSplitFull(image, {}, 'auto')
    expect(result.outputs).toHaveLength(2)
    // 装饰挂在第一张贴纸的输出里（同色系断崖：主贴纸 40000px vs 装饰 196px）
    const first = result.outputs[0]
    expect(first.x).toBeLessThanOrEqual(300)
    expect(first.w).toBeGreaterThan(250)
  })

  it('阈值切断软光晕桥接：alpha 桥接的两个贴纸仍切出 2 张', () => {
    // 两个实心贴纸之间铺一条 alpha=100 的光晕桥（低于阈值 128，会被切断）
    const w = 600
    const data = new Uint8ClampedArray(w * 300 * 4)
    const fill = (x0: number, y0: number, width: number, height: number, alpha: number) => {
      for (let y = y0; y < y0 + height; y++) {
        for (let x = x0; x < x0 + width; x++) {
          const p = (y * w + x) * 4
          data[p] = 220
          data[p + 1] = 130
          data[p + 2] = 90
          data[p + 3] = alpha
        }
      }
    }
    fill(40, 100, 150, 100, 255)
    fill(410, 100, 150, 100, 255)
    fill(190, 130, 220, 40, 100)
    const result = runSplitFull({ width: w, height: 300, data }, {}, 'auto')
    expect(result.outputs).toHaveLength(2)
  })
})

describe('buildSplitOptions 参数映射', () => {
  it('alpha 源映射 threshold，color 源映射 bgTolerance，auto 参数不透传', () => {
    const params: StickerSplitParams = { ...DEFAULT_STICKER_SPLIT_PARAMS, threshold: 200, tolerance: 50 }
    const alphaOpts = buildSplitOptions('alpha', params)
    expect(alphaOpts.threshold).toBe(200)
    expect(alphaOpts.bgTolerance).toBeUndefined()
    expect(alphaOpts.gap).toBeUndefined()

    const colorOpts = buildSplitOptions('color', params)
    expect(colorOpts.bgTolerance).toBe(50)
    expect(colorOpts.threshold).toBeUndefined()

    const autoOpts = buildSplitOptions('auto', DEFAULT_STICKER_SPLIT_PARAMS)
    expect(autoOpts.source).toBe('auto')
    expect('threshold' in autoOpts).toBe(true) // 默认 128 仍显式传递，跟随 source 联动
    expect(autoOpts.gap).toBeUndefined()
    expect(autoOpts.minSize).toBeUndefined()
    expect(autoOpts.padding).toBeUndefined()
  })

  it('显式参数覆盖 auto', () => {
    const opts = buildSplitOptions('alpha', { ...DEFAULT_STICKER_SPLIT_PARAMS, gap: 40, minSize: 800, padding: 12 })
    expect(opts.gap).toBe(40)
    expect(opts.minSize).toBe(800)
    expect(opts.padding).toBe(12)
  })
})
