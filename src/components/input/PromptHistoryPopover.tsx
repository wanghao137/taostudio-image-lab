import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useStore } from '../../store'
import type { PromptHistoryEntry } from '../../types'

interface PromptHistoryPopoverProps {
  onPick: (entry: PromptHistoryEntry) => void
  onClose: () => void
  /** 触发按钮等锚点元素：点击锚点不视为外部点击（否则 toggle 会先关再开）。 */
  anchorRef?: RefObject<HTMLElement | null>
}

function formatTime(value: number) {
  const date = new Date(value)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000
  if (value >= startOfToday) {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
  }
  if (value >= startOfYesterday) return '昨天'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date).replace(/\//g, '-')
}

/**
 * 画廊提示词历史下拉：最近 20 条提交记录，点击回填提示词与参数。
 * 之所以不复用 HistoryModal：那个组件与 Agent 会话（重命名/删除/跳转）深度耦合。
 */
export default function PromptHistoryPopover({ onPick, onClose, anchorRef }: PromptHistoryPopoverProps) {
  const promptHistory = useStore((s) => s.promptHistory)
  const clearPromptHistory = useStore((s) => s.clearPromptHistory)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [searchQuery, setSearchQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleInteract = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (containerRef.current?.contains(target)) return
      if (anchorRef?.current?.contains(target)) return
      onClose()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleInteract, captureEventOptions)
    document.addEventListener('touchstart', handleInteract, captureEventOptions)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleInteract, captureEventOptions)
      document.removeEventListener('touchstart', handleInteract, captureEventOptions)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [anchorRef, onClose])

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return promptHistory
    return promptHistory.filter((entry) => entry.prompt.toLocaleLowerCase().includes(query))
  }, [promptHistory, searchQuery])

  const handleClear = () => {
    setConfirmDialog({
      title: '清空提示词历史',
      message: '确定清空全部提示词历史记录吗？此操作不可撤销。',
      confirmText: '清空',
      tone: 'danger',
      action: () => {
        clearPromptHistory()
        onClose()
      },
    })
  }

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full mb-2 left-0 w-80 sm:w-96 max-w-[calc(100vw-2rem)] max-h-[60vh] bg-white dark:bg-[#1c1c1e] rounded-xl shadow-2xl overflow-hidden flex flex-col border border-gray-200 dark:border-white/10 z-50 text-gray-900 dark:text-gray-200"
      role="dialog"
      aria-label="提示词历史"
    >
      <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-white/10 shrink-0 gap-2">
        <input
          type="text"
          placeholder="搜索提示词..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm px-2 text-gray-900 dark:text-white placeholder-gray-400"
          autoFocus
        />
        <button
          type="button"
          onClick={handleClear}
          disabled={promptHistory.length === 0}
          className="shrink-0 text-xs text-gray-500 hover:text-red-500 dark:text-gray-400 dark:hover:text-red-400 disabled:opacity-40 disabled:hover:text-gray-500 transition-colors"
          aria-label="清空提示词历史"
        >
          清空
        </button>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 p-1 hover:bg-gray-100 dark:hover:bg-white/10 rounded-lg text-gray-500 dark:text-gray-400 transition-colors"
          aria-label="关闭"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1 overscroll-contain">
        {filtered.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-gray-500">
            {promptHistory.length === 0 ? '还没有提交记录' : '没有匹配的提示词'}
          </div>
        )}
        {filtered.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onPick(entry)}
            className="w-full flex items-start gap-2 rounded-lg px-3 py-2 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors text-left"
          >
            <svg className="w-4 h-4 mt-0.5 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-gray-700 dark:text-gray-300 line-clamp-2 leading-snug break-all">{entry.prompt}</span>
              <span className="mt-1 flex items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
                <span className="font-mono">{entry.size === 'auto' ? '自动' : entry.size}</span>
                {entry.n > 1 && <span>×{entry.n}</span>}
                <span className="uppercase">{entry.output_format}</span>
                <span className="ml-auto shrink-0">{formatTime(entry.usedAt)}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

const captureEventOptions = { capture: true } as const
