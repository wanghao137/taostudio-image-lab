// gifenc 无官方类型，按 dist 源码整理的 API 面
declare module 'gifenc' {
  export type PaletteFormat = 'rgb565' | 'rgb444' | 'rgba4444'

  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: PaletteFormat
      clearAlpha?: boolean
      clearAlphaColor?: number
      clearAlphaThreshold?: number
      oneBitAlpha?: boolean | number
      useSqrt?: boolean
    },
  ): number[][]

  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: PaletteFormat,
  ): Uint8Array

  export function prequantize(
    rgba: Uint8Array | Uint8ClampedArray,
    options?: { roundRGB?: number; roundAlpha?: number; oneBitAlpha?: boolean | number },
  ): void

  export interface GifEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: number[][]
        first?: boolean
        transparent?: boolean
        transparentIndex?: number
        delay?: number
        repeat?: number
        dispose?: number
      },
    ): void
    finish(): void
    bytes(): Uint8Array
    bytesView(): Uint8Array
    reset(): void
  }

  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GifEncoderInstance
}
