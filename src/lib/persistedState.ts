import type { AgentInputDraft, AppMode, AppSettings, FavoriteCollection, InputImage, MaskDraft, PromptHistoryEntry, SceneDraft, SceneDraftSceneId, SceneDrafts, TaskParams } from '../types'
import { normalizeSettings } from './apiProfiles'
import { clampSkillEntryCount, SKILL_ENTRY_COUNT_DEFAULT } from './skillWorkshop/expansion'
import { ensureDefaultFavoriteCollection, normalizeFavoriteCollections, resolveDefaultFavoriteCollectionId } from './favoriteState'
import { getPersistableInputImage, isEmptyAgentInputDraft, normalizeAgentInputDraft, saveGalleryInputDraft } from './inputDraftState'

export interface PersistedAppState {
  settings: AppSettings
  previousPresetConfig?: Pick<AppSettings, 'customProviders' | 'profiles'> | null
  dismissedPresetProfileIds?: string[]
  dismissedPresetProviderIds?: string[]
  params: TaskParams
  prompt?: string
  inputImages?: InputImage[]
  dismissedCodexCliPrompts: string[]
  appMode: AppMode
  galleryInputDraft: AgentInputDraft | null
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  /** 画廊提示词历史；旧持久化数据可能缺失，恢复时由 normalizePromptHistory 兜底为 [] */
  promptHistory?: PromptHistoryEntry[]
  /** 场景草稿（提示词/参数/输入图 id，均轻量）；与 prompt/inputImages 一样受 persistInputOnRestart 门控，
   *  旧持久化数据缺失时恢复为 {} */
  sceneDrafts?: SceneDrafts
  supportPromptDismissed: boolean
  supportPromptOpen: boolean
  supportPromptSkippedForImportedData: boolean
  /** Skill 工坊扩写偏好（严格模式/期望条数）；旧持久化数据缺失时按默认值兜底 */
  skillExpansionPrefs?: SkillExpansionPrefs
}

/** Skill 工坊扩写偏好：与运行态无关的轻量用户设置，跨会话记忆 */
export interface SkillExpansionPrefs {
  strictMode: boolean
  entryCount: number
}

type PersistedStateSource = Omit<PersistedAppState, 'prompt' | 'inputImages'> & {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  /** partialize 时从完整 store state 读取扩写偏好（结构宽松，逐字段校验） */
  skillExpansion?: { strictMode?: unknown; entryCount?: unknown }
}

type PersistedStateFallback = Pick<
  PersistedAppState,
  'settings' | 'params' | 'dismissedPresetProfileIds' | 'dismissedPresetProviderIds' | 'dismissedCodexCliPrompts' | 'favoriteCollections' | 'defaultFavoriteCollectionId'
>

export type NormalizedPersistedAppState = PersistedAppState & {
  previousPresetConfig: Pick<AppSettings, 'customProviders' | 'profiles'> | null
  dismissedPresetProfileIds: string[]
  dismissedPresetProviderIds: string[]
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  sceneDrafts: SceneDrafts
  skillExpansionPrefs: SkillExpansionPrefs
}

/** 参与草稿持久化的场景键（不含 skill） */
const SCENE_DRAFT_SCENE_IDS: readonly SceneDraftSceneId[] = ['portrait', 'general', 'sticker']

/** 只保留三个非 skill 场景的合法草稿键，逐字段拷贝防外层可变性渗透 */
export function toPersistableSceneDrafts(drafts: SceneDrafts | undefined): SceneDrafts {
  const out: SceneDrafts = {}
  if (!drafts) return out
  for (const sceneId of SCENE_DRAFT_SCENE_IDS) {
    const draft = drafts[sceneId]
    if (!draft) continue
    out[sceneId] = {
      prompt: draft.prompt,
      params: { ...draft.params },
      inputImageIds: [...draft.inputImageIds],
    }
  }
  return out
}

function normalizeSceneDraft(value: unknown, fallbackParams: TaskParams): SceneDraft | null {
  if (!isRecord(value)) return null
  return {
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    params: normalizeParams(value.params, fallbackParams),
    inputImageIds: normalizeStringArray(value.inputImageIds, []),
  }
}

