import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AgentInputDraft,
  ApiMode,
  ApiProfile,
  AppSettings,
  AppMode,
  TaskParams,
  InputImage,
  MaskDraft,
  StickerSplitSource,
  PromptReverseSource,
  TaskRecord,
  FavoriteCollection,
  PromptHistoryEntry,
  SceneDefaults,
  SceneId,
  SceneSettings,
  StoredImage,
  StoredImageThumbnail,
  RefusalRecoveryRecord,
  SkillSummary,
} from './types'
import { DEFAULT_PARAMS } from './types'
import { DEFAULT_SETTINGS, getActiveApiProfile, getCustomProviderDefinition, getSceneImageApiProfile, getSceneTextApiProfileResolution, mergeImportedSettings, mergePresetImportedSettings, normalizeSettings, validateApiProfile } from './lib/apiProfiles'
import { enforcePresetConfigPolicy, getPresetConfig, getPresetProfileIds, getPresetProviderIds, isPresetConfigDeletionPrevented, isPresetConfigOnlyEnabled, isPresetConfigParamsLocked, isPresetProfile, isPresetProviderDeletionPrevented } from './lib/presetConfig'
import { dismissAllTooltips } from './lib/tooltipDismiss'
import { remapImageMentionsForOrder, replaceImageMentionsForApi, stripImageMentionMarkers } from './lib/promptImageMentions'
import {
  getAllTasks,
  putTask as dbPutTask,
  deleteTask as dbDeleteTask,
  commitTaskDeletion,
  clearTasksAndAdvanceGeneration,
  getTaskGeneration,
  getAllAgentConversations,
  clearAgentConversations as dbClearAgentConversations,
  getLocalAutoSaveDirectoryHandle,
  putLocalAutoSaveDirectoryHandle,
  clearLocalAutoSaveDirectoryHandle,
  clearEngineDeliveryDirectoryHandle,
  getSceneDirectoryHandle,
  putSceneDirectoryHandle,
  clearSceneDirectoryHandle,
  listSceneDirectoryHandles,
  getSkillsRootDirectoryHandle,
  putSkillsRootDirectoryHandle,
  clearSkillsRootDirectoryHandle,
  type StoredLocalAutoSaveDirectoryHandle,
  getImage,
  getImageMetadata,
  getImageRecord,
  getStoredImageThumbnail,
  getImageThumbnail,
  getAllImageIds,
  putImage,
  putImageThumbnail,
  deleteImage,
  clearImages,
  storeImage,
  storeImageWithSize,
  migrateImagesToBlobs,
  StorageQuotaError,
} from './lib/db'
import { callImageApi } from './lib/api'
import { showBrowserNotification } from './lib/browserNotification'
import { IMAGE_FETCH_CORS_HINT } from './lib/imageApiShared'
import { getFalErrorMessage, getFalQueuedImageResult } from './lib/falAiImageApi'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { getChangedParams, normalizeParamsForSettings } from './lib/paramCompatibility'
import { buildNativeTransparentPrompt, createTransparentOutputMeta, getTransparentRequestParams } from './lib/transparentImage'
import { blobToDataUrl, fileToDataUrl } from './lib/dataUrl'
import { cacheImage, cacheThumbnail, clearImageCaches, deleteCachedImage, deleteImageCacheEntry, ensureImageCached, getCachedImage, getUnpinnedQuotaImageIds, pinQuotaImage, scheduleThumbnailBackfill } from './lib/imageCache'
import { hasActiveDataOperations } from './lib/dataOperations'
import { formatExportFileTime } from './lib/exportFileName'
import { buildExportZip, createExportBlob, getExportImageEstimatedBytes, getExportZipPlan, MAX_EXPORT_ZIP_BYTES, readExportZip, readExportZipFileAsDataUrl, readExportZipManifest } from './lib/exportZip'
import { storeTaskOutputImages } from './lib/taskOutputPersistence'
import { appendTargetAspectPromptHint, createTargetAspectPromptHint } from './lib/targetAspectPrompt'
import { calculateImageSize } from './lib/size'
import {
  buildLocalAutoSaveFolderName,
  buildLocalAutoSaveMetadata,
  buildLocalAutoSavePromptText,
  getLocalAutoSaveEligibility,
  getLocalAutoSaveImageBytes,
  getLocalAutoSaveImageFileName,
  getLocalAutoSaveIntentSize,
  isLocalAutoSaveSupported,
} from './lib/localAutoSave'
import { LocalAutoSavePermissionError, writeLocalAutoSaveArchive } from './lib/localAutoSaveWriter'
import { isEmptyAgentInputDraft, restoreGalleryInputDraftState, restoreInputImageFromStoredImage, saveGalleryInputDraft, syncActiveInputDraft, updateInputDraftImages } from './lib/inputDraftState'
import { ALL_FAVORITES_COLLECTION_ID, DEFAULT_FAVORITE_COLLECTION_ID, DEFAULT_FAVORITE_COLLECTION_NAME, createDefaultFavoriteCollection, deleteFavoriteCollectionState, ensureDefaultFavoriteCollection, getTaskFavoriteCollectionIds as getTaskFavoriteCollectionIdsForState, mergeFavoriteCollections, normalizeFavoriteCollectionIds, normalizeFavoriteCollectionName, normalizeFavoriteCollections, normalizeFavoritePatch, normalizeLoadedFavoriteState, resolveDefaultFavoriteCollectionId, sameFavoriteCollectionIds } from './lib/favoriteState'
import { createPersistedState, migratePersistedState, normalizePersistedState } from './lib/persistedState'
import { addImageSizeParam, createTaskDonePatch, createTaskErrorPatch, deriveFinalGalleryActualParams, firstActualParams, hasActualParams, hasActualSizeParam, mapActualParamsByImage, mapRevisedPromptsByImage, markInterruptedOpenAIRunningTasks, resolveFinalActualParams } from './lib/taskState'
import { stripInjectedCodexCliSizePrompt } from './lib/size'
import { BUILTIN_SKILL_IDS, loadBuiltinSkill } from './lib/skillWorkshop/builtinSkills'
import { scanLocalSkills } from './lib/skillWorkshop/localSkills'
import { parseExpansionEntries } from './lib/skillWorkshop/expansion'
import { callSkillExpansionApi } from './lib/skillWorkshop/skillExpansionApi'

export { ensureImageCached, getCachedImage } from './lib/imageCache'
export { ALL_FAVORITES_COLLECTION_ID, DEFAULT_FAVORITE_COLLECTION_ID, DEFAULT_FAVORITE_COLLECTION_NAME } from './lib/favoriteState'
const FAL_RECOVERY_POLL_MS = 10_000
const CUSTOM_RECOVERY_POLL_MS = 10_000
const SUPPORT_PROMPT_IMAGE_THRESHOLD = 50
const falRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const customRecoveryAbortControllers = new Map<string, AbortController>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
// 数据清除标志：clearData 成功清空任务后置为 true，用于阻止清除后仍在飞行中的
// 异步写入（executeTask、recovery timer 等）把任务重新写回内存/IndexedDB。
// 仅在 initStore（页面加载）和新的用户生成（submitTask/retryTask）时重置。
let tasksCleared = false
let taskStorageGeneration = 0

// Skill 扩写进行中的中止器（工坊单飞：新扩写开始时覆盖旧引用）。与
// customRecoveryAbortControllers 同为模块级 AbortController 既有模式。
let skillExpansionAbortController: AbortController | null = null

// ===== 生成并发队列 =====
// 浏览器同源约 6 个 HTTP 连接：>6 个长耗时图像任务并发时，排队任务的超时
// 时钟已在走但请求发不出去，最终团灭。信号量限制同时在飞的 executeTask。
const GENERATION_CONCURRENCY = 2
const generationQueue: Array<() => void> = []
let activeGenerationCount = 0

export function getGenerationQueueLength(): number {
  return generationQueue.length + activeGenerationCount
}

async function withGenerationSlot<T>(operation: (releaseSlot: () => void) => Promise<T>): Promise<T> {
  if (activeGenerationCount >= GENERATION_CONCURRENCY) {
    await new Promise<void>((resolve) => generationQueue.push(resolve))
  }
  activeGenerationCount += 1
  let slotReleased = false
  const releaseSlot = () => {
    if (slotReleased) return
    slotReleased = true
    activeGenerationCount -= 1
    const next = generationQueue.shift()
    if (next) next()
  }
  try {
    return await operation(releaseSlot)
  } finally {
    releaseSlot()
  }
}
const taskClearChannel = typeof window !== 'undefined' && 'BroadcastChannel' in window
  ? new window.BroadcastChannel('taostudio-image-lab-task-clear')
  : null

taskClearChannel?.addEventListener('message', (event: MessageEvent) => {
  if (event.data?.type !== 'tasks-cleared') return
  tasksCleared = true
  taskStorageGeneration = Math.max(taskStorageGeneration, Number(event.data.generation) || 0)
  for (const timer of falRecoveryTimers.values()) clearTimeout(timer)
  falRecoveryTimers.clear()
  for (const timer of customRecoveryTimers.values()) clearTimeout(timer)
  customRecoveryTimers.clear()
  for (const controller of customRecoveryAbortControllers.values()) controller.abort()
  customRecoveryAbortControllers.clear()
  for (const timer of openAIWatchdogTimers.values()) clearTimeout(timer)
  openAIWatchdogTimers.clear()
  clearTaskPersistRetryTimers()
  clearImageCaches()
  useStore.setState({ tasks: [] })
})
const ERROR_TOAST_MAX_LENGTH = 80
type ToastType = 'info' | 'success' | 'error'

export function getErrorToastMessage(message: string): string {
  const text = message.trim()
  if (!text) return '操作失败'

  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? ''
  const separatorIndex = firstLine.search(/[：:]/)
  if (separatorIndex > 0) {
    const title = firstLine.slice(0, separatorIndex).trim()
    if (isErrorToastTitle(title)) return title
  }

  if (firstLine.length > ERROR_TOAST_MAX_LENGTH) return '操作失败，请查看详情'
  return firstLine || '操作失败'
}

function getToastMessage(message: string, type: ToastType): string {
  return type === 'error' ? getErrorToastMessage(message) : message
}

function isErrorToastTitle(title: string): boolean {
  return /(?:失败|错误|异常|报错|无法|不能|超时|中断|断开|请先|请输入|已达上限|不存在|已丢失)$/.test(title)
}

export type SettingsTab = 'general' | 'api' | 'data' | 'about'

const TIMEOUT_STREAMING_HINT = '也可尝试打开「流式传输」，并提高「请求中间步骤图像数」来维持连接。'
const TIMEOUT_PARTIAL_IMAGES_ZERO_HINT = '官方流式接口不发送心跳，当前「请求中间步骤图像数」为 0，连接可能因无数据传输而断开。建议提高到 2 或 3。'
const TIMEOUT_PARTIAL_IMAGES_LOW_HINT = '也可尝试提高「请求中间步骤图像数」来维持连接，避免长时间无数据传输导致断开。'

type TimeoutStreamingHintProfile = Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages'>

function getTimeoutStreamingHint(profile?: TimeoutStreamingHintProfile | null) {
  if (profile?.provider !== 'openai') return ''
  const partialImages = profile.streamPartialImages ?? DEFAULT_SETTINGS.streamPartialImages ?? 0
  if (profile.streamImages !== true) return TIMEOUT_STREAMING_HINT
  if (partialImages === 0) return TIMEOUT_PARTIAL_IMAGES_ZERO_HINT
  return partialImages < 3 ? TIMEOUT_PARTIAL_IMAGES_LOW_HINT : ''
}

