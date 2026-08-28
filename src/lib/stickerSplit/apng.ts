// 极简 APNG 封装器：帧 PNG 由 getImageData + fflate 直接构造（filter 0 + deflate），
// 不走 canvas.toBlob —— 后者在软件渲染环境下逐帧编码病态慢（实测 4 帧 14s）。
// chunk 级重组：acTL + fcTL/fdAT。全帧 SOURCE 混合 + 全画布覆盖，dispose/blend 语义最简。
// 纯函数核心（buildApng / pngFrameFromImageData）不依赖 DOM，Node 可测。
import { deflateSync } from 'fflate'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface PngChunk {
  type: string
  data: Uint8Array
}

/** 解析 PNG 字节流为 chunk 列表（跳过 8 字节签名）。 */
export function parsePngChunks(png: Uint8Array): PngChunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error('不是有效的 PNG 数据')
  const chunks: PngChunk[] = []
  let offset = 8
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7])
    const data = png.subarray(offset + 8, offset + 8 + length)
    chunks.push({ type, data })
    offset += 12 + length
    if (type === 'IEND') break
  }
  return chunks
}

/** 分段字节缓冲：避免逐字节 push 大数组的装箱开销。 */
class ByteBuilder {
  private parts: Uint8Array[] = []
  private length = 0

  push(bytes: Uint8Array) {
    this.parts.push(bytes)
    this.length += bytes.length
  }

  pushUint32(value: number) {
    const buf = new Uint8Array(4)
    new DataView(buf.buffer).setUint32(0, value)
    this.push(buf)
  }

  build(): Uint8Array {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const part of this.parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }
}

function writeChunk(out: ByteBuilder, type: string, data: Uint8Array) {
  const typeBytes = new Uint8Array(4)
  for (let i = 0; i < 4; i++) typeBytes[i] = type.charCodeAt(i)
  const crcInput = new Uint8Array(4 + data.length)
  crcInput.set(typeBytes)
  crcInput.set(data, 4)
  out.pushUint32(data.length)
  out.push(typeBytes)
  out.push(data)
  const crc = new Uint8Array(4)
  new DataView(crc.buffer).setUint32(0, crc32(crcInput))
  out.push(crc)
}

function fcTLData(sequence: number, width: number, height: number, delayMs: number): Uint8Array {
  const buf = new ArrayBuffer(26)
  const view = new DataView(buf)
  view.setUint32(0, sequence)
  view.setUint32(4, width)
  view.setUint32(8, height)
  view.setUint32(12, 0)
  view.setUint32(16, 0)
  view.setUint16(20, Math.max(1, Math.round(delayMs)))
  view.setUint16(22, 1000)
  view.setUint8(24, 0) // dispose: NONE（每帧全画布覆盖）
  view.setUint8(25, 0) // blend: SOURCE
  return new Uint8Array(buf)
}

/**
 * 把若干等尺寸 PNG 帧重组成 APNG。第一帧的 IDAT 直接充当首帧数据，
 * 后续帧每段 IDAT 转为 fdAT。返回完整 APNG 字节。
 */
export function buildApng(pngFrames: Uint8Array[], delaysMs: number[]): Uint8Array {
  if (pngFrames.length === 0) throw new Error('没有帧')
  if (pngFrames.length !== delaysMs.length) throw new Error('帧数与时长不一致')

  const parsed = pngFrames.map((frame) => {
    const chunks = parsePngChunks(frame)
    const ihdr = chunks.find((c) => c.type === 'IHDR')
    const idats = chunks.filter((c) => c.type === 'IDAT')
    const iend = chunks.find((c) => c.type === 'IEND')
    if (!ihdr || idats.length === 0 || !iend) throw new Error('PNG 帧缺少 IHDR/IDAT/IEND')
    return { ihdr, idats, iend }
  })

  const width = new DataView(parsed[0].ihdr.data.buffer, parsed[0].ihdr.data.byteOffset).getUint32(0)
  const height = new DataView(parsed[0].ihdr.data.buffer, parsed[0].ihdr.data.byteOffset).getUint32(4)

  const out = new ByteBuilder()
  out.push(new Uint8Array(PNG_SIGNATURE))
  writeChunk(out, 'IHDR', parsed[0].ihdr.data)

  const actl = new Uint8Array(8)
  const actlView = new DataView(actl.buffer)
  actlView.setUint32(0, pngFrames.length)
  actlView.setUint32(4, 0) // 无限循环
  writeChunk(out, 'acTL', actl)

  let sequence = 0
  parsed.forEach((frame, i) => {
    writeChunk(out, 'fcTL', fcTLData(sequence++, width, height, delaysMs[i]))
    if (i === 0) {
      for (const idat of frame.idats) writeChunk(out, 'IDAT', idat.data)
    } else {
      for (const idat of frame.idats) {
        const fd = new Uint8Array(4 + idat.data.length)
        new DataView(fd.buffer).setUint32(0, sequence++)
        fd.set(idat.data, 4)
        writeChunk(out, 'fdAT', fd)
      }
    }
  })
  writeChunk(out, 'IEND', parsed[0].iend.data)
  return out.build()
}

/** RGBA 像素 → 最小 PNG（IHDR + 单 IDAT + IEND，filter 0）。 */
export function pngFrameFromImageData(data: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const stride = 1 + width * 4
  const raw = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    // raw[y * stride] = 0（filter: None）
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1)
  }
  const idat = deflateSync(raw, { level: 6 })

  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA

  const out = new ByteBuilder()
  out.push(new Uint8Array(PNG_SIGNATURE))
  writeChunk(out, 'IHDR', ihdr)
  writeChunk(out, 'IDAT', idat)
  writeChunk(out, 'IEND', new Uint8Array(0))
  return out.build()
}

/** 浏览器封装：canvas 帧序列 → APNG Blob。 */
export async function encodeApngFromCanvases(frames: Array<{ canvas: HTMLCanvasElement | OffscreenCanvas; delayMs: number }>): Promise<Blob> {
  const pngs: Uint8Array[] = []
  for (const frame of frames) {
    const ctx = frame.canvas.getContext('2d') as CanvasRenderingContext2D | null
    if (!ctx) throw new Error('无法读取画布像素')
    const image = ctx.getImageData(0, 0, frame.canvas.width, frame.canvas.height)
    pngs.push(pngFrameFromImageData(image.data, image.width, image.height))
  }
  const bytes = buildApng(pngs, frames.map((f) => f.delayMs))
  return new Blob([bytes as BlobPart], { type: 'image/apng' })
}
