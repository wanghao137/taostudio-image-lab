import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Settings2 } from 'lucide-react'
import { initStore, restoreExplicitPresetConfig, useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, getExplicitUrlSettingsIds, hasUrlSettingParams } from './lib/urlSettings'
import { createDefaultOpenAIProfile, hasDefaultPresetConfig, normalizeSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, hasEmbeddedDefaultConfig, loadCustomProviderSettingsFromUrl, loadEmbeddedDefaultConfig } from './lib/customProviderConfigUrl'
import { getDefaultPresetProfileId, getPresetProfileIds, isPresetConfigOnlyEnabled, setPresetConfig } from './lib/presetConfig'
import type { AppSettings, SceneId } from './types'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import { useIsMobile } from './hooks/useIsMobile'
import Header, { SCENE_TABS } from './components/Header'
import SearchBar from './components/SearchBar'
import InputBar from './components/InputBar'
import Toast from './components/Toast'
import ImageContextMenu from './components/ImageContextMenu'
import MobileShell from './components/MobileShell'
import { useGlobalClickSuppression } from './lib/clickSuppression'
import ErrorBoundary from './components/ErrorBoundary'

// 移动端统计降级：仅保留这三项；桌面端 6 项不变。
const MOBILE_STAT_LABELS = ['输出', '生成中', '收藏']

let defaultConfigImportStarted = false
const EngineWorkspace = lazy(() => import('./components/EngineWorkspace'))
const TaskGrid = lazy(() => import('./components/TaskGrid'))
const DetailModal = lazy(() => import('./components/DetailModal'))
const Lightbox = lazy(() => import('./components/Lightbox'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))
const ConfirmDialog = lazy(() => import('./components/ConfirmDialog'))
const MaskEditorModal = lazy(() => import('./components/MaskEditorModal'))
const StickerSplitModal = lazy(() => import('./components/StickerSplitModal'))
const PromptReverseModal = lazy(() => import('./components/PromptReverseModal'))
const SupportPromptModal = lazy(() => import('./components/SupportPromptModal'))
const FavoriteCollectionsView = lazy(() =>
  import('./components/FavoriteCollections').then((module) => ({ default: module.FavoriteCollectionsView })),
)
const FavoriteCollectionPickerModal = lazy(() =>
  import('./components/FavoriteCollections').then((module) => ({ default: module.FavoriteCollectionPickerModal })),
)
const ManageCollectionsModal = lazy(() =>
  import('./components/FavoriteCollections').then((module) => ({ default: module.ManageCollectionsModal })),
)
const MobileComposeSheet = lazy(() => import('./components/MobileComposeSheet'))
const SceneSettingsDrawer = lazy(() =>
  import('./components/SceneSettingsDrawer').then((module) => ({ default: module.SceneSettingsDrawer })),
)
const SkillWorkshop = lazy(() =>
  import('./components/SkillWorkshop').then((module) => ({ default: module.SkillWorkshop })),
)

function getSceneLabel(scene: SceneId): string {
  // SCENE_TABS 已含全部场景，id 兜底仅防御
  return SCENE_TABS.find((tab) => tab.id === scene)?.label ?? scene
}