function createOpenAITimeoutError(timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。${getTimeoutStreamingHint(profile)}`
}

/** 从任务当前生效的 profile 里取超时秒数，供超时文案使用。 */
function activeProfileTimeoutSeconds(taskId: string, task: TaskRecord): number {
  const settings = useStore.getState().settings
  const profile = getTaskApiProfile(settings, task) ?? getActiveApiProfile(settings)
  return profile.timeout
}

function getTimeoutHintProfileFor(task: TaskRecord): TimeoutStreamingHintProfile | null {
  const settings = useStore.getState().settings
  return getTaskApiProfile(settings, task) ?? {
    provider: task.apiProvider ?? getActiveApiProfile(settings).provider,
    streamImages: getActiveApiProfile(settings).streamImages,
    streamPartialImages: getActiveApiProfile(settings).streamPartialImages,
  }
}

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

function isAgentTask(task: TaskRecord) {
  return task.sourceMode === 'agent' || Boolean(task.agentConversationId || task.agentRoundId)
}

function showTaskCompletionNotification(title: string, body: string) {
  const settings = normalizeSettings(useStore.getState().settings)
  if (!settings.taskCompletionNotification) return
  showBrowserNotification(title, { body })
}

function countSuccessfulOutputImages(tasks: TaskRecord[]) {
  return tasks.reduce((count, task) => count + (task.status === 'done' && !isAgentTask(task) ? task.outputImages.length : 0), 0)
}

function skipSupportPromptForImportedData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptOpen) return {}
    return { supportPromptSkippedForImportedData: true }
  })
}

function showSupportPromptForExistingLocalData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed || state.supportPromptOpen) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptSkippedForImportedData) return {}
    return { supportPromptOpen: true }
  })
}

function maybeOpenSupportPrompt(previousTasks: TaskRecord[], nextTasks: TaskRecord[], taskId: string) {
  const state = useStore.getState()
  if (state.supportPromptDismissed || state.supportPromptOpen || state.supportPromptSkippedForImportedData) return

  const previousTask = previousTasks.find((task) => task.id === taskId)
  const nextTask = nextTasks.find((task) => task.id === taskId)
  if (!nextTask || previousTask?.status === 'done' || nextTask.status !== 'done' || nextTask.outputImages.length === 0) return

  const previousCount = countSuccessfulOutputImages(previousTasks)
  const nextCount = countSuccessfulOutputImages(nextTasks)
  if (previousCount <= SUPPORT_PROMPT_IMAGE_THRESHOLD && nextCount > SUPPORT_PROMPT_IMAGE_THRESHOLD) {
    useStore.setState({ supportPromptOpen: true })
  }
}

export function getPersistedState(state: AppState) {
  return createPersistedState(state)
}

function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
  const plan = normalizePersistedState(persistedState, currentState)
  if (!plan) return currentState
  return {
    ...currentState,
    ...plan,
    activeFavoriteCollectionId: null,
    favoritePickerTaskIds: null,
  }
}

// ===== Store 类型 =====

export interface SkillExpansionEntry {
  id: string
  text: string
  enabled: boolean
}

export interface SkillExpansionState {
  status: 'idle' | 'running' | 'error'
  error: string | null
  entries: SkillExpansionEntry[]
}

export interface SkillWorkshopState {
  builtin: SkillSummary[]
  builtinLoading: boolean
  local: SkillSummary[]
  localRootName: string | null
  scanning: boolean
}

/** 按 id 在内置与本地 skill 列表中查找（内置优先） */
function findSkillSummary(skills: SkillWorkshopState, id: string | null): SkillSummary | null {
  if (!id) return null
  return skills.builtin.find((skill) => skill.id === id) ??
    skills.local.find((skill) => skill.id === id) ?? null
}

interface AppState {
  // 模式
  appMode: AppMode
  setAppMode: (mode: AppMode) => void

  // 设置
  settings: AppSettings
  previousPresetConfig: Pick<AppSettings, 'customProviders' | 'profiles'> | null
  setSettings: (s: Partial<AppSettings>) => void
  setPresetImportedSettings: (
    importedSettings: Partial<AppSettings> | unknown,
    transform?: (settings: AppSettings) => Partial<AppSettings>,
  ) => Promise<void>
  dismissedPresetProfileIds: string[]
  dismissPresetProfile: (id: string) => void
  restorePresetProfile: (id: string) => void
  dismissedPresetProviderIds: string[]
  dismissPresetProvider: (id: string) => void
  restorePresetProvider: (id: string) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  replaceInputImage: (idx: number, img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void
  stickerSplitSource: StickerSplitSource | null
  setStickerSplitSource: (src: StickerSplitSource | null) => void
  promptReverseSource: PromptReverseSource | null
  setPromptReverseSource: (src: PromptReverseSource | null) => void
  galleryInputDraft: AgentInputDraft | null

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  setReusedTaskApiProfile: (profileId: string | null, missing?: boolean, profileName?: string | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  /** 画廊提示词历史（最近 20 条，持久化到 localStorage），用于一键回填 */
  promptHistory: PromptHistoryEntry[]
  recordPromptHistory: (prompt: string, params: TaskParams) => void
  clearPromptHistory: () => void
  favoriteCollections: FavoriteCollection[]
  setFavoriteCollections: (collections: FavoriteCollection[]) => void
  defaultFavoriteCollectionId: string | null
  setDefaultFavoriteCollectionId: (id: string | null) => void
  activeFavoriteCollectionId: string | null
  isManageCollectionsModalOpen: boolean
  setActiveFavoriteCollectionId: (id: string | null) => void
  openManageCollectionsModal: () => void
  closeManageCollectionsModal: () => void
  favoritePickerTaskIds: string[] | null
  openFavoritePicker: (taskIds: string[]) => void
  closeFavoritePicker: () => void
  streamPreviews: Record<string, string>
  streamPreviewSlots: Record<string, Record<string, string>>
  setTaskStreamPreview: (taskId: string, image?: string, requestIndex?: number) => void
  localAutoSaveRunningTaskIds: Record<string, true>
  selectLocalAutoSaveDirectory: () => Promise<void>
  authorizeLocalAutoSaveDirectory: () => Promise<boolean>
  /** 补保存前置门（逐句柄授权）：全局目录 + 全部场景目录，任一授权成功即 true 并补跑 pending */
  authorizeAllLocalAutoSaveDirectories: () => Promise<boolean>
  retryPendingLocalAutoSaves: () => Promise<void>

  // 场景
  setActiveScene: (scene: SceneId) => void
  setSceneImageProfileId: (scene: SceneId, profileId: string | null) => void
  setSceneTextProfileId: (scene: SceneId, profileId: string | null) => void
  setSceneDefaults: (scene: SceneId, defaults: Partial<SceneDefaults>) => void
  selectSceneSaveDirectory: (scene: SceneId) => Promise<void>
  clearSceneSaveDirectory: (scene: SceneId) => Promise<void>

  // Skill 工坊
  skills: SkillWorkshopState
  activeSkillId: string | null
  skillInputDraft: string
  skillExpansion: SkillExpansionState
  loadBuiltinSkills: () => Promise<void>
  importSkillsRootDirectory: () => Promise<void>
  refreshLocalSkills: () => Promise<void>
  clearSkillsRootDirectory: () => Promise<void>
  setActiveSkill: (id: string) => void
  setSkillInputDraft: (draft: string) => void
  runSkillExpansion: () => Promise<void>
  abortSkillExpansion: () => void
  updateSkillEntry: (id: string, patch: Partial<Pick<SkillExpansionEntry, 'text' | 'enabled'>>) => void
  removeSkillEntry: (id: string) => void
  generateFromSkillEntries: () => Promise<void>

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void
  /** 画廊任务列表的场景过滤：'all' 不限，其余只看对应场景（旧任务无 sceneId 视为 general） */
  gallerySceneFilter: 'all' | SceneId
  setGallerySceneFilter: (filter: AppState['gallerySceneFilter']) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void
  selectedFavoriteCollectionIds: string[]
  setSelectedFavoriteCollectionIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleFavoriteCollectionSelection: (id: string, force?: boolean) => void
  clearFavoriteCollectionSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showSettings: boolean
  settingsTabRequest: SettingsTab | null
  setShowSettings: (v: boolean, tab?: SettingsTab) => void
  supportPromptOpen: boolean
  supportPromptDismissed: boolean
  supportPromptSkippedForImportedData: boolean
  setSupportPromptOpen: (v: boolean) => void
  dismissSupportPrompt: () => void

  // Toast
  toast: { message: string; type: ToastType } | null
  showToast: (message: string, type?: ToastType) => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    checkbox?: {
      label: string
      defaultChecked?: boolean
      disabled?: boolean
      tone?: 'primary' | 'danger'
    }
    confirmText?: string
    cancelText?: string
    showCancel?: boolean
    buttons?: Array<{
      label: string
      tone?: 'primary' | 'secondary' | 'danger' | 'warning'
      action: (checkboxChecked?: boolean) => void
    }>
    icon?: 'info' | 'copy'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    awaitAction?: boolean
    action?: (checkboxChecked?: boolean) => void | boolean | Promise<void | boolean>
    cancelAction?: (checkboxChecked?: boolean) => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

function isImageReferencedByState(state: AppState, imageId: string) {
  if (state.promptReverseSource?.imageId === imageId) return true
  if (state.inputImages.some((img) => img.id === imageId)) return true
  if (state.galleryInputDraft?.inputImages.some((img) => img.id === imageId)) return true
  return state.tasks.some((task) =>
    task.inputImageIds.includes(imageId) ||
    task.outputImages.includes(imageId) ||
    task.transparentOriginalImages?.includes(imageId) ||
    task.exactSizeOriginalImages?.includes(imageId) ||
    task.streamPartialImageIds?.includes(imageId) ||
    task.maskTargetImageId === imageId ||
    task.maskImageId === imageId
  )
}

export async function deleteImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  try {
    await deleteStoredImageIfUnreferenced(imageId)
  } catch {
    // 清理是内存/存储优化，失败不影响替换结果。
  }
}

async function deleteStoredImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  const [image, thumbnail] = await Promise.all([getImage(imageId), getStoredImageThumbnail(imageId)])
  if (isImageReferencedByState(useStore.getState(), imageId)) return

  await deleteImage(imageId)
  if (!isImageReferencedByState(useStore.getState(), imageId)) {
    deleteImageCacheEntry(imageId)
    return
  }

  // 删除期间被新引用：恢复。恢复写盘若失败（配额/IO），原图不能就此永久
  // 丢失——钉进内存缓存保底并告警，用户仍可导出。
  if (image) {
    try {
      await putImage(image)
      cacheImage(image.id, image.dataUrl)
    } catch (err) {
      console.error('恢复被引用图片失败，已保留内存副本', err)
      pinQuotaImage(image.id, image.dataUrl)
      useStore.getState().showToast('一张被引用的图片在清理时险些丢失，已保留内存副本，请尽快导出。', 'error')
    }
  }
  if (thumbnail) {
    try {
      await putImageThumbnail(thumbnail)
    } catch {
      // 缩略图可自愈，失败无影响。
    }
    cacheThumbnail(thumbnail.id, {
      dataUrl: thumbnail.thumbnailDataUrl,
      width: thumbnail.width,
      height: thumbnail.height,
      thumbnailVersion: thumbnail.thumbnailVersion,
    })
  }
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Mode
      appMode: 'gallery',
      setAppMode: (appMode) => {
        if (appMode === 'gallery') {
          const state = get()
          const galleryInputDraft = saveGalleryInputDraft(state)
          set((state) => ({
            appMode,
            galleryInputDraft,
            selectedTaskIds: [],
            selectedFavoriteCollectionIds: [],
            ...(state.appMode !== 'gallery' ? restoreGalleryInputDraftState(galleryInputDraft) : {}),
          }))
          return
        }

        const state = get()
        if (appMode === 'engine') {
          const galleryInputDraft = state.appMode === 'gallery'
            ? saveGalleryInputDraft(state)
            : state.galleryInputDraft
          set({
            appMode,
            galleryInputDraft,
            selectedTaskIds: [],
            selectedFavoriteCollectionIds: [],
          })
          return
        }
      },

      // Settings
      settings: { ...DEFAULT_SETTINGS },
      previousPresetConfig: null,
      dismissedPresetProfileIds: [],
      dismissPresetProfile: (id) => set((state) => ({
        dismissedPresetProfileIds: state.dismissedPresetProfileIds.includes(id)
          ? state.dismissedPresetProfileIds
          : [...state.dismissedPresetProfileIds, id],
      })),
      restorePresetProfile: (id) => set((state) => ({
        dismissedPresetProfileIds: state.dismissedPresetProfileIds.filter((item) => item !== id),
      })),
      dismissedPresetProviderIds: [],
      dismissPresetProvider: (id) => set((state) => ({
        dismissedPresetProviderIds: state.dismissedPresetProviderIds.includes(id)
          ? state.dismissedPresetProviderIds
          : [...state.dismissedPresetProviderIds, id],
      })),
      restorePresetProvider: (id) => set((state) => ({
        dismissedPresetProviderIds: state.dismissedPresetProviderIds.filter((item) => item !== id),
      })),
      setSettings: (s) => set((st) => {
        const previous = normalizeSettings(st.settings)
        const incoming = s as Partial<AppSettings>
        const hasLegacyOverrides =
          incoming.baseUrl !== undefined ||
          incoming.apiKey !== undefined ||
          incoming.model !== undefined ||
          incoming.timeout !== undefined ||
          incoming.apiMode !== undefined ||
          incoming.codexCli !== undefined ||
          incoming.apiProxy !== undefined ||
          incoming.streamImages !== undefined ||
          incoming.streamPartialImages !== undefined
        const mergedIncoming = incoming.localAutoSave !== undefined
          ? {
              ...incoming,
              localAutoSave: {
                ...previous.localAutoSave,
                ...incoming.localAutoSave,
              },
            }
          : incoming
        const merged = normalizeSettings({ ...previous, ...mergedIncoming })
        if (hasLegacyOverrides && incoming.profiles === undefined) {
          merged.profiles = merged.profiles.map((profile) =>
            profile.id === merged.activeProfileId
              ? {
                  ...profile,
                  baseUrl: incoming.baseUrl ?? profile.baseUrl,
                  apiKey: incoming.apiKey ?? profile.apiKey,
                  model: incoming.model ?? profile.model,
                  timeout: incoming.timeout ?? profile.timeout,
                  apiMode: incoming.apiMode === 'images' || incoming.apiMode === 'responses' ? incoming.apiMode : profile.apiMode,
                  codexCli: incoming.codexCli ?? profile.codexCli,
                  apiProxy: incoming.apiProxy ?? profile.apiProxy,
                  streamImages: incoming.streamImages ?? profile.streamImages,
                  streamPartialImages: incoming.streamPartialImages ?? profile.streamPartialImages,
                }
              : profile,
          )
        }
        const effectiveDismissedPresetProviderIds = st.dismissedPresetProviderIds.filter((id) =>
          !isPresetProviderDeletionPrevented(id, previous.profiles),
        )
        const settings = normalizeSettings(enforcePresetConfigPolicy(merged, {
          dismissedPresetProviderIds: effectiveDismissedPresetProviderIds,
        }))
        const shouldClearReusedProfile = st.reusedTaskApiProfileId && settings.activeProfileId === st.reusedTaskApiProfileId
        return {
          settings,
          ...(shouldClearReusedProfile
            ? { reusedTaskApiProfileId: null, reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false }
            : {}),
        }
      }),
      setPresetImportedSettings: async (importedSettings, transform) => {
        set((state) => {
          const presetIds = getPresetProfileIds()
          const presetProviderIds = getPresetProviderIds()
          const dismissedPresetProfileIds = state.dismissedPresetProfileIds.filter((id) => presetIds.has(id))
          const deletionPrevented = isPresetConfigDeletionPrevented()
          const remainingPresetProfiles = (getPresetConfig()?.profiles ?? state.settings.profiles)
            .filter((profile) => !dismissedPresetProfileIds.includes(profile.id))
          const dismissedPresetProviderIds = state.dismissedPresetProviderIds
            .filter((id) => presetProviderIds.has(id))
          const effectiveDismissedPresetProviderIds = dismissedPresetProviderIds
            .filter((id) => !isPresetProviderDeletionPrevented(id, remainingPresetProfiles))
          const merged = mergePresetImportedSettings(state.settings, importedSettings, {
            lockPresetParams: isPresetConfigParamsLocked(),
            dismissedPresetProfileIds: deletionPrevented ? [] : dismissedPresetProfileIds,
            dismissedPresetProviderIds: effectiveDismissedPresetProviderIds,
            previousPresetConfig: state.previousPresetConfig,
            usedPresetProfileIds: state.tasks.flatMap((task) => task.apiProfileId ? [task.apiProfileId] : []),
          })
          const settings = normalizeSettings(enforcePresetConfigPolicy(
            normalizeSettings(transform?.(merged.settings) ?? merged.settings),
            { dismissedPresetProviderIds: effectiveDismissedPresetProviderIds },
          ))
          const shouldClearReusedProfile = state.reusedTaskApiProfileId && settings.activeProfileId === state.reusedTaskApiProfileId
          return {
            settings,
            previousPresetConfig: getPresetConfig() ? merged.presetConfig : null,
            dismissedPresetProfileIds,
            dismissedPresetProviderIds,
            reusedTaskApiProfileId: shouldClearReusedProfile ? null : state.reusedTaskApiProfileId,
            ...(shouldClearReusedProfile
              ? { reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false }
              : {}),
          }
        })
      },
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set((s) => syncActiveInputDraft(s, { prompt })),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return syncActiveInputDraft(s, { inputImages: [...s.inputImages, img] })
        }),
      replaceInputImage: (idx, img) => {
        let removedImageId: string | null = null
        set((s) => {
          if (idx < 0 || idx >= s.inputImages.length) return s
          const previous = s.inputImages[idx]
          if (!previous || previous.id === img.id) return s
          if (s.inputImages.some((item, itemIdx) => itemIdx !== idx && item.id === img.id)) return s
          removedImageId = previous.id
          const inputImages = s.inputImages.map((item, itemIdx) => itemIdx === idx ? img : item)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: { [previous.id]: img.id },
            clearMissingMask: previous.id === s.maskDraft?.targetImageId,
          }))
        })
        if (removedImageId) void deleteImageIfUnreferenced(removedImageId)
      },
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const inputImages = s.inputImages.filter((_, i) => i !== idx)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            clearMissingMask: removed?.id === s.maskDraft?.targetImageId,
          }))
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) deleteCachedImage(img.id)
          return syncActiveInputDraft(s, {
            ...updateInputDraftImages(s, []),
            maskDraft: null,
            maskEditorImageId: null,
          })
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: options?.equivalentImageIds,
          }))
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return syncActiveInputDraft(s, updateInputDraftImages(s, images, { clearMissingMask: false }))
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId)
          return syncActiveInputDraft(s, {
            maskDraft,
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
          })
        }),
      clearMaskDraft: () => set((s) => syncActiveInputDraft(s, { maskDraft: null })),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => {
        if (maskEditorImageId) dismissAllTooltips()
        set((s) => syncActiveInputDraft(s, { maskEditorImageId }))
      },
      stickerSplitSource: null,
      setStickerSplitSource: (stickerSplitSource) => {
        if (stickerSplitSource) dismissAllTooltips()
        set({ stickerSplitSource })
      },
      promptReverseSource: null,
      setPromptReverseSource: (promptReverseSource) => {
        if (promptReverseSource) dismissAllTooltips()
        const prev = get().promptReverseSource
        set({ promptReverseSource })
        // 上传/粘贴反推在替换前可重复触发：被替换/关闭/清空的旧上传图若无人引用则回收，
        // 否则要等到下次重载的孤儿清扫。先 set 再删，避免与引用判定里的 source 检查互锁；
        // imageId 为 null（落区待输入态）不参与清理。
        if (prev?.imageId && prev.imageId !== promptReverseSource?.imageId) {
          void deleteImageIfUnreferenced(prev.imageId)
        }
      },
      galleryInputDraft: null,

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      setReusedTaskApiProfile: (profileId, missing = false, profileName = null) => set({
        reusedTaskApiProfileId: profileId,
        reusedTaskApiProfileName: profileName,
        reusedTaskApiProfileMissing: missing,
      }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set(() => ({
        tasks,
        ...(countSuccessfulOutputImages(tasks) <= SUPPORT_PROMPT_IMAGE_THRESHOLD
          ? { supportPromptSkippedForImportedData: false }
          : {}),
      })),
      promptHistory: [],
      recordPromptHistory: (prompt, params) => {
        const trimmed = prompt.trim()
        if (!trimmed) return
        set((state) => {
          const deduped = state.promptHistory.filter((entry) => entry.prompt !== trimmed)
          const entry: PromptHistoryEntry = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            prompt: trimmed,
            size: params.size,
            quality: params.quality,
            output_format: params.output_format,
            n: params.n,
            usedAt: Date.now(),
          }
          return { promptHistory: [entry, ...deduped].slice(0, 20) }
        })
      },
      clearPromptHistory: () => set({ promptHistory: [] }),
      favoriteCollections: [createDefaultFavoriteCollection()],
      setFavoriteCollections: (favoriteCollections) => set((state) => {
        const nextCollections = ensureDefaultFavoriteCollection(normalizeFavoriteCollections(favoriteCollections))
        return {
          favoriteCollections: nextCollections,
          defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(nextCollections, state.defaultFavoriteCollectionId),
        }
      }),
      defaultFavoriteCollectionId: DEFAULT_FAVORITE_COLLECTION_ID,
      setDefaultFavoriteCollectionId: (defaultFavoriteCollectionId) => set((state) => (
        defaultFavoriteCollectionId === null || state.favoriteCollections.some((collection) => collection.id === defaultFavoriteCollectionId)
          ? { defaultFavoriteCollectionId }
          : state
      )),
      activeFavoriteCollectionId: null,
      isManageCollectionsModalOpen: false,
      setActiveFavoriteCollectionId: (activeFavoriteCollectionId) => set({ activeFavoriteCollectionId, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),
      openManageCollectionsModal: () => set({ isManageCollectionsModalOpen: true }),
      closeManageCollectionsModal: () => set({ isManageCollectionsModalOpen: false }),
      favoritePickerTaskIds: null,
      openFavoritePicker: (taskIds) => {
        if (!taskIds.length) return
        dismissAllTooltips()
        set({ favoritePickerTaskIds: Array.from(new Set(taskIds)).filter(Boolean) })
      },
      closeFavoritePicker: () => set({ favoritePickerTaskIds: null }),
      streamPreviews: {},
      streamPreviewSlots: {},
      setTaskStreamPreview: (taskId, image, requestIndex = 0) => set((s) => {
        if (image) {
          if (!s.tasks.some((task) => task.id === taskId)) return s
          const slotKey = String(requestIndex)
          const currentSlots = s.streamPreviewSlots[taskId] ?? {}
          if (s.streamPreviews[taskId] === image && currentSlots[slotKey] === image) return s
          return {
            streamPreviews: { ...s.streamPreviews, [taskId]: image },
            streamPreviewSlots: {
              ...s.streamPreviewSlots,
              [taskId]: { ...currentSlots, [slotKey]: image },
            },
          }
        }

        if (!(taskId in s.streamPreviews) && !(taskId in s.streamPreviewSlots)) return s
        const next = { ...s.streamPreviews }
        const nextSlots = { ...s.streamPreviewSlots }
        delete next[taskId]
        delete nextSlots[taskId]
        return { streamPreviews: next, streamPreviewSlots: nextSlots }
      }),
      localAutoSaveRunningTaskIds: {},
      selectLocalAutoSaveDirectory: async () => selectLocalAutoSaveDirectory(),
      authorizeLocalAutoSaveDirectory: async () => authorizeLocalAutoSaveDirectory(),
      authorizeAllLocalAutoSaveDirectories: async () => authorizeAllLocalAutoSaveDirectories(),
      retryPendingLocalAutoSaves: async () => retryPendingLocalAutoSaves(),

      // Scenes
      setActiveScene: (scene) => {
        const state = get()
        // 同场景重复点击：不重放默认参数，但要修复漂移的画廊过滤
        //（filter 不持久化，刷新后可能停在别的场景 → 当前场景任务不可见的 Tab 死点）。
        if (state.settings.activeScene === scene) {
          if (state.gallerySceneFilter !== scene) set({ gallerySceneFilter: scene })
          return
        }
        set({ settings: { ...state.settings, activeScene: scene }, gallerySceneFilter: scene })
        applySceneDefaults(scene)
      },
      setSceneImageProfileId: (scene, profileId) => {
        patchSceneSettings(scene, { imageProfileId: profileId })
      },
      setSceneTextProfileId: (scene, profileId) => {
        patchSceneSettings(scene, { textProfileId: profileId })
      },
      setSceneDefaults: (scene, defaults) => {
        const current = useStore.getState().settings.scenes[scene]
        patchSceneSettings(scene, { defaults: { ...current.defaults, ...defaults } })
      },
      selectSceneSaveDirectory: async (scene) => selectSceneSaveDirectory(scene),
      clearSceneSaveDirectory: async (scene) => clearSceneSaveDirectory(scene),

      // Skill 工坊
      skills: { builtin: [], builtinLoading: false, local: [], localRootName: null, scanning: false },
      activeSkillId: null,
      skillInputDraft: '',
      skillExpansion: { status: 'idle', error: null, entries: [] },
      loadBuiltinSkills: async () => {
        set((state) => ({ skills: { ...state.skills, builtinLoading: true } }))
        const loaded = await Promise.all(BUILTIN_SKILL_IDS.map(async (id): Promise<SkillSummary | null> => {
          const parsed = await loadBuiltinSkill(id)
          if (!parsed) return null
          return { id, name: parsed.name, description: parsed.description, body: parsed.body, source: 'builtin' }
        }))
        const builtin = loaded.filter((skill): skill is SkillSummary => skill !== null)
        set((state) => ({
          skills: { ...state.skills, builtin, builtinLoading: false },
          // 首次加载自动选中第一个内置 skill（不覆盖用户已做的选择）
          activeSkillId: state.activeSkillId ?? builtin[0]?.id ?? null,
        }))
      },
      importSkillsRootDirectory: async () => importSkillsRootDirectory(),
      refreshLocalSkills: async () => refreshLocalSkills(),
      clearSkillsRootDirectory: async () => clearSkillsRootDirectory(),
      setActiveSkill: (id) => {
        // 切换 skill 即重置扩写结果：条目属于上一个 skill 的扩写输出，
        // 且生成链的 skillMeta 取当前 activeSkillId，保留会造成溯源错配。
        set({ activeSkillId: id, skillExpansion: { status: 'idle', error: null, entries: [] } })
      },
      setSkillInputDraft: (skillInputDraft) => set({ skillInputDraft }),
      runSkillExpansion: async () => {
        const state = get()
        const activeSkill = findSkillSummary(state.skills, state.activeSkillId)
        // 校验失败不动 entries：保留已扩写结果，用户修正输入后重试不丢条目
        if (!activeSkill) {
          set((prev) => ({ skillExpansion: { status: 'error', error: '请先选择一个 skill', entries: prev.skillExpansion.entries } }))
          return
        }
        const userInput = state.skillInputDraft.trim()
        if (!userInput) {
          set((prev) => ({ skillExpansion: { status: 'error', error: '请输入锚点内容（主题、场景或角色设定）', entries: prev.skillExpansion.entries } }))
          return
        }
        const resolution = getSceneTextApiProfileResolution(state.settings)
        if (!resolution.profile) {
          set((prev) => ({ skillExpansion: { status: 'error', error: '未找到可用的文本模型配置（需 Responses 类型），可在设置→API 中添加', entries: prev.skillExpansion.entries } }))
          return
        }
        // 新扩写开始前先 abort 旧请求：旧请求 await 返回后被下方「最新 run」守卫拦截，不再回写污染状态
        skillExpansionAbortController?.abort()
        const controller = new AbortController()
        skillExpansionAbortController = controller
        set((prev) => ({ skillExpansion: { status: 'running', error: null, entries: prev.skillExpansion.entries } }))
        try {
          const raw = await callSkillExpansionApi({
            settings: state.settings,
            profile: resolution.profile,
            skillBody: activeSkill.body,
            userInput,
            signal: controller.signal,
          })
          // 仅最新一次扩写允许回写：被 abort/替换的孤儿请求后到也不得覆盖新结果
          if (skillExpansionAbortController !== controller) return
          const entries = parseExpansionEntries(raw).map((entry) => ({ ...entry, enabled: true }))
          set({ skillExpansion: { status: 'idle', error: null, entries } })
        } catch (err) {
          if (skillExpansionAbortController !== controller) return
          if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            set({ skillExpansion: { status: 'idle', error: null, entries: [] } })
            return
          }
          set((prev) => ({
            skillExpansion: {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
              entries: prev.skillExpansion.entries,
            },
          }))
        } finally {
          if (skillExpansionAbortController === controller) skillExpansionAbortController = null
        }
      },
      abortSkillExpansion: () => {
        skillExpansionAbortController?.abort()
        skillExpansionAbortController = null
        // 立即回 idle 清空条目；在飞请求随后返回时被「最新 run」守卫拦截，不回写
        set({ skillExpansion: { status: 'idle', error: null, entries: [] } })
      },
      updateSkillEntry: (id, patch) => set((state) => ({
        skillExpansion: {
          ...state.skillExpansion,
          entries: state.skillExpansion.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
        },
      })),
      removeSkillEntry: (id) => set((state) => ({
        skillExpansion: {
          ...state.skillExpansion,
          entries: state.skillExpansion.entries.filter((entry) => entry.id !== id),
        },
      })),
      generateFromSkillEntries: async () => {
        const state = get()
        const enabledEntries = state.skillExpansion.entries.filter((entry) => entry.enabled)
        if (!enabledEntries.length) {
          state.showToast('没有已启用的提示词条目', 'error')
          return
        }
        const activeSkill = findSkillSummary(state.skills, state.activeSkillId)
        if (!activeSkill) {
          state.showToast('请先选择一个 skill', 'error')
          return
        }
        const imageProfile = getSceneImageApiProfile(state.settings)
        const profileError = validateApiProfile(imageProfile)
        if (profileError) {
          state.showToast(`请先完善请求 API 配置：${profileError}`, 'error')
          state.setShowSettings(true)
          return
        }
        const skillMeta = { skillId: activeSkill.id, skillInput: state.skillInputDraft }
        const taskCountBefore = useStore.getState().tasks.length
        let submittedCount = 0
        try {
          for (const entry of enabledEntries) {
            useStore.getState().setPrompt(entry.text)
            await submitTask({ skillMeta })
            submittedCount += 1
          }
        } catch {
          // 单条提交抛错即中断循环：捕获 rejection 避免 unhandled，按已完成数提示失败位置
          state.showToast(`已提交 ${submittedCount} 个生成任务（第 ${submittedCount + 1} 条提交失败）`, 'error')
          return
        }
        const submitted = useStore.getState().tasks.length - taskCountBefore
        state.showToast(`已提交 ${submitted} 个生成任务`, submitted > 0 ? 'success' : 'error')
      },

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set(filterFavorite ? { filterFavorite, selectedTaskIds: [], selectedFavoriteCollectionIds: [] } : { filterFavorite, activeFavoriteCollectionId: null, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),
      gallerySceneFilter: 'general',
      setGallerySceneFilter: (gallerySceneFilter) => set({ gallerySceneFilter }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),
      selectedFavoriteCollectionIds: [],
      setSelectedFavoriteCollectionIds: (updater) => set((s) => ({
        selectedFavoriteCollectionIds: typeof updater === 'function' ? updater(s.selectedFavoriteCollectionIds) : updater
      })),
      toggleFavoriteCollectionSelection: (id, force) => set((s) => {
        const isSelected = s.selectedFavoriteCollectionIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedFavoriteCollectionIds: shouldSelect
            ? [...s.selectedFavoriteCollectionIds, id]
            : s.selectedFavoriteCollectionIds.filter((x) => x !== id)
        }
      }),
      clearFavoriteCollectionSelection: () => set({ selectedFavoriteCollectionIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => {
        if (detailTaskId) dismissAllTooltips()
        set({ detailTaskId })
      },
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) => {
        if (lightboxImageId) dismissAllTooltips()
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) })
      },
      showSettings: false,
      settingsTabRequest: null,
      setShowSettings: (showSettings, settingsTabRequest) => {
        if (showSettings) dismissAllTooltips()
        set({
          showSettings,
          ...(settingsTabRequest ? { settingsTabRequest } : {}),
          ...(!showSettings ? { settingsTabRequest: null } : {}),
        })
      },
      supportPromptOpen: false,
      supportPromptDismissed: false,
      supportPromptSkippedForImportedData: false,
      setSupportPromptOpen: (supportPromptOpen) => set({ supportPromptOpen }),
      dismissSupportPrompt: () => set({ supportPromptOpen: false, supportPromptDismissed: true }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        const toastMessage = getToastMessage(message, type)
        const toast = { message: toastMessage, type }
        set({ toast })
        setTimeout(() => {
          set((s) => (s.toast === toast ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => {
        if (confirmDialog) dismissAllTooltips()
        set({ confirmDialog })
      },
    }),
    {
      name: 'gpt-image-playground',
      version: 2,
      migrate: migratePersistedState,
      partialize: getPersistedState,
      merge: mergePersistedState,
    },
  ),
)

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

// 任务持久化失败重试：IndexedDB 写入失败（配额/瞬态锁）时 UI 与磁盘会静默分叉，
// 刷新后画廊部分消失。这里统一兜底：指数退避重试，最终失败弹一次去重提示。
let taskPersistFailedNotified = false
const taskPersistRetryQueue = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> }>()
const TASK_PERSIST_MAX_ATTEMPTS = 3

function clearTaskPersistRetryTimers() {
  for (const { timer } of taskPersistRetryQueue.values()) clearTimeout(timer)
  taskPersistRetryQueue.clear()
  taskPersistFailedNotified = false
}

function notifyTaskPersistFailedOnce() {
  if (taskPersistFailedNotified) return
  taskPersistFailedNotified = true
  useStore.getState().showToast(
    '部分任务记录未能写入本地存储，刷新前请先导出备份；若持续出现请检查浏览器存储空间。',
    'error',
  )
}

function scheduleTaskPersistRetry(task: TaskRecord) {
  const existing = taskPersistRetryQueue.get(task.id)
  const attempts = existing ? existing.attempts + 1 : 1
  if (existing) clearTimeout(existing.timer)
  if (attempts > TASK_PERSIST_MAX_ATTEMPTS) {
    taskPersistRetryQueue.delete(task.id)
    notifyTaskPersistFailedOnce()
    return
  }
  const timer = setTimeout(() => {
    taskPersistRetryQueue.delete(task.id)
    const latest = useStore.getState().tasks.find((item) => item.id === task.id)
    // 任务已不在 store：被删除或被清空，绝不能用陈旧快照写回（复活 bug）。
    if (!latest) return
    void putTask(latest)
  }, attempts * attempts * 1000)
  taskPersistRetryQueue.set(task.id, { attempts, timer })
}

function putTask(task: TaskRecord): Promise<IDBValidKey> {
  // 数据已被用户清除：丢弃飞行中写入，避免把已清除的任务重新写回 IndexedDB。
  if (tasksCleared) return Promise.resolve(task.id)
  const generation = task.storageGeneration ?? taskStorageGeneration
  return dbPutTask({ ...task, storageGeneration: generation }, generation)
    .catch((err: unknown) => {
      if (err instanceof StorageQuotaError) throw err // 配额已有专门的内存钉住处理
      scheduleTaskPersistRetry(task)
      return task.id
    })
}

async function refreshTaskStorageGeneration() {
  taskStorageGeneration = await getTaskGeneration()
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  const profile = getActiveApiProfile(settings)
  return `${profile.baseUrl}\n${profile.apiKey}`
}

function isRunningOpenAITask(task: TaskRecord) {
  return task.status === 'running' && (task.apiProvider ?? 'openai') !== 'fal'
}

function isAsyncCustomProviderTask(settings: AppSettings, provider: string, hasInputImages: boolean) {
  const customProvider = getCustomProviderDefinition(settings, provider)
  if (!customProvider?.poll) return false
  const submitMapping = hasInputImages && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  return Boolean(submitMapping.taskIdPath)
}

function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

/** 看门狗宽限：覆盖 lib 层的完整重试预算（1 次原始 + 2 次瞬态重试 + 1 次安全改写，
 * 每次窗口独立刷新）加退避间隔。lib 超时仍是权威，看门狗只兜底 fetch 挂死。 */
function getOpenAIWatchdogGraceSeconds(timeoutSeconds: number) {
  const retryWindows = 4 // 原始 + 2 重试 + 1 改写
  const backoffHeadroomSeconds = 30
  return timeoutSeconds * retryWindows + backoffHeadroomSeconds - timeoutSeconds
}

/** 单次恢复轮询的最长等待；超时后 abort，由恢复调度器决定重试。 */
const CUSTOM_RECOVERY_POLL_TIMEOUT_MS = 5 * 60 * 1000

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    ...createTaskErrorPatch(task, error, now),
    falRecoverable: false,
    elapsed: Math.max(0, now - task.createdAt),
  })
  return true
}

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null, startedAtMs?: number) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  // 锚点是请求开始（槽位取得后），不是任务创建——排队等待不应消耗看门狗预算。
  const startedAt = startedAtMs ?? Date.now()
  const timeoutMs = Math.max(0, timeoutSeconds * 1000)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds, profile))
    if (failed) useStore.getState().showToast('OpenAI 任务请求超时', 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

export function taskHasOutputErrors(task: Pick<TaskRecord, 'outputErrors'>) {
  return Boolean(task.outputErrors?.length)
}

export function taskMatchesFilterStatus(task: TaskRecord, filterStatus: AppState['filterStatus']) {
  if (filterStatus === 'all') return true
  if (filterStatus === 'error') return task.status === 'error' || taskHasOutputErrors(task)
  return task.status === filterStatus
}

export function taskMatchesSearchQuery(task: TaskRecord, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const prompt = (task.prompt || '').toLowerCase()
  const paramStr = JSON.stringify(task.params).toLowerCase()
  const errorStr = [task.error, ...(task.outputErrors ?? []).map((item) => item.error)].filter(Boolean).join('\n').toLowerCase()
  return prompt.includes(q) || paramStr.includes(q) || errorStr.includes(q)
}

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return
  const promptRewriteGuardMessage = settings.allowPromptRewrite
    ? '当前已允许模型改写优化提示词，因此不会额外加入不改写要求。'
    : '同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。'

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。${promptRewriteGuardMessage}`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function getFalRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === 'fal' && task.apiProvider === 'fal') return taskProfile
  return null
}

