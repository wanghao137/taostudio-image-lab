import { useState } from 'react'
import { Activity, Archive, ChevronRight, Layers } from 'lucide-react'
import type { ImageBatchSummaryV1 } from '../../lib/imageTaskApi'
import {
  DeliveryStatus,
  formatTime,
  batchStateLabel,
  batchStateTone,
  batchPrimaryAction,
  displayBatchName,
  batchHasActiveAutomation,
} from './shared'
import type { EngineDeliveryRecord } from '../../lib/db'

function BatchQueueRow({
  batch,
  selected,
  onSelect,
}: {
  batch: ImageBatchSummaryV1
  selected: boolean
  onSelect: (batch: ImageBatchSummaryV1) => void
}) {
  const issueCount = batch.stats.failed + batch.stats.needsReview + batch.stats.rejected
  return (
    <button
      type="button"
      onClick={() => onSelect(batch)}
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-l-2 px-2 py-3 text-left transition-colors hover:bg-white/60 dark:hover:bg-white/[0.03] sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-3 ${selected ? 'border-l-[#356c82] bg-white dark:bg-white/[0.04]' : batch.state === 'running' ? 'border-l-sky-400/70' : issueCount ? 'border-l-amber-400/70' : 'border-l-transparent'}`}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" title={batch.name || batch.id}>{displayBatchName(batch)}</div>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-stone-400">
          <span>{batch.stats.succeeded}/{batch.stats.total} 完成</span>
          {batch.stats.failed > 0 && <span className="text-red-500 dark:text-red-300">{batch.stats.failed} 失败</span>}
          {batch.stats.cancelled > 0 && <span className="text-amber-600 dark:text-amber-300">{batch.stats.cancelled} 已中断</span>}
          {batch.stats.qaNeedsReview + batch.stats.qaFailed > 0 && <span>{batch.stats.qaNeedsReview + batch.stats.qaFailed} QA 告警</span>}
          {batch.stats.needsReview > 0 && <span>{batch.stats.needsReview} 待人工确认</span>}
        </div>
      </div>
      <time className="hidden self-center whitespace-nowrap text-[10px] text-stone-400 sm:block">{formatTime(batch.updatedAt)}</time>
      <span className="self-center text-right">
        <span className={`block whitespace-nowrap text-[11px] font-medium ${batchStateTone(batch)}`}>{batchStateLabel(batch)}</span>
        <span className="mt-1 block whitespace-nowrap text-[10px] text-stone-400">{batchPrimaryAction(batch)}</span>
      </span>
    </button>
  )
}

export function BatchQueueSection({
  title,
  batches,
  selectedBatchId,
  onSelect,
}: {
  title: string
  batches: ImageBatchSummaryV1[]
  selectedBatchId: string | undefined
  onSelect: (batch: ImageBatchSummaryV1) => void
}) {
  if (!batches.length) return null
  return (
    <section aria-label={title} className="border-t border-stone-200 first:border-t-0 dark:border-white/[0.06]">
      <div className="flex items-center justify-between px-2 py-2 sm:px-3">
        <h3 className="text-[10px] font-medium uppercase text-stone-400">{title}</h3>
        <span className="font-mono text-[10px] text-stone-400">{batches.length}</span>
      </div>
      <div className="divide-y divide-stone-200 dark:divide-white/[0.06]">
        {batches.map((batch) => (
          <BatchQueueRow
            key={batch.id}
            batch={batch}
            selected={selectedBatchId === batch.id}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  )
}

// A batch queue section that can collapse its rows behind its header. Used for
// historical groups (incomplete / archived) so they don't bury the running and
// needs-attention batches that need immediate attention. The header always shows
// the count and a chevron; clicking it toggles the rows without losing state.
export function CollapsibleBatchSection({
  title,
  batches,
  selectedBatchId,
  onSelect,
  collapsed,
  onToggle,
}: {
  title: string
  batches: ImageBatchSummaryV1[]
  selectedBatchId: string | undefined
  onSelect: (batch: ImageBatchSummaryV1) => void
  collapsed: boolean
  onToggle: () => void
}) {
  if (!batches.length) return null
  return (
    <section aria-label={title} className="border-t border-stone-200 first:border-t-0 dark:border-white/[0.06]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={`batch-group-${title}`}
        className="flex w-full items-center justify-between px-2 py-2 text-left transition-colors hover:bg-white/60 dark:hover:bg-white/[0.03] sm:px-3"
      >
        <span className="flex items-center gap-1.5">
          <ChevronRight className={`h-3 w-3 text-stone-400 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          <h3 className="text-[10px] font-medium uppercase text-stone-400">{title}</h3>
        </span>
        <span className="font-mono text-[10px] text-stone-400">{batches.length}</span>
      </button>
      {!collapsed && (
        <div id={`batch-group-${title}`} className="divide-y divide-stone-200 dark:divide-white/[0.06]">
          {batches.map((batch) => (
            <BatchQueueRow
              key={batch.id}
              batch={batch}
              selected={selectedBatchId === batch.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  )
}

