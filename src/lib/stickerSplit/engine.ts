import { getStickerSplitCore } from './coreLoad'
import type { StickerSplitAnalyzeResult, StickerSplitExtract, StickerSplitOptions } from './coreLoad'

// core.js 只读取 width/height/data 三个字段，不要求真正的 ImageData 实例；
// 用普通对象让 Worker（结构化克隆）和 Node 测试环境都不依赖 DOM 类型。
export interface SplitImageData {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface SplitOutput {
  index: number
  x: number
  y: number
  w: number
  h: number
  data: Uint8ClampedArray
}

export type SquareSetting = 'auto' | 'on' | 'off'

export interface SplitRunMeta {
  source: 'alpha' | 'color'
  suggestGap: number
  stats: { ms: number; componentsRaw: number; components: number; groups: number }
  squareAuto: boolean
  square: boolean
}

export interface SplitRunResult extends SplitRunMeta {
  outputs: SplitOutput[]
}

/** 完整管线：analyze → 像素级 extract → autoSquare/toSquare，附带回 analyze 结果供 resquare 复用。 */
export function runSplitFull(
  imageData: SplitImageData,
  opts: StickerSplitOptions,
  squareSetting: SquareSetting,
): SplitRunResult & { analyzeResult: StickerSplitAnalyzeResult } {
  const core = getStickerSplitCore()
  const analyzeResult = core.analyze(imageData as ImageData, opts)
  const extracts: StickerSplitExtract[] = analyzeResult.boxes.map((_, i) => core.extract(imageData as ImageData, analyzeResult, i))
  const { squareAuto, square, outputs } = applySquare(extracts, squareSetting)
  return { ...toMeta(analyzeResult), squareAuto, square, outputs, analyzeResult }
}

/** 仅切换方形输出：复用已有 analyze 结果（Worker 缓存路径），重跑 extract + 方形化。 */
export function rerunSquare(
  imageData: SplitImageData,
  analyzeResult: StickerSplitAnalyzeResult,
  squareSetting: SquareSetting,
): SplitRunResult {
  const core = getStickerSplitCore()
  const extracts: StickerSplitExtract[] = analyzeResult.boxes.map((_, i) => core.extract(imageData as ImageData, analyzeResult, i))
  const { squareAuto, square, outputs } = applySquare(extracts, squareSetting)
  return { ...toMeta(analyzeResult), squareAuto, square, outputs }
}

/**
 * 单主体守卫：取面积最大的连通域并按其紧框提取。
 * AI 编辑帧偶发"多角色/多格拼贴"污染（把姿势指令理解成序列表），
 * 用分水岭确定性兜底：只保留最大主体，丢弃其余。
 */
export function extractLargestComponent(imageData: SplitImageData): SplitImageData | null {
  const core = getStickerSplitCore()
  const result = core.analyze(imageData as ImageData, { group: 'none', minSize: 400 })
  if (!result.boxes.length) return null
  let best = 0
  for (let i = 1; i < result.boxes.length; i++) {
    if (result.boxes[i].area > result.boxes[best].area) best = i
  }
  const extracted = core.extract(imageData as ImageData, result, best)
  return { width: extracted.w, height: extracted.h, data: extracted.data }
}

function toMeta(analyzeResult: StickerSplitAnalyzeResult): SplitRunMeta {
  return {
    source: analyzeResult.source,
    suggestGap: analyzeResult.suggestGap,
    stats: analyzeResult.stats,
    squareAuto: false,
    square: false,
  }
}

function applySquare(extracts: StickerSplitExtract[], squareSetting: SquareSetting) {
  const core = getStickerSplitCore()
  const squareAuto = core.autoSquare(extracts)
  const square = squareSetting === 'on' || (squareSetting === 'auto' && squareAuto)
  const outputs = square ? extracts.map((ex) => core.toSquare(ex)) : extracts
  return { squareAuto, square, outputs: outputs as SplitOutput[] }
}