function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile && taskProfile.provider === task.apiProvider && taskProfile.provider !== 'openai' && taskProfile.provider !== 'fal') return taskProfile
  return null
}

export function getTaskApiProfile(settings: AppSettings, task: TaskRecord): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  if (!task.apiProfileId) return null
  return normalized.profiles.find((profile) => profile.id === task.apiProfileId) ?? null
}

function createSettingsForApiProfile(settings: AppSettings, profile: ApiProfile): AppSettings {
  const normalized = normalizeSettings(settings)
  return normalizeSettings({
    ...normalized,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    timeout: profile.timeout,
    apiMode: profile.apiMode,
    codexCli: profile.codexCli,
    apiProxy: profile.apiProxy,
    profiles: normalized.profiles.map((item) => item.id === profile.id ? profile : item),
    activeProfileId: profile.id,
  })
}

function getReusedTaskApiProfile(settings: AppSettings, profileId: string | null): ApiProfile | null {
  if (!profileId) return null
  return normalizeSettings(settings).profiles.find((profile) => profile.id === profileId) ?? null
}

function getTaskApiProfileName(task: TaskRecord) {
  return task.apiProfileName || task.apiModel || '未知配置'
}

function isNetworkRecoverableError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isApiRequestNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)
  }
  return false
}

function getApiModeApiName(apiMode: ApiMode) {
  return apiMode === 'responses' ? 'Responses API' : 'Image API'
}

function getApiRequestNetworkErrorHint(
  err: unknown,
  createdAt: number,
  usesApiProxy: boolean,
  profile?: Pick<ApiProfile, 'provider' | 'apiMode' | 'streamImages' | 'streamPartialImages'> | null,
): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const elapsedSeconds = Math.max(0, (Date.now() - createdAt) / 1000)

  if (elapsedSeconds <= 15) {
    if (usesApiProxy) {
      return '提示：请求立即失败，请检查 API 代理服务是否正常运行。'
    }
    const unsupportedApiHint = profile?.provider === 'openai'
      ? `\n· API 不支持 ${getApiModeApiName(profile.apiMode)}`
      : ''
    return `提示：请求立即失败，可能原因：\n· API 服务器不可达或地址有误，请检查 API URL 是否正确、服务是否正常运行${unsupportedApiHint}\n· 接口不支持浏览器跨域请求，可使用 Docker 部署版或本地运行版并配置 API 代理解决`
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return `提示：请求等待约 60 秒后被断开，这通常是 Nginx 等反向代理的默认超时，而非接口本身报错。可调大代理的超时时间（如 proxy_read_timeout），或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return `提示：请求等待约 120 秒后被断开，这通常是 Cloudflare 等 CDN/网关的超时限制，而非接口本身报错。如果使用 Cloudflare，可考虑升级套餐或使用不经过 CDN 的直连地址。${getTimeoutStreamingHint(profile)}`
  }

  if (usesApiProxy && elapsedSeconds >= 290 && elapsedSeconds <= 320) {
    return `提示：请求等待约 300 秒后被断开——这是 Vercel 函数的执行时长上限（Hobby 套餐 300 秒）。若前端部署在 Vercel 且走 /api-proxy 同源回退代理，超过 300 秒的 4K 请求必然被掐断：请改用 Cloudflare Worker 代理（image-proxy.taostudioai.com）、直连接口，或调低超时前完成。${getTimeoutStreamingHint(profile)}`
  }

  return `提示：请求等待较长时间后被断开，通常是反向代理或网关的超时限制，而非接口本身报错。可检查代理超时设置，或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
}

