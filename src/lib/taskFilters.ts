import type { TaskRecord } from '../types'
import { ALL_FAVORITES_COLLECTION_ID, getTaskFavoriteCollectionIds as getTaskFavoriteCollectionIdsBase } from './favoriteState'
import { taskMatchesFilterStatus, taskMatchesSearchQuery } from '../store'

/**
 * 画廊任务过滤/排序的唯一样本（TaskGrid 与 InputBar 共用）。
 * 状态/搜索匹配委托 store 的 taskMatchesFilterStatus / taskMatchesSearchQuery
 * （语义唯一来源），这里只补充收藏过滤与排序。
 */
export function filterAndSortTasks(
  tasks: TaskRecord[],
  options: {
    searchQuery: string
    filterStatus: 'all' | 'running' | 'done' | 'error'
    filterFavorite: boolean
    activeFavoriteCollectionId?: string | null
    defaultFavoriteCollectionId?: string | null
  },
): TaskRecord[] {
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
  const q = options.searchQuery.trim()

  return sorted.filter((t) => {
    if (options.filterFavorite) {
      if (!t.isFavorite) return false
      const active = options.activeFavoriteCollectionId
      if (active && active !== ALL_FAVORITES_COLLECTION_ID) {
        const ids = getTaskFavoriteCollectionIdsBase(t, options.defaultFavoriteCollectionId ?? null)
        if (!ids.includes(active)) return false
      }
    }
    if (!taskMatchesFilterStatus(t, options.filterStatus)) return false
    return taskMatchesSearchQuery(t, q)
  })
}
