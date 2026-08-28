// 透明类型检测：「拆分贴纸」入口只在带真实透明背景的图上展示。
// 判据(第一性原理)：贴纸拼图的透明背景通常占 ≥30% 像素；不透明图(JPG/不透明 PNG)
// 除个别缩放噪点外 alpha 恒为 255。取 ≤128 边的降采样图，≥1% 像素 alpha ≤8 即判为透明。
// 检测对象用当前可见 src 即可：原图 PNG 自带 alpha，网格缩略图是 WebP(保留 alpha 通道)。
const SAMPLE_MAX_DIM = 128
const MIN_TRANSPARENT_RATIO = 0.01
const ALPHA_FLOOR = 8
const CACHE_MAX_ENTRIES = 300

const results = new Map<string, Promise<boolean>>()

/** 带 memo 的检测；key 优先用 imageId，无 id 时退回 src 本身。解码失败按不透明处理，宁缺勿滥。 */
export function isTransparentImageCached(key: string, src: string): Promise<boolean> {
  const known = results.get(key)
  if (known) return known
  const pending = isTransparentImage(src).catch(() => false)
  if (results.size >= CACHE_MAX_ENTRIES) results.clear()
  results.set(key, pending)
  return pending
}

export async function isTransparentImage(src: string): Promise<boolean> {
  const res = await fetch(src)
  if (!res.ok && !src.startsWith('data:')) throw new Error(`读取图片失败：${res.status}`)
  const blob = await res.blob()
  const bitmap = await createImageBitmap(blob)
  try {
    const scale = Math.min(1, SAMPLE_MAX_DIM / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return false
    ctx.drawImage(bitmap, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    let transparent = 0
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] <= ALPHA_FLOOR) transparent++
    }
    return transparent >= w * h * MIN_TRANSPARENT_RATIO
  } finally {
    bitmap.close()
  }
}
