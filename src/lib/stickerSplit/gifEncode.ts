// GIF 封装：gifenc 编码，rgba4444 调色板 + oneBitAlpha 处理 1-bit 透明
//（GIF 物理上只有全透明/不透明，半透明光晕按 alpha≥128 归入不透明，与切分阈值一致）。
import { GIFEncoder, applyPalette, prequantize, quantize } from 'gifenc'

export interface GifFrame {
  data: Uint8ClampedArray
  width: number
  height: number
  delayMs: number
}

export function encodeGif(frames: GifFrame[]): Blob {
  if (!frames.length) throw new Error('没有帧')
  const gif = GIFEncoder()
  for (const frame of frames) {
    // prequantize 会原地改写，拷贝一份，调用方的帧数据可重复用于多次导出
    const rgba = new Uint8Array(frame.data)
    // 先把像素 alpha 二值化，量化/映射两侧保持一致，透明像素稳定落到 alpha=0 的调色板项
    prequantize(rgba, { oneBitAlpha: 127 })
    const palette = quantize(rgba, 192, { format: 'rgba4444', oneBitAlpha: 127 })
    const indexed = applyPalette(rgba, palette, 'rgba4444')
    const transparentIndex = palette.findIndex((color) => (color[3] ?? 255) <= 127)
    gif.writeFrame(indexed, frame.width, frame.height, {
      palette,
      delay: Math.max(20, Math.round(frame.delayMs)),
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
      repeat: 0,
    })
  }
  gif.finish()
  const bytes = gif.bytes()
  return new Blob([bytes as BlobPart], { type: 'image/gif' })
}
