// core.js 是 UMD：浏览器/Worker 走全局分支（挂 self.StickerSplit，此处导出为空），
// vite-node/测试环境走 CJS 互操作分支（展开为下列命名导出）。类型按命名导出形态声明，
// coreLoad.ts 在两条通道里动态取用。
import type { StickerSplitAnalyzeResult, StickerSplitExtract, StickerSplitOptions } from './coreLoad'

export const analyze: (imageData: ImageData, opts?: StickerSplitOptions) => StickerSplitAnalyzeResult
export const extract: (imageData: ImageData, result: StickerSplitAnalyzeResult, i: number) => StickerSplitExtract
export const toSquare: (ex: StickerSplitExtract) => StickerSplitExtract
export const autoSquare: (extracts: StickerSplitExtract[]) => boolean
export const defaults: Required<StickerSplitOptions>
export const version: string
