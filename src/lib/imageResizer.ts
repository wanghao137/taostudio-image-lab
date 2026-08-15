import { blobToDataUrl } from './dataUrl'
import { loadImage } from './canvasImage'

let workerInstance: Worker | null = null
let workerRequestId = 0

function destroyUpscaleWorker() {
  if (!workerInstance) return
  try {
    workerInstance.terminate()
  } catch {
    // 已死则忽略
  }
  workerInstance = null
}

function getUpscaleWorker(): Worker | null {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null
  if (workerInstance) return workerInstance
  try {
    const worker = new Worker(new URL('../workers/lanczosUpscale.worker.ts', import.meta.url), { type: 'module' })
    // 模块加载失败/CSP 拦截等：回收实例，后续调用立即走 canvas 回退，
    // 而不是每张图都白等 120 秒超时。
    worker.addEventListener('error', () => {
      destroyUpscaleWorker()
    })
    workerInstance = worker
    return worker
  } catch {
    return null
  }
}

/**
 * Worker 路径：lanczos3 重采样（cover 裁切内建），PNG dataUrl 输出。
 * 输出格式固定 PNG——exact_size 4K 资产路径本就要求无损。
 * requestId 关联：并发调用（如 n=4 扇出）各自只收自己的响应，不会串台。
 */
async function resizeWithWorker(dataUrl: string, targetW: number, targetH: number, fitMode: 'cover' | 'contain'): Promise<string> {
  const worker = getUpscaleWorker()
  if (!worker) throw new Error('worker unavailable')
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  const requestId = ++workerRequestId
  const result = await new Promise<{ buffer?: ArrayBuffer; error?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', onMessage)
      // 超时视为 Worker 卡死：回收实例，避免后续每张图都白等 120 秒
      destroyUpscaleWorker()
      reject(new Error('lanczos upscale timeout'))
    }, 120_000)
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { requestId?: number }).requestId !== requestId) return
      clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      resolve(event.data as { buffer?: ArrayBuffer; error?: string })
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage({ requestId, bitmap, targetW, targetH, fitMode }, [bitmap])
  })
  if (result.error || !result.buffer) throw new Error(result.error || 'lanczos upscale failed')
  return blobToDataUrl(new Blob([result.buffer], { type: 'image/png' }), 'image/png')
}

/** 主线程回退：canvas 高质量平滑（Worker/OffscreenCanvas 不可用时）。 */
async function resizeWithCanvas(dataUrl: string, targetW: number, targetH: number, fitMode: 'cover' | 'contain'): Promise<string> {
  const image = await loadImage(dataUrl)
  const srcRatio = image.naturalWidth / image.naturalHeight
  const targetRatio = targetW / targetH
  let sx = 0
  let sy = 0
  let sw = image.naturalWidth
  let sh = image.naturalHeight
  if (fitMode === 'cover' && srcRatio !== targetRatio) {
    if (srcRatio > targetRatio) {
      sw = Math.round(sh * targetRatio)
      sx = Math.floor((image.naturalWidth - sw) / 2)
    } else {
      sh = Math.round(sw / targetRatio)
      sy = Math.floor((image.naturalHeight - sh) / 2)
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable in this browser')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  if (fitMode === 'contain' && srcRatio !== targetRatio) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, targetW, targetH)
  }
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, targetW, targetH)
  return blobToDataUrl(await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error('canvas export failed')), 'image/png')
  }), 'image/png')
}

/**
 * 高质量重采样入口：优先 Worker lanczos3（不阻塞 UI），失败回退 canvas。
 * 注意：与旧实现不同，这里 cover 裁切发生在 raw 原图上（单次重采样），
 * 不再有"先规格化到 1K 再放大"的两次重采样路径。
 */
export async function resizeImageHighQuality(
  dataUrl: string,
  targetW: number,
  targetH: number,
  fitMode: 'cover' | 'contain' = 'cover',
): Promise<string> {
  try {
    return await resizeWithWorker(dataUrl, targetW, targetH, fitMode)
  } catch (error) {
    console.warn('lanczos Worker 重采样失败，回退 canvas', error)
    return resizeWithCanvas(dataUrl, targetW, targetH, fitMode)
  }
}