export function GalleryWorkspaceHeader({ onOpenSceneSettings }: { onOpenSceneSettings: () => void }) {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const activeScene = useStore((s) => s.settings.activeScene)
  const gallerySceneFilter = useStore((s) => s.gallerySceneFilter)
  const setGallerySceneFilter = useStore((s) => s.setGallerySceneFilter)
  const isMobile = useIsMobile()

  const stats = useMemo(() => {
    return tasks.reduce(
      (acc, task) => {
        acc.total += 1
        acc.outputs += task.status === 'done' ? task.outputImages.length : 0
        acc.saved += task.isFavorite ? 1 : 0
        acc[task.status] += 1
        return acc
      },
      { total: 0, running: 0, done: 0, error: 0, outputs: 0, saved: 0 },
    )
  }, [tasks])

  const statusLabel = filterStatus === 'all'
    ? '全部'
    : filterStatus === 'done'
    ? '已完成'
    : filterStatus === 'running'
    ? '生成中'
    : '失败'
  const scopeLabel = filterFavorite
    ? activeFavoriteCollectionId
      ? '收藏夹'
      : '收藏'
    : '画廊'

  const statItems = [
    { label: '任务', value: stats.total, tone: 'text-stone-900 dark:text-stone-50' },
    { label: '生成中', value: stats.running, tone: 'text-[#356c82] dark:text-[#8ec5d7]' },
    { label: '已完成', value: stats.done, tone: 'text-[#6f8f72] dark:text-[#b1d0a6]' },
    { label: '失败', value: stats.error, tone: 'text-red-500 dark:text-red-300' },
    { label: '输出', value: stats.outputs, tone: 'text-[#df7b57] dark:text-[#ffb096]' },
    { label: '收藏', value: stats.saved, tone: 'text-amber-500 dark:text-amber-300' },
  ]
  // 移动端仅保留「输出 / 生成中 / 收藏」三项，桌面端 6 项不变。
  const visibleStatItems = isMobile
    ? statItems.filter((item) => MOBILE_STAT_LABELS.includes(item.label))
    : statItems

  return (
    <section data-no-drag-select data-ui-summary className="mt-4">
      <div className="overflow-hidden rounded-xl border border-stone-200/80 bg-white/70 shadow-[0_18px_50px_rgba(72,54,35,0.08)] ring-1 ring-white/70 backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-[0_18px_60px_rgba(0,0,0,0.28)] dark:ring-white/[0.04]">
        <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-[#df7b57] shadow-[0_0_0_4px_rgba(223,123,87,0.14)]" />
              <h2 className="truncate text-sm font-semibold tracking-normal text-stone-900 dark:text-stone-50">
                创作工作台
              </h2>
              <span className="rounded-md border border-[#356c82]/20 bg-[#356c82]/10 px-2 py-0.5 text-[11px] font-medium text-[#356c82] dark:border-[#8ec5d7]/20 dark:bg-[#8ec5d7]/10 dark:text-[#8ec5d7]">
                {scopeLabel}
              </span>
              {/* 一键全部开关：当前场景过滤 ↔ 全部场景，文案随状态翻转（桌面与移动共用头部） */}
              <button
                type="button"
                onClick={() => setGallerySceneFilter(gallerySceneFilter === 'all' ? activeScene : 'all')}
                title={gallerySceneFilter === 'all' ? `只看「${getSceneLabel(activeScene)}」场景的任务` : '查看全部场景的任务'}
                className="shrink-0 rounded-md border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-500 transition-colors hover:border-stone-300 hover:bg-stone-100 hover:text-stone-700 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-stone-300 dark:hover:bg-white/[0.1] dark:hover:text-stone-100"
              >
                {gallerySceneFilter === 'all' ? `仅${getSceneLabel(activeScene)}` : '全部'}
              </button>
              <span className="rounded-md border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-stone-300">
                {statusLabel}
              </span>
              {/* 场景设置抽屉入口：仅画廊工作台头部渲染（桌面与移动共用），绑定当前 activeScene */}
              <button
                type="button"
                onClick={onOpenSceneSettings}
                aria-label="场景设置"
                title="场景设置"
                className="ml-auto shrink-0 rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-white/[0.08] dark:hover:text-stone-100"
              >
                <Settings2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
            {searchQuery.trim() ? (
              <p className="mt-1 truncate text-xs text-stone-500 dark:text-stone-400">
                搜索：{searchQuery.trim()}
              </p>
            ) : null}
          </div>
          <div className="flex gap-1.5 sm:items-center sm:justify-end sm:gap-2 sm:overflow-visible sm:pb-0">
            {visibleStatItems.map((item) => (
              <div
                key={item.label}
                className="min-w-[76px] shrink-0 rounded-lg border border-stone-200/70 bg-stone-50/80 px-2.5 py-2 dark:border-white/[0.08] dark:bg-black/18"
              >
                <div className={`font-mono text-base font-semibold leading-none ${item.tone}`}>{item.value}</div>
                <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-stone-400 dark:text-stone-500">{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

export default function App() {
  const appMode = useStore((s) => s.appMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const showSettings = useStore((s) => s.showSettings)
  const confirmDialog = useStore((s) => s.confirmDialog)
  const supportPromptOpen = useStore((s) => s.supportPromptOpen)
  const maskEditorImageId = useStore((s) => s.maskEditorImageId)
  const stickerSplitSource = useStore((s) => s.stickerSplitSource)
  const promptReverseSource = useStore((s) => s.promptReverseSource)
  const favoritePickerTaskIds = useStore((s) => s.favoritePickerTaskIds)
  const isManageCollectionsModalOpen = useStore((s) => s.isManageCollectionsModalOpen)
  const activeScene = useStore((s) => s.settings.activeScene)
  const isMobile = useIsMobile()
  // composeOpen 由 Task 5 的 MobileComposeSheet 消费；setComposeOpen 由 FAB 触发。
  const [composeOpen, setComposeOpen] = useState(false)
  // 场景设置抽屉：从画廊工作台头部齿轮打开，始终绑定当前 activeScene。
  const [sceneSettingsOpen, setSceneSettingsOpen] = useState(false)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    if (defaultConfigImportStarted) return
    defaultConfigImportStarted = true

    const searchParams = new URLSearchParams(window.location.search)
    const customProviderConfigUrl = getCustomProviderConfigUrl()
    const embeddedDefaultConfig = hasEmbeddedDefaultConfig()
    const loadDefaultConfig = () => embeddedDefaultConfig
      ? Promise.resolve().then(() => loadEmbeddedDefaultConfig())
      : loadCustomProviderSettingsFromUrl(customProviderConfigUrl)

    const applyUrlSettings = async (baseSettings: Partial<AppSettings>) => {
      const ids = getExplicitUrlSettingsIds(searchParams)
      const restored = await restoreExplicitPresetConfig(ids)
      const restoredSettings = useStore.getState().settings
      const sourceSettings = restored
        ? { ...restoredSettings, ...baseSettings, customProviders: restoredSettings.customProviders, profiles: restoredSettings.profiles }
        : baseSettings
      const nextSettings = buildSettingsFromUrlParams(sourceSettings, searchParams)
      return Object.keys(nextSettings).length ? nextSettings : sourceSettings
    }

    const clearAppliedUrlSettings = () => {
      if (!hasUrlSettingParams(searchParams)) return
      clearUrlSettingParams(searchParams)
      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    void initStore()
      .then(async () => {
        const importedSettings = embeddedDefaultConfig || customProviderConfigUrl
          ? await loadDefaultConfig()
          : hasDefaultPresetConfig()
            ? {
                customProviders: [],
                profiles: [{ ...createDefaultOpenAIProfile(), isDefault: true }],
              }
            : null
        setPresetConfig(importedSettings)

        const state = useStore.getState()
        if (importedSettings) {
          await state.setPresetImportedSettings(importedSettings)
        } else if (state.previousPresetConfig) {
          await state.setPresetImportedSettings({ customProviders: [], profiles: [] })
        }

        const syncedState = useStore.getState()
        if (!importedSettings) {
          useStore.setState({ dismissedPresetProfileIds: [], dismissedPresetProviderIds: [] })
          if (syncedState.settings.profiles.some((profile) => profile.isDefault)) {
            syncedState.setSettings({
              profiles: syncedState.settings.profiles.map((profile) => profile.isDefault ? { ...profile, isDefault: undefined } : profile),
            })
          }
        }

        const current = useStore.getState()
        const presetIds = getPresetProfileIds()
        const defaultPresetId = getDefaultPresetProfileId()
        const settings = isPresetConfigOnlyEnabled()
          ? normalizeSettings({
              ...current.settings,
              activeProfileId: presetIds.has(current.settings.activeProfileId)
                ? current.settings.activeProfileId
                : defaultPresetId ?? [...presetIds][0],
            })
          : current.settings
        current.setSettings(await applyUrlSettings(settings))
        clearAppliedUrlSettings()
      })
      .catch((error) => {
        console.warn('Failed to import preset config:', error)
        setPresetConfig(null)
        const state = useStore.getState()
        void applyUrlSettings(state.settings).then((settings) => {
          useStore.getState().setSettings(settings)
          clearAppliedUrlSettings()
        })
      })
  }, [])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  return (
    <>
      {isMobile ? (
        <MobileShell composeHidden={activeScene === 'skill'} onOpenCompose={() => setComposeOpen(true)}>
          <ErrorBoundary sectionLabel={appMode === 'engine' ? '引擎工作台' : activeScene === 'skill' ? 'Skill 工坊' : '画廊'}>
            {appMode === 'engine' ? (
              <>
                <div className="safe-area-x">
                  <div className="m-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                    引擎工作台信息密度较高，建议在桌面端使用以获得更好体验。
                  </div>
                </div>
                <Suspense fallback={<div className="min-h-[320px]" />}>
                  <EngineWorkspace />
                </Suspense>
              </>
            ) : activeScene === 'skill' ? (
              <div className="safe-area-x max-w-7xl mx-auto">
                <Suspense fallback={<div className="min-h-[320px]" />}>
                  <SkillWorkshop onOpenSceneSettings={() => setSceneSettingsOpen(true)} />
                </Suspense>
              </div>
            ) : (
              <div className="safe-area-x max-w-7xl mx-auto">
                <GalleryWorkspaceHeader onOpenSceneSettings={() => setSceneSettingsOpen(true)} />
                <SearchBar />
                {filterFavorite && !activeFavoriteCollectionId ? (
                  <Suspense fallback={null}>
                    <FavoriteCollectionsView />
                  </Suspense>
                ) : (
                  <Suspense fallback={<div className="min-h-[220px]" />}>
                    <TaskGrid />
                  </Suspense>
                )}
              </div>
            )}
          </ErrorBoundary>
        </MobileShell>
      ) : (
        <>
          <Header />
          <ErrorBoundary sectionLabel={appMode === 'engine' ? '引擎工作台' : activeScene === 'skill' ? 'Skill 工坊' : '画廊'}>
            {appMode === 'engine' ? (
              <Suspense fallback={<div className="min-h-[320px]" />}>
                <EngineWorkspace />
              </Suspense>
            ) : activeScene === 'skill' ? (
              <main data-home-main data-drag-select-surface className="pb-6">
                <div className="safe-area-x max-w-7xl mx-auto">
                  <Suspense fallback={<div className="min-h-[320px]" />}>
                    <SkillWorkshop onOpenSceneSettings={() => setSceneSettingsOpen(true)} />
                  </Suspense>
                </div>
              </main>
            ) : (
              <main data-home-main data-drag-select-surface className="pb-[calc(var(--input-bar-clearance,12rem)+1.5rem)]">
                <div className="safe-area-x max-w-7xl mx-auto">
                  <GalleryWorkspaceHeader onOpenSceneSettings={() => setSceneSettingsOpen(true)} />
                  <SearchBar />
                  {filterFavorite && !activeFavoriteCollectionId ? (
                    <Suspense fallback={null}>
                      <FavoriteCollectionsView />
                    </Suspense>
                  ) : (
                    <Suspense fallback={<div className="min-h-[220px]" />}>
                      <TaskGrid />
                    </Suspense>
                  )}
                </div>
              </main>
            )}
            {appMode === 'gallery' && activeScene !== 'skill' && <InputBar />}
          </ErrorBoundary>
        </>
      )}

      {/* 移动端创作抽屉（z-50，仅 <640px 渲染，组件内 sm:hidden 双重保险） */}
      {isMobile && (
        <Suspense fallback={null}>
          <MobileComposeSheet open={composeOpen} onClose={() => setComposeOpen(false)} />
        </Suspense>
      )}

      {/* 模态层：移动/桌面两端共用，保持在 Suspense 里；崩溃只炸单个模态不炸整页。
          key 随活动模态变化：切换查看对象时重置错误态，不让上一个崩溃污染下一个。 */}
      <ErrorBoundary
        key={detailTaskId ?? lightboxImageId ?? maskEditorImageId ?? (stickerSplitSource ? stickerSplitSource.imageId ?? stickerSplitSource.url ?? 'sticker' : null) ?? (promptReverseSource ? 'prompt-reverse' : null) ?? (showSettings ? 'settings' : isManageCollectionsModalOpen ? 'collections' : null) ?? (sceneSettingsOpen ? 'scene-settings' : null) ?? 'none'}
        sectionLabel="弹窗"
      >
        <Suspense fallback={null}>
          {detailTaskId ? <DetailModal /> : null}
          {lightboxImageId ? <Lightbox /> : null}
          {showSettings ? <SettingsModal /> : null}
          {confirmDialog ? <ConfirmDialog /> : null}
          {supportPromptOpen ? <SupportPromptModal /> : null}
          {maskEditorImageId ? <MaskEditorModal /> : null}
          {stickerSplitSource ? <StickerSplitModal /> : null}
          {promptReverseSource ? <PromptReverseModal /> : null}
          {favoritePickerTaskIds?.length ? <FavoriteCollectionPickerModal /> : null}
          {isManageCollectionsModalOpen ? <ManageCollectionsModal /> : null}
          {sceneSettingsOpen ? <SceneSettingsDrawer scene={activeScene} onClose={() => setSceneSettingsOpen(false)} /> : null}
        </Suspense>
      </ErrorBoundary>
      <Toast />
      <ImageContextMenu />
    </>
  )
}
