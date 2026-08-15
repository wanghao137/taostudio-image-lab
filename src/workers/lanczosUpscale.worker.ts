/// <reference lib="webworker" />
import { computeCoverCrop, lanczos3ResizeRGBA } from '../lib/lanczos'

self.onmessage = async (event: MessageEvent) => {
  const { requestId, bitmap, targetW, targetH, fitMode } = event.data as {
    requestId: number
    bitmap: ImageBitmap
    targetW: number
    targetH: number
    fitMode: 'cover' | 'contain'
  }
  try {
    const srcW = bitmap.width
    const srcH = bitmap.height

    // cover：先中心裁出目标比例；contain：按目标比例 letterbox（黑边），
    // 与 canvas 实现的语义一致。本产品路径只用 cover。
    let sx = 0
    let sy = 0
    let sw = srcW
    let sh = srcH
    if (fitMode === 'cover') {
      const crop = computeCoverCrop(srcW, srcH, targetW, targetH)
      sx = crop.x
      sy = crop.y
      sw = crop.cropW
      sh = crop.cropH
    }

    const offscreen = new OffscreenCanvas(sw, sh)
    const ctx = offscreen.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable')
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
    const srcData = ctx.getImageData(0, 0, sw, sh)
    // 预乘 alpha：非预乘数据在 alpha 阶跃处做 lanczos 会产生彩色/黑色镶边
    //（transparent_output 的半透明边缘是真实可达场景）。对不透明图是恒等变换。
    const px = srcData.data
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3]
      if (a !== 255 && a !== 0) {
        px[i] = (px[i] * a) / 255
        px[i + 1] = (px[i + 1] * a) / 255
        px[i + 2] = (px[i + 2] * a) / 255
      }
    }

    const resized = lanczos3ResizeRGBA(px, sw, sh, targetW, targetH)
    // 反预乘
    for (let i = 0; i < resized.length; i += 4) {
      const a = resized[i + 3]
      if (a > 0 && a < 255) {
        resized[i] = Math.min(255, Math.round((resized[i] * 255) / a))
        resized[i + 1] = Math.min(255, Math.round((resized[i + 1] * 255) / a))
        resized[i + 2] = Math.min(255, Math.round((resized[i + 2] * 255) / a))
      }
    }

    const outCanvas = new OffscreenCanvas(targetW, targetH)
    const outCtx = outCanvas.getContext('2d')
    if (!outCtx) throw new Error('OffscreenCanvas 2D context unavailable')
    outCtx.putImageData(new ImageData(new Uint8ClampedArray(resized.buffer as ArrayBuffer), targetW, targetH), 0, 0)
    const blob = await outCanvas.convertToBlob({ type: 'image/png' })
    bitmap.close()
    const buffer = await blob.arrayBuffer()
    ;(self as unknown as Worker).postMessage({ requestId, buffer }, [buffer])
  } catch (error) {
    bitmap.close()
    ;(self as unknown as Worker).postMessage({ requestId, error: error instanceof Error ? error.message : String(error) })
  }
}
