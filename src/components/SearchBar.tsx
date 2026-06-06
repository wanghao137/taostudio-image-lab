import { useStore } from '../store'
import Select from './Select'
import { ChevronLeftIcon, FavoriteIcon, CollectionManageIcon } from './icons'

export default function SearchBar() {
  const searchQuery = useStore((s) => s.searchQuery)
  const setSearchQuery = useStore((s) => s.setSearchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const setFilterStatus = useStore((s) => s.setFilterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const setFilterFavorite = useStore((s) => s.setFilterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const setActiveFavoriteCollectionId = useStore((s) => s.setActiveFavoriteCollectionId)
  const openManageCollectionsModal = useStore((s) => s.openManageCollectionsModal)
  const inCollectionOverview = filterFavorite && !activeFavoriteCollectionId

  const handleFavoriteClick = () => {
    if (activeFavoriteCollectionId) {
      setActiveFavoriteCollectionId(null)
      return
    }
    setFilterFavorite(!filterFavorite)
  }

  return (
    <div data-no-drag-select className="my-3 rounded-xl border border-stone-200/80 bg-white/65 p-2 shadow-sm backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.035]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative z-10 min-w-0 flex-1">
          <svg
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400 dark:text-stone-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            type="text"
            placeholder={inCollectionOverview ? '搜索收藏夹' : '搜索提示词、模型、尺寸'}
            className="h-10 w-full rounded-lg border border-transparent bg-stone-50/90 pl-10 pr-4 text-sm text-stone-800 outline-none transition focus:border-[#356c82]/45 focus:bg-white focus:ring-2 focus:ring-[#356c82]/15 dark:bg-black/18 dark:text-stone-100 dark:focus:border-[#8ec5d7]/35 dark:focus:bg-black/25 dark:focus:ring-[#8ec5d7]/15"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!inCollectionOverview && (
            <div className="relative w-36">
              <Select
                value={filterStatus}
                onChange={(val) => setFilterStatus(val as 'all' | 'done' | 'running' | 'error')}
                options={[
                  { label: '全部状态', value: 'all' },
                  { label: '已完成', value: 'done' },
                  { label: '生成中', value: 'running' },
                  { label: '失败', value: 'error' },
                ]}
                className="h-10 rounded-lg border border-stone-200/80 bg-stone-50/90 px-3 text-sm text-stone-700 transition hover:bg-white focus:outline-none focus:ring-2 focus:ring-[#356c82]/15 dark:border-white/[0.08] dark:bg-black/18 dark:text-stone-200 dark:hover:bg-white/[0.06]"
              />
            </div>
          )}
          <button
            type="button"
            onClick={handleFavoriteClick}
            className={`flex h-10 w-10 items-center justify-center rounded-lg border transition-all ${
              filterFavorite
                ? 'border-amber-300 bg-amber-50 text-amber-500 shadow-[0_0_0_3px_rgba(245,158,11,0.12)] dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-300'
                : 'border-stone-200/80 bg-stone-50/90 text-stone-400 hover:bg-white hover:text-amber-500 dark:border-white/[0.08] dark:bg-black/18 dark:text-stone-500 dark:hover:bg-white/[0.06] dark:hover:text-amber-300'
            }`}
            title={activeFavoriteCollectionId ? '返回收藏夹' : filterFavorite ? '退出收藏视图' : '收藏'}
          >
            {activeFavoriteCollectionId ? <ChevronLeftIcon className="h-5 w-5" /> : <FavoriteIcon filled={filterFavorite} className="h-5 w-5" />}
          </button>
          {inCollectionOverview && (
            <button
              type="button"
              onClick={openManageCollectionsModal}
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-stone-200/80 bg-stone-50/90 text-stone-400 transition-all hover:bg-white hover:text-[#356c82] dark:border-white/[0.08] dark:bg-black/18 dark:text-stone-500 dark:hover:bg-white/[0.06] dark:hover:text-[#8ec5d7]"
              title="管理收藏夹"
            >
              <CollectionManageIcon className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
