/// <reference lib="webworker" />
import { rerunSquare, runSplitFull, type SplitImageData, type SplitRunResult, type SquareSetting } from '../lib/stickerSplit/engine'
import type { StickerSplitAnalyzeResult, StickerSplitOptions } from '../lib/stickerSplit/coreLoad'

type SplitRequest = {
  type: 'split'
  requestId: number
  imageData: { width: number; height: number; data: ArrayBuffer }
  opts: StickerSplitOptions
  squareSetting: SquareSetting
}

type ResquareRequest = {
  type: 'resquare'
  requestId: number
  squareSetting: SquareSetting
}

type ReanalyzeRequest = {
  type: 'reanalyze'
  requestId: number
  opts: StickerSplitOptions
  squareSetting: SquareSetting
}

export interface SerializedRunResult extends Omit<SplitRunResult, 'outputs'> {
  outputs: Array<{ index: number; x: number; y: number; w: number; h: number; data: ArrayBuffer }>
}

type WorkerResponse =
  | { requestId: number; ok: true; result: SerializedRunResult }
  | { requestId: number; ok: false; error: string; code?: 'no-cache' }

// resquare 复用的单槽缓存：analyze 结果含像素级标签，切换方形输出时
// 免去重复整条分析。收到新 split 即覆盖；任何异常清空，防止脏缓存。
let cachedImageData: SplitImageData | null = null
let cachedAnalyze: StickerSplitAnalyzeResult | null = null

self.onmessage = (event: MessageEvent<SplitRequest | ResquareRequest | ReanalyzeRequest>) => {
  const msg = event.data
  try {
    if (msg.type === 'split') {
      cachedImageData = { width: msg.imageData.width, height: msg.imageData.height, data: new Uint8ClampedArray(msg.imageData.data) }
      const result = runSplitFull(cachedImageData, msg.opts, msg.squareSetting)
      cachedAnalyze = result.analyzeResult
      postResult(msg.requestId, result)
    } else if (msg.type === 'reanalyze') {
      // 高级参数调整：复用缓存像素完整重算，并刷新 analyze 缓存。
      if (!cachedImageData) {
        postCacheMiss(msg.requestId)
        return
      }
      const result = runSplitFull(cachedImageData, msg.opts, msg.squareSetting)
      cachedAnalyze = result.analyzeResult
      postResult(msg.requestId, result)
    } else {
      if (!cachedImageData || !cachedAnalyze) {
        postCacheMiss(msg.requestId)
        return
      }
      postResult(msg.requestId, rerunSquare(cachedImageData, cachedAnalyze, msg.squareSetting))
    }
  } catch (error) {
    cachedImageData = null
    cachedAnalyze = null
    const resp: WorkerResponse = { requestId: msg.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }
    ;(self as unknown as Worker).postMessage(resp)
  }
}

function postCacheMiss(requestId: number) {
  const resp: WorkerResponse = { requestId, ok: false, error: 'no cached pixels', code: 'no-cache' }
  ;(self as unknown as Worker).postMessage(resp)
}

function postResult(requestId: number, result: SplitRunResult) {
  // 显式挑字段：analyzeResult（含像素级标签）留在 Worker，不克隆回主线程。
  const serialized: SerializedRunResult = {
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
      data: o.data.buffer as ArrayBuffer,
    })),
  }
  const transfer = serialized.outputs.map((o) => o.data)
  ;(self as unknown as Worker).postMessage({ requestId, ok: true, result: serialized } satisfies WorkerResponse, transfer)
}
