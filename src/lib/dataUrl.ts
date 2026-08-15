const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function dataUrlToBytes(dataUrl: string): { ext: string; bytes: Uint8Array; mime: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,/)
  const mime = match?.[1] ?? 'image/png'
  const ext = mime.split('/')[1] ?? 'png'
  const binary = atob(dataUrl.replace(/^data:[^;]+;base64,/, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return { ext, bytes, mime }
}

/** 同步 dataUrl → Blob（存储边界使用；比 fetch(dataUrl) 版更快且无网络栈参与）。 */
export function dataUrlToBlob(dataUrl: string, fallbackType = 'image/png'): Blob {
  const { bytes, mime } = dataUrlToBytes(dataUrl)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Blob([buffer], { type: mime || fallbackType })
}

export function bytesToDataUrl(bytes: Uint8Array, filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
  const mime = IMAGE_MIME_BY_EXTENSION[ext] ?? 'image/png'
  return `data:${mime};base64,${bytesToBase64(bytes)}`
}

export async function blobToDataUrl(blob: Blob, fallbackMime = 'application/octet-stream'): Promise<string> {
  return `data:${blob.type || fallbackMime};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`
}

export function fileToDataUrl(file: File): Promise<string> {
  return blobToDataUrl(file, file.type || 'application/octet-stream')
}
