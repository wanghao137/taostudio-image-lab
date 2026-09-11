import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import Select from './Select'
import { Checkbox } from './Checkbox'
import { CloseIcon } from './icons'
import { SCENE_TABS } from './Header'
import { isLocalAutoSaveSupported } from '../lib/localAutoSave'
import {
  DEFAULT_IMAGES_MODEL,
  DEFAULT_RESPONSES_MODEL,
  getActiveApiProfile,
  getApiProviderLabel,
  getSceneImageApiProfile,
  getSceneTextApiProfileResolution,
  isTextCapableApiProfile,
} from '../lib/apiProfiles'
import { COMMON_IMAGE_RATIOS, type SizeTier } from '../lib/size'
import type { SceneDefaults, SceneId, SceneSettings } from '../types'

const EMPTY_SCENE_SETTINGS: SceneSettings = {
  imageProfileId: null,
  textProfileId: null,
  saveDirectoryName: null,
  defaults: {},
}

function getSceneLabel(scene: SceneId): string {
  // SCENE_TABS 已含全部场景，id 兜底仅防御
  return SCENE_TABS.find((tab) => tab.id === scene)?.label ?? scene
}

const TEXT_RESOLVED_BY_LABELS: Record<string, string> = {
  explicit: '手动指定',
  active: '自动跟随生图配置',
  sole: '自动采用唯一可用文本配置',
}

const SELECT_CLASS_NAME = 'w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50'
const INPUT_CLASS_NAME = 'w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50'
const SECTION_CARD_CLASS_NAME = 'rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] space-y-3 shadow-sm'
const SECTION_TITLE_CLASS_NAME = 'text-sm font-bold text-gray-800 dark:text-gray-100'
const SECTION_HINT_CLASS_NAME = 'text-xs leading-relaxed text-gray-400 dark:text-gray-500'
const SUMMARY_CLASS_NAME = 'text-xs leading-relaxed text-stone-500 dark:text-stone-400'

/** 场景覆盖文本输入：本地草稿态，onBlur 提交（trim，空→null 回跟随），store 值外部变化时回同步 */
function SceneOverrideTextInput({ id, value, placeholder, onCommit }: {
  id?: string
  value: string | null
  placeholder: string
  onCommit: (next: string | null) => void
}) {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => { setDraft(value ?? '') }, [value])
  return (
    <input
      id={id}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const trimmed = draft.trim()
        if (trimmed === (value?.trim() ?? '')) {
          // 与已存值相同（如仅多出空白）：跳过提交，但把输入框回写为 trim 后
          // 文本，避免残留未 trim 的显示值。
          setDraft(trimmed)
          return
        }
        onCommit(trimmed || null)
      }}
      placeholder={placeholder}
      className={INPUT_CLASS_NAME}
    />
  )
}

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={SECTION_CARD_CLASS_NAME}>
      <h4 className={SECTION_TITLE_CLASS_NAME}>{title}</h4>
      {children}
    </section>
  )
}

/**
 * 场景设置抽屉：生图模型 / 保存目录 / 文本模型 / 默认参数 四组配置。
 * 绑定调用方传入的场景（当前 activeScene），所有修改即时落 store，无草稿态。
 */