function isRefusalRecoveryRecord(value: unknown): value is RefusalRecoveryRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<RefusalRecoveryRecord>
  return (record.status === 'not_triggered' || record.status === 'recovered' || record.status === 'blocked') &&
    Boolean(record.attempt_1 && typeof record.attempt_1 === 'object') &&
    Boolean(record.rewrite && typeof record.rewrite === 'object') &&
    Boolean(record.attempt_2 && typeof record.attempt_2 === 'object')
}

function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload' | 'refusalRecovery'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  const refusalRecovery = 'refusalRecovery' in err ? (err as { refusalRecovery?: unknown }).refusalRecovery : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
    refusalRecovery: isRefusalRecoveryRecord(refusalRecovery) ? refusalRecovery : undefined,
  }
}

function clearFalRecoveryTimer(taskId: string) {
  const timer = falRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  falRecoveryTimers.delete(taskId)
}

function scheduleFalRecovery(taskId: string, delayMs = FAL_RECOVERY_POLL_MS) {
  if (falRecoveryTimers.has(taskId)) return
  if (!useStore.getState().tasks.some((task) => task.id === taskId)) return
  const timer = setTimeout(() => {
    falRecoveryTimers.delete(taskId)
    recoverFalTask(taskId)
  }, delayMs)
  falRecoveryTimers.set(taskId, timer)
}

function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  if (!useStore.getState().tasks.some((task) => task.id === taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

async function readImageSizeParam(dataUrl: string): Promise<Partial<TaskParams> | undefined> {
  if (typeof Image === 'undefined') return undefined

  return new Promise((resolve) => {
    let settled = false
    const image = new Image()
    const finish = (params: Partial<TaskParams> | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(params)
    }
    const timer = setTimeout(() => finish(undefined), 2000)
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
      } else {
        finish(undefined)
      }
    }
    image.onerror = () => finish(undefined)
    image.src = dataUrl
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
    }
  })
}

async function readImageSizeParamsList(images: string[]): Promise<Array<Partial<TaskParams> | undefined>> {
  return Promise.all(images.map((image) => readImageSizeParam(image)))
}

async function resolveImageSizeParamsList(
  images: string[],
  preferred?: Array<Partial<TaskParams> | undefined>,
  sizes?: Array<{ width?: number; height?: number } | undefined>,
): Promise<Array<Partial<TaskParams> | undefined>> {
  const withStoredSizes = images.map((_, index) => addImageSizeParam(preferred?.[index], sizes?.[index]))
  if (withStoredSizes.every(hasActualSizeParam)) {
    return withStoredSizes
  }
  const fallback = await readImageSizeParamsList(images)
  return images.map((_, index) => {
    const params = withStoredSizes[index]
    const fallbackParams = fallback[index]
    if (hasActualSizeParam(params)) return params
    if (fallbackParams?.size) return { ...(params ?? {}), size: fallbackParams.size }
    return hasActualParams(params) ? params : fallbackParams
  })
}

async function completeRecoveredFalTask(task: TaskRecord, result: Awaited<ReturnType<typeof getFalQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return
  if (latest.status !== 'running' && !latest.falRecoverable) return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds, exactSizeOriginalImageIds, exactSizeTransforms, persistFailedCount } = await storeTaskOutputImages(task, result.images, deleteUnreferencedImageIds)
  const resolvedActualParamsList = await resolveImageSizeParamsList(outputDataUrls, result.actualParamsList, outputImageSizes)
  const actualParamsList = resolvedActualParamsList.map((params, index) =>
    resolveFinalActualParams(params, outputImageSizes[index], task.params),
  )
  const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestBeforeUpdate || latestBeforeUpdate.status === 'done' || (latestBeforeUpdate.status !== 'running' && !latestBeforeUpdate.falRecoverable)) {
    await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? []), ...(exactSizeOriginalImageIds ?? [])])
    return
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    exactSizeOriginalImages: exactSizeOriginalImageIds,
    exactSizeTransforms,
    outputPersistWarning: persistFailedCount > 0 || undefined,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    ...createTaskDonePatch(task, Date.now()),
    falRecoverable: false,
  })
  if (persistFailedCount > 0) {
    useStore.getState().showToast(`fal.ai 任务已恢复，但存储空间不足，${persistFailedCount} 张图片仅保留在内存中，请立即导出。`, 'error')
  } else {
    useStore.getState().showToast(`fal.ai 任务已恢复，共 ${outputIds.length} 张图片`, 'success')
  }
  if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `fal.ai 任务已恢复，共 ${outputIds.length} 张图片。`)
}

async function recoverFalTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || task.apiProvider !== 'fal' || !task.falRequestId || !task.falEndpoint || task.status === 'done') return

  const profile = getFalRecoveryProfile(settings, task)
  if (!profile) {
    scheduleFalRecovery(taskId)
    return
  }

  try {
    const result = await getFalQueuedImageResult(profile, task.falEndpoint, task.falRequestId, task.params)
    clearFalRecoveryTimer(taskId)
    await completeRecoveredFalTask(task, result)
    return
  } catch (err) {
    if (!useStore.getState().tasks.some((item) => item.id === taskId)) return
    if (isNetworkRecoverableError(err)) {
      scheduleFalRecovery(taskId)
      return
    }

    clearFalRecoveryTimer(taskId)
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, getFalErrorMessage(err) ?? (err instanceof Error ? err.message : String(err)), Date.now()),
      ...getRawErrorPayload(err),
      falRecoverable: false,
    })
  }
}

/** 初始化：从 IndexedDB 加载任务，按需恢复输入图片，并清理孤立图片 */
/** 刷新后 gallerySceneFilter 不持久化：跟随 persist 恢复的 activeScene 同步一次，
 *  防止非 general 场景的新任务停在 general 过滤下不可见（setActiveScene 同场景兜底之外的第二道防线）。 */
function syncGallerySceneFilterToActiveScene() {
  const { gallerySceneFilter, settings } = useStore.getState()
  if (gallerySceneFilter !== settings.activeScene) {
    useStore.setState({ gallerySceneFilter: settings.activeScene })
  }
}

export async function initStore() {
  // 页面加载/刷新：重置数据清除标志，允许从（已清空后的）IndexedDB 正常加载，
  // 并允许后续生成正常写入。
  tasksCleared = false
  await refreshTaskStorageGeneration()
  const initTaskStorageGeneration = taskStorageGeneration
  // Agent 功能已移除（2026-09 设计决策）：一次性清空存量会话并释放其引用图；
  // 用户确认从未使用，预期为空。建表保留防老库升级报错。
  try {
    await dbClearAgentConversations()
  } catch { /* 老库无表等情况静默 */ }
  const storedTasks = await getAllTasks()
  const generationTasks = storedTasks.map((task) => ({ ...task, storageGeneration: taskStorageGeneration }))
  const { tasks: markedTasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(generationTasks, Date.now())
  const interruptedTaskIds = new Set(interruptedTasks.map((task) => task.id))
  const favoriteState = useStore.getState()
  const normalizedFavorites = normalizeLoadedFavoriteState(markedTasks, favoriteState.favoriteCollections, favoriteState.defaultFavoriteCollectionId)
  const tasks = normalizedFavorites.tasks
  if (normalizedFavorites.collections !== favoriteState.favoriteCollections) {
    favoriteState.setFavoriteCollections(normalizedFavorites.collections)
  }
  if (normalizedFavorites.defaultFavoriteCollectionId !== favoriteState.defaultFavoriteCollectionId) {
    useStore.getState().setDefaultFavoriteCollectionId(normalizedFavorites.defaultFavoriteCollectionId)
  }
  await Promise.all(tasks
    .filter((task, index) => normalizedFavorites.changed || interruptedTaskIds.has(task.id) || task.rawResponsePayload !== markedTasks[index]?.rawResponsePayload)
    .map((task) => putTask(task)))
  const latestTaskStorageGeneration = await getTaskGeneration()
  if (latestTaskStorageGeneration !== initTaskStorageGeneration) {
    taskStorageGeneration = latestTaskStorageGeneration
    tasksCleared = true
    useStore.setState({ tasks: [] })
    syncGallerySceneFilterToActiveScene()
    return
  }
  useStore.getState().setTasks(tasks)
  showSupportPromptForExistingLocalData(tasks)
  for (const task of tasks) {
    if (
      task.apiProvider === 'fal' &&
      task.falRequestId &&
      task.falEndpoint &&
      (task.status === 'running' || task.falRecoverable)
    ) {
      scheduleFalRecovery(task.id, 0)
    }
    if (
      task.customTaskId &&
      (task.status === 'running' || task.customRecoverable)
    ) {
      scheduleCustomRecovery(task.id, 0)
    }
  }

  // 收集所有任务引用的图片 id
  const referencedIds = new Set<string>()
  const state = useStore.getState()
  const persistedInputImages = state.inputImages
  const galleryInputDraft = state.galleryInputDraft
  for (const img of persistedInputImages) referencedIds.add(img.id)
  if (galleryInputDraft) {
    for (const img of galleryInputDraft.inputImages) referencedIds.add(img.id)
  }
  for (const t of tasks) {
    addTaskReferencedImageIds(referencedIds, t)
  }

  // 只枚举 key 清理孤立图片，避免启动时把所有 4K 原图读进内存。
  const imageIds = await getAllImageIds()
  const referencedImageIds: string[] = []
  // 新鲜度保护：另一标签页可能刚把生成图写盘、任务记录尚未落库——从本页看
  // 是"孤儿"但实际在途。10 分钟内创建的孤儿跳过，留给下次清扫处理。
  const ORPHAN_GRACE_MS = 10 * 60 * 1000
  let skippedFreshOrphans = 0
  for (const imgId of imageIds) {
    if (referencedIds.has(imgId)) {
      referencedImageIds.push(imgId)
      continue
    }
    let createdAt: number | undefined
    try {
      // 轻量读取：blob 记录不做 dataUrl 转换（清扫只需时间戳）
      createdAt = (await getImageMetadata(imgId))?.createdAt
    } catch {
      // 读失败时保守跳过：宁可多留一个孤儿也不冒删错的风险。
      skippedFreshOrphans += 1
      continue
    }
    if (createdAt !== undefined && Date.now() - createdAt < ORPHAN_GRACE_MS) {
      skippedFreshOrphans += 1
      continue
    }
    await deleteImage(imgId)
  }
  if (skippedFreshOrphans > 0) {
    console.info(`孤儿清扫跳过 ${skippedFreshOrphans} 张新鲜/不可读图片（将在下次启动时复查）`)
  }
  scheduleThumbnailBackfill(referencedImageIds)

  const restoredInputImages: InputImage[] = []
  for (const img of persistedInputImages) {
    if (img.dataUrl) {
      restoredInputImages.push(img)
      cacheImage(img.id, img.dataUrl)
      continue
    }
    const storedImage = await getImage(img.id)
    if (storedImage?.dataUrl) {
      restoredInputImages.push(restoreInputImageFromStoredImage(img, storedImage))
      cacheImage(img.id, storedImage.dataUrl)
    }
  }
  if (restoredInputImages.length !== persistedInputImages.length || restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)) {
    useStore.getState().setInputImages(restoredInputImages)
  }

  if (galleryInputDraft) {
    const restoredGalleryImages: InputImage[] = []
    for (const img of galleryInputDraft.inputImages) {
      if (img.dataUrl) {
        restoredGalleryImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
    }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredGalleryImages.push(restoreInputImageFromStoredImage(img, storedImage))
        cacheImage(img.id, storedImage.dataUrl)
      }
    }
    const restoredGalleryDraft: AgentInputDraft = {
      ...galleryInputDraft,
      ...updateInputDraftImages(galleryInputDraft, restoredGalleryImages),
    }
    const shouldClearMask = galleryInputDraft.maskDraft !== restoredGalleryDraft.maskDraft
    const galleryDraftsChanged =
      restoredGalleryImages.length !== galleryInputDraft.inputImages.length ||
      restoredGalleryImages.some((img, index) => img.dataUrl !== galleryInputDraft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    if (galleryDraftsChanged) {
      const latestState = useStore.getState()
      const nextGalleryInputDraft = isEmptyAgentInputDraft(restoredGalleryDraft) ? null : restoredGalleryDraft
      useStore.setState({
        galleryInputDraft: nextGalleryInputDraft,
        ...(latestState.appMode === 'gallery'
          ? restoreGalleryInputDraftState(nextGalleryInputDraft)
          : {}),
      })
    }
  }

  // 场景过滤跟随持久化恢复的 activeScene（F1：防刷新后过滤停在旧值导致当前场景任务不可见）
  syncGallerySceneFilterToActiveScene()
  // 启动后尝试恢复本地自动保存的会话级权限（若有目录已选且权限降级为 prompt）
  void restoreLocalAutoSavePermissionOnUserActivation()
  // 存量 base64 图片后台迁移为 Blob（省 ~25-33% 空间）：让步式、幂等、
  // 不阻塞启动；迁移期间的新写入本就是 Blob 格式。
  void migrateImagesToBlobs()
    .then(({ migrated }) => {
      if (migrated > 0) console.info(`图片存储迁移完成：${migrated} 张已转为 Blob`)
    })
    .catch((error) => {
      console.warn('图片存储迁移未完成（下次启动会继续）', error)
    })
}

/** 提交新任务 */
export async function submitTask(options: { allowFullMask?: boolean; useCurrentApiProfileWhenReusedMissing?: boolean; skillMeta?: { skillId: string; skillInput: string } } = {}) {
  // 用户发起新生成：重置数据清除标志，确保新任务能正常写入。
  tasksCleared = false
  await refreshTaskStorageGeneration()
  const { settings, prompt, inputImages, maskDraft, params, reusedTaskApiProfileId, reusedTaskApiProfileName, reusedTaskApiProfileMissing, showToast, setConfirmDialog } =
    useStore.getState()

  const normalizedSettings = normalizeSettings(settings)
  let activeProfile = getSceneImageApiProfile(settings)
  let requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  if (normalizedSettings.reuseTaskApiProfileTemporarily && (reusedTaskApiProfileId || reusedTaskApiProfileMissing)) {
    const reusedProfile = getReusedTaskApiProfile(normalizedSettings, reusedTaskApiProfileId)
    if (!reusedProfile) {
      if (options.useCurrentApiProfileWhenReusedMissing) {
        useStore.getState().setReusedTaskApiProfile(null)
      } else {
        setConfirmDialog({
          title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${reusedTaskApiProfileName || '未知配置'}」，要使用当前的 API 配置「${activeProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ ...options, useCurrentApiProfileWhenReusedMissing: true })
      },
        })
        return
      }
    } else {
      activeProfile = reusedProfile
      requestSettings = createSettingsForApiProfile(normalizedSettings, reusedProfile)
    }
  }

  if (validateApiProfile(activeProfile)) {
    showToast(`请先完善请求 API 配置：${validateApiProfile(activeProfile)}`, 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  for (const img of orderedInputImages) {
    await storeImage(img.dataUrl)
  }

  const normalizedParams = normalizeParamsForSettings(params, requestSettings, {
    hasInputImages: orderedInputImages.length > 0,
    preserveExactSizeIntent: true,
  })
  const shouldUseTransparentOutput = (normalizedParams.output_format === 'png' || normalizedParams.output_format === 'webp') && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output && activeProfile.transparentBackgroundMethod === 'local'
    ? createTransparentOutputMeta(prompt.trim())
    : null
  const normalizedParamPatch = getChangedParams(params, taskParams)
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  // 记录提示词历史（画廊模式的一键回填来源）。
  // 剥离图片提及标记：历史回填后 @图N 若按索引绑定到当前不相关的图，
  // 会对错误的图发起计费编辑请求；纯文本化最安全。
  useStore.getState().recordPromptHistory(stripImageMentionMarkers(prompt), taskParams)

  const taskId = genId()
  const task: TaskRecord = {
    id: taskId,
    storageGeneration: taskStorageGeneration,
    prompt: prompt.trim(),
    params: taskParams,
    targetAspectPromptHint: createTargetAspectPromptHint(taskParams.size) ?? undefined,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiMode: activeProfile.apiMode,
    apiModel: activeProfile.model,
    inputImageIds: orderedInputImages.map((i) => i.id),
    maskTargetImageId,
    maskImageId,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    status: 'running',
    error: null,
    sceneId: settings.activeScene,
    // Skill 工坊溯源（generateFromSkillEntries 逐条目提交时携带）
    ...(options.skillMeta ? { skillId: options.skillMeta.skillId, skillInput: options.skillMeta.skillInput } : {}),
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([task, ...latestTasks])
  await putTask(task)
  useStore.getState().showToast('任务已提交', 'success')

  if (settings.clearInputAfterSubmit) {
    useStore.getState().setPrompt('')
    useStore.getState().clearInputImages()
  }
  useStore.getState().setReusedTaskApiProfile(null)

  // 异步调用 API
  executeTask(taskId)
}

function addInputDraftReferencedImageIds(target: Set<string>, draft: AgentInputDraft | null) {
  if (!draft) return
  for (const img of draft.inputImages) target.add(img.id)
}

function addTaskReferencedImageIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.inputImageIds || []) target.add(id)
  if (task.maskImageId) target.add(task.maskImageId)
  for (const id of task.outputImages || []) target.add(id)
  for (const id of task.transparentOriginalImages || []) {
    if (id) target.add(id)
  }
  for (const id of task.exactSizeOriginalImages || []) {
    if (id) target.add(id)
  }
  for (const id of task.streamPartialImageIds || []) target.add(id)
}

async function deleteUnreferencedImageIds(imageIds: Iterable<string>) {
  const candidates = Array.from(new Set(Array.from(imageIds).filter(Boolean)))
  if (candidates.length === 0) return

  const { tasks, inputImages, galleryInputDraft } = useStore.getState()
  const stillUsed = new Set<string>()
  for (const task of tasks) addTaskReferencedImageIds(stillUsed, task)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) stillUsed.add(img.id)

  for (const imgId of candidates) {
    if (stillUsed.has(imgId)) continue
    await deleteStoredImageIfUnreferenced(imgId)
  }
}

