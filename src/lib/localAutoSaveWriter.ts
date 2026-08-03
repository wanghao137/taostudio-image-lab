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
  data: Uint8Array | string | Blob
  type: string
}

export interface LocalAutoSaveWriteParams {
  rootHandle: WritableDirectoryHandle
  folderName: string
  files: LocalAutoSaveWriteFile[]
}

export interface LocalDeliveryWriteParams {
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
  const segments = file.name.split('/').map((segment) => segment.trim()).filter(Boolean)
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error('本地保存文件名无效')
  }
  let directory = handle
  for (const segment of segments.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(segment, { create: true })
  }
  const fileHandle = await directory.getFileHandle(segments[segments.length - 1], { create: true })
  const writable = await fileHandle.createWritable()
  const payload = typeof file.data === 'string'
    ? new Blob([file.data], { type: file.type })
    : file.data instanceof Blob
      ? file.data
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

function splitDirectoryPath(value: string) {
  const segments = value.split('/').map((segment) => segment.trim()).filter(Boolean)
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\'))) {
    throw new Error('本地保存目录名无效')
  }
  return segments
}

async function getOrCreateDirectoryPath(rootHandle: WritableDirectoryHandle, path: string) {
  let directory = rootHandle
  for (const segment of splitDirectoryPath(path)) {
    directory = await directory.getDirectoryHandle(segment, { create: true })
  }
  return directory
}

/** Write an idempotent delivery folder. Unlike the legacy archive writer this
 * reuses the requested folder, so a retry updates the same local delivery. */
export async function writeLocalDeliveryFiles(params: LocalDeliveryWriteParams) {
  try {
    await ensureReadWritePermission(params.rootHandle)
    const folder = await getOrCreateDirectoryPath(params.rootHandle, params.folderName)
    for (const file of params.files) await writeFile(folder, file)
    return {
      folderName: params.folderName,
      files: params.files.map((file) => file.name),
    }
  } catch (err) {
    if (err instanceof LocalAutoSavePermissionError) throw err
    if (isPermissionLikeError(err)) throw new LocalAutoSavePermissionError()
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`本地交付保存失败：${message}`)
  }
}