export function SceneSettingsDrawer({ scene, onClose }: { scene: SceneId; onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const setSceneImageProfileId = useStore((s) => s.setSceneImageProfileId)
  const setSceneImageOverrides = useStore((s) => s.setSceneImageOverrides)
  const setSceneTextProfileId = useStore((s) => s.setSceneTextProfileId)
  const setSceneDefaults = useStore((s) => s.setSceneDefaults)
  const selectSceneSaveDirectory = useStore((s) => s.selectSceneSaveDirectory)
  const clearSceneSaveDirectory = useStore((s) => s.clearSceneSaveDirectory)

  const scrollRef = useRef<HTMLDivElement>(null)
  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true, scrollRef)

  const sceneSettings = settings.scenes[scene] ?? EMPTY_SCENE_SETTINGS
  const activeProfile = getActiveApiProfile(settings)
  const localAutoSaveSupported = isLocalAutoSaveSupported()
  const localAutoSaveEnabled = settings.localAutoSave.enabled

  // 场景引用的具体配置：覆盖控件（服务商/模型）只对具体配置有意义
  const referencedProfile = sceneSettings.imageProfileId
    ? settings.profiles.find((profile) => profile.id === sceneSettings.imageProfileId) ?? null
    : null
  // 解析链（getSceneImageApiProfile 显式传 scene，非 activeScene 场景也能预览）：
  // 引用 profile → 服务商草稿切换 → 模型覆盖，与提交任务时完全同链
  const resolvedImageProfile = getSceneImageApiProfile(settings, scene)

  // 服务商选项只列该配置 providerDrafts 已有草稿的 provider（排除当前 provider）；
  // 绝不列无草稿 provider：首切新 provider 显空会被误认为配置丢失。
  const providerDraftIds = referencedProfile
    ? Object.keys(referencedProfile.providerDrafts ?? {}).filter((id) => id !== referencedProfile.provider)
    : []
  // 兜底：场景覆盖的 provider 不在草稿选项里时补一条选项，避免 Select 显示裸 id。
  // 典型场景：全局把该配置切到与场景覆盖相同的服务商后，该 provider 因是当前
  // provider 被草稿列表排除（草稿已消费），但场景内存值（未归一化折叠）仍是它；
  // 也覆盖草稿缺失的其他残留值。label 回落 getApiProviderLabel 的裸 id 兜底。
  const sceneProviderId = sceneSettings.imageProviderId ?? ''
  const providerFallbackIds = referencedProfile && sceneProviderId && !providerDraftIds.includes(sceneProviderId)
    ? [sceneProviderId]
    : []
  const providerOptions = [
    { label: `跟随该配置当前（${getApiProviderLabel(settings, referencedProfile?.provider ?? 'openai')}）`, value: '' },
    ...providerDraftIds.map((id) => ({ label: getApiProviderLabel(settings, id), value: id })),
    ...providerFallbackIds.map((id) => ({ label: getApiProviderLabel(settings, id), value: id })),
  ]
  const resolvedSummary = `实际生效：${getApiProviderLabel(settings, resolvedImageProfile.provider)} · ${resolvedImageProfile.apiMode} · 模型 ${resolvedImageProfile.model}` +
    (resolvedImageProfile.apiMode === 'responses' ? ` · 生图 ${resolvedImageProfile.imageGenerationModel || '默认'}` : '')

  const imageProfileOptions = [
    { label: `跟随全局（当前：${activeProfile.name}）`, value: '' },
    ...settings.profiles.map((profile) => ({
      label: `${profile.name} · ${getApiProviderLabel(settings, profile.provider)} · ${profile.model}`,
      value: profile.id,
    })),
  ]

  const textProfiles = settings.profiles.filter(isTextCapableApiProfile)
  const textProfileOptions = [
    { label: '跟随全局文本路由', value: '' },
    ...textProfiles.map((profile) => ({
      label: `${profile.name} · ${profile.model || DEFAULT_RESPONSES_MODEL}`,
      value: profile.id,
    })),
  ]
  // getSceneTextApiProfileResolution 按 settings.activeScene 解析；本抽屉只以 activeScene 打开，两者一致。
  const sceneIsActiveScene = scene === settings.activeScene
  const textResolution = sceneIsActiveScene ? getSceneTextApiProfileResolution(settings) : null

  const ratioOptions = [
    { label: '跟随当前选择', value: '' },
    ...COMMON_IMAGE_RATIOS.map((ratio) => ({ label: ratio.label, value: ratio.value })),
  ]

  const tierOptions = [
    { label: '跟随当前选择', value: '' },
    { label: '1K', value: '1K' },
    { label: '2K', value: '2K' },
    { label: '4K', value: '4K' },
  ]

  const patchDefaults = (patch: Partial<SceneDefaults>) => setSceneDefaults(scene, patch)

  return (
    <div data-no-drag-select className="fixed inset-0 z-[90] flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        ref={scrollRef}
        className="safe-area-top safe-area-bottom relative z-10 flex h-full w-full flex-col overflow-y-auto border-l border-white/50 bg-white/90 shadow-2xl ring-1 ring-black/5 backdrop-blur-xl animate-drawer-right-in custom-scrollbar dark:border-white/[0.08] dark:bg-gray-900/90 dark:ring-white/10 sm:max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-gray-100 bg-white/80 px-5 py-4 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/80">
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold text-gray-800 dark:text-gray-100">{getSceneLabel(scene)} · 场景设置</h3>
            <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">仅影响本场景的生图与默认参数</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="ml-3 shrink-0 rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 p-4">
          {/* 一、生图模型 */}
          <SectionCard title="生图模型">
            <div className="block">
              <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">场景生图配置</span>
              <Select
                value={sceneSettings.imageProfileId ?? ''}
                onChange={(value: string) => {
                  setSceneImageProfileId(scene, value || null)
                  // 切换/清除引用配置时同步清空三项覆盖：旧 provider 草稿与模型覆盖对另一配置无意义，
                  // 与持久化归一化（imageProfileId 为 null 时三字段折叠 null）语义保持一致。
                  setSceneImageOverrides(scene, { imageProviderId: null, imageModelOverride: null, imageGenerationModelOverride: null })
                }}
                options={imageProfileOptions}
                className={SELECT_CLASS_NAME}
              />
              <p className={SECTION_HINT_CLASS_NAME}>本场景提交生图任务时优先使用此配置；选择跟随全局时使用全局激活配置。</p>
            </div>
            {referencedProfile ? (
              <>
                <div className="block">
                  <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">服务商</span>
                  <Select
                    value={sceneSettings.imageProviderId ?? ''}
                    onChange={(value: string) => setSceneImageOverrides(scene, { imageProviderId: value || null })}
                    options={providerOptions}
                    className={SELECT_CLASS_NAME}
                  />
                  <p className={SECTION_HINT_CLASS_NAME}>可选项来自该配置内已保存的服务商草稿（在设置 → API 中切换过服务商即产生草稿）。</p>
                </div>
                <div className="block">
                  <label htmlFor={`scene-model-override-${scene}`} className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">模型 ID</label>
                  <SceneOverrideTextInput
                    id={`scene-model-override-${scene}`}
                    value={sceneSettings.imageModelOverride ?? null}
                    placeholder={resolvedImageProfile.model}
                    onCommit={(next) => setSceneImageOverrides(scene, { imageModelOverride: next })}
                  />
                  <p className={SECTION_HINT_CLASS_NAME}>覆盖本场景提交时使用的模型 ID；留空跟随该配置当前值。</p>
                </div>
                {resolvedImageProfile.apiMode === 'responses' && (
                  <div className="block">
                    <label htmlFor={`scene-igm-override-${scene}`} className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">图像生成模型</label>
                    <SceneOverrideTextInput
                      id={`scene-igm-override-${scene}`}
                      value={sceneSettings.imageGenerationModelOverride ?? null}
                      placeholder={resolvedImageProfile.imageGenerationModel || DEFAULT_IMAGES_MODEL}
                      onCommit={(next) => setSceneImageOverrides(scene, { imageGenerationModelOverride: next })}
                    />
                    <p className={SECTION_HINT_CLASS_NAME}>Responses 模式下 image_generation 工具使用的图像模型；留空跟随该配置当前值。</p>
                  </div>
                )}
                <p className={SUMMARY_CLASS_NAME}>{resolvedSummary}</p>
              </>
            ) : (
              <p className={SECTION_HINT_CLASS_NAME}>选择具体配置后可覆盖服务商与模型。</p>
            )}
          </SectionCard>

          {/* 二、保存目录 */}
          <SectionCard title="保存目录">
            {!localAutoSaveSupported ? (
              <div className="rounded-xl border border-yellow-200/70 bg-yellow-50 px-3 py-2 text-xs leading-relaxed text-yellow-700 dark:border-yellow-500/20 dark:bg-yellow-500/10 dark:text-yellow-200">
                本地自动保存仅支持桌面 Chrome/Edge。移动端暂不支持本地自动保存，可继续使用手动下载。
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-gray-700 dark:text-gray-300">本地自动保存总开关</p>
                    <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">与全局设置的开关为同一项，场景目录需在总开关开启后生效。</p>
                  </div>
                  <Checkbox
                    checked={localAutoSaveEnabled}
                    onChange={(enabled) => setSettings({ localAutoSave: { ...settings.localAutoSave, enabled } })}
                    label={localAutoSaveEnabled ? '开启' : '关闭'}
                  />
                </div>
                {localAutoSaveEnabled ? (
                  <div className="space-y-2.5">
                    <div className="rounded-xl bg-gray-50/80 p-3 text-xs leading-relaxed text-gray-600 dark:bg-white/[0.04] dark:text-gray-300">
                      <div>场景保存目录：{sceneSettings.saveDirectoryName ?? '跟随全局目录'}</div>
                      <div>全局目录：{settings.localAutoSave.directoryName ?? '未选择'}</div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <button
                        type="button"
                        onClick={() => { void selectSceneSaveDirectory(scene) }}
                        className="rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
                      >
                        选择独立目录
                      </button>
                      <button
                        type="button"
                        onClick={() => { void clearSceneSaveDirectory(scene) }}
                        disabled={!sceneSettings.saveDirectoryName}
                        className="rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-gray-100/80 disabled:hover:text-gray-700 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white dark:disabled:hover:bg-white/[0.06] dark:disabled:hover:text-gray-300"
                      >
                        清除
                      </button>
                    </div>
                    <p className={SECTION_HINT_CLASS_NAME}>设置后本场景生成的 4K 图片自动保存到场景目录，清除后跟随全局目录。</p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-yellow-200/70 bg-yellow-50 px-3 py-2 text-xs leading-relaxed text-yellow-700 dark:border-yellow-500/20 dark:bg-yellow-500/10 dark:text-yellow-200">
                    已停用本地自动保存，开启总开关后可为本场景指定独立保存目录。
                  </div>
                )}
              </>
            )}
          </SectionCard>

          {/* 三、文本模型 */}
          <SectionCard title="文本模型">
            <div className="block">
              <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">场景文本配置</span>
              <Select
                value={sceneSettings.textProfileId ?? ''}
                onChange={(value: string) => setSceneTextProfileId(scene, value || null)}
                options={textProfileOptions}
                className={SELECT_CLASS_NAME}
              />
              {!sceneIsActiveScene ? (
                <p className={SECTION_HINT_CLASS_NAME}>切换到该场景后可查看文本路由详情。</p>
              ) : textResolution?.profile ? (
                <p className={SECTION_HINT_CLASS_NAME}>
                  本场景反推提示词等文本功能使用：{textResolution.profile.name} · {textResolution.profile.model || DEFAULT_RESPONSES_MODEL}
                  （{TEXT_RESOLVED_BY_LABELS[textResolution.resolvedBy ?? ''] ?? '自动'}）
                </p>
              ) : (
                <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                  未找到可用的文本模型配置（需 Responses 类型），可在设置→API 中添加
                </p>
              )}
            </div>
          </SectionCard>

          {/* 四、默认参数 */}
          <SectionCard title="默认参数">
            <div className="block">
              <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">默认比例</span>
              <Select
                value={sceneSettings.defaults.ratio ?? ''}
                onChange={(value: string) => patchDefaults({ ratio: value || undefined })}
                options={ratioOptions}
                className={SELECT_CLASS_NAME}
              />
            </div>
            <div className="block">
              <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">默认档位</span>
              <Select
                value={sceneSettings.defaults.tier ?? ''}
                onChange={(value: string) => patchDefaults({ tier: (value || undefined) as SizeTier | undefined })}
                options={tierOptions}
                className={SELECT_CLASS_NAME}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Checkbox
                  checked={sceneSettings.defaults.transparentBackground === true}
                  onChange={(checked) => patchDefaults({ transparentBackground: checked })}
                  label="透明背景"
                />
                <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                  勾选进入场景时自动开启透明背景，取消勾选则强制关闭。
                </p>
              </div>
              {sceneSettings.defaults.transparentBackground !== undefined && (
                <button
                  type="button"
                  onClick={() => patchDefaults({ transparentBackground: undefined })}
                  className="shrink-0 text-xs text-blue-500 transition hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  恢复跟随
                </button>
              )}
            </div>
            <p className={SECTION_HINT_CLASS_NAME}>切换到本场景时应用以上默认参数，未设置的项保持当前值。</p>
          </SectionCard>
        </div>
      </div>
    </div>
  )
}

export default SceneSettingsDrawer
