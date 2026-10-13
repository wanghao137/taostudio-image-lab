import { invoke } from '@tauri-apps/api/core'
import { isTauri } from './platform'
import { throwIfAborted } from './serverSentEvents'

/** 写入大文件时的取消信号与进度回调（已写入字节数、总字节数），仅客户端分块写入时生效 */
export interface SaveOptions {
  signal?: AbortSignal
  onProgress?: (written: number, total: number) => void
}

/** 客户端中用户选定的保存目录；token 对应 Rust 侧记下的目录，前端无法借此写入其他位置 */
export interface SaveDir {
  token: number
  path: string
}

// “文件保存位置”为“默认地址”时直接写入默认保存地址，由 App 按设置同步
let saveToDefaultDir = false

export function setSaveToDefaultDir(enabled: boolean) {
  saveToDefaultDir = enabled
}

// 客户端首次保存前询问保存方式，由 App 注册；返回 false 表示用户取消了本次保存
let beforeSave: (() => Promise<boolean>) | null = null

export function setBeforeSave(fn: (() => Promise<boolean>) | null) {
  beforeSave = fn
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// 整个文件作为一次 IPC 请求体时，WebView2 浏览器进程会为 260 MB 的分卷短暂占用 3~5 GB 内存，改为分块传输
const CHUNK_SIZE = 8 * 1024 * 1024

/**
 * 把内容分块写入 Rust 侧在目标目录中打开的临时文件，全部写完后提交（改名为目标文件），返回实际写入的完整路径。
 * 任一步失败或取消时丢弃临时文件，不留下写了一半的文件
 */
async function writeInChunks(id: number, data: Blob | Uint8Array, opts?: SaveOptions) {
  try {
    const size = data instanceof Blob ? data.size : data.byteLength
    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      throwIfAborted(opts?.signal)
      const chunk = data instanceof Blob
        ? new Uint8Array(await data.slice(offset, offset + CHUNK_SIZE).arrayBuffer())
        : data.subarray(offset, offset + CHUNK_SIZE)
      await invoke('save_write', chunk, { headers: { 'x-id': String(id) } })
      opts?.onProgress?.(Math.min(offset + CHUNK_SIZE, size), size)
    }
    // 取消后不再提交，由下方丢弃临时文件
    throwIfAborted(opts?.signal)
    return await invoke<string>('save_commit', { id })
  } catch (err) {
    await invoke('save_abort', { id }).catch((abortErr) => console.warn('丢弃临时文件失败', abortErr))
    throw err
  }
}

/**
 * 保存单个文件：网页版触发浏览器下载；客户端弹出系统保存对话框，由 Rust 写入所选路径，
 * 或在“默认地址”模式下直接写入默认保存地址（同名自动加序号）。
 * 返回保存位置（网页版为文件名），用户取消时返回 null
 */
export async function saveFile(data: Blob | Uint8Array, fileName: string, opts?: SaveOptions): Promise<string | null> {
  if (!isTauri) {
    triggerDownload(data instanceof Blob ? data : new Blob([data as BlobPart]), fileName)
    return fileName
  }
  if (beforeSave && !(await beforeSave())) return null
  if (saveToDefaultDir) return await saveFileToDir(await invoke<SaveDir>('download_dir_use'), data, fileName, opts)
  const id = await invoke<number | null>('save_file', { name: fileName })
  if (id === null) return null
  return await writeInChunks(id, data, opts)
}

/**
 * 仅客户端：弹出目录选择框，用于一次保存多个文件；用户取消时返回 null。
 * “默认地址”模式下不弹框，直接返回默认保存地址，地址不可用时抛出 Rust 给出的原因
 */
export async function pickSaveDir() {
  if (beforeSave && !(await beforeSave())) return null
  return await invoke<SaveDir | null>(saveToDefaultDir ? 'download_dir_use' : 'save_dir_pick')
}

/** 仅客户端：写入 pickSaveDir 选定的目录，已有同名文件时自动加序号，返回实际写入的完整路径 */
export async function saveFileToDir(dir: SaveDir, data: Blob | Uint8Array, fileName: string, opts?: SaveOptions) {
  return await writeInChunks(await invoke<number>('save_dir_begin', { token: dir.token, name: fileName }), data, opts)
}

/** 仅客户端：默认保存地址，用于在设置中显示 */
export function getDefaultSaveDir() {
  return invoke<string>('download_dir_get')
}

/** 更改默认保存地址前的原地址：有文件或不能迁移时才返回 */
export interface PreviousSaveDir {
  path: string
  files: number
  bytes: number
  /** 不能迁移的原因（互相包含、包含数据目录、磁盘根目录或用户主目录等） */
  blocked: string | null
  /** 系统已知文件夹（下载、图片等），迁移后保留文件夹本身 */
  keepSource: boolean
}

/** 仅客户端：弹出目录选择框更改默认保存地址，返回新地址及原地址的统计；用户取消时返回 null */
export function changeDefaultSaveDir() {
  return invoke<{ path: string, previous: PreviousSaveDir | null } | null>('download_dir_pick')
}

/** 未能完整移动的条目：原位置的完整路径与原因 */
export interface MoveIssue {
  path: string
  error: string
}

