import type { AgentConversation, TaskRecord, StoredImage, StoredImageThumbnail } from '../types'
import { blobToDataUrl, dataUrlToBlob } from './dataUrl'
const DB_NAME = 'gpt-image-playground'
const DB_VERSION = 5
const STORE_TASKS = 'tasks'
const STORE_IMAGES = 'images'
const STORE_THUMBNAILS = 'thumbnails'
const STORE_AGENT_CONVERSATIONS = 'agentConversations'
const STORE_LOCAL_AUTO_SAVE = 'localAutoSave'
const STORE_META = 'meta'
const LOCAL_AUTO_SAVE_DIRECTORY_KEY = 'directory'
const TASK_GENERATION_KEY = 'taskGeneration'
const ENGINE_DELIVERY_PREFIX = 'engineDelivery:'
const THUMBNAIL_MAX_SIZE = 720
const THUMBNAIL_QUALITY = 0.9
const THUMBNAIL_VERSION = 2

export const CURRENT_THUMBNAIL_VERSION = THUMBNAIL_VERSION

export interface StoredLocalAutoSaveDirectoryHandle {
  id: typeof LOCAL_AUTO_SAVE_DIRECTORY_KEY
  handle: FileSystemDirectoryHandle
  name?: string
  updatedAt: number
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        db.createObjectStore(STORE_TASKS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_THUMBNAILS)) {
        db.createObjectStore(STORE_THUMBNAILS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_AGENT_CONVERSATIONS)) {
        db.createObjectStore(STORE_AGENT_CONVERSATIONS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_LOCAL_AUTO_SAVE)) {
        db.createObjectStore(STORE_LOCAL_AUTO_SAVE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function dbTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        // 事务结束即关连接：泄漏的打开连接会阻塞 deleteDatabase（重建逃生门）
        const closeDb = () => { try { db.close() } catch { /* already closed */ } }
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const req = fn(store)
        let result: T
        let settled = false
        const fail = (err: unknown) => {
          if (!settled) {
            settled = true
            reject(err instanceof DOMException ? err : new Error(String(err)))
          }
        }
        req.onsuccess = () => {
          result = req.result
        }
        req.onerror = () => fail(req.error)
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => {
          closeDb()
          if (!settled) {
            settled = true
            resolve(result)
          }
        }
        tx.onerror = () => { closeDb(); fail(tx.error) }
        tx.onabort = () => { closeDb(); fail(tx.error) }
      }),
  )
}

// ===== Tasks =====

export function getAllTasks(): Promise<TaskRecord[]> {
  return dbTransaction(STORE_TASKS, 'readonly', (s) => s.getAll())
}

export function putTask(task: TaskRecord, expectedGeneration?: number): Promise<IDBValidKey> {
  if (expectedGeneration === undefined) {
    return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.put(task))
  }

  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_TASKS, STORE_META], 'readwrite')
        const taskStore = tx.objectStore(STORE_TASKS)
        const metaStore = tx.objectStore(STORE_META)
        const generationRequest = metaStore.get(TASK_GENERATION_KEY)
        generationRequest.onsuccess = () => {
          const currentGeneration = Number(generationRequest.result?.value ?? 0)
          if (currentGeneration !== expectedGeneration) return
          taskStore.put(task)
        }
        generationRequest.onerror = () => reject(generationRequest.error)
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(task.id)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
        try { db.close() } catch { /* already closed */ }
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function getTaskGeneration(): Promise<number> {
  return dbTransaction(STORE_META, 'readonly', (s) => s.get(TASK_GENERATION_KEY))
    .then((record) => Number((record as { value?: number } | undefined)?.value ?? 0))
}

