/**
 * db 门面（上游 v0.8.0 架构）：客户端把核心数据操作转发到 Rust 侧（SQLite + 图片文件），
 * 网页版走 IndexedDB 实现（dbWeb，即本 fork 的完整实现，含场景句柄/引擎交付/生成代际等自有扩展）。
 * fork 自有扩展（场景/引擎/本地保存句柄等基于 FileSystemDirectoryHandle 的 API）在客户端
 * 仍走 dbWeb——webview 内 IndexedDB 可用；这些目录句柄功能在客户端内本就由 Tauri 侧能力替代。
 */
import * as web from './dbWeb'
import * as tauri from './dbTauri'
import { isTauri } from './platform'

type CoreFn = (...args: never[]) => unknown
const core: Record<string, CoreFn> = (isTauri ? tauri : web) as unknown as Record<string, CoreFn>

// ===== 核心数据操作（按平台转发） =====

export const getAllTasks = core.getAllTasks as typeof web.getAllTasks
export const putTask = core.putTask as typeof web.putTask
export const deleteTask = core.deleteTask as typeof web.deleteTask
export const commitTaskDeletion = core.commitTaskDeletion as typeof web.commitTaskDeletion
export const clearTasks = core.clearTasks as typeof web.clearTasks
export const getAllAgentConversations = core.getAllAgentConversations as typeof web.getAllAgentConversations
export const putAgentConversation = core.putAgentConversation as typeof web.putAgentConversation
export const clearAgentConversations = core.clearAgentConversations as typeof web.clearAgentConversations
export const replaceAgentConversations = core.replaceAgentConversations as typeof web.replaceAgentConversations
export const getImage = core.getImage as typeof web.getImage
export const getStoredImageThumbnail = core.getStoredImageThumbnail as typeof web.getStoredImageThumbnail
export const putImageThumbnail = core.putImageThumbnail as typeof web.putImageThumbnail
export const getAllImages = core.getAllImages as typeof web.getAllImages
export const getAllImageIds = core.getAllImageIds as typeof web.getAllImageIds
export const putImage = core.putImage as typeof web.putImage
export const deleteImage = core.deleteImage as typeof web.deleteImage
export const clearImages = core.clearImages as typeof web.clearImages
// 哈希平台无关（SubtleCrypto + FNV 兜底），在门面实现
export const hashDataUrl: typeof web.hashDataUrl = async (dataUrl) => {
  if (!globalThis.crypto?.subtle) return web.hashDataUrl(dataUrl)
  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// getImageMeta：网页版走 dbWeb 的等价实现；客户端走 Rust 元数据查询
export const getImageMeta = (
  isTauri
    ? (tauri.getImageMeta as typeof web.getImageMetadata)
    : (web.getImageMetadata as typeof web.getImageMetadata)
)

// storeImageWithSize：网页版保留 dbWeb 完整实现（含 fork 的 4K 尺寸探测优化）；
// 客户端按上游门面路径（hash 去重 + 平台转发的 putImage/putImageThumbnail）。
// storeImage 同样按平台路由：客户端若写 IndexedDB 而读取走 Rust，重启后输入图/掩码全部丢失
export const storeImage: typeof web.storeImage = isTauri
  ? async (dataUrl, source) => (await storeImageWithSize(dataUrl, source)).id
  : web.storeImage

export const storeImageWithSize: typeof web.storeImageWithSize = isTauri
  ? async (dataUrl, source) => {
      const id = await hashDataUrl(dataUrl)
      const existing = await getImage(id)
      if (existing) return { id, width: existing.width, height: existing.height }
      const { safeCreateImageThumbnail } = await import('./dbWeb')
      const thumbnail = await safeCreateImageThumbnail(dataUrl)
      await putImage({ id, dataUrl, createdAt: Date.now(), source, width: thumbnail.width, height: thumbnail.height })
      if (thumbnail.thumbnailDataUrl) {
        await putImageThumbnail({ id, thumbnailDataUrl: thumbnail.thumbnailDataUrl, width: thumbnail.width, height: thumbnail.height, thumbnailVersion: 2 })
      }
      return { id, width: thumbnail.width, height: thumbnail.height }
    }
  : web.storeImageWithSize

// ===== fork 自有扩展：始终走 IndexedDB 实现（webview 内亦可用） =====

export {
  CURRENT_THUMBNAIL_VERSION,
  getTaskGeneration,
  clearTasksAndAdvanceGeneration,
  getLocalAutoSaveDirectoryHandle,
  putLocalAutoSaveDirectoryHandle,
  clearLocalAutoSaveDirectoryHandle,
  getEngineDeliveryDirectoryHandle,
  putEngineDeliveryDirectoryHandle,
  clearEngineDeliveryDirectoryHandle,
  type EngineDeliveryRecord,
  getEngineDeliveryRecord,
  putEngineDeliveryRecord,
  deleteEngineDeliveryRecord,
  SCENE_DIRECTORY_KEY_PREFIX,
  getSceneDirectoryHandle,
  putSceneDirectoryHandle,
  clearSceneDirectoryHandle,
  listSceneDirectoryHandles,
  SKILLS_ROOT_DIRECTORY_KEY,
  getSkillsRootDirectoryHandle,
  putSkillsRootDirectoryHandle,
  clearSkillsRootDirectoryHandle,
  type StoredLocalAutoSaveDirectoryHandle,
  getImageRecord,
  getImageMetadata,
  migrateImagesToBlobs,
  getStoredFreshImageThumbnail,
  getImageThumbnail,
  getAllRawImageRecords,
  StorageQuotaError,
  isQuotaExceededError,
  estimateStorage,
  type StoredImageRecord,
} from './dbWeb'

// 客户端专用 API（网页版调用时由 dbTauri 内部判定非 Tauri 报错或空实现）
export { getImageStats, type ImageStat } from './dbTauri'