async function persistTaskStreamPartialImage(taskId: string, dataUrl: string) {
  try {
    const imgId = await storeImage(dataUrl, 'generated')
    cacheImage(imgId, dataUrl)

    const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
    if (!latestTask || latestTask.status === 'done') {
      await deleteUnreferencedImageIds([imgId])
      return
    }

    const currentIds = latestTask.streamPartialImageIds || []
    if (currentIds.includes(imgId)) return
    updateTaskInStore(taskId, { streamPartialImageIds: [...currentIds, imgId] })
  } catch (err) {
    console.error(err)
  }
}

async function executeTask(taskId: string) {
  // 并发槽在拿到任务快照之前不入队：找不到任务/配置的任务不应占用槽位。
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile && task.apiProfileId) {
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, '找不到此任务所使用的 API 配置。', Date.now()),
      falRecoverable: false,
      customRecoverable: false,
    })
    return
  }
  await withGenerationSlot((releaseSlot) => executeTaskWithSlot(taskId, releaseSlot))
}

async function executeTaskWithSlot(taskId: string, releaseSlot?: () => void) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile && task.apiProfileId) {
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, '找不到此任务所使用的 API 配置。', Date.now()),
      falRecoverable: false,
      customRecoverable: false,
    })
    return
  }
  const activeProfile = taskProfile ?? getSceneImageApiProfile(settings)
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const taskProvider = taskProfile?.provider ?? task.apiProvider ?? activeProfile.provider
  let falRequestInfo: { requestId: string; endpoint: string } | null = task.falRequestId && task.falEndpoint
        ? { requestId: task.falRequestId, endpoint: task.falEndpoint }
    : null
  let customTaskInfo: { taskId: string } | null = task.customTaskId
    ? { taskId: task.customTaskId }
    : null

  // 锚点统一：错误提示与看门狗都用「槽位取得时刻」（请求开始），不含并发
  // 队列等待——否则排队 240s + 60s 失败会被错归因为 300s Vercel 上限。
  const requestStartedAt = Date.now()
  if (
    taskProvider !== 'fal' &&
    !isAsyncCustomProviderTask(requestSettings, taskProvider, task.inputImageIds.length > 0)
  ) {
    // 看门狗是兜底护栏而非第二只超时表：lib 层请求超时（含瞬态重试、每次
    // 重试刷新窗口）是权威；看门狗按「请求开始」计时，且宽限覆盖整个重试
    // 预算，避免 lib 还在重试时提前判死、丢弃晚到的成功结果（白烧额度）。
    scheduleOpenAIWatchdog(
      taskId,
      activeProfile.timeout + getOpenAIWatchdogGraceSeconds(activeProfile.timeout),
      activeProfile,
      requestStartedAt,
    )
  }

  try {
    // 获取输入图片 data URLs
    const inputDataUrls: string[] = []
    for (const imgId of task.inputImageIds) {
      const dataUrl = await ensureImageCached(imgId)
      if (!dataUrl) throw new Error('输入图片已不存在')
      inputDataUrls.push(dataUrl)
    }
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    // 原生透明：background 参数照发（官方后端按参数出 alpha）；部分后端不读
    // 该参数但遵循提示词意图，因此叠加透明指令，两类后端都能直出真透明。
    const nativeTransparentRequested = Boolean(task.params.transparent_output) && !task.transparentOutput
    const baseRequestPrompt = task.transparentOutput && task.transparentPrompt
      ? task.transparentPrompt
      : task.prompt
    const requestPrompt = nativeTransparentRequested
      ? buildNativeTransparentPrompt(baseRequestPrompt)
      : baseRequestPrompt
    const promptSentToApi = appendTargetAspectPromptHint(
      replaceImageMentionsForApi(requestPrompt, inputDataUrls.length),
      task.params.size,
    )
    const providerParams = normalizeParamsForSettings(task.params, requestSettings, {
      hasInputImages: inputDataUrls.length > 0,
      // 4K 资产请求侧收口：网关原生能力 ~1.5MP（2026-08-14 探针实测），
      // 请求更大尺寸买不到像素；本地放大仍按 task.params.size 到 4K。
      capRequestSize: taskProvider !== 'fal' && !isAsyncCustomProviderTask(requestSettings, taskProvider, task.inputImageIds.length > 0),
    })

    const result = await callImageApi({
      settings: requestSettings,
      prompt: promptSentToApi,
      params: providerParams,
      nativeTransparentBackground: nativeTransparentRequested,
      inputImageDataUrls: inputDataUrls,
      maskDataUrl,
      skipCodexCliSizePrompt: task.sourceMode === 'agent',
      onFalRequestEnqueued: (request) => {
        falRequestInfo = request
        updateTaskInStore(taskId, {
          falRequestId: request.requestId,
          falEndpoint: request.endpoint,
          falRecoverable: false,
        })
        // 已转入 provider 侧队列等待（恢复定时器接管）：释放浏览器连接槽位。
        releaseSlot?.()
      },
      onCustomTaskEnqueued: (request) => {
        customTaskInfo = request
        updateTaskInStore(taskId, {
          customTaskId: request.taskId,
          customRecoverable: false,
        })
        releaseSlot?.()
      },
      onPartialImage: (partial) => {
        useStore.getState().setTaskStreamPreview(taskId, partial.image, partial.requestIndex)
        void persistTaskStreamPartialImage(taskId, partial.image)
      },
    })

    const latestBeforeSuccess = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeSuccess || latestBeforeSuccess.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }

    // 存储输出图片
    const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds, exactSizeOriginalImageIds, exactSizeTransforms, persistFailedCount } = await storeTaskOutputImages(task, result.images, deleteUnreferencedImageIds)
    const isAsyncCustomTask = taskProvider !== 'fal' && taskProvider !== 'openai' && Boolean(customTaskInfo)
    const resolvedActualParamsList = await resolveImageSizeParamsList(
      outputDataUrls,
      isAsyncCustomTask ? undefined : result.actualParamsList,
      outputImageSizes,
    )
    const actualParamsList = resolvedActualParamsList.map((params, index) =>
      resolveFinalActualParams(params, outputImageSizes[index], task.params),
    )
    const actualParams = deriveFinalGalleryActualParams(
      taskProvider,
      isAsyncCustomTask,
      result.actualParams,
      actualParamsList,
      outputIds.length,
      task.params,
    )
    const shouldStoreRevisedPrompts = taskProvider !== 'fal' && !isAsyncCustomTask
    const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
    const revisedPrompts = activeProfile.codexCli && task.sourceMode !== 'agent'
      ? result.revisedPrompts?.map((prompt) => prompt == null ? prompt : stripInjectedCodexCliSizePrompt(prompt, requestPrompt, providerParams.size))
      : result.revisedPrompts
    const revisedPromptByImage = shouldStoreRevisedPrompts ? mapRevisedPromptsByImage(outputIds, revisedPrompts) : undefined
    const promptWasRevised = shouldStoreRevisedPrompts && revisedPrompts?.some(
      (revisedPrompt) => revisedPrompt?.trim() && revisedPrompt.trim() !== promptSentToApi.trim(),
    )
    const hasRevisedPromptValue = shouldStoreRevisedPrompts && revisedPrompts?.some((revisedPrompt) => revisedPrompt?.trim())
    if (taskProvider === 'openai' && activeProfile.apiMode === 'responses' && !activeProfile.codexCli && !result.refusalRecovery) {
      if (promptWasRevised) {
        showCodexCliPrompt()
      } else if (!hasRevisedPromptValue) {
        showCodexCliPrompt(false, '接口没有返回官方 API 会返回的部分信息')
      }
    }

    // 更新任务
    const latestBeforeUpdate = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestBeforeUpdate || latestBeforeUpdate.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      await deleteUnreferencedImageIds([
        ...outputIds,
        ...(transparentOriginalImageIds ?? []),
        ...(exactSizeOriginalImageIds ?? []),
      ])
      return
    }
    const partialImageIdsToClean = latestBeforeUpdate.streamPartialImageIds || []
    clearOpenAIWatchdogTimer(taskId)
    useStore.getState().setTaskStreamPreview(taskId)
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      transparentOriginalImages: transparentOriginalImageIds,
      exactSizeOriginalImages: exactSizeOriginalImageIds,
      exactSizeTransforms,
      outputErrors: result.failedRequests?.length ? result.failedRequests : undefined,
      outputPersistWarning: persistFailedCount > 0 || undefined,
      streamPartialImageIds: undefined,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      actualParams,
      actualParamsByImage,
      revisedPromptByImage,
      refusalRecovery: result.refusalRecovery,
      ...createTaskDonePatch(task, Date.now()),
      falRecoverable: false,
      customRecoverable: false,
    })
    if (!isAgentTask(task) && useStore.getState().settings.localAutoSave.enabled) {
      void runLocalAutoSaveForTask(taskId)
    }
    void deleteUnreferencedImageIds(partialImageIdsToClean)

    const failedCount = result.failedRequests?.length ?? 0
    const completionMessage = persistFailedCount > 0
      ? `生成完成，但浏览器存储空间不足，${persistFailedCount} 张图片仅保留在内存中，刷新后会丢失——请立即导出或清理空间。`
      : failedCount > 0
        ? `生成完成：成功 ${outputIds.length} 张，失败 ${failedCount} 张`
        : `生成完成，共 ${outputIds.length} 张图片`
    useStore.getState().showToast(completionMessage, persistFailedCount > 0 || failedCount > 0 ? 'error' : 'success')
    if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `${completionMessage}。`)
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    clearOpenAIWatchdogTimer(taskId)
    const latestTask = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestTask || latestTask.status !== 'running') return
    useStore.getState().setTaskStreamPreview(taskId)
    const latestFalRequestInfo = falRequestInfo ?? (latestTask.falRequestId && latestTask.falEndpoint
      ? { requestId: latestTask.falRequestId, endpoint: latestTask.falEndpoint }
      : null)
    const latestCustomTaskInfo = customTaskInfo ?? (latestTask.customTaskId ? { taskId: latestTask.customTaskId } : null)
    if (latestTask.apiProvider === 'fal' && latestFalRequestInfo && isNetworkRecoverableError(err)) {
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, '与 fal.ai 的连接已断开，之后会继续查询任务结果。', Date.now()),
        falRequestId: latestFalRequestInfo.requestId,
        falEndpoint: latestFalRequestInfo.endpoint,
        falRecoverable: true,
      })
      scheduleFalRecovery(taskId)
    } else if (latestCustomTaskInfo && isNetworkRecoverableError(err)) {
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, '与自定义异步任务的连接已断开，之后会继续查询任务结果。', Date.now()),
        customTaskId: latestCustomTaskInfo.taskId,
        customRecoverable: true,
      })
      scheduleCustomRecovery(taskId)
    } else {
      // lib 层超时（AbortError）原样抛出时消息是浏览器 jargon；翻译成
      // 与看门狗一致的用户文案。
      const isTimeoutAbort = typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError'
      let errorMessage = isTimeoutAbort
        ? createOpenAITimeoutError(activeProfileTimeoutSeconds(taskId, latestTask), getTimeoutHintProfileFor(latestTask))
        : err instanceof Error ? err.message : String(err)
      const settings = useStore.getState().settings
      const profile = getTaskApiProfile(settings, latestTask)
      const usesApiProxy = profile?.apiProxy ?? settings.apiProxy
      const activeProfile = getActiveApiProfile(settings)
      const hintProfile = profile ?? {
        provider: latestTask.apiProvider ?? activeProfile.provider,
        apiMode: settings.apiMode,
        streamImages: activeProfile.streamImages,
        streamPartialImages: activeProfile.streamPartialImages,
      }
      const networkErrorHint = getApiRequestNetworkErrorHint(err, requestStartedAt, usesApiProxy, hintProfile)
      if (networkErrorHint && !errorMessage.includes(IMAGE_FETCH_CORS_HINT)) {
        errorMessage += `\n${networkErrorHint}`
      }
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, errorMessage, Date.now()),
        ...getRawErrorPayload(err),
        falRecoverable: false,
        customRecoverable: false,
      })
      useStore.getState().setDetailTaskId(taskId)
    }
  } finally {
    // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
    for (const imgId of task.inputImageIds) {
      deleteCachedImage(imgId)
    }
  }
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  // 数据已被用户清除：飞行中的生成回调（recovery timer 等）不应把任务写回。
  if (tasksCleared && !useStore.getState().tasks.some((t) => t.id === taskId)) return
  const { tasks, setTasks, defaultFavoriteCollectionId } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...normalizeFavoritePatch(t, patch, defaultFavoriteCollectionId) } : t,
  )
  const task = updated.find((t) => t.id === taskId)
  setTasks(updated)
  maybeOpenSupportPrompt(tasks, updated, taskId)
  if (task) putTask(task)
}

async function updateTaskLocalAutoSave(taskId: string, localAutoSave: TaskRecord['localAutoSave']) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((task) => task.id === taskId ? { ...task, localAutoSave } : task)
  const task = updated.find((item) => item.id === taskId)
  setTasks(updated)
  if (task) await putTask(task)
}

function isLocalAutoSaveRetryable(task: TaskRecord) {
  return task.localAutoSave?.status === 'pending' ||
    task.localAutoSave?.status === 'saving' ||
    task.localAutoSave?.status === 'failed' ||
    task.localAutoSave?.status === 'needs_permission'
}

export function getLocalAutoSaveRetryableTaskCount(tasks: TaskRecord[]) {
  return tasks.filter(isLocalAutoSaveRetryable).length
}

function normalizeImportedTaskLocalAutoSave(task: TaskRecord): TaskRecord {
  if (!task.localAutoSave) return task
  return {
    ...task,
    localAutoSave: {
      status: 'pending',
      error: '导入的数据不包含本地归档文件，请重新补保存',
    },
  }
}

export async function selectLocalAutoSaveDirectory() {
  if (typeof window === 'undefined' || !isLocalAutoSaveSupported(window)) {
    useStore.getState().showToast('本地自动保存仅支持桌面 Chrome/Edge', 'error')
    return
  }

  try {
    const handle = await (window as unknown as {
      showDirectoryPicker: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>
    }).showDirectoryPicker({ mode: 'readwrite' })
    await putLocalAutoSaveDirectoryHandle(handle)
    void (navigator.storage?.persist?.() ?? Promise.resolve(false)).catch(() => false)
    useStore.getState().setSettings({
      localAutoSave: {
        ...useStore.getState().settings.localAutoSave,
        enabled: true,
        directoryName: handle.name,
      },
    })
    useStore.getState().showToast('本地自动保存位置已设置', 'success')
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    useStore.getState().showToast(`设置本地自动保存位置失败：${message}`, 'error')
  }
}

// ===== 场景配置与场景保存目录 =====

/** 只 patch 单个场景的设置字段，不影响其他场景；不做归一化迁移（显式 false 等运行期语义需原样保留） */
function patchSceneSettings(sceneId: SceneId, patch: Partial<SceneSettings>) {
  const state = useStore.getState()
  const scene = state.settings.scenes[sceneId]
  useStore.setState({
    settings: {
      ...state.settings,
      scenes: {
        ...state.settings.scenes,
        [sceneId]: { ...scene, ...patch },
      },
    },
  })
}

/** 切换场景时应用场景默认参数：只覆盖场景显式给出的维度，其余参数保持用户当前值 */
function applySceneDefaults(sceneId: SceneId) {
  const { settings, params } = useStore.getState()
  const defaults = settings.scenes[sceneId].defaults
  const patch: Partial<TaskParams> = {}
  if (defaults.ratio || defaults.tier) {
    // calculateImageSize 对无法解析的比例返回 null（如 '1:1' 缺省回落始终有效，此保护针对异常自定义值）
    const size = calculateImageSize(defaults.tier ?? '1K', defaults.ratio ?? '1:1')
    if (size) patch.size = size
  }
  if (defaults.transparentBackground === true && params.output_format === 'png') patch.transparent_output = true
  if (defaults.transparentBackground === false) patch.transparent_output = false
  if (Object.keys(patch).length) useStore.getState().setParams(patch)
}

export async function selectSceneSaveDirectory(sceneId: SceneId) {
  if (typeof window === 'undefined' || !isLocalAutoSaveSupported(window)) {
    useStore.getState().showToast('本地自动保存仅支持桌面 Chrome/Edge', 'error')
    return
  }

  try {
    const handle = await (window as unknown as {
      showDirectoryPicker: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>
    }).showDirectoryPicker({ mode: 'readwrite' })
    await putSceneDirectoryHandle(sceneId, handle)
    void (navigator.storage?.persist?.() ?? Promise.resolve(false)).catch(() => false)
    patchSceneSettings(sceneId, { saveDirectoryName: handle.name })
    useStore.getState().showToast('场景保存位置已设置', 'success')
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    useStore.getState().showToast(`设置场景保存位置失败：${message}`, 'error')
  }
}

export async function clearSceneSaveDirectory(sceneId: SceneId) {
  await clearSceneDirectoryHandle(sceneId)
  patchSceneSettings(sceneId, { saveDirectoryName: null })
}

// ===== Skill 工坊本地目录 =====
// 权限处理放在 store 侧（而非扫描函数内）：requestPermission 需要用户手势且
// 结果要以 toast 反馈；scanLocalSkills 保持纯扫描便于单测。

type PermissionCapableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
}

async function ensureSkillsRootPermission(handle: PermissionCapableDirectoryHandle): Promise<boolean> {
  const descriptor = { mode: 'readwrite' as const }
  const queried = await handle.queryPermission?.(descriptor)
  if (queried === 'granted') return true
  const permission = await handle.requestPermission?.(descriptor)
  return permission === 'granted'
}

