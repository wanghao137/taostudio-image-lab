import { zipSync } from 'fflate'
import type { SplitOutput } from './engine'
import { getNumberedFileNameBase, sanitizeFileNamePart } from '../exportFileName'

/** RGBA 输出 → PNG Blob。 */
export async function encodeSplitPng(output: SplitOutput): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(output.w, output.h)
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.putImageData(new ImageData(new Uint8ClampedArray(output.data), output.w, output.h), 0, 0)
      return await canvas.convertToBlob({ type: 'image/png' })
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = output.w
  canvas.height = output.h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布上下文')
  ctx.putImageData(new ImageData(new Uint8ClampedArray(output.data), output.w, output.h), 0, 0)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PNG 编码失败'))
    }, 'image/png')
  })
}

/** 单张下载：文件名 `<base>-01.png`（单张时 `<base>.png` 由调用方决定是否去序号）。 */
export async function downloadSplitOutput(output: SplitOutput, fileNameBase: string, order: number, total: number): Promise<void> {
  const blob = await encodeSplitPng(output)
  triggerDownload(blob, `${sanitizeFileNamePart(getNumberedFileNameBase(fileNameBase, order, total)) || 'sticker'}.png`)
}

/** 打包 zip 一次性下载全部（站内已有 fflate，优先 zip 而不是连发多张下载）。 */
export async function downloadSplitOutputsZip(outputs: SplitOutput[], fileNameBase: string): Promise<number> {
  if (!outputs.length) return 0
  const base = sanitizeFileNamePart(fileNameBase) || 'stickers'
  const files: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}
  for (let i = 0; i < outputs.length; i++) {
    const blob = await encodeSplitPng(outputs[i])
    files[`${getNumberedFileNameBase(base, i, outputs.length)}.png`] = [new Uint8Array(await blob.arrayBuffer()), { mtime: new Date() }]
  }
  const zipped = zipSync(files, { level: 6 })
  const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
  triggerDownload(new Blob([buffer], { type: 'application/zip' }), `${base}.zip`)
  return outputs.length
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