/** Atomically invalidates every existing task writer and clears all task rows. */
export function clearTasksAndAdvanceGeneration(): Promise<number> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_TASKS, STORE_META], 'readwrite')
        const taskStore = tx.objectStore(STORE_TASKS)
        const metaStore = tx.objectStore(STORE_META)
        const generationRequest = metaStore.get(TASK_GENERATION_KEY)
        let nextGeneration = 0

        generationRequest.onsuccess = () => {
          nextGeneration = Number(generationRequest.result?.value ?? 0) + 1
          metaStore.put({ id: TASK_GENERATION_KEY, value: nextGeneration })
          taskStore.clear()
        }
        generationRequest.onerror = () => reject(generationRequest.error)
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(nextGeneration)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
        try { db.close() } catch { /* already closed */ }
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function deleteTask(id: string, expectedGeneration?: number): Promise<undefined> {
  if (expectedGeneration === undefined) {
    return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.delete(id))
  }

  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_TASKS, STORE_META], 'readwrite')
        const taskStore = tx.objectStore(STORE_TASKS)
        const metaStore = tx.objectStore(STORE_META)
        const generationRequest = metaStore.get(TASK_GENERATION_KEY)
        generationRequest.onsuccess = () => {
          const currentGeneration = Number(generationRequest.result?.value ?? 0)
          if (currentGeneration !== expectedGeneration) return
          taskStore.delete(id)
        }
        generationRequest.onerror = () => reject(generationRequest.error)
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(undefined)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
        try { db.close() } catch { /* already closed */ }
        tx.onabort = () => reject(tx.error)
      }),
  )
}

/** Atomically removes deleted tasks and persists scrubbed siblings for one task generation. */
export function commitTaskDeletion(
  deletedTaskIds: string[],
  updatedTasks: TaskRecord[],
  updatedConversations: AgentConversation[],
  expectedGeneration?: number,
): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const storeNames = expectedGeneration === undefined
          ? [STORE_TASKS, STORE_AGENT_CONVERSATIONS]
          : [STORE_TASKS, STORE_AGENT_CONVERSATIONS, STORE_META]
        const tx = db.transaction(storeNames, 'readwrite')
        const taskStore = tx.objectStore(STORE_TASKS)
        const conversationStore = tx.objectStore(STORE_AGENT_CONVERSATIONS)
        const commit = () => {
          for (const id of deletedTaskIds) taskStore.delete(id)
          for (const task of updatedTasks) taskStore.put(task)
          for (const conversation of updatedConversations) conversationStore.put(conversation)
        }
        if (expectedGeneration === undefined) {
          commit()
        } else {
          const metaStore = tx.objectStore(STORE_META)
          const generationRequest = metaStore.get(TASK_GENERATION_KEY)
          generationRequest.onsuccess = () => {
            const currentGeneration = Number(generationRequest.result?.value ?? 0)
            if (currentGeneration === expectedGeneration) commit()
          }
          generationRequest.onerror = () => reject(generationRequest.error)
        }
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(undefined)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
        try { db.close() } catch { /* already closed */ }
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function clearTasks(): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.clear())
}

// ===== Agent conversations =====

export function getAllAgentConversations(): Promise<AgentConversation[]> {
  return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readonly', (s) => s.getAll())
}

