export type WritablePermissionState = PermissionState

export interface WritableFileHandle {
  createWritable: () => Promise<WritableStreamDefaultWriter | FileSystemWritableFileStream>
}

export interface WritableDirectoryHandle {
  name?: string
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<WritablePermissionState>
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<WritablePermissionState>
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<WritableDirectoryHandle>
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<WritableFileHandle>
}

export interface LocalAutoSaveWriteFile {
  name: string
  data: Uint8Array | string
  type: string
}

export interface LocalAutoSaveWriteParams {
  rootHandle: WritableDirectoryHandle
  folderName: string
  files: LocalAutoSaveWriteFile[]
}

export class LocalAutoSavePermissionError extends Error {
  constructor() {
    super('需要重新授权保存位置')
    this.name = 'LocalAutoSavePermissionError'
  }
}

function isPermissionLikeError(err: unknown) {
  if (err instanceof LocalAutoSavePermissionError) return true
  if (!err || typeof err !== 'object') return false
  const name = 'name' in err ? err.name : undefined
  return name === 'NotAllowedError' || name === 'SecurityError'
}

function isNotFoundLikeError(err: unknown) {
  if (!err || typeof err !== 'object') return false
  const name = 'name' in err ? err.name : undefined
  return name === 'NotFoundError'
}

async function ensureReadWritePermission(handle: WritableDirectoryHandle) {
  const descriptor = { mode: 'readwrite' as const }
  const queried = await handle.queryPermission?.(descriptor)
  if (queried === 'granted') return
  const requested = await handle.requestPermission?.(descriptor)
  if (requested !== 'granted') throw new LocalAutoSavePermissionError()
}

async function writeFile(handle: WritableDirectoryHandle, file: LocalAutoSaveWriteFile) {
  const fileHandle = await handle.getFileHandle(file.name, { create: true })
  const writable = await fileHandle.createWritable()
  const payload = typeof file.data === 'string'
    ? new Blob([file.data], { type: file.type })
    : new Blob([toArrayBuffer(file.data)], { type: file.type })
  await writable.write(payload)
  await writable.close()
}

async function directoryExists(rootHandle: WritableDirectoryHandle, folderName: string) {
  try {
    await rootHandle.getDirectoryHandle(folderName, { create: false })
    return true
  } catch (err) {
    if (isNotFoundLikeError(err)) return false
    throw err
  }
}

async function createUniqueDirectory(rootHandle: WritableDirectoryHandle, folderName: string) {
  let attempt = 1
  while (true) {
    const candidate = attempt === 1 ? folderName : `${folderName}-${attempt}`
    if (!(await directoryExists(rootHandle, candidate))) {
      const handle = await rootHandle.getDirectoryHandle(candidate, { create: true })
      return { folderName: candidate, handle }
    }
    attempt += 1
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer as ArrayBuffer
}

export async function writeLocalAutoSaveArchive(params: LocalAutoSaveWriteParams) {
  try {
    await ensureReadWritePermission(params.rootHandle)
    const { folderName, handle: folder } = await createUniqueDirectory(params.rootHandle, params.folderName)
    for (const file of params.files) {
      await writeFile(folder, file)
    }
    return {
      folderName,
      files: params.files.map((file) => file.name),
    }
  } catch (err) {
    if (err instanceof LocalAutoSavePermissionError) throw err
    if (isPermissionLikeError(err)) throw new LocalAutoSavePermissionError()
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`本地自动保存失败：${message}`)
  }
}