export async function importSkillsRootDirectory() {
  if (typeof window === 'undefined' || !isLocalAutoSaveSupported(window)) {
    useStore.getState().showToast('本地自动保存仅支持桌面 Chrome/Edge', 'error')
    return
  }

  try {
    const handle = await (window as unknown as {
      showDirectoryPicker: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>
    }).showDirectoryPicker({ mode: 'readwrite' })
    await putSkillsRootDirectoryHandle(handle)
    useStore.setState((state) => ({ skills: { ...state.skills, scanning: true } }))
    const local = await scanLocalSkills(handle)
    useStore.setState((state) => ({
      skills: { ...state.skills, local, localRootName: handle.name, scanning: false },
    }))
    useStore.getState().showToast(
      local.length ? `已导入 ${local.length} 个本地 skill` : '该目录下没有可用的本地 skill',
      'success',
    )
  } catch (err) {
    useStore.setState((state) => ({ skills: { ...state.skills, scanning: false } }))
    if (err instanceof DOMException && err.name === 'AbortError') return
    const message = err instanceof Error ? err.message : String(err)
    useStore.getState().showToast(`导入本地 skills 目录失败：${message}`, 'error')
  }
}

export async function refreshLocalSkills() {
  const record = await getSkillsRootDirectoryHandle()
  const handle = record?.handle as PermissionCapableDirectoryHandle | undefined
  if (!handle) {
    useStore.getState().showToast('尚未导入本地 skills 目录，请先选择文件夹', 'error')
    return
  }
  useStore.setState((state) => ({ skills: { ...state.skills, scanning: true } }))
  try {
    if (!(await ensureSkillsRootPermission(handle))) {
      useStore.setState((state) => ({ skills: { ...state.skills, scanning: false } }))
      useStore.getState().showToast('未获得文件夹访问权限，请允许后重新扫描', 'error')
      return
    }
    const local = await scanLocalSkills(handle)
    useStore.setState((state) => ({
      skills: { ...state.skills, local, localRootName: handle.name, scanning: false },
    }))
  } catch (err) {
    useStore.setState((state) => ({ skills: { ...state.skills, scanning: false } }))
    const message = err instanceof Error ? err.message : String(err)
    useStore.getState().showToast(`扫描本地 skills 失败：${message}`, 'error')
  }
}

export async function clearSkillsRootDirectory() {
  await clearSkillsRootDirectoryHandle()
  useStore.setState((state) => ({
    skills: { ...state.skills, local: [], localRootName: null },
  }))
}

export async function authorizeLocalAutoSaveDirectory() {
  try {
    const handle = await getSelectedLocalAutoSaveDirectoryHandle() as PermissionCapableDirectoryHandle | null
    if (!handle) {
      useStore.getState().showToast('未找到已保存的位置，请重新选择文件夹', 'error')
      return false
    }

    const descriptor = { mode: 'readwrite' as const }
    const queried = await handle.queryPermission?.(descriptor)
    const permission = queried === 'granted'
      ? queried
      : await handle.requestPermission?.(descriptor)
    if (permission !== 'granted') {
      useStore.getState().showToast('未获得文件夹写入权限，请允许后重试', 'error')
      return false
    }

    useStore.getState().showToast('原保存位置已重新授权', 'success')
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    useStore.getState().showToast(`重新授权保存位置失败：${message}`, 'error')
    return false
  }
}

/**
 * 设置页「重新授权并补保存」的前置门（逐句柄授权）：全局目录句柄 + 全部场景目录句柄
 * 在同一次用户手势内逐把 requestPermission（readwrite），任一 granted 即返回 true 并补跑
 * pending 归档——无全局目录、只有场景目录时不再被单句柄版本堵死（F2）。
 * 单把失败（如用户手势耗尽）只跳过该把，不影响其余句柄的授权结果。
 */
export async function authorizeAllLocalAutoSaveDirectories() {
  try {
    const targets: PermissionCapableDirectoryHandle[] = []
    const globalHandle = await getSelectedLocalAutoSaveDirectoryHandle() as PermissionCapableDirectoryHandle | null
    if (globalHandle) targets.push(globalHandle)
    for (const record of await listSceneDirectoryHandles()) {
      const handle = record?.handle as PermissionCapableDirectoryHandle | undefined
      if (handle) targets.push(handle)
    }
    if (!targets.length) {
      useStore.getState().showToast('未找到已保存的位置，请重新选择文件夹', 'error')
      return false
    }

    const descriptor = { mode: 'readwrite' as const }
    let granted = false
    for (const handle of targets) {
      try {
        const queried = await handle.queryPermission?.(descriptor)
        const permission = queried === 'granted' ? queried : await handle.requestPermission?.(descriptor)
        if (permission === 'granted') granted = true
      } catch { /* 单把失败不阻断其余句柄 */ }
    }
    if (!granted) {
      useStore.getState().showToast('未获得文件夹写入权限，请允许后重试', 'error')
      return false
    }

    useStore.getState().showToast('保存位置已重新授权', 'success')
    await retryPendingLocalAutoSaves()
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    useStore.getState().showToast(`重新授权保存位置失败：${message}`, 'error')
    return false
  }
}

// 防止 React StrictMode 双调用或多次 initStore 重复挂监听器。
// 标志挂在 window 上而非模块级变量，便于测试在 beforeEach 中重置。
const RESTORE_FLAG_KEY = '__taostudioLocalAutoSaveRestoreAttached'

type PermissionCapableHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>
}

function attachOneShotPermissionRequestor(handle: PermissionCapableHandle, directoryName: string) {
  const w = window as unknown as Record<string, unknown>
  if (w[RESTORE_FLAG_KEY]) return
  w[RESTORE_FLAG_KEY] = true

  const tryOnce = async () => {
    window.removeEventListener('pointerdown', tryOnce)
    window.removeEventListener('keydown', tryOnce)
    try {
      const permission = await handle.requestPermission?.({ mode: 'readwrite' })
      if (permission === 'granted') {
        useStore.getState().showToast(`已恢复自动保存到「${directoryName}」`, 'success')
        await retryPendingLocalAutoSaves()
      }
      // 非 granted（用户拒绝或关闭弹条）→ 静默，留给设置页手动处理
    } catch {
      // requestPermission 抛错（如非 user activation 上下文）→ 静默
    } finally {
      w[RESTORE_FLAG_KEY] = false
    }
  }
  window.addEventListener('pointerdown', tryOnce, { once: true })
  window.addEventListener('keydown', tryOnce, { once: true })
}

/**
 * 应用启动后调用一次：检查本地自动保存的目录权限（全局目录 + 各场景目录），若已降级为 prompt，
 * 则挂一次性 user-activation 监听器，用户下次点击页面时自动 requestPermission。
 * handle 仍在 IndexedDB 中（不随会话失效），只是权限状态会降级，因此无需重选文件夹。
 */
export async function restoreLocalAutoSavePermissionOnUserActivation() {
  try {
    const { localAutoSave } = useStore.getState().settings
    if (!localAutoSave.enabled) return

    // 单把句柄的恢复路径：granted 顺手补一次 pending；prompt 挂一次性监听器；
    // denied：用户曾显式拒绝，不打扰，留给设置页处理
    const restoreHandle = async (handle: PermissionCapableHandle, directoryName: string) => {
      const descriptor = { mode: 'readwrite' as const }
      const permission = await handle.queryPermission?.(descriptor)
      if (permission === 'granted') {
        // 会话内仍有效，顺手补一次 pending（若有）
        await retryPendingLocalAutoSaves()
        return
      }
      // denied / prompt / undefined
      if (permission === 'prompt') {
        attachOneShotPermissionRequestor(handle, directoryName)
      }
    }

    const directoryName = localAutoSave.directoryName?.trim()
    if (directoryName) {
      const stored = await getLocalAutoSaveDirectoryHandle()
      const handle = stored?.handle as PermissionCapableHandle | undefined
      if (handle) await restoreHandle(handle, directoryName)
    }

    // 场景目录句柄逐把走同一恢复路径（只恢复授权，不弹选择器）
    const sceneStored = await listSceneDirectoryHandles()
    for (const record of sceneStored) {
      const handle = record?.handle as PermissionCapableHandle | undefined
      if (!handle) continue
      await restoreHandle(handle, record.name ?? handle.name)
    }
  } catch {
    // 全流程静默，绝不打断用户
  }
}

export async function retryPendingLocalAutoSaves() {
  const retryable = useStore.getState().tasks.filter(isLocalAutoSaveRetryable)
  for (const task of retryable) {
    await runLocalAutoSaveForTask(task.id)
  }
}

/** 句柄存储记录与设置目录名的一致性校验（从 getSelectedLocalAutoSaveDirectoryHandle 提取复用）：
 *  目录被重命名/移动后记录即失效——通过则返回句柄；不通过时清除失效句柄并返回 null。 */
async function authorizeStoredDirectoryHandle(options: {
  stored: StoredLocalAutoSaveDirectoryHandle | undefined
  selectedName: string | null | undefined
  clearStored: () => Promise<unknown>
}): Promise<FileSystemDirectoryHandle | null> {
  const storedName = options.stored?.name ?? options.stored?.handle.name
  if (options.stored?.handle && storedName && options.selectedName?.trim() === storedName) {
    return options.stored.handle
  }
  if (options.stored?.handle) await options.clearStored()
  return null
}

async function getSelectedLocalAutoSaveDirectoryHandle() {
  const selectedName = useStore.getState().settings.localAutoSave.directoryName?.trim()
  if (!selectedName) {
    await clearLocalAutoSaveDirectoryHandle()
    return null
  }

  const directory = await getLocalAutoSaveDirectoryHandle()
  const handle = await authorizeStoredDirectoryHandle({
    stored: directory,
    selectedName,
    clearStored: () => clearLocalAutoSaveDirectoryHandle(),
  })
  if (handle) return handle

  const settings = useStore.getState().settings.localAutoSave
  if (settings.directoryName !== null) {
    useStore.getState().setSettings({
      localAutoSave: {
        ...settings,
        directoryName: null,
      },
    })
  }
  return null
}

/** 任务落盘目录解析：场景任务优先用场景目录句柄（名称不一致时清除场景句柄与记录后回落），否则走全局目录 */
async function resolveTaskSaveDirectoryHandle(task: TaskRecord): Promise<FileSystemDirectoryHandle | null> {
  const sceneId = task.sceneId
  if (sceneId) {
    const stored = await getSceneDirectoryHandle(sceneId)
    const sceneSettings = useStore.getState().settings.scenes[sceneId]
    const handle = await authorizeStoredDirectoryHandle({
      stored,
      selectedName: sceneSettings?.saveDirectoryName,
      clearStored: () => clearSceneDirectoryHandle(sceneId),
    })
    if (handle) return handle
    if (sceneSettings?.saveDirectoryName) {
      patchSceneSettings(sceneId, { saveDirectoryName: null })
    }
  }
  return getSelectedLocalAutoSaveDirectoryHandle()
}

export async function runLocalAutoSaveForTask(taskId: string) {
  const state = useStore.getState()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) return
  if (!state.settings.localAutoSave.enabled) return
  if (state.localAutoSaveRunningTaskIds[taskId]) return
  if (task.localAutoSave?.status === 'saved') return

  useStore.setState((current) => ({
    localAutoSaveRunningTaskIds: {
      ...current.localAutoSaveRunningTaskIds,
      [taskId]: true,
    },
  }))

  try {
    const storedImages: StoredImage[] = []
    for (const imageId of task.outputImages) {
      const image = await getImage(imageId)
      if (image) storedImages.push(image)
    }

    const eligibility = getLocalAutoSaveEligibility(task, storedImages)
    if (!eligibility.eligible) {
      await updateTaskLocalAutoSave(taskId, {
        status: eligibility.status,
        error: eligibility.reason === 'missing_image' ? '图片数据已不存在' : eligibility.reason,
      })
      return
    }

    const directoryHandle = await resolveTaskSaveDirectoryHandle(task)
    if (!directoryHandle) {
      await updateTaskLocalAutoSave(taskId, {
        status: 'pending',
        error: '未选择保存位置',
      })
      return
    }

    const intentSize = getLocalAutoSaveIntentSize(task)
    const actualSize = {
      width: storedImages[0].width ?? intentSize?.width ?? 0,
      height: storedImages[0].height ?? intentSize?.height ?? 0,
    }
    const usedNames = new Set(
      useStore.getState().tasks
        .map((item) => item.localAutoSave?.folderName)
        .filter((value): value is string => Boolean(value)),
    )
    const folderName = buildLocalAutoSaveFolderName(task, actualSize, usedNames)
    const imageFiles = storedImages.map((image, index) => ({
      image,
      fileName: getLocalAutoSaveImageFileName(index, image),
    }))
    const metadata = buildLocalAutoSaveMetadata(task, imageFiles)

    await updateTaskLocalAutoSave(taskId, { status: 'saving' })
    const result = await writeLocalAutoSaveArchive({
      rootHandle: directoryHandle,
      folderName,
      files: [
        ...imageFiles.map(({ image, fileName }) => ({
          name: fileName,
          data: getLocalAutoSaveImageBytes(image),
          type: image.dataUrl.match(/^data:([^;]+)/)?.[1] ?? 'image/png',
        })),
        {
          name: 'prompt.txt',
          data: buildLocalAutoSavePromptText(task, actualSize),
          type: 'text/plain;charset=utf-8',
        },
        {
          name: 'metadata.json',
          data: `${JSON.stringify(metadata, null, 2)}\n`,
          type: 'application/json;charset=utf-8',
        },
      ],
    })

    const savedAt = Date.now()
    await updateTaskLocalAutoSave(taskId, {
      status: 'saved',
      folderName: result.folderName,
      files: result.files,
      savedAt,
    })
    useStore.getState().setSettings({
      localAutoSave: {
        ...useStore.getState().settings.localAutoSave,
        lastSavedAt: savedAt,
        lastSavedFolderName: result.folderName,
      },
    })
  } catch (err) {
    await updateTaskLocalAutoSave(taskId, {
      status: err instanceof LocalAutoSavePermissionError ? 'needs_permission' : 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    useStore.setState((current) => {
      const localAutoSaveRunningTaskIds = { ...current.localAutoSaveRunningTaskIds }
      delete localAutoSaveRunningTaskIds[taskId]
      return { localAutoSaveRunningTaskIds }
    })
  }
}

export function getTaskFavoriteCollectionIds(task: TaskRecord) {
  return getTaskFavoriteCollectionIdsForState(task, useStore.getState().defaultFavoriteCollectionId)
}

export function getFavoriteCollectionTitle(collectionId: string | null, collections = useStore.getState().favoriteCollections) {
  if (collectionId === ALL_FAVORITES_COLLECTION_ID) return '全部'
  return collections.find((collection) => collection.id === collectionId)?.name ?? DEFAULT_FAVORITE_COLLECTION_NAME
}

export function createFavoriteCollection(name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName) return null
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return null
  }
  const state = useStore.getState()
  const existing = state.favoriteCollections.find((collection) => collection.name === normalizedName)
  if (existing) return existing
  const now = Date.now()
  const collection: FavoriteCollection = { id: genId(), name: normalizedName, createdAt: now, updatedAt: now }
  state.setFavoriteCollections([...state.favoriteCollections, collection])
  state.showToast(`已创建收藏夹「${normalizedName}」`, 'success')
  return collection
}

export function renameFavoriteCollection(collectionId: string, name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName || collectionId === ALL_FAVORITES_COLLECTION_ID) return
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return
  }
  const { favoriteCollections, setFavoriteCollections, showToast } = useStore.getState()
  setFavoriteCollections(favoriteCollections.map((collection) =>
    collection.id === collectionId ? { ...collection, name: normalizedName, updatedAt: Date.now() } : collection,
  ))
  showToast('收藏夹名称已更新', 'success')
}

export async function updateTasksFavoriteCollections(taskIds: string[], collectionIds: string[]) {
  const ids = normalizeFavoriteCollectionIds(collectionIds)
  const uniqueTaskIds = Array.from(new Set(taskIds)).filter(Boolean)
  if (!uniqueTaskIds.length) return
  const { tasks, setTasks, clearSelection, showToast, defaultFavoriteCollectionId } = useStore.getState()
  const idSet = new Set(uniqueTaskIds)
  const changedTaskIds = new Set<string>()
  const updated = tasks.map((task) => {
    if (!idSet.has(task.id)) return task
    if (sameFavoriteCollectionIds(getTaskFavoriteCollectionIdsForState(task, defaultFavoriteCollectionId), ids)) return task
    changedTaskIds.add(task.id)
    return { ...task, favoriteCollectionIds: ids, isFavorite: ids.length > 0 }
  })
  if (!changedTaskIds.size) {
    clearSelection()
    return
  }
  setTasks(updated)
  await Promise.all(updated.filter((task) => changedTaskIds.has(task.id)).map((task) => putTask(task)))
  clearSelection()
  showToast(ids.length ? '收藏夹已更新' : '已取消收藏', 'success')
}

export async function deleteFavoriteCollection(collectionId: string, deleteTasks = false) {
  const state = useStore.getState()
  const collection = state.favoriteCollections.find((item) => item.id === collectionId)
  const result = deleteFavoriteCollectionState({
    collections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: state.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: state.selectedFavoriteCollectionIds,
    selectedTaskIds: state.selectedTaskIds,
    tasks: state.tasks,
    collectionId,
    deleteTasks,
  })
  if (!collection || !result) return

  useStore.setState({
    favoriteCollections: result.collections,
    defaultFavoriteCollectionId: result.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: result.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: result.selectedFavoriteCollectionIds,
    selectedTaskIds: result.selectedTaskIds,
  })
  if (result.updatedTasks.length) {
    const patches = new Map(result.updatedTasks.map((task) => [task.id, task]))
    const updated = useStore.getState().tasks.map((task) => {
      const patch = patches.get(task.id)
      return patch ? { ...task, favoriteCollectionIds: patch.favoriteCollectionIds, isFavorite: patch.isFavorite } : task
    })
    useStore.getState().setTasks(updated)
    await Promise.all(updated.filter((task) => patches.has(task.id)).map((task) => putTask(task)))
  }
  if (result.taskIdsToDelete.length) await removeMultipleTasks(result.taskIdsToDelete)
  useStore.getState().showToast(`已删除收藏夹「${collection.name}」`, 'success')
}