export function putAgentConversation(conversation: AgentConversation, expectedGeneration?: number): Promise<IDBValidKey> {
  if (expectedGeneration === undefined) {
    return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readwrite', (s) => s.put(conversation))
  }

  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_AGENT_CONVERSATIONS, STORE_META], 'readwrite')
        const conversationStore = tx.objectStore(STORE_AGENT_CONVERSATIONS)
        const metaStore = tx.objectStore(STORE_META)
        const generationRequest = metaStore.get(TASK_GENERATION_KEY)
        generationRequest.onsuccess = () => {
          const currentGeneration = Number(generationRequest.result?.value ?? 0)
          if (currentGeneration !== expectedGeneration) return
          conversationStore.put(conversation)
        }
        generationRequest.onerror = () => reject(generationRequest.error)
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(conversation.id)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
        try { db.close() } catch { /* already closed */ }
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function deleteAgentConversation(id: string, expectedGeneration?: number): Promise<undefined> {
  if (expectedGeneration === undefined) {
    return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readwrite', (s) => s.delete(id))
  }

  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_AGENT_CONVERSATIONS, STORE_META], 'readwrite')
        const conversationStore = tx.objectStore(STORE_AGENT_CONVERSATIONS)
        const metaStore = tx.objectStore(STORE_META)
        const generationRequest = metaStore.get(TASK_GENERATION_KEY)
        generationRequest.onsuccess = () => {
          const currentGeneration = Number(generationRequest.result?.value ?? 0)
          if (currentGeneration !== expectedGeneration) return
          conversationStore.delete(id)
        }
        generationRequest.onerror = () => reject(generationRequest.error)
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(undefined)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
        try { db.close() } catch { /* already closed */ }
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function clearAgentConversations(expectedGeneration?: number): Promise<undefined> {
  if (expectedGeneration === undefined) {
    return dbTransaction(STORE_AGENT_CONVERSATIONS, 'readwrite', (s) => s.clear())
  }

  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_AGENT_CONVERSATIONS, STORE_META], 'readwrite')
        const conversationStore = tx.objectStore(STORE_AGENT_CONVERSATIONS)
        const metaStore = tx.objectStore(STORE_META)
        const generationRequest = metaStore.get(TASK_GENERATION_KEY)
        generationRequest.onsuccess = () => {
          const currentGeneration = Number(generationRequest.result?.value ?? 0)
          if (currentGeneration !== expectedGeneration) return
          conversationStore.clear()
        }
        generationRequest.onerror = () => reject(generationRequest.error)
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(undefined)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
        try { db.close() } catch { /* already closed */ }
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function replaceAgentConversations(conversations: AgentConversation[], expectedGeneration?: number): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const storeNames = expectedGeneration === undefined
          ? [STORE_AGENT_CONVERSATIONS]
          : [STORE_AGENT_CONVERSATIONS, STORE_META]
        const tx = db.transaction(storeNames, 'readwrite')
        const store = tx.objectStore(STORE_AGENT_CONVERSATIONS)
        const replace = () => {
          store.clear()
          for (const conversation of conversations) store.put(conversation)
        }
        if (expectedGeneration === undefined) {
          replace()
        } else {
          const metaStore = tx.objectStore(STORE_META)
          const generationRequest = metaStore.get(TASK_GENERATION_KEY)
          generationRequest.onsuccess = () => {
            const currentGeneration = Number(generationRequest.result?.value ?? 0)
            if (currentGeneration === expectedGeneration) replace()
          }
          generationRequest.onerror = () => reject(generationRequest.error)
        }
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(undefined)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
        try { db.close() } catch { /* already closed */ }
        tx.onabort = () => reject(tx.error)
      }),
  )
}

// ===== Local auto-save =====

export function getLocalAutoSaveDirectoryHandle(): Promise<StoredLocalAutoSaveDirectoryHandle | undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readonly', (s) => s.get(LOCAL_AUTO_SAVE_DIRECTORY_KEY))
}

export function putLocalAutoSaveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<IDBValidKey> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.put({
    id: LOCAL_AUTO_SAVE_DIRECTORY_KEY,
    handle,
    name: handle.name,
    updatedAt: Date.now(),
  } satisfies StoredLocalAutoSaveDirectoryHandle))
}

export function clearLocalAutoSaveDirectoryHandle(): Promise<undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.delete(LOCAL_AUTO_SAVE_DIRECTORY_KEY))
}

export interface EngineDeliveryRecord {
  id: string
  kind: 'job' | 'batch'
  entityId: string
  revision: string
  status: 'pending' | 'saving' | 'saved' | 'partial' | 'failed' | 'needs_permission' | 'unsupported'
  folderName?: string | null
  files?: string[]
  savedItems?: string[]
  savedCount?: number
  totalCount?: number
  error?: string | null
  updatedAt: number
}

function engineDeliveryKey(kind: EngineDeliveryRecord['kind'], entityId: string) {
  return `${ENGINE_DELIVERY_PREFIX}${kind}:${entityId}`
}

export function getEngineDeliveryRecord(kind: EngineDeliveryRecord['kind'], entityId: string): Promise<EngineDeliveryRecord | undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readonly', (s) => s.get(engineDeliveryKey(kind, entityId)))
}

export function putEngineDeliveryRecord(record: EngineDeliveryRecord): Promise<IDBValidKey> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.put(record))
}

export function deleteEngineDeliveryRecord(kind: EngineDeliveryRecord['kind'], entityId: string): Promise<undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.delete(engineDeliveryKey(kind, entityId)))
}

// ===== Images =====

/** IndexedDB 内部记录：新格式以 blob 存二进制（省 ~25-33% 空间），旧格式/读取出口为 dataUrl。 */
type StoredImageRecord = Omit<StoredImage, 'dataUrl'> & { dataUrl?: string; blob?: Blob }

/**
 * 写入统一转 Blob：上层契约仍是 dataUrl 字符串，转换收敛在存储边界。
 * 转换失败（异常格式）回退旧格式，读出时兼容。
 */
export function putImage(image: StoredImage): Promise<IDBValidKey> {
  return dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.put(imageToBlobRecord(image)))
}

