import type { SplitImageData, SplitRunResult, SquareSetting } from './engine'
import type { StickerSplitOptions } from './coreLoad'

/** 高级面板的可调参数（与 core 选项的映射见 buildSplitOptions）。 */
export interface StickerSplitParams {
  threshold: number
  tolerance: number
  gap: number | 'auto'
  minSize: number | 'auto'
  padding: number | 'auto'
}

export const DEFAULT_STICKER_SPLIT_PARAMS: StickerSplitParams = {
  threshold: 128,
  tolerance: 30,
  gap: 'auto',
  minSize: 'auto',
  padding: 'auto',
}

/** alpha 源只认 threshold，color 源只认 bgTolerance；auto 的参数不传，交给 core 默认。 */
export function buildSplitOptions(source: 'auto' | 'alpha' | 'color', params: StickerSplitParams): StickerSplitOptions {
  const opts: StickerSplitOptions = { source }
  if (source === 'color') opts.bgTolerance = params.tolerance
  else opts.threshold = params.threshold
  if (params.gap !== 'auto') opts.gap = params.gap
  if (params.minSize !== 'auto') opts.minSize = params.minSize
  if (params.padding !== 'auto') opts.padding = params.padding
  return opts
}

/** Worker 缓存缺失（实例被回收过）时抛出的标记错误，调用方应带像素重跑。 */
export class StickerSplitCacheMissError extends Error {
  constructor() {
    super('sticker-split cache miss')
    this.name = 'StickerSplitCacheMissError'
  }
}

/** 任意可 fetch 的 src（dataURL / blobURL / 远程 URL）→ 像素数据 + 显示用位图（调用方负责 close）。 */
export async function decodeImageSource(src: string): Promise<{ imageData: SplitImageData; display: ImageBitmap }> {
  const res = await fetch(src)
  if (!res.ok && !src.startsWith('data:')) throw new Error(`读取图片失败：${res.status}`)
  const blob = await res.blob()
  const bitmap = await createImageBitmap(blob)
  const w = bitmap.width
  const h = bitmap.height
  const readPixels = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
    ctx.drawImage(bitmap, 0, 0)
    const d = ctx.getImageData(0, 0, w, h)
    return { width: w, height: h, data: d.data }
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
    if (ctx) return { imageData: readPixels(ctx), display: bitmap }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx2d) {
    bitmap.close()
    throw new Error('无法创建画布上下文')
  }
  return { imageData: readPixels(ctx2d), display: bitmap }
}

type WorkerOkResponse = {
  requestId: number
  ok: true
  result: {
    source: 'alpha' | 'color'
    suggestGap: number
    stats: { ms: number; componentsRaw: number; components: number; groups: number }
    squareAuto: boolean
    square: boolean
    outputs: Array<{ index: number; x: number; y: number; w: number; h: number; data: ArrayBuffer }>
  }
}

type WorkerErrResponse = { requestId: number; ok: false; error: string; code?: 'no-cache' }

let workerInstance: Worker | null = null
let workerRequestId = 0

function destroySplitWorker() {
  if (!workerInstance) return
  try {
    workerInstance.terminate()
  } catch {
    // 已死则忽略
  }
  workerInstance = null
}

function getSplitWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  if (workerInstance) return workerInstance
  try {
    const worker = new Worker(new URL('../../workers/stickerSplit.worker.ts', import.meta.url), { type: 'module' })
    // 模块加载失败/CSP 拦截：回收实例，后续调用直接走主线程回退。
    worker.addEventListener('error', () => {
      destroySplitWorker()
    })
    workerInstance = worker
    return worker
  } catch {
    return null
  }
}

const WORKER_TIMEOUT_MS = 120_000

/**
 * 完整切分管线（analyze + extract + 方形化）。发送前复制一份像素再 transfer，
 * 调用方持有的 imageData 始终有效，可继续用于后续参数重算。
 */
export async function splitStickerImage(imageData: SplitImageData, opts: StickerSplitOptions, squareSetting: SquareSetting): Promise<SplitRunResult> {
  const worker = getSplitWorker()
  if (!worker) return runOnMainThread(imageData, opts, squareSetting)

  const requestId = ++workerRequestId
  const copy = imageData.data.slice()
  const response = await askWorker(worker, requestId, {
    type: 'split',
    requestId,
    imageData: { width: imageData.width, height: imageData.height, data: copy.buffer as ArrayBuffer },
    opts,
    squareSetting,
  }, [copy.buffer as ArrayBuffer])

  if (!response.ok) throw new Error(response.error || '贴纸切分失败')
  return toRunResult(response.result)
}

/**
 * 复用 Worker 缓存的像素重算：resquare=true 只重跑 extract + 方形化（切方形输出用），
 * 否则从缓存像素完整重 analyze（高级参数调整用）。缓存缺失抛 StickerSplitCacheMissError。
 */
export async function rerunStickerSplit(opts: StickerSplitOptions, squareSetting: SquareSetting, resquare: boolean): Promise<SplitRunResult> {
  const worker = getSplitWorker()
  if (!worker) throw new StickerSplitCacheMissError()

  const requestId = ++workerRequestId
  const response = await askWorker(worker, requestId, {
    type: resquare ? 'resquare' : 'reanalyze',
    requestId,
    opts,
    squareSetting,
  })

  if (!response.ok) {
    if (response.code === 'no-cache') throw new StickerSplitCacheMissError()
    throw new Error(response.error || '贴纸切分失败')
  }
  return toRunResult(response.result)
}

function toRunResult(result: WorkerOkResponse['result']): SplitRunResult {
  return {
    source: result.source,
    suggestGap: result.suggestGap,
    stats: result.stats,
    squareAuto: result.squareAuto,
    square: result.square,
    outputs: result.outputs.map((o) => ({
      index: o.index,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      data: new Uint8ClampedArray(o.data),
    })),
  }
}

function askWorker(worker: Worker, requestId: number, payload: Record<string, unknown>, transfer?: Array<ArrayBuffer>) {
  return new Promise<WorkerOkResponse | WorkerErrResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.removeEventListener('message', onMessage)
      // 超时视为 Worker 卡死：回收实例，避免后续每次都白等满超时
      destroySplitWorker()
      reject(new Error('贴纸切分超时'))
    }, WORKER_TIMEOUT_MS)
    const onMessage = (event: MessageEvent<WorkerOkResponse | WorkerErrResponse>) => {
      if (event.data?.requestId !== requestId) return
      clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      resolve(event.data)
    }
    worker.addEventListener('message', onMessage)
    worker.postMessage(payload, transfer ?? [])
  })
}

async function runOnMainThread(imageData: SplitImageData, opts: StickerSplitOptions, squareSetting: SquareSetting): Promise<SplitRunResult> {
  // 回退路径按需加载，避免正常路径把 core.js 打进主 chunk。
  const { runSplitFull } = await import('./engine')
  const { analyzeResult: _analyzeResult, ...result } = runSplitFull(imageData, opts, squareSetting)
  return result
}