function normalizeSceneDrafts(value: unknown, fallbackParams: TaskParams): SceneDrafts {
  if (!isRecord(value)) return {}
  const drafts: SceneDrafts = {}
  for (const sceneId of SCENE_DRAFT_SCENE_IDS) {
    const draft = normalizeSceneDraft(value[sceneId], fallbackParams)
    if (draft) drafts[sceneId] = draft
  }
  return drafts
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeParams(value: unknown, fallback: TaskParams): TaskParams {
  if (!isRecord(value)) return fallback
  return {
    size: typeof value.size === 'string' ? value.size : fallback.size,
    exact_size: typeof value.exact_size === 'boolean' ? value.exact_size : fallback.exact_size,
    quality: value.quality === 'auto' || value.quality === 'low' || value.quality === 'medium' || value.quality === 'high' || value.quality === 'xhigh' || value.quality === 'max'
      ? value.quality
      : fallback.quality,
    output_format: value.output_format === 'png' || value.output_format === 'jpeg' || value.output_format === 'webp' ? value.output_format : fallback.output_format,
    output_compression: value.output_compression === null || (typeof value.output_compression === 'number' && Number.isFinite(value.output_compression))
      ? value.output_compression
      : fallback.output_compression,
    moderation: value.moderation === 'auto' || value.moderation === 'low' ? value.moderation : fallback.moderation,
    n: typeof value.n === 'number' && Number.isFinite(value.n) ? value.n : fallback.n,
    transparent_output: typeof value.transparent_output === 'boolean' ? value.transparent_output : fallback.transparent_output,
    input_ratio_policy: value.input_ratio_policy === 'auto' || value.input_ratio_policy === 'crop' || value.input_ratio_policy === 'outpaint' || value.input_ratio_policy === 'off'
      ? value.input_ratio_policy
      : fallback.input_ratio_policy,
  }
}

/** Skill 扩写偏好归一：非法值回落默认（严格模式开、SKILL_ENTRY_COUNT_DEFAULT 条），
 *  条数收口复用 expansion.ts 的 SKILL_ENTRY_COUNT_MIN/MAX（clampSkillEntryCount），
 *  与运行态/UI 输入共用同一常量出口，避免多处硬编码漂移 */
export function normalizeSkillExpansionPrefs(value: unknown): SkillExpansionPrefs {
  if (!isRecord(value)) return { strictMode: true, entryCount: SKILL_ENTRY_COUNT_DEFAULT }
  return { strictMode: value.strictMode !== false, entryCount: clampSkillEntryCount(value.entryCount) }
}

export function normalizePromptHistory(value: unknown): PromptHistoryEntry[] {
  if (!Array.isArray(value)) return []
  const entries: PromptHistoryEntry[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.prompt !== 'string' || !item.prompt.trim()) continue
    entries.push({
      id: typeof item.id === 'string' ? item.id : `${item.usedAt ?? Date.now()}-${entries.length}`,
      prompt: item.prompt,
      size: typeof item.size === 'string' ? item.size : 'auto',
      quality: item.quality === 'low' || item.quality === 'medium' || item.quality === 'high' ? item.quality : 'auto',
      output_format: item.output_format === 'jpeg' || item.output_format === 'webp' ? item.output_format : 'png',
      n: typeof item.n === 'number' && Number.isFinite(item.n) && item.n > 0 ? item.n : 1,
      usedAt: typeof item.usedAt === 'number' && Number.isFinite(item.usedAt) ? item.usedAt : Date.now(),
    })
    if (entries.length >= 20) break
  }
  return entries
}

export function createPersistedState(state: PersistedStateSource): PersistedAppState {
  const settings = normalizeSettings(state.settings)
  const galleryInputDraft = saveGalleryInputDraft(state)
  return {
    settings,
    previousPresetConfig: state.previousPresetConfig ?? null,
    dismissedPresetProfileIds: state.dismissedPresetProfileIds ?? [],
    dismissedPresetProviderIds: state.dismissedPresetProviderIds ?? [],
    params: state.params,
    ...(settings.persistInputOnRestart && (state.appMode === 'gallery' || galleryInputDraft)
      ? {
          prompt: galleryInputDraft?.prompt ?? '',
          inputImages: galleryInputDraft?.inputImages.map(getPersistableInputImage) ?? [],
          sceneDrafts: toPersistableSceneDrafts(state.sceneDrafts),
        }
      : {}),
    dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    appMode: state.appMode,
    galleryInputDraft: settings.persistInputOnRestart && galleryInputDraft
      ? { ...galleryInputDraft, inputImages: galleryInputDraft.inputImages.map(getPersistableInputImage) }
      : null,
    favoriteCollections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    promptHistory: normalizePromptHistory(state.promptHistory),
    skillExpansionPrefs: normalizeSkillExpansionPrefs(state.skillExpansion),
    supportPromptDismissed: state.supportPromptDismissed,
    supportPromptOpen: state.supportPromptOpen,
    supportPromptSkippedForImportedData: state.supportPromptSkippedForImportedData,
  }
}

