import { useEffect, useState } from 'react'
import { estimateStorage } from '../../lib/db'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`
}

/**
 * 设置页存储用量条：配额耗尽会静默丢图（见 storeTaskOutputImages 的
 * StorageQuotaError 处理），让用户平时就能看到余量是第一道防线。
 */
export default function StorageUsageCard() {
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    void estimateStorage().then((result) => {
      if (!cancelled) setEstimate(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!estimate) {
    return (
      <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] shadow-sm">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">存储空间</h4>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">当前浏览器不支持存储用量估算。</p>
      </div>
    )
  }

  const { usage, quota } = estimate
  const ratio = quota > 0 ? usage / quota : 0
  const percent = Math.min(100, Math.round(ratio * 100))
  const tone = percent >= 90
    ? 'bg-red-500'
    : percent >= 75
      ? 'bg-amber-500'
      : 'bg-emerald-500'

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] shadow-sm">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">存储空间</h4>
        <span className="text-xs font-mono text-gray-500 dark:text-gray-400">
          {formatBytes(usage)} / {formatBytes(quota)}
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-white/[0.08]" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="浏览器存储用量">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(percent, 1)}%` }} />
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        已用 {percent}%
        {percent >= 90 ? ' — 空间即将耗尽：新图片可能无法保存，请导出备份后清理旧任务。' : ''}
      </p>
    </div>
  )
}
