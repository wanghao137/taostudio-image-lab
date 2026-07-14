import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { initStore } from './store'
import { useStore } from './store'
import { buildSettingsFromUrlParams, clearUrlSettingParams, hasUrlSettingParams } from './lib/urlSettings'
import { mergeImportedSettings } from './lib/apiProfiles'
import { getCustomProviderConfigUrl, loadCustomProviderSettingsFromUrl } from './lib/customProviderConfigUrl'
import { useDockerApiUrlMigrationNotice } from './hooks/useDockerApiUrlMigrationNotice'
import { useIsMobile } from './hooks/useIsMobile'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import InputBar from './components/InputBar'
import Toast from './components/Toast'
import ImageContextMenu from './components/ImageContextMenu'
import MobileShell from './components/MobileShell'
import { useGlobalClickSuppression } from './lib/clickSuppression'

// 移动端统计降级：仅保留这三项；桌面端 6 项不变。
const MOBILE_STAT_LABELS = ['输出', '生成中', '收藏']

let customProviderConfigUrlImportStarted = false
const AgentWorkspace = lazy(() => import('./components/AgentWorkspace'))
const TaskGrid = lazy(() => import('./components/TaskGrid'))
const DetailModal = lazy(() => import('./components/DetailModal'))
const Lightbox = lazy(() => import('./components/Lightbox'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))
const ConfirmDialog = lazy(() => import('./components/ConfirmDialog'))
const MaskEditorModal = lazy(() => import('./components/MaskEditorModal'))
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

function GalleryWorkspaceHeader() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
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
              <span className="rounded-md border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-stone-300">
                {statusLabel}
              </span>
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
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const detailTaskId = useStore((s) => s.detailTaskId)
  const lightboxImageId = useStore((s) => s.lightboxImageId)
  const showSettings = useStore((s) => s.showSettings)
  const confirmDialog = useStore((s) => s.confirmDialog)
  const supportPromptOpen = useStore((s) => s.supportPromptOpen)
  const maskEditorImageId = useStore((s) => s.maskEditorImageId)
  const favoritePickerTaskIds = useStore((s) => s.favoritePickerTaskIds)
  const isManageCollectionsModalOpen = useStore((s) => s.isManageCollectionsModalOpen)
  const isMobile = useIsMobile()
  // composeOpen 由 Task 5 的 MobileComposeSheet 消费；setComposeOpen 由 FAB 触发。
  const [composeOpen, setComposeOpen] = useState(false)
  useDockerApiUrlMigrationNotice()
  useGlobalClickSuppression()

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    const nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    const customProviderConfigUrl = getCustomProviderConfigUrl()
    if (customProviderConfigUrl && !customProviderConfigUrlImportStarted) {
      customProviderConfigUrlImportStarted = true
      void loadCustomProviderSettingsFromUrl(customProviderConfigUrl)
        .then((importedSettings) => {
          if (!importedSettings) return
          const state = useStore.getState()
          state.setSettings(mergeImportedSettings(state.settings, importedSettings))
        })
        .catch((error) => {
          console.warn('Failed to import custom provider config URL:', error)
        })
    }

    initStore()
  }, [setSettings])

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
        <MobileShell onOpenCompose={() => setComposeOpen(true)}>
          {appMode === 'agent' ? (
            <div className="safe-area-x">
              <div className="m-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                智能体工作台为多图工作流，建议在桌面端使用以获得更好体验。
              </div>
              <Suspense fallback={null}>
                <AgentWorkspace />
              </Suspense>
            </div>
          ) : (
            <div className="safe-area-x max-w-7xl mx-auto">
              <GalleryWorkspaceHeader />
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
        </MobileShell>
      ) : (
        <>
          <Header />
          {appMode === 'agent' ? (
            <Suspense fallback={null}>
              <AgentWorkspace />
            </Suspense>
          ) : (
            <main data-home-main data-drag-select-surface className="pb-[calc(var(--input-bar-clearance,12rem)+1.5rem)]">
              <div className="safe-area-x max-w-7xl mx-auto">
                <GalleryWorkspaceHeader />
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
          <InputBar />
        </>
      )}

      {/* 移动端创作抽屉（z-50，仅 <640px 渲染，组件内 sm:hidden 双重保险） */}
      {isMobile && (
        <Suspense fallback={null}>
          <MobileComposeSheet open={composeOpen} onClose={() => setComposeOpen(false)} />
        </Suspense>
      )}

      {/* 模态层：移动/桌面两端共用，保持在 Suspense 里 */}
      <Suspense fallback={null}>
        {detailTaskId ? <DetailModal /> : null}
        {lightboxImageId ? <Lightbox /> : null}
        {showSettings ? <SettingsModal /> : null}
        {confirmDialog ? <ConfirmDialog /> : null}
        {supportPromptOpen ? <SupportPromptModal /> : null}
        {maskEditorImageId ? <MaskEditorModal /> : null}
        {favoritePickerTaskIds?.length ? <FavoriteCollectionPickerModal /> : null}
        {isManageCollectionsModalOpen ? <ManageCollectionsModal /> : null}
      </Suspense>
      <Toast />
      <ImageContextMenu />
    </>
  )
}
