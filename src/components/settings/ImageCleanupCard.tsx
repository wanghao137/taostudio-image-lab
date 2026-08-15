import { useCallback, useEffect, useState } from 'react'
import { getCleanupPlan, rebuildDatabase, runImageCleanup, useStore } from '../../store'

/**
 * 可清理项驱逐入口（#20）：失败任务的流式中间图、老于 30 天任务的
 * 处理前原图副本。只展示数量并按需执行，不自动清理。
 */
export default function ImageCleanupCard() {
  const tasks = useStore((s) => s.tasks)
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [cleaning, setCleaning] = useState(false)
  const [plan, setPlan] = useState({ failedPartialCount: 0, staleOriginalCopyCount: 0, taskCount: 0 })

  useEffect(() => {
    setPlan(getCleanupPlan(tasks))
  }, [tasks])

  const handleCleanup = useCallback(() => {
    setConfirmDialog({
      title: '清理可释放图片',
      message: `将删除 ${plan.failedPartialCount} 张失败任务的中间图和 ${plan.staleOriginalCopyCount} 张老任务的处理前副本（30 天前的任务）。任务记录与输出图不受影响。`,
      confirmText: '清理',
      action: async () => {
        setCleaning(true)
        try {
          const removed = await runImageCleanup(useStore.getState().tasks)
          showToast(`已清理 ${removed} 张图片`, 'success')
        } catch (err) {
          showToast(`清理失败：${err instanceof Error ? err.message : String(err)}`, 'error')
        } finally {
          setCleaning(false)
        }
      },
    })
  }, [plan, setConfirmDialog, showToast])

  const handleRebuild = useCallback(() => {
    setConfirmDialog({
      title: '重建数据库（最后手段）',
      message: '删除整个本地数据库（所有任务、图片、会话）并重置为初始状态。仅当「清空数据」反复失败或存储损坏时使用；请先导出备份！此操作不可撤销。',
      confirmText: '删除全部并重建',
      tone: 'danger',
      action: async () => {
        try {
          await rebuildDatabase()
          showToast('数据库已重建，请刷新页面', 'success')
        } catch (err) {
          showToast(`重建失败：${err instanceof Error ? err.message : String(err)}`, 'error')
        }
      },
    })
  }, [setConfirmDialog, showToast])

  const totalCleanable = plan.failedPartialCount + plan.staleOriginalCopyCount

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] shadow-sm">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">存储清理</h4>
        {totalCleanable > 0 && (
          <span className="text-xs text-amber-600 dark:text-amber-400">可释放 {totalCleanable} 张</span>
        )}
      </div>
      <div className="mt-2 space-y-1 text-xs text-gray-500 dark:text-gray-400">
        <div>失败任务中间图：{plan.failedPartialCount} 张</div>
        <div>老任务处理前副本（30 天前）：{plan.staleOriginalCopyCount} 张</div>
        {totalCleanable === 0 && <div className="text-emerald-600 dark:text-emerald-400">暂无可清理项</div>}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={handleCleanup}
          disabled={totalCleanable === 0 || cleaning}
          className="rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 disabled:opacity-50 disabled:hover:bg-gray-100/80 disabled:hover:text-gray-700 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
        >
          {cleaning ? '清理中…' : '清理可释放图片'}
        </button>
        <button
          type="button"
          onClick={handleRebuild}
          className="rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-medium text-red-600 transition-all hover:bg-red-50 dark:border-red-900/50 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/30"
        >
          重建数据库
        </button>
      </div>
      <p className="mt-2 text-[11px] text-gray-400 dark:text-gray-500">
        重建会删除本地全部数据（含图片），是「清空数据」反复失败时的逃生门；请先导出备份。
      </p>
    </div>
  )
}