function imageToBlobRecord(image: StoredImage): StoredImageRecord {
  if (image.blob instanceof Blob) {
    const { blob } = image
    return { ...image, dataUrl: undefined, blob }
  }
  if (!image.dataUrl) return image
  try {
    const blob = dataUrlToBlob(image.dataUrl)
    return { ...image, dataUrl: undefined, blob }
  } catch {
    // 无法转换（非 data: 或异常 mime）时保留旧格式保证可读
    return image
  }
}

export async function getImage(id: string): Promise<StoredImage | undefined> {
  const record = await dbTransaction<StoredImageRecord | undefined>(STORE_IMAGES, 'readonly', (s) => s.get(id))
  if (!record) return undefined
  if (record.dataUrl) return { ...record, dataUrl: record.dataUrl }
  if (!(record.blob instanceof Blob)) return undefined
  const dataUrl = await blobToDataUrl(record.blob)
  return { ...record, dataUrl, blob: undefined }
}

/** 读取原始记录（不转换），供迁移与内部使用。 */
function getRawImageRecord(id: string): Promise<StoredImageRecord | undefined> {
  return dbTransaction<StoredImageRecord | undefined>(STORE_IMAGES, 'readonly', (s) => s.get(id))
}

/** 原始记录读取（blob 或 dataUrl 格式）：导出 sizing 等只需要字节尺寸的场景，
 * 避免 getImage 的 Blob→dataUrl 全量转换。 */
export function getImageRecord(id: string): Promise<StoredImageRecord | undefined> {
  return getRawImageRecord(id)
}

/** 轻量元数据读取：不做 Blob→dataUrl 转换（清扫/统计只需时间戳等字段）。 */
export async function getImageMetadata(id: string): Promise<{ createdAt?: number; width?: number; height?: number; source?: StoredImage['source'] } | undefined> {
  const record = await getRawImageRecord(id)
  if (!record) return undefined
  return { createdAt: record.createdAt, width: record.width, height: record.height, source: record.source }
}

/**
 * 存量 base64 记录懒迁移为 Blob：每 5 张让出主线程，全量后台完成。
 * 幂等：已是 blob 的记录跳过；单张失败跳过保留原格式。
 * 单条记录的 读→转→写 在同一个 readwrite 事务内完成：与删除/清除操作
 * 串行化，不会把已删记录复活写回。
 */
export async function migrateImagesToBlobs(): Promise<{ migrated: number; skipped: number }> {
  const keys = await getAllImageIds()
  let migrated = 0
  let skipped = 0
  let batchCount = 0
  for (const id of keys) {
    try {
      const done = await migrateOneImageRecord(id)
      if (done) migrated += 1
      else skipped += 1
    } catch {
      skipped += 1
    }
    batchCount += 1
    if (batchCount % 5 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return { migrated, skipped }
}

/** 单条记录原子迁移：事务内读原始记录，legacy 才转换写回。返回是否迁移。 */
function migrateOneImageRecord(id: string): Promise<boolean> {
  return openDB().then(
    (db) =>
      new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE_IMAGES, 'readwrite')
        const store = tx.objectStore(STORE_IMAGES)
        const getReq = store.get(id)
        getReq.onsuccess = () => {
          const record = getReq.result as StoredImageRecord | undefined
          if (!record || record.blob instanceof Blob || !record.dataUrl) {
            resolve(false)
            return
          }
          try {
            const blob = dataUrlToBlob(record.dataUrl)
            const { dataUrl: _omit, ...rest } = record
            void _omit
            store.put({ ...rest, blob })
            resolve(true)
          } catch {
            resolve(false)
          }
        }
        getReq.onerror = () => reject(getReq.error)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
        try { db.close() } catch { /* already closed */ }
        tx.onabort = () => reject(tx.error)
      }),
  )
}

export function getStoredImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  return dbTransaction(STORE_THUMBNAILS, 'readonly', (s) => s.get(id))
}

export async function getStoredFreshImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const thumbnail = await getStoredImageThumbnail(id)
  return thumbnail?.thumbnailVersion === THUMBNAIL_VERSION ? thumbnail : undefined
}

export function putImageThumbnail(thumbnail: StoredImageThumbnail): Promise<IDBValidKey> {
  return dbTransaction(STORE_THUMBNAILS, 'readwrite', (s) => s.put(thumbnail))
}

