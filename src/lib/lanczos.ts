/**
 * 纯函数 Lanczos3 重采样核心（无 DOM 依赖）：Worker 与单测共用。
 * 分离水平/垂直两趟（可分离核），时间 O(srcW×dstW + srcH×dstH) 的预计算
 * 权重 + O(dst 总像素) 的加权累加——8MP 目标在主线程也只需数百毫秒，
 * Worker 里则完全不阻塞 UI。
 */

export interface ResizeWeights {
  /** 每个目标像素对应的源像素索引区间 [start, start + count) */
  starts: Int32Array
  counts: Int32Array
  /** 展开的权重（按目标像素分段） */
  weights: Float32Array
}

/** Lanczos 核（a=3） */
export function lanczos3(x: number): number {
  if (x === 0) return 1
  const absX = Math.abs(x)
  if (absX >= 3) return 0
  const px = Math.PI * absX
  // sinc(x) * sinc(x/3)
  return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px)
}

/** 预计算某轴的一维重采样权重（含边界钳制与归一化，防止边缘振铃）。 */
export function computeAxisWeights(srcSize: number, dstSize: number): ResizeWeights {
  const starts = new Int32Array(dstSize)
  const counts = new Int32Array(dstSize)
  const weightChunks: Float32Array[] = []

  // 放大用等分点采样中心，缩小按 filter 半径覆盖（本仓库场景只放大，
  // 但保留下采样正确性以便复用）。
  const scale = dstSize >= srcSize ? 1 : srcSize / dstSize
  const filterRadius = 3 * scale

  for (let dst = 0; dst < dstSize; dst += 1) {
    const center = (dst + 0.5) * (srcSize / dstSize)
    const start = Math.max(0, Math.floor(center - filterRadius + 0.5))
    const end = Math.min(srcSize, Math.ceil(center + filterRadius + 0.5))
    const count = end - start
    const chunk = new Float32Array(count)
    let sum = 0
    for (let i = 0; i < count; i += 1) {
      const w = lanczos3((start + i + 0.5 - center) / scale)
      chunk[i] = w
      sum += w
    }
    if (sum !== 0) {
      for (let i = 0; i < count; i += 1) chunk[i] /= sum
    }
    starts[dst] = start
    counts[dst] = count
    weightChunks.push(chunk)
  }

  const weights = new Float32Array(weightChunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of weightChunks) {
    weights.set(chunk, offset)
    offset += chunk.length
  }
  return { starts, counts, weights }
}

/** 预计算每个目标像素的权重段起始偏移（O(n)，替代循环内重复累加的 O(n²)）。 */
function computeWeightOffsets(counts: Int32Array): Int32Array {
  const offsets = new Int32Array(counts.length)
  let acc = 0
  for (let i = 0; i < counts.length; i += 1) {
    offsets[i] = acc
    acc += counts[i]
  }
  return offsets
}

/**
 * RGBA 逐通道 lanczos3 重采样（两趟可分离）。
 * src 为 RGBA（4 字节/像素）；返回同格式。处理 8MP 图时中间缓冲约
 * dstW×srcH×4 字节（4K 目标约 53MB transient，Worker 中无碍）。
 */
export function lanczos3ResizeRGBA(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  // 水平趟：srcW×srcH → dstW×srcH
  const hw = computeAxisWeights(srcW, dstW)
  const hwOffsets = computeWeightOffsets(hw.counts)
  const mid = new Float32Array(dstW * srcH * 4)
  for (let y = 0; y < srcH; y += 1) {
    const srcRow = y * srcW * 4
    const midRow = y * dstW * 4
    for (let dx = 0; dx < dstW; dx += 1) {
      const start = hw.starts[dx]
      const count = hw.counts[dx]
      const weightOffset = hwOffsets[dx]
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < count; k += 1) {
        const w = hw.weights[weightOffset + k]
        if (w === 0) continue
        const sx = (start + k) * 4 + srcRow
        r += w * src[sx]
        g += w * src[sx + 1]
        b += w * src[sx + 2]
        a += w * src[sx + 3]
      }
      const dm = dx * 4 + midRow
      mid[dm] = r
      mid[dm + 1] = g
      mid[dm + 2] = b
      mid[dm + 3] = a
    }
  }

  // 垂直趟：dstW×srcH → dstW×dstH
  const vw = computeAxisWeights(srcH, dstH)
  const vwOffsets = computeWeightOffsets(vw.counts)
  const dst = new Uint8ClampedArray(dstW * dstH * 4)
  for (let dy = 0; dy < dstH; dy += 1) {
    const start = vw.starts[dy]
    const count = vw.counts[dy]
    const weightOffset = vwOffsets[dy]
    for (let x = 0; x < dstW; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < count; k += 1) {
        const w = vw.weights[weightOffset + k]
        if (w === 0) continue
        const sm = (start + k) * dstW * 4 + x * 4
        r += w * mid[sm]
        g += w * mid[sm + 1]
        b += w * mid[sm + 2]
        a += w * mid[sm + 3]
      }
      const dIdx = (dy * dstW + x) * 4
      dst[dIdx] = Math.round(r)
      dst[dIdx + 1] = Math.round(g)
      dst[dIdx + 2] = Math.round(b)
      dst[dIdx + 3] = Math.round(a)
    }
  }
  return dst
}

/** cover 裁切：从源图中心裁出目标比例的子区域（返回像素区间）。 */
export function computeCoverCrop(
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
): { x: number; y: number; cropW: number; cropH: number } {
  const srcRatio = srcW / srcH
  const targetRatio = targetW / targetH
  if (srcRatio > targetRatio) {
    const cropW = Math.round(srcH * targetRatio)
    const x = Math.floor((srcW - cropW) / 2)
    return { x, y: 0, cropW, cropH: srcH }
  }
  const cropH = Math.round(srcW / targetRatio)
  const y = Math.floor((srcH - cropH) / 2)
  return { x: 0, y, cropW: srcW, cropH }
}