/**
 * 迁移旧持久化数据：丢弃 legacy agent 数据（智能体已移除，不迁移）。
 * 老版本 localStorage 里可能残留 agentConversations / activeAgentConversationId /
 * agentInputDrafts 等字段，这里剥离子字段，防止继续被持久化写回。
 */
export function migratePersistedState(persistedState: unknown, _version?: number): unknown {
  if (!isRecord(persistedState)) return persistedState
  const {
    agentConversations: _agentConversations,
    activeAgentConversationId: _activeAgentConversationId,
    agentInputDrafts: _agentInputDrafts,
    agentSidebarCollapsed: _agentSidebarCollapsed,
    agentAssetTab: _agentAssetTab,
    agentAssetPanelCollapsed: _agentAssetPanelCollapsed,
    ...rest
  } = persistedState
  return rest
}

export function normalizePersistedState(
  persistedState: unknown,
  fallback: PersistedStateFallback,
  now = Date.now(),
): NormalizedPersistedAppState | null {
  if (!isRecord(persistedState)) return null

  const settings = normalizeSettings(persistedState.settings ?? fallback.settings)
  const previousPresetConfig = isRecord(persistedState.previousPresetConfig) && Array.isArray(persistedState.previousPresetConfig.profiles)
    ? (() => {
      const normalized = normalizeSettings(persistedState.previousPresetConfig)
      return {
        customProviders: normalized.customProviders,
        profiles: persistedState.previousPresetConfig.profiles.length ? normalized.profiles : [],
      }
    })()
    : null
  // Agent 模式已移除：存量持久化的 appMode:'agent' 归一为 'gallery'（engine 本就不持久化，维持原行为）。
  const appMode: AppMode = 'gallery'
  const galleryInputDraft = settings.persistInputOnRestart
    ? normalizeAgentInputDraft(persistedState.galleryInputDraft ?? {
        prompt: persistedState.prompt,
        inputImages: persistedState.inputImages,
        maskDraft: null,
        maskEditorImageId: null,
      }, now)
    : null
  const favoriteCollections = Array.isArray(persistedState.favoriteCollections)
    ? ensureDefaultFavoriteCollection(normalizeFavoriteCollections(persistedState.favoriteCollections, now), now)
    : fallback.favoriteCollections
  const preferredDefaultFavoriteCollectionId = persistedState.defaultFavoriteCollectionId === null || typeof persistedState.defaultFavoriteCollectionId === 'string'
    ? persistedState.defaultFavoriteCollectionId
    : fallback.defaultFavoriteCollectionId

  return {
    settings,
    previousPresetConfig,
    dismissedPresetProfileIds: normalizeStringArray(persistedState.dismissedPresetProfileIds, fallback.dismissedPresetProfileIds ?? []),
    dismissedPresetProviderIds: normalizeStringArray(persistedState.dismissedPresetProviderIds, fallback.dismissedPresetProviderIds ?? []),
    params: normalizeParams(persistedState.params, fallback.params),
    dismissedCodexCliPrompts: normalizeStringArray(persistedState.dismissedCodexCliPrompts, fallback.dismissedCodexCliPrompts),
    appMode,
    galleryInputDraft: galleryInputDraft && !isEmptyAgentInputDraft(galleryInputDraft) ? galleryInputDraft : null,
    favoriteCollections,
    defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(favoriteCollections, preferredDefaultFavoriteCollectionId),
    promptHistory: normalizePromptHistory(persistedState.promptHistory),
    sceneDrafts: normalizeSceneDrafts(persistedState.sceneDrafts, normalizeParams(persistedState.params, fallback.params)),
    skillExpansionPrefs: normalizeSkillExpansionPrefs(persistedState.skillExpansionPrefs),
    supportPromptDismissed: Boolean(persistedState.supportPromptDismissed),
    supportPromptOpen: Boolean(persistedState.supportPromptOpen),
    supportPromptSkippedForImportedData: Boolean(persistedState.supportPromptSkippedForImportedData),
    prompt: galleryInputDraft?.prompt ?? '',
    inputImages: galleryInputDraft?.inputImages ?? [],
    maskDraft: galleryInputDraft?.maskDraft ?? null,
    maskEditorImageId: galleryInputDraft?.maskEditorImageId ?? null,
  }
}