export interface MoveReport {
  moved: number
  renamed: number
  /** 未能移动的条目及原因，仍留在原地址 */
  failed: MoveIssue[]
  /** 已复制到新地址、但原位置未能删除的条目及原因 */
  notRemoved: MoveIssue[]
  sourceRemoved: boolean
}

/** 仅客户端：把上次更改前的原地址中的全部内容移动到当前默认保存地址 */
export function migrateDefaultSaveDir() {
  return invoke<MoveReport>('download_dir_migrate')
}

/** 仅客户端：在资源管理器中打开默认保存地址 */
export function openDefaultSaveDir() {
  return invoke<void>('download_dir_open')
}

// ===== 命名保存目录（仅客户端）：本地自动保存、场景保存目录、引擎交付目录。
// 与网页版的句柄方案不同：WebView2 的文件系统访问权限不跨重启保留（实测重启后变 prompt，
// 后台自动保存没有用户手势无法重新授权），所以客户端目录经目录选择框选择后由 Rust 记在
// meta 表，重启后直接可用。目录名（basename）仍存设置字段，与网页版语义保持一致。

export const AUTO_SAVE_DIR_KEY = 'autoSave'
export const ENGINE_DELIVERY_DIR_KEY = 'engineDelivery'

export function sceneSaveDirKey(sceneId: string) {
  return `scene:${sceneId}`
}

/** 目录完整路径的最后一段，与设置里的目录名（网页版为句柄 name）对应 */
export function saveDirBasename(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** 弹出目录选择框为命名目录选择位置并记住；用户取消时返回 null */
export async function pickNamedSaveDir(key: string): Promise<SaveDir | null> {
  return await invoke<SaveDir | null>('named_save_dir_pick', { key })
}

/** 使用已记住的命名目录（目录缺失或未选择时抛错，交由调用方回落/提示） */
export async function resolveNamedSaveDir(key: string): Promise<SaveDir> {
  return await invoke<SaveDir>('named_save_dir_use', { key })
}

/** 读取命名目录的完整路径（用于显示）；未选择时返回 null */
export async function getNamedSaveDirPath(key: string): Promise<string | null> {
  return await invoke<string | null>('named_save_dir_get', { key })
}

export async function clearNamedSaveDir(key: string): Promise<void> {
  await invoke('named_save_dir_clear', { key })
}

/** 在已登记目录中创建去重后的新文件夹（同名自动加序号），返回凭以写入的文件夹 */
export async function createSaveFolder(dir: SaveDir, folderName: string): Promise<SaveDir> {
  return await invoke<SaveDir>('save_dir_folder_create', { token: dir.token, name: folderName })
}

/** 在已登记目录中按相对路径就位文件夹（逐级创建，已存在则复用），用于交付类幂等写入 */
export async function ensureSaveFolder(dir: SaveDir, path: string): Promise<SaveDir> {
  return await invoke<SaveDir>('save_dir_folder_ensure', { token: dir.token, path })
}

/** 传给 Rust 的写入载荷：字符串按 UTF-8 编码 */
function toBytes(data: Uint8Array | string | Blob): Uint8Array | Blob {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data
}

/**
 * 客户端原生归档写入，等价于网页版 writeLocalAutoSaveArchive 的句柄路径：
 * 在目录中创建去重文件夹，把文件逐个分块写入。文件名为不含子路径的单段名。
 */
export async function writeArchiveToNativeDir(
  dir: SaveDir,
  folderName: string,
  files: Array<{ name: string, data: Uint8Array | string | Blob, type: string }>,
): Promise<{ folderName: string, files: string[] }> {
  const folder = await createSaveFolder(dir, folderName)
  for (const file of files) {
    await saveFileToDir(folder, toBytes(file.data), file.name)
  }
  return { folderName: saveDirBasename(folder.path), files: files.map((file) => file.name) }
}

/**
 * 客户端原生交付写入，等价于网页版 writeLocalDeliveryFiles 的句柄路径：
 * folderName 与文件名都可以带相对子路径，文件夹就位后覆盖式改写同一文件（幂等重放）。
 */
export async function writeDeliveryToNativeDir(
  dir: SaveDir,
  folderName: string,
  files: Array<{ name: string, data: Uint8Array | string | Blob, type: string }>,
): Promise<{ folderName: string, files: string[] }> {
  const folder = await ensureSaveFolder(dir, folderName)
  for (const file of files) {
    const splitAt = Math.max(file.name.lastIndexOf('/'), file.name.lastIndexOf('\\'))
    const sub = splitAt >= 0 ? file.name.slice(0, splitAt) : ''
    const base = splitAt >= 0 ? file.name.slice(splitAt + 1) : file.name
    const target = sub ? await ensureSaveFolder(folder, sub) : folder
    // 覆盖式写入：与网页版交付语义一致，重放不产生副本
    const id = await invoke<number>('save_dir_begin_replace', { token: target.token, name: base })
    try {
      await writeInChunks(id, toBytes(file.data))
    } catch (err) {
      await invoke('save_abort', { id }).catch((abortErr) => console.warn('丢弃临时文件失败', abortErr))
      throw err
    }
  }
  return { folderName, files: files.map((file) => file.name) }
}