/** 重试失败的任务：创建新任务并执行 */
export async function retryTask(task: TaskRecord) {
  // 用户重试生成：重置数据清除标志。
  tasksCleared = false
  await refreshTaskStorageGeneration()
  const { settings } = useStore.getState()
  const activeProfile = getSceneImageApiProfile(settings)
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const normalizedParams = normalizeParamsForSettings(task.params, requestSettings, {
    hasInputImages: task.inputImageIds.length > 0,
    preserveExactSizeIntent: true,
  })
  const shouldUseTransparentOutput = (normalizedParams.output_format === 'png' || normalizedParams.output_format === 'webp') && normalizedParams.transparent_output
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output && activeProfile.transparentBackgroundMethod === 'local'
    ? createTransparentOutputMeta(task.prompt.trim())
    : null
  const taskId = genId()
  const newTask: TaskRecord = {
    id: taskId,
    storageGeneration: taskStorageGeneration,
    prompt: task.prompt,
    params: taskParams,
    targetAspectPromptHint: createTargetAspectPromptHint(taskParams.size) ?? undefined,
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiMode: activeProfile.apiMode,
    apiModel: activeProfile.model,
    inputImageIds: [...task.inputImageIds],
    maskTargetImageId: task.maskTargetImageId ?? null,
    maskImageId: task.maskImageId ?? null,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    status: 'running',
    error: null,
    sceneId: settings.activeScene,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([newTask, ...latestTasks])
  await putTask(newTask)

  executeTask(taskId)
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { settings, setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast, setConfirmDialog, setReusedTaskApiProfile } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const currentProfile = getActiveApiProfile(settings)
  const taskProfile = normalizedSettings.reuseTaskApiProfileTemporarily ? getTaskApiProfile(normalizedSettings, task) : null
  const matchedProfile = taskProfile && (!isPresetConfigOnlyEnabled() || isPresetProfile(taskProfile.id)) ? taskProfile : null
  const shouldTemporarilyReuseProfile = Boolean(matchedProfile && matchedProfile.id !== currentProfile.id)
  const missingReusedProfile = normalizedSettings.reuseTaskApiProfileTemporarily && !matchedProfile
  const taskProfileName = matchedProfile?.name ?? getTaskApiProfileName(task)
  const paramsSettings = shouldTemporarilyReuseProfile && matchedProfile ? createSettingsForApiProfile(normalizedSettings, matchedProfile) : normalizedSettings

  setParams(normalizeParamsForSettings(task.params, paramsSettings, {
    hasInputImages: task.inputImageIds.length > 0,
    preserveExactSizeIntent: true,
  }))
  setReusedTaskApiProfile(
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.id : null,
    missingReusedProfile,
    taskProfileName,
  )
  clearMaskDraft()

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const storedImage = await getImage(imgId)
    const dataUrl = storedImage?.dataUrl ?? await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({
        id: imgId,
        dataUrl,
        ...(storedImage?.width ? { width: storedImage.width } : {}),
        ...(storedImage?.height ? { height: storedImage.height } : {}),
      })
    }
  }
  setInputImages(imgs)
  setPrompt(task.prompt)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  if (missingReusedProfile) {
    setConfirmDialog({
      title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${taskProfileName}」，要使用当前的 API 配置「${currentProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ useCurrentApiProfileWhenReusedMissing: true })
      },
    })
    return
  }

  showToast(
    shouldTemporarilyReuseProfile && matchedProfile
      ? `已临时复用该任务的 API 配置「${matchedProfile.name}」`
      : '已复用配置到输入框',
    'success',
  )
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const storedImage = await getImage(imgId)
    const dataUrl = storedImage?.dataUrl ?? await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({
        id: imgId,
        dataUrl,
        ...(storedImage?.width ? { width: storedImage.width } : {}),
        ...(storedImage?.height ? { height: storedImage.height } : {}),
      })
      added++
    }
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

type TaskDeletionStateUpdater = (state: AppState, taskIds: Set<string>) => Partial<AppState> | null

async function removeTasks(taskIds: string[], updateState?: TaskDeletionStateUpdater) {
  // Capture the generation before taking the in-memory deletion snapshot. If
  // clearData advances the generation while cleanup is in flight, every
  // persistence path below becomes a no-op instead of reviving old tasks.
  if (tasksCleared) return 0
  const deletionGeneration = taskStorageGeneration
  const toDelete = new Set(taskIds)
  let deletedTasks: TaskRecord[] = []
  useStore.setState((state) => {
    deletedTasks = state.tasks.filter((task) => toDelete.has(task.id))
    const streamPreviews = { ...state.streamPreviews }
    const streamPreviewSlots = { ...state.streamPreviewSlots }
    for (const taskId of toDelete) {
      delete streamPreviews[taskId]
      delete streamPreviewSlots[taskId]
    }
    return {
      tasks: state.tasks.filter((task) => !toDelete.has(task.id)),
      selectedTaskIds: state.selectedTaskIds.filter((id) => !toDelete.has(id)),
      streamPreviews,
      streamPreviewSlots,
    }
  })
  if (deletedTasks.length === 0 && !updateState) return 0

  const deletedImageIds = new Set<string>()
  for (const task of deletedTasks) {
    addTaskReferencedImageIds(deletedImageIds, task)
    clearFalRecoveryTimer(task.id)
    clearCustomRecoveryTimer(task.id)
    clearOpenAIWatchdogTimer(task.id)
  }

  if (updateState) {
    useStore.setState((state) => {
      const patch = updateState(state, toDelete)
      if (!patch) return state
      return patch
    })
  }
  try {
    await commitTaskDeletion(deletedTasks.map((task) => task.id), [], [], deletionGeneration)
  } catch (err) {
    console.warn('原子清理任务关联数据失败，改用逐项持久化', err)
    await Promise.all(deletedTasks.map((task) => dbDeleteTask(task.id, deletionGeneration)))
  }
  await deleteUnreferencedImageIds(deletedImageIds)
  return deletedTasks.length
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  if (!taskIds.length) return

  const deletedCount = await removeTasks(taskIds)
  if (deletedCount === 0) return
  useStore.getState().showToast(`已删除 ${deletedCount} 个任务`, 'success')
}

/** 删除所有失败任务 */
export async function clearFailedTasks(taskIds?: string[]) {
  const targetTaskIds = taskIds ? new Set(taskIds) : null
  const failedTasks = useStore.getState().tasks
    .filter((task) => taskMatchesFilterStatus(task, 'error') && (!targetTaskIds || targetTaskIds.has(task.id)))
  const failedTaskIds = failedTasks
    .filter((task) => task.status === 'error')
    .map((task) => task.id)
  const partialFailedTaskIds = new Set(
    failedTasks
      .filter((task) => task.status !== 'error' && taskHasOutputErrors(task))
      .map((task) => task.id),
  )

  if (failedTaskIds.length) await removeMultipleTasks(failedTaskIds)
  if (partialFailedTaskIds.size) {
    const { tasks, setTasks, selectedTaskIds, setSelectedTaskIds, showToast } = useStore.getState()
    const updated = tasks.map((task) => partialFailedTaskIds.has(task.id) ? { ...task, outputErrors: undefined } : task)
    setTasks(updated)
    const nextSelectedTaskIds = selectedTaskIds.filter((id) => !partialFailedTaskIds.has(id))
    if (nextSelectedTaskIds.length !== selectedTaskIds.length) setSelectedTaskIds(nextSelectedTaskIds)
    await Promise.all(updated.filter((task) => partialFailedTaskIds.has(task.id)).map((task) => putTask(task)))
    showToast(`已清除 ${partialFailedTaskIds.size} 条部分失败记录`, 'success')
  }
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const deletedCount = await removeTasks([task.id])
  if (deletedCount === 0) return
  useStore.getState().showToast('任务已删除', 'success')
}

/** 清空数据选项 */
export interface ClearOptions {
  clearConfig?: boolean
  clearTasks?: boolean
}

/** 清空数据 */
export async function clearData(options: ClearOptions = { clearConfig: true, clearTasks: true }) {
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()

  // 先取消所有恢复轮询 / 超时监控，防止清空期间或清空后有数据被写回 IndexedDB
  if (options.clearTasks) {
    // 立即置位清除标志：关闭"clearData 的原子清除事务期间，飞行中的 executeTask
    // 读到尚未清空的内存而继续写回 IndexedDB"的竞态窗口。任何此后到达的 putTask 写入都成为空操作。
    tasksCleared = true
    for (const timer of falRecoveryTimers.values()) clearTimeout(timer)
    falRecoveryTimers.clear()
    for (const timer of customRecoveryTimers.values()) clearTimeout(timer)
    customRecoveryTimers.clear()
    for (const timer of openAIWatchdogTimers.values()) clearTimeout(timer)
    openAIWatchdogTimers.clear()
    clearTaskPersistRetryTimers()
  }

  let clearTasksFailed = false
  let clearAgentConversationsFailed = false
  let clearImagesFailed = false
  let clearConfigFailed = false

  if (options.clearTasks) {
    try {
      taskStorageGeneration = await clearTasksAndAdvanceGeneration()
      setTasks([])
      taskClearChannel?.postMessage({ type: 'tasks-cleared', generation: taskStorageGeneration })
      const remaining = await getAllTasks()
      if (remaining.length > 0) {
        clearTasksFailed = true
        console.error('clearData: tasks 存储未完全清空，剩余 %d 条', remaining.length)
      }
    } catch (err) {
      clearTasksFailed = true
      console.error('clearData: 清空 tasks 失败', err)
    }

    // Agent 功能已移除：清空数据时同步清空（已停用的）agent 会话表，防止老数据残留。
    try {
      await dbClearAgentConversations(taskStorageGeneration)
      const remaining = await getAllAgentConversations()
      if (remaining.length > 0) {
        clearAgentConversationsFailed = true
        console.error('clearData: agentConversations 存储未完全清空，剩余 %d 条', remaining.length)
      }
    } catch (err) {
      clearAgentConversationsFailed = true
      console.error('clearData: 清空 agentConversations 失败', err)
    }

    try {
      await clearImages()
      const remaining = await getAllImageIds()
      if (remaining.length > 0) {
        clearImagesFailed = true
        console.error('clearData: images 存储未完全清空，剩余 %d 条', remaining.length)
      }
    } catch (err) {
      clearImagesFailed = true
      console.error('clearData: 清空 images/thumbnails 失败', err)
    }

    clearImageCaches()
    useStore.setState({
      supportPromptOpen: false,
      supportPromptSkippedForImportedData: false,
    })
    clearInputImages()
    clearMaskDraft()

    // Keep the task-clear tombstone until an explicit reload or new task
    // generation; secondary-store failures must not reopen stale writers.
  }

  if (options.clearConfig) {
    try {
      const presetConfig = getPresetConfig()
      useStore.setState({
        dismissedPresetProfileIds: [],
        dismissedPresetProviderIds: [],
        dismissedCodexCliPrompts: [],
        supportPromptDismissed: false,
      })
      await clearLocalAutoSaveDirectoryHandle()
      await clearEngineDeliveryDirectoryHandle()
      if (presetConfig) {
        useStore.setState({ settings: { ...DEFAULT_SETTINGS } })
        await useStore.getState().setPresetImportedSettings(presetConfig)
      } else {
        setSettings({ ...DEFAULT_SETTINGS })
      }
      setParams({ ...DEFAULT_PARAMS })
    } catch (err) {
      clearConfigFailed = true
      console.error('clearData: 清空配置失败', err)
    }
  }

  const failed = clearTasksFailed || clearAgentConversationsFailed || clearImagesFailed || clearConfigFailed
  showToast(
    failed ? '部分数据清空失败，可重试清空；若持续失败请使用「重建数据库」' : '所选数据已清空',
    failed ? 'error' : 'success',
  )
}

// ===== 可清理项驱逐（#20）=====

export interface CleanupPlan {
  /** 失败任务遗留的流式中间图数量 */
  failedPartialCount: number
  /** 老于 30 天任务的可丢弃副本（透明处理前原图 / 精确尺寸处理前原图）数量 */
  staleOriginalCopyCount: number
  /** 相关任务数 */
  taskCount: number
}

/** 涉及任务引用的所有图片 id（清理候选对照，防止误删仍被输出的图）。 */
function collectProtectedImageIds(tasks: TaskRecord[]): Set<string> {
  const protectedIds = new Set<string>()
  for (const task of tasks) {
    for (const id of task.outputImages ?? []) protectedIds.add(id)
    for (const id of task.inputImageIds ?? []) protectedIds.add(id)
    if (task.maskImageId) protectedIds.add(task.maskImageId)
  }
  return protectedIds
}

const CLEANUP_STALE_TASK_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** 计算可清理项（不执行删除）。partial 图属失败任务遗留；副本图须任务老于 30 天。 */
export function getCleanupPlan(tasks: TaskRecord[], now = Date.now()): CleanupPlan {
  const failedPartialIds = new Set<string>()
  const staleCopyIds = new Set<string>()
  const relatedTaskIds = new Set<string>()

  for (const task of tasks) {
    const failed = task.status === 'error'
    if (failed && task.streamPartialImageIds?.length) {
      for (const id of task.streamPartialImageIds) {
        if (id) {
          failedPartialIds.add(id)
          relatedTaskIds.add(task.id)
        }
      }
    }
    const stale = now - task.createdAt > CLEANUP_STALE_TASK_AGE_MS
    if (stale) {
      for (const id of task.transparentOriginalImages ?? []) {
        if (id) {
          staleCopyIds.add(id)
          relatedTaskIds.add(task.id)
        }
      }
      for (const id of task.exactSizeOriginalImages ?? []) {
        if (id) {
          staleCopyIds.add(id)
          relatedTaskIds.add(task.id)
        }
      }
    }
  }

  // 交集防护：同一张图若同时是任何任务的输出/输入/遮罩，绝不清
  const protectedIds = collectProtectedImageIds(tasks)
  for (const id of [...failedPartialIds]) if (protectedIds.has(id)) failedPartialIds.delete(id)
  for (const id of [...staleCopyIds]) if (protectedIds.has(id)) staleCopyIds.delete(id)

  return {
    failedPartialCount: failedPartialIds.size,
    staleOriginalCopyCount: staleCopyIds.size,
    taskCount: relatedTaskIds.size,
  }
}

/**
 * 执行清理：删除失败任务 partial 图与老任务副本图，并从任务记录里移除对应
 * 引用（任务本体与输出图保留）。返回删除的图片数量。
 */
export async function runImageCleanup(tasks: TaskRecord[]): Promise<number> {
  const protectedIds = collectProtectedImageIds(tasks)
  const now = Date.now()
  const taskPatches: Array<{ taskId: string; patch: Partial<TaskRecord> }> = []

  for (const task of tasks) {
    const patch: Partial<TaskRecord> = {}
    if (task.status === 'error' && task.streamPartialImageIds?.length) {
      const keep = task.streamPartialImageIds.filter((id) => !id || protectedIds.has(id))
      if (keep.length !== task.streamPartialImageIds.length) {
        patch.streamPartialImageIds = keep.length ? keep : undefined
      }
    }
    const stale = now - task.createdAt > CLEANUP_STALE_TASK_AGE_MS
    if (stale) {
      if (task.transparentOriginalImages?.length) {
        const keep = task.transparentOriginalImages.filter((id) => !id || protectedIds.has(id))
        if (keep.length !== task.transparentOriginalImages.length) {
          patch.transparentOriginalImages = keep.length ? keep : undefined
        }
      }
      if (task.exactSizeOriginalImages?.length) {
        const keep = task.exactSizeOriginalImages.filter((id) => !id || protectedIds.has(id))
        if (keep.length !== task.exactSizeOriginalImages.length) {
          patch.exactSizeOriginalImages = keep.length ? keep : undefined
        }
      }
    }
    if (Object.keys(patch).length) taskPatches.push({ taskId: task.id, patch })
  }

  // 先重算受影响图（按补丁后的引用视图），删除真正孤立者
  const patchedTasks = tasks.map((task) => {
    const entry = taskPatches.find((p) => p.taskId === task.id)
    return entry ? { ...task, ...entry.patch } : task
  })
  const stillReferenced = collectProtectedImageIds(patchedTasks)
  // 输入图/遮罩引用也要纳入防护（collectProtectedImageIds 已含），再排除保留引用
  for (const task of patchedTasks) {
    for (const id of task.streamPartialImageIds ?? []) stillReferenced.add(id)
    for (const id of task.transparentOriginalImages ?? []) stillReferenced.add(id)
    for (const id of task.exactSizeOriginalImages ?? []) stillReferenced.add(id)
  }

  // 候选 = 清理前引用集 - 清理后引用集（真正孤立的图）
  const before = new Set<string>()
  for (const task of tasks) {
    for (const id of task.streamPartialImageIds ?? []) if (id) before.add(id)
    for (const id of task.transparentOriginalImages ?? []) if (id) before.add(id)
    for (const id of task.exactSizeOriginalImages ?? []) if (id) before.add(id)
  }
  const candidateIds = new Set<string>()
  for (const id of before) {
    if (!stillReferenced.has(id)) candidateIds.add(id)
  }

  // 先删再剥：只有真正删除成功的引用才从任务记录里剥离——删除失败而
  // 剥了引用会造成永久孤儿（下次清理再也扫不到它）。
  const deletedIds = new Set<string>()
  for (const id of candidateIds) {
    try {
      await deleteImage(id)
      deleteImageCacheEntry(id)
      deletedIds.add(id)
    } catch {
      // 删除失败：保留任务引用，下次清理可重试
    }
  }

  const appliedPatches: Array<{ taskId: string; patch: Partial<TaskRecord> }> = []
  for (const { taskId, patch } of taskPatches) {
    const original = tasks.find((t) => t.id === taskId)
    if (!original) continue
    const applied: Partial<TaskRecord> = {}
    if (patch.streamPartialImageIds !== undefined || patch.streamPartialImageIds === undefined && original.streamPartialImageIds) {
      const keep = (original.streamPartialImageIds ?? []).filter((id) => patch.streamPartialImageIds?.includes(id) || !deletedIds.has(id))
      const next = keep.length ? keep : undefined
      if (next === undefined || keep.length !== original.streamPartialImageIds?.length) applied.streamPartialImageIds = next
    }
    if (original.transparentOriginalImages?.length) {
      const keep = original.transparentOriginalImages.filter((id) => patch.transparentOriginalImages?.includes(id) || !deletedIds.has(id))
      const next = keep.length ? keep : undefined
      if (keep.length !== original.transparentOriginalImages.length) applied.transparentOriginalImages = next
    }
    if (original.exactSizeOriginalImages?.length) {
      const keep = original.exactSizeOriginalImages.filter((id) => patch.exactSizeOriginalImages?.includes(id) || !deletedIds.has(id))
      const next = keep.length ? keep : undefined
      if (keep.length !== original.exactSizeOriginalImages.length) applied.exactSizeOriginalImages = next
    }
    if (Object.keys(applied).length) appliedPatches.push({ taskId, patch: applied })
  }
  for (const { taskId, patch } of appliedPatches) {
    updateTaskInStore(taskId, patch)
  }
  return deletedIds.size
}