/** 原记录直写（携带 blob 时不做转换），用于 width/height 回填等元数据修补。 */
async function patchImageMetadata(id: string, width: number, height: number) {
  const record = await getRawImageRecord(id)
  if (!record || (record.width === width && record.height === height)) return
  await dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.put({ ...record, width, height }))
}

export async function getImageThumbnail(id: string): Promise<StoredImageThumbnail | undefined> {
  const existingThumbnail = await getStoredImageThumbnail(id)
  if (existingThumbnail?.thumbnailVersion === THUMBNAIL_VERSION) {
    // 只读元数据判断是否需要回填——不做 Blob→dataUrl 全量转换
    const metadata = await getImageMetadata(id)
    if (metadata && (!metadata.width || !metadata.height) && existingThumbnail.width && existingThumbnail.height) {
      await patchImageMetadata(id, existingThumbnail.width, existingThumbnail.height)
    }
    return existingThumbnail
  }

  const image = await getImage(id)
  if (!image) return undefined
  const legacyImage = image as StoredImage & Partial<StoredImageThumbnail>
  if (legacyImage.thumbnailDataUrl && legacyImage.thumbnailVersion === THUMBNAIL_VERSION) {
    const thumbnail: StoredImageThumbnail = {
      id,
      thumbnailDataUrl: legacyImage.thumbnailDataUrl,
      width: legacyImage.width,
      height: legacyImage.height,
      thumbnailVersion: THUMBNAIL_VERSION,
    }
    await putImageThumbnail(thumbnail)
    if ((!image.width || !image.height) && thumbnail.width && thumbnail.height) {
      await patchImageMetadata(id, thumbnail.width, thumbnail.height)
    }
    return thumbnail
  }

  const metadata = await safeCreateImageThumbnail(image.dataUrl)
  if (!metadata.thumbnailDataUrl) return undefined
  const thumbnail: StoredImageThumbnail = {
    id,
    thumbnailDataUrl: metadata.thumbnailDataUrl,
    width: metadata.width,
    height: metadata.height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
  await putImageThumbnail(thumbnail)
  if (metadata.width && metadata.height && (image.width !== metadata.width || image.height !== metadata.height)) {
    await patchImageMetadata(id, metadata.width, metadata.height)
  }
  return thumbnail
}

/** 原始记录批量读取（blob 或 dataUrl 格式，不转换）。仅限内部/测试用途。 */
export function getAllRawImageRecords(): Promise<StoredImageRecord[]> {
  return dbTransaction<StoredImageRecord[]>(STORE_IMAGES, 'readonly', (s) => s.getAll())
}

export function getAllImageIds(): Promise<string[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAllKeys()).then((keys) =>
    keys.map(String),
  )
}

// ===== Storage quota =====

export class StorageQuotaError extends Error {
  /** 配额失败前算好的图片 id，调用方可据此把图留在内存缓存里。 */
  imageId: string
  width?: number
  height?: number

  constructor(options: { imageId: string; width?: number; height?: number }) {
    super('浏览器存储空间不足，图片未能持久化。')
    this.name = 'StorageQuotaError'
    this.imageId = options.imageId
    this.width = options.width
    this.height = options.height
  }
}

/** IndexedDB 写入失败是否属于配额耗尽（浏览器抛 QuotaExceededError，Firefox 抛 QueryInterface 错误名）。 */
export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { name?: unknown; message?: unknown; code?: unknown }
  if (record.name === 'QuotaExceededError' || record.code === 22) return true
  // Firefox: DOMException named NS_ERROR_DOM_QUOTA_REACHED
  if (typeof record.message === 'string' && /quota/i.test(record.message)) return true
  return false
}

/** 估算当前站点存储用量；不可用时返回 null。 */
export async function estimateStorage(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate()
      if (typeof estimate.usage === 'number' && typeof estimate.quota === 'number') {
        return { usage: estimate.usage, quota: estimate.quota }
      }
    }
  } catch {
    // 估算失败不应影响任何主流程
  }
  return null
}

export function deleteImage(id: string): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).delete(id)
        tx.objectStore(STORE_THUMBNAILS).delete(id)
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(undefined)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
      }),
  )
}

