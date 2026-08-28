// 引入顺序即求值顺序：先补 self（纯 Node ESM 下 UMD 的 root 才不为 undefined）。
// 算法文件 core.js 保持上游原样，不做任何修改：
// - 浏览器/Worker（Vite ESM）：UMD 走全局分支，挂 self.StickerSplit，命名空间为空；
// - vitest/vite-node（CJS 互操作）：UMD 走 module.exports 分支，展开为命名导出。
// 两条通道都试，哪个环境都能拿到。
import './coreSelf'
import * as coreNs from './core.js'

export interface StickerSplitOptions {
  source?: 'auto' | 'alpha' | 'color'
  threshold?: number
  bgTolerance?: number
  bg?: [number, number, number] | null
  minSize?: number | 'auto'
  group?: 'auto' | 'grid' | 'prox' | 'none'
  gap?: number | 'auto'
  padding?: number | 'auto'
  maxAnalyzeDim?: number
}

export interface StickerSplitBox {
  x: number
  y: number
  w: number
  h: number
  area: number
  index: number
  comps: number[]
}

export interface StickerSplitStats {
  ms: number
  componentsRaw: number
  components: number
  groups: number
}

export interface StickerSplitAnalyzeResult {
  width: number
  height: number
  source: 'alpha' | 'color'
  bg: number[] | null
  scale: number
  mode: string
  components: unknown[]
  boxes: StickerSplitBox[]
  suggestGap: number
  stats: StickerSplitStats
  // extract() 的内部依赖，调用方只透传、不读取
  _labels: Int32Array
  _fg: {
    source: 'alpha' | 'color'
    threshold: number
    bg: number[] | null
    tolerance: number
    scale: number
    w2: number
    h2: number
  }
}

export interface StickerSplitExtract {
  x: number
  y: number
  w: number
  h: number
  data: Uint8ClampedArray
  index: number
}

export interface StickerSplitCore {
  analyze(imageData: ImageData, opts?: StickerSplitOptions): StickerSplitAnalyzeResult
  extract(imageData: ImageData, result: StickerSplitAnalyzeResult, i: number): StickerSplitExtract
  toSquare(ex: StickerSplitExtract): StickerSplitExtract
  autoSquare(extracts: StickerSplitExtract[]): boolean
  defaults: Required<StickerSplitOptions>
  version: string
}

let cached: StickerSplitCore | null = null

export function getStickerSplitCore(): StickerSplitCore {
  if (!cached) {
    const fromGlobal = (globalThis as { StickerSplit?: StickerSplitCore }).StickerSplit ?? null
    const fromNamespace = typeof (coreNs as Partial<StickerSplitCore>).analyze === 'function' ? (coreNs as unknown as StickerSplitCore) : null
    cached = fromGlobal ?? fromNamespace
    if (!cached) throw new Error('贴纸切图核心算法加载失败')
  }
  return cached
}