/**
 * clearData 逃生门：删除整个 IndexedDB 数据库并重置内存态。
 * 用于存储损坏 / 反复清空失败的最后手段。
 * 注意：先停掉本页全部后台写入器（重试定时器、清空标志），再请求删除；
 * 若删除被打开的连接阻止（其他标签页 / 未 GC 的泄漏连接），明确报错
 * 而不是假成功——被阻止时数据库并未删除。
 */
export async function rebuildDatabase(): Promise<void> {
  if (typeof indexedDB === 'undefined') throw new Error('当前环境不支持 IndexedDB')
  // 停掉本页写入器，避免删除请求被本页新事务持续阻塞/复活
  tasksCleared = true
  clearTaskPersistRetryTimers()
  clearImageCaches()

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('gpt-image-playground')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('删除数据库失败'))
    request.onblocked = () => reject(new Error('数据库正被其他标签页或后台任务占用，请关闭其他标签页后重试'))
  })

  useStore.setState({ tasks: [] })
}

/** 重置数据清除标志，仅供单元测试在 beforeEach 中调用。 */
export function __resetTasksClearedForTests() {
  tasksCleared = false
}

async function completeRecoveredCustomTask(task: TaskRecord, result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return
  if (latest.status !== 'running' && !latest.customRecoverable) return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds, exactSizeOriginalImageIds, exactSizeTransforms, persistFailedCount } = await storeTaskOutputImages(task, result.images, deleteUnreferencedImageIds)
  const resolvedActualParamsList = await resolveImageSizeParamsList(outputDataUrls, undefined, outputImageSizes)
  const actualParamsList = resolvedActualParamsList.map((params, index) =>
    resolveFinalActualParams(params, outputImageSizes[index], task.params),
  )
  const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestBeforeUpdate || latestBeforeUpdate.status === 'done' || (latestBeforeUpdate.status !== 'running' && !latestBeforeUpdate.customRecoverable)) {
    await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? []), ...(exactSizeOriginalImageIds ?? [])])
    return
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    exactSizeOriginalImages: exactSizeOriginalImageIds,
    exactSizeTransforms,
    outputPersistWarning: persistFailedCount > 0 || undefined,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    ...createTaskDonePatch(task, Date.now()),
    customRecoverable: false,
  })
  if (persistFailedCount > 0) {
    useStore.getState().showToast(`自定义异步任务已恢复，但存储空间不足，${persistFailedCount} 张图片仅保留在内存中，请立即导出。`, 'error')
  } else {
    useStore.getState().showToast(`自定义异步任务已恢复，共 ${outputIds.length} 张图片`, 'success')
  }
  if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `自定义异步任务已恢复，共 ${outputIds.length} 张图片。`)
}

async function recoverCustomTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || !task.customTaskId || task.status === 'done') return

  const profile = getCustomRecoveryProfile(settings, task)
  const customProvider = profile ? getCustomProviderDefinition(settings, profile.provider) : null
  if (!profile || !customProvider?.poll) {
    scheduleCustomRecovery(taskId)
    return
  }

  // 恢复轮询有自己的中止器：单次 poll fetch 不再可能无限挂起，
  // clearData/任务删除时也可取消。
  const controller = new AbortController()
  customRecoveryAbortControllers.set(taskId, controller)
  const perPollTimeout = setTimeout(() => controller.abort(), CUSTOM_RECOVERY_POLL_TIMEOUT_MS)
  try {
    // 恢复轮询同样有 30 分钟上限（pollCustomTaskResult 内部强制），
    // 不再出现坏网关下的无限轮询。
    const result = await getCustomQueuedImageResult(profile, customProvider, task.customTaskId, task.params, controller.signal)
    clearCustomRecoveryTimer(taskId)
    await completeRecoveredCustomTask(task, result)
  } catch (err) {
    clearCustomRecoveryTimer(taskId)
    if (!useStore.getState().tasks.some((item) => item.id === taskId)) return
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, err instanceof Error ? err.message : String(err), Date.now()),
      ...getRawErrorPayload(err),
      customRecoverable: false,
    })
  } finally {
    clearTimeout(perPollTimeout)
    customRecoveryAbortControllers.delete(taskId)
  }
}

/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

/** 导出数据为 ZIP */
export async function exportData(options: ExportOptions = { exportConfig: true, exportTasks: true }) {
  try {
    const state = useStore.getState()
    if (options.exportTasks && hasActiveDataOperations(state.tasks)) throw new Error('当前有任务正在进行，请完成或停止后再导出。')
    const tasks = options.exportTasks ? await getAllTasks() : []
    const imageIds = options.exportTasks ? await getAllImageIds() : []
    // 配额失败仅存内存的图（钉在 imageCache 的 pinnedQuotaImages）：必须并入导出，
    // 否则「请立即导出」的指引救不回这些已计费的图。
    const pinnedIds = options.exportTasks ? getUnpinnedQuotaImageIds().filter((id) => !imageIds.includes(id)) : []
    if (pinnedIds.length) imageIds.push(...pinnedIds)
    const { settings, favoriteCollections, defaultFavoriteCollectionId } = state
    const exportedAt = Date.now()
    const params = {
      options,
      exportedAt,
      settings,
      tasks,
      imageTasks: tasks,
      favoriteCollections,
      defaultFavoriteCollectionId,
    }
    const imageSizes = []
    for (const id of imageIds) {
      // sizing 走原始记录（blob.size 直读），不触发 Blob→dataUrl 全量转换
      let image = await getImageRecord(id)
      if (!image) {
        const pinnedDataUrl = getCachedImage(id)
        if (!pinnedIds.includes(id) || !pinnedDataUrl) continue
        image = { id, dataUrl: pinnedDataUrl, createdAt: exportedAt, source: 'generated' }
      }
      const thumbnail = await getImageThumbnail(id)
      imageSizes.push({ id, bytes: getExportImageEstimatedBytes(image as StoredImage, thumbnail) })
    }
    const plan = getExportZipPlan(params, imageSizes)
    const backupId = `${exportedAt}`

    for (let index = 0; index < plan.length; index++) {
      const images: StoredImage[] = []
      const thumbnailsByImageId = new Map<string, StoredImageThumbnail>()
      for (const id of plan[index].imageIds) {
        let image = await getImage(id)
        if (!image) {
          const pinnedDataUrl = getCachedImage(id)
          if (!pinnedIds.includes(id) || !pinnedDataUrl) continue
          image = { id, dataUrl: pinnedDataUrl, createdAt: exportedAt, source: 'generated' }
        }
        images.push(image)
        const thumbnail = await getImageThumbnail(id)
        if (!thumbnail?.thumbnailDataUrl) continue
        thumbnailsByImageId.set(id, thumbnail)
        cacheThumbnail(id, {
          dataUrl: thumbnail.thumbnailDataUrl,
          width: thumbnail.width,
          height: thumbnail.height,
          thumbnailVersion: thumbnail.thumbnailVersion,
        })
      }

      const partNumber = index + 1
      const result = await buildExportZip({
        ...params,
        tasks: plan[index].tasks,
        images,
        thumbnailsByImageId,
        includeManifestData: plan[index].includeBaseData,
        backupPart: plan.length > 1 ? { id: backupId, index: partNumber, total: plan.length } : undefined,
      })
      const blob = createExportBlob(result.bytes)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const suffix = plan.length > 1 ? `_${String(plan.length).padStart(2, '0')}parts_part${String(partNumber).padStart(2, '0')}` : ''
      a.href = url
      a.download = `gpt-image-playground-backup_${formatExportFileTime(new Date(exportedAt))}${suffix}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      if (partNumber < plan.length) await new Promise((resolve) => setTimeout(resolve, 150))
    }
    useStore.getState().showToast(plan.length > 1 ? `已请求下载 ${plan.length} 个 ZIP，请确认浏览器已允许多文件下载` : '数据已导出', 'success')
  } catch (e) {
    console.error('exportData failed', e)
    const detail = e instanceof Error ? e.message.trim() : String(e).trim()
    useStore.getState().showToast(detail ? `导出失败，${detail}` : '导出失败，未知错误', 'error')
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
}

export async function restoreExplicitPresetConfig(ids: { providerIds: string[], profileIds: string[] }) {
  const presetProviderIds = getPresetProviderIds()
  const presetProfileIds = getPresetProfileIds()
  const providerIds = ids.providerIds.filter((id) => presetProviderIds.has(id))
  const profileIds = ids.profileIds.filter((id) => presetProfileIds.has(id))
  if (!providerIds.length && !profileIds.length) return false

  const state = useStore.getState()
  for (const id of providerIds) state.restorePresetProvider(id)
  for (const id of profileIds) state.restorePresetProfile(id)
  const presetConfig = getPresetConfig()
  if (presetConfig) await useStore.getState().setPresetImportedSettings(presetConfig)
  return true
}

/** 导入 ZIP 数据 */
export async function importData(input: File | File[], options: ImportOptions = { importConfig: true, importTasks: true }): Promise<boolean> {
  try {
    // 导入数据：重置清除标志，使导入的任务能正常写入。
    tasksCleared = false
    await refreshTaskStorageGeneration()
    const state = useStore.getState()
    if (options.importTasks && hasActiveDataOperations(state.tasks)) throw new Error('当前有任务正在进行，请完成或停止后再导入。')
    const files = Array.isArray(input) ? input : [input]
    if (!files.length) throw new Error('没有选择备份文件。')
    if (files.some((file) => file.size >= MAX_EXPORT_ZIP_BYTES)) {
      throw new Error('单个 ZIP 不能达到或超过 2 GB，请选择分片备份。')
    }

    const selected = [] as Array<{ file: File; manifest: Awaited<ReturnType<typeof readExportZipManifest>> }>
    for (const file of files) {
      const manifest = await readExportZipManifest(new Uint8Array(await file.arrayBuffer()), options.importTasks)
      selected.push({ file, manifest })
    }
    const multipart = selected.some((part) => part.manifest.backupPart != null)
    if (multipart) {
      if (selected.some((part) => !part.manifest.backupPart)) throw new Error('不能混合选择分片备份和普通备份。')
      const first = selected[0].manifest.backupPart!
      const indexes = new Set(selected.map((part) => part.manifest.backupPart!.index))
      const validSet = selected.every((part) => {
        const backupPart = part.manifest.backupPart!
        return backupPart.id === first.id && backupPart.total === first.total && backupPart.index >= 1 && backupPart.index <= first.total
      })
      if (!validSet || indexes.size !== selected.length) throw new Error('所选分片不属于同一批备份或包含重复分片。')
      if (options.importTasks && (selected.length !== first.total || indexes.size !== first.total)) {
        throw new Error(`分片备份不完整，请一次选择同一备份的全部 ${first.total} 个 ZIP。`)
      }
      selected.sort((a, b) => a.manifest.backupPart!.index - b.manifest.backupPart!.index)
    }

    const settingsManifests = selected.filter((part) => part.manifest.settings)
    if (options.importConfig && !options.importTasks && !settingsManifests.length) throw new Error('所选备份不包含配置数据。')
    const importedTasks = selected.flatMap((part) => part.manifest.tasks ?? [])
    // 老备份的 manifest 可能含 agentConversations 字段（智能体已移除）：解析天然容忍，
    // 这里静默忽略，不导入也不报错。
    const hasTaskData = selected.some((part) => part.manifest.tasks != null || part.manifest.imageFiles != null)

    const importedImageIds: string[] = []
    if (options.importTasks && hasTaskData) {
      for (const part of selected) {
        const { manifest, files: zipFiles } = await readExportZip(new Uint8Array(await part.file.arrayBuffer()))
        for (const [id, info] of Object.entries(manifest.imageFiles ?? {})) {
          const dataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!dataUrl) continue
          await putImage({
            id,
            dataUrl,
            createdAt: info.createdAt,
            source: info.source,
            width: info.width,
            height: info.height,
          })
          cacheImage(id, dataUrl)
          importedImageIds.push(id)
        }

        for (const [id, info] of Object.entries(manifest.thumbnailFiles ?? {})) {
          const thumbnailDataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!thumbnailDataUrl) continue
          await putImageThumbnail({
            id,
            thumbnailDataUrl,
            width: info.width,
            height: info.height,
            thumbnailVersion: info.thumbnailVersion,
          })
          cacheThumbnail(id, {
            dataUrl: thumbnailDataUrl,
            width: info.width,
            height: info.height,
            thumbnailVersion: info.thumbnailVersion,
          })
        }
      }

      let failedTaskImports = 0
      for (const task of importedTasks) {
        try {
          // 导入走直写：putTask 的失败重试包装会把写失败吞成成功，
          // 导入场景必须如实感知（否则展示"导入成功"但任务缺失）。
          await dbPutTask(normalizeImportedTaskLocalAutoSave(task), taskStorageGeneration)
        } catch {
          failedTaskImports += 1
        }
      }
      if (failedTaskImports > 0) {
        useStore.getState().showToast(`导入完成，但 ${failedTaskImports} 个任务写入本地存储失败（空间不足？），建议清理空间后重试导入。`, 'error')
      }

      const tasks = await getAllTasks()
      const state = useStore.getState()
      const importedFavoriteCollections = selected.flatMap((part) => part.manifest.favoriteCollections ?? [])
      const mergedFavorites = mergeFavoriteCollections(state.favoriteCollections, importedFavoriteCollections)
      const favoriteCollections = mergedFavorites.collections
      const importedDefaultFavoriteCollectionId = selected
        .map((part) => part.manifest.defaultFavoriteCollectionId)
        .find((id) => id != null && favoriteCollections.some((collection) => collection.id === id))
      const defaultFavoriteCollectionId = mergedFavorites.importedCollections.length
        ? resolveDefaultFavoriteCollectionId(favoriteCollections, importedDefaultFavoriteCollectionId)
        : state.defaultFavoriteCollectionId
      const normalizedFavorites = normalizeLoadedFavoriteState(tasks, favoriteCollections, defaultFavoriteCollectionId)
      useStore.setState({
        tasks: normalizedFavorites.tasks,
        favoriteCollections: normalizedFavorites.collections,
        defaultFavoriteCollectionId: normalizedFavorites.defaultFavoriteCollectionId,
      })
      if (normalizedFavorites.changed) await Promise.all(normalizedFavorites.tasks.map((task) => putTask(task)))
      skipSupportPromptForImportedData(tasks)
      scheduleThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && settingsManifests.length) {
      const state = useStore.getState()
      const providerIds = new Set(settingsManifests.flatMap((part) =>
        part.manifest.settings?.customProviders.map((provider) => provider.id) ?? [],
      ))
      const profileIds = new Set(settingsManifests.flatMap((part) =>
        part.manifest.settings?.profiles.map((profile) => profile.id) ?? [],
      ))
      const presetProviderIds = getPresetProviderIds()
      const presetProfileIds = getPresetProfileIds()
      for (const id of providerIds) {
        if (presetProviderIds.has(id)) state.restorePresetProvider(id)
      }
      for (const id of profileIds) {
        if (presetProfileIds.has(id)) state.restorePresetProfile(id)
      }
      const current = useStore.getState()
      // 只重置画廊自动保存句柄；引擎交付句柄是独立授权，不随配置导入失效。
      await clearLocalAutoSaveDirectoryHandle()
      const importedSettings = settingsManifests.reduce(
        (cur, part) => mergeImportedSettings(cur, part.manifest.settings, { preserveInternalIds: true }),
        current.settings,
      )
      current.setSettings({
        ...importedSettings,
        localAutoSave: {
          ...importedSettings.localAutoSave,
          directoryName: null,
          lastSavedAt: null,
          lastSavedFolderName: null,
        },
      })
    }

    let msg = '数据已成功导入'
    if (options.importTasks && hasTaskData) {
      msg = `已导入 ${importedTasks.length} 个任务`
    } else if (options.importConfig && settingsManifests.length) {
      msg = '配置已成功导入'
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    console.error('importData failed', e)
    const detail = e instanceof Error ? e.message.trim() : String(e).trim()
    useStore.getState().showToast(detail ? `导入失败，${detail}` : '导入失败，未知错误', 'error')
    return false
  }
}

/** 添加图片到输入（文件上传） */
export async function addImageFromFile(file: File): Promise<void> {
  const image = await createInputImageFromFile(file)
  if (!image) return
  useStore.getState().addInputImage(image)
}

export async function createInputImageFromFile(file: File): Promise<InputImage | null> {
  if (!file.type.startsWith('image/')) return null
  const dataUrl = await fileToDataUrl(file)
  const stored = await storeImageWithSize(dataUrl, 'upload')
  cacheImage(stored.id, dataUrl)
  return { id: stored.id, dataUrl, width: stored.width, height: stored.height }
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const stored = await storeImageWithSize(dataUrl, 'upload')
  cacheImage(stored.id, dataUrl)
  useStore.getState().addInputImage({ id: stored.id, dataUrl, width: stored.width, height: stored.height })
}