export function clearImages(): Promise<undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_IMAGES, STORE_THUMBNAILS], 'readwrite')
        tx.objectStore(STORE_IMAGES).clear()
        tx.objectStore(STORE_THUMBNAILS).clear()
        try { db.close() } catch { /* already closed */ }
        tx.oncomplete = () => resolve(undefined)
        try { db.close() } catch { /* already closed */ }
        tx.onerror = () => reject(tx.error)
      }),
  )
}

// ===== Image hashing & dedup =====

export async function hashDataUrl(dataUrl: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return hashDataUrlFallback(dataUrl)
  }

  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashDataUrlFallback(dataUrl: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193

  for (let i = 0; i < dataUrl.length; i++) {
    const code = dataUrl.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }

  return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

export interface StoreImageResult {
  id: string
  width?: number
  height?: number
}

/**
 * 存储图片，若已存在（按 hash 去重）则跳过。
 * 返回 image id 及图片真实宽高。
 */
export async function storeImage(dataUrl: string, source: NonNullable<StoredImage['source']> = 'upload'): Promise<string> {
  return (await storeImageWithSize(dataUrl, source)).id
}

export async function storeImageWithSize(dataUrl: string, source: NonNullable<StoredImage['source']> = 'upload'): Promise<StoreImageResult> {
  const id = await hashDataUrl(dataUrl)
  const existing = await getImage(id)
  if (!existing) {
    const thumbnail = await safeCreateImageThumbnail(dataUrl)
    try {
      await putImage({
        id,
        dataUrl,
        createdAt: Date.now(),
        source,
        width: thumbnail.width,
        height: thumbnail.height,
      })
    } catch (err) {
      // 配额耗尽时不能让上层把已经生成的图整张丢弃——把 id/尺寸带回去，
      // 调用方可据此把图留在内存缓存并提示用户导出。
      if (isQuotaExceededError(err)) {
        throw new StorageQuotaError({ imageId: id, width: thumbnail.width, height: thumbnail.height })
      }
      throw err
    }
    // 缩略图写入失败（含配额）不视为图片未持久化：原图已落盘即成功，
    // 缩略图缺失由 backfill 自愈。这里吞掉错误是刻意的。
    try {
      if (thumbnail.thumbnailDataUrl) {
        await putImageThumbnail({
          id,
          thumbnailDataUrl: thumbnail.thumbnailDataUrl,
          width: thumbnail.width,
          height: thumbnail.height,
          thumbnailVersion: THUMBNAIL_VERSION,
        })
      }
    } catch (err) {
      if (!isQuotaExceededError(err)) throw err
      console.warn('缩略图因存储配额不足未写入，将在空间释放后自动补全', err)
    }
    return { id, width: thumbnail.width, height: thumbnail.height }
  }

  if ((await getStoredImageThumbnail(id))?.thumbnailVersion !== THUMBNAIL_VERSION) {
    const thumbnail = await safeCreateImageThumbnail(existing.dataUrl)
    const width = thumbnail.width ?? existing.width
    const height = thumbnail.height ?? existing.height
    if (thumbnail.width && thumbnail.height && (existing.width !== thumbnail.width || existing.height !== thumbnail.height)) {
      await putImage({ ...existing, width: thumbnail.width, height: thumbnail.height })
    }
    if (thumbnail.thumbnailDataUrl) {
      await putImageThumbnail({
        id,
        thumbnailDataUrl: thumbnail.thumbnailDataUrl,
        width: thumbnail.width,
        height: thumbnail.height,
        thumbnailVersion: THUMBNAIL_VERSION,
      })
    }
    return { id, width, height }
  }
  return { id, width: existing.width, height: existing.height }
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片加载失败'))
    image.src = dataUrl
  })
}

async function createImageThumbnail(dataUrl: string): Promise<Omit<StoredImageThumbnail, 'id'>> {
  const image = await loadImage(dataUrl)
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (width <= 0 || height <= 0) throw new Error('图片尺寸无效')

  const scale = Math.min(1, THUMBNAIL_MAX_SIZE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  return {
    thumbnailDataUrl: canvas.toDataURL('image/webp', THUMBNAIL_QUALITY),
    width,
    height,
    thumbnailVersion: THUMBNAIL_VERSION,
  }
}

async function safeCreateImageThumbnail(dataUrl: string): Promise<Partial<Omit<StoredImageThumbnail, 'id'>>> {
  try {
    return await createImageThumbnail(dataUrl)
  } catch {
    return {}
  }
}
