import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Ban, Check, Download, FolderOpen, HardDrive, Layers, LoaderCircle, Pause, Play, RefreshCw, X } from 'lucide-react'
import type { ImageBatchV1, ImageBatchItemV1, ImageBatchEventV1, ImageTaskApiConfig, ImageBatchSummaryV1 } from '../../lib/imageTaskApi'
import type { EngineDeliveryRecord } from '../../lib/db'
import { isEngineLocalDeliverySupported } from '../../lib/engineLocalDelivery'
import {
  StatusBadge,
  QaBadge,
  HumanReviewBadge,
  DeliveryStatus,
  formatTime,
  formatDuration,
  shortTaskTitle,
  batchStateLabel,
  batchStateTone,
  batchPresentationState,
  batchReviewNote,
  batchPrimaryAction,
} from './shared'
import ReviewThumbnail from './ReviewThumbnail'

export default function BatchInspector({
  batch,
  config,
  busy,
  itemsLoading = false,
  delivery,
  deliveryBusy,
  onSaveDelivery,
  onDownloadDelivery,
  onControl,
  onReview,
  onRetryItem,
  onLoadMoreItems,
  onLoadMoreEvents,
  itemPage,
  eventPage,
  onClose,
  onBulkReview,
  onArchiveBatch,
  onDeleteBatch,
  onPruneAssets,
}: {
  batch: ImageBatchV1
  config: ImageTaskApiConfig
  busy: boolean
  itemsLoading?: boolean
  delivery?: EngineDeliveryRecord
  deliveryBusy: boolean
  onSaveDelivery: () => void
  onDownloadDelivery: () => void
  onControl: (action: 'pause' | 'resume' | 'retry-failed' | 'retry-cancelled') => void
  onReview: (itemKey: string, acceptanceStatus: 'accepted' | 'rejected') => void
  onRetryItem: (item: ImageBatchItemV1) => void
  onLoadMoreItems: () => void
  onLoadMoreEvents: () => void
  itemPage: { loaded: number; total: number; hasMore: boolean }
  eventPage: { loaded: number; total: number; hasMore: boolean }
  onClose: () => void
  onBulkReview: (items: ImageBatchItemV1[], acceptanceStatus: 'accepted' | 'rejected') => void
  onArchiveBatch: (batchId: string) => void
  onDeleteBatch: (batchId: string) => void
  onPruneAssets: () => void
}) {
  const [reviewFilter, setReviewFilter] = useState<'all' | 'warnings' | 'not_run' | 'pending' | 'approved' | 'rejected' | 'failed' | 'cancelled'>('pending')
  // P2-12: Free-text search within batch items by prompt text
  const [itemSearch, setItemSearch] = useState('')
  // 删除批次二次确认：首次点击进入待确认态，3 秒未确认复位（替代原生 confirm）
  const [deleteArmed, setDeleteArmed] = useState(false)
  useEffect(() => {
    if (!deleteArmed) return
    const timer = setTimeout(() => setDeleteArmed(false), 3000)
    return () => clearTimeout(timer)
  }, [deleteArmed])
  // 审查键盘遍历（J/K/Enter/X）状态；监听器在 reviewItems 声明后注册
  const [focusedItemKey, setFocusedItemKey] = useState<string | null>(null)
  const autoAcceptedCount = useMemo(
    () => batch.items.filter((item) => item.humanReviewStatus === 'approved' && item.humanReview?.actor === 'system').length,
    [batch.items],
  )
  const humanApprovedCount = Math.max(0, batch.stats.humanReviewApproved - autoAcceptedCount)
  const funnel = [
    { label: '执行完成', value: batch.stats.terminal, tone: 'bg-sky-500' },
    { label: '成功产出', value: batch.stats.succeeded, tone: 'bg-cyan-500' },
    { label: 'QA 通过', value: batch.stats.qaPassed, tone: 'bg-teal-500' },
    { label: '人工验收', value: humanApprovedCount, tone: 'bg-emerald-500' },
    { label: '最终可交付', value: batch.stats.accepted, tone: 'bg-green-600' },
  ]
  const elapsedMs = Math.max(0, Date.now() - new Date(batch.createdAt).getTime())
  const completedForRate = Math.max(batch.stats.terminal, 1)
  const averageMs = elapsedMs / completedForRate
  const remaining = Math.max(0, batch.stats.total - batch.stats.terminal)
  const etaMs = remaining * averageMs
  const throughput = elapsedMs > 0 ? batch.stats.terminal / (elapsedMs / 60_000) : 0
  const retryCount = batch.items.reduce((sum, item) => sum + Math.max(0, item.job.attempts - 1), 0)
  const reviewItems = useMemo(() => batch.items.filter((item) => {
    if (reviewFilter === 'warnings') return item.qaStatus === 'needs_review' || item.qaStatus === 'failed'
    if (reviewFilter === 'not_run') return item.qaStatus === 'not_run'
    if (reviewFilter === 'pending') return item.humanReviewStatus === 'pending'
    if (reviewFilter === 'approved') return item.humanReviewStatus === 'approved'
    if (reviewFilter === 'rejected') return item.humanReviewStatus === 'rejected'
    if (reviewFilter === 'failed') return item.job.state === 'failed'
    if (reviewFilter === 'cancelled') return item.job.state === 'cancelled'
    return true // 'all'
  }).filter((item) => {
    // P2-12: Apply free-text search on prompt text
    if (!itemSearch.trim()) return true
    const prompt = (item.job.request.input.prompt || '').toLowerCase()
    return prompt.includes(itemSearch.trim().toLowerCase())
  }), [batch.items, reviewFilter, itemSearch])
  const focusedItem = useMemo(
    () => reviewItems.find((item) => item.itemKey === focusedItemKey) ?? null,
    [reviewItems, focusedItemKey],
  )
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      // Enter 在聚焦按钮上会原生触发 click——同时处理会双动作（如归档+误审）。
      if (e.key === 'Enter' && target?.closest('button, a, select, [role="button"]')) return
      // 资产 Lightbox 打开时（全屏覆盖层）不处理——否则在放大图
      // 后台静默审查当前条目。
      if (document.querySelector('[data-engine-lightbox]')) return
      const idx = focusedItem ? reviewItems.findIndex((it) => it.itemKey === focusedItem.itemKey) : -1
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        const next = reviewItems[Math.min(idx + 1, reviewItems.length - 1)] ?? reviewItems[0]
        if (next) setFocusedItemKey(next.itemKey)
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        const prev = reviewItems[Math.max(idx - 1, 0)] ?? reviewItems[0]
        if (prev) setFocusedItemKey(prev.itemKey)
      } else if (focusedItem && (e.key === 'Enter' || e.key === 'x' || e.key === 'X') && !busy) {
        e.preventDefault()
        onReview(focusedItem.itemKey, e.key === 'Enter' ? 'accepted' : 'rejected')
        // 审完自动跳到下一个待审查条目
        const next = reviewItems[idx + 1] ?? reviewItems.find((it) => it.humanReviewStatus === 'pending' && it.itemKey !== focusedItem.itemKey)
        setFocusedItemKey(next?.itemKey ?? null)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [busy, focusedItem, onReview, reviewItems])
  return (
    <div>
      <button
        type="button"
        onClick={onClose}
        className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-stone-300 px-2.5 py-1.5 text-xs font-medium text-stone-600 hover:bg-stone-100 lg:hidden dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/[0.06]"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        返回列表
      </button>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium text-stone-400">批次详情</div>
          <h2 className="mt-1 break-all font-mono text-sm font-semibold">{batch.name || batch.id}</h2>
          {batch.automation.enabled && (
            <div className="mt-2 text-[10px] font-medium text-[#356c82] dark:text-[#8ec5d7]">
              自动恢复 · 视觉 QA · 人工确认交付
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-md border border-stone-300 px-2 py-1 text-[11px] font-medium text-stone-600 dark:border-white/10 dark:text-stone-300">
            {batch.state === 'paused' ? '已暂停' : batch.state === 'archived' ? '已归档' : batch.state === 'completed' ? '已完成' : '运行中'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-stone-300 text-stone-400 hover:text-stone-700 dark:border-white/10 dark:hover:text-stone-200"
            aria-label="关闭面板"
            title="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-4 border-l-2 border-emerald-400 bg-emerald-50/70 px-3 py-3 text-xs text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 shrink-0" />
          <span className="font-medium">本地交付</span>
          <span className="ml-auto"><DeliveryStatus record={delivery} supported={isEngineLocalDeliverySupported()} /></span>
        </div>
        {delivery?.error && <p className="mt-1 break-words leading-5 text-red-700 dark:text-red-300">{delivery.error}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={onSaveDelivery} disabled={deliveryBusy || !isEngineLocalDeliverySupported() || batch.state === 'running'} className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
            {deliveryBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <HardDrive className="h-3 w-3" />}保存到本机
          </button>
          <button type="button" onClick={onDownloadDelivery} disabled={deliveryBusy || batch.stats.succeeded === 0} className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-500/40 px-2 text-[10px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-40 dark:text-emerald-100 dark:hover:bg-emerald-400/15">
            <Download className="h-3 w-3" />下载批次 ZIP
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-4 opacity-75">只保存成功产物；失败、取消项保留在 batch-manifest.json 中，不会伪装成已交付。</p>
      </div>
      <div className="mt-5" aria-label="批次质量漏斗">
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
          {funnel.map((stage) => {
            const percentage = batch.stats.total ? Math.round((stage.value / batch.stats.total) * 100) : 0
            return (
              <div key={stage.label} className="min-w-0 border-t border-stone-300 pt-2 dark:border-white/10">
                <div className="truncate text-[9px] font-medium text-stone-400 sm:text-[10px]">{stage.label}</div>
                <div className="mt-1 font-mono text-sm font-semibold">{stage.value}<span className="text-[9px] font-normal text-stone-400">/{batch.stats.total}</span></div>
                <div className="mt-2 h-1.5 overflow-hidden bg-stone-200 dark:bg-white/10">
                  <div className={`h-full ${stage.tone}`} style={{ width: `${percentage}%` }} />
                </div>
                <div className="mt-1 font-mono text-[9px] text-stone-400">{percentage}%</div>
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-stone-500 dark:text-stone-400">
          <span className="text-red-600 dark:text-red-300">失败 {batch.stats.failed}</span>
          <span>取消 {batch.stats.cancelled}</span>
          <span className="text-amber-700 dark:text-amber-300">QA 告警 {batch.stats.qaNeedsReview + batch.stats.qaFailed}</span>
          <span>QA 未运行 {batch.stats.qaNotRun}</span>
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-3 gap-x-4 gap-y-3 border-y border-stone-300 py-4 text-xs dark:border-white/10">
        <div><dt className="text-stone-400">成功</dt><dd className="mt-1 font-mono text-emerald-600">{batch.stats.succeeded}</dd></div>
        <div><dt className="text-stone-400">失败</dt><dd className="mt-1 font-mono text-red-500">{batch.stats.failed}</dd></div>
        <div><dt className="text-stone-400">已取消</dt><dd className="mt-1 font-mono text-stone-400">{batch.stats.cancelled}</dd></div>
        <div><dt className="text-stone-400">执行中</dt><dd className="mt-1 font-mono">{batch.stats.active}</dd></div>
        <div><dt className="text-stone-400">排队</dt><dd className="mt-1 font-mono">{batch.stats.queued}</dd></div>
        <div><dt className="text-stone-400">QA 告警</dt><dd className="mt-1 font-mono text-amber-700 dark:text-amber-300">{batch.stats.qaNeedsReview + batch.stats.qaFailed}</dd></div>
      </dl>
      {(batch.state === 'running' || batch.state === 'paused') && (
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-b border-stone-300 pb-4 text-xs dark:border-white/10 sm:grid-cols-3">
          <div><dt className="text-stone-400">已耗时</dt><dd className="mt-1 font-mono">{formatDuration(elapsedMs)}</dd></div>
          <div><dt className="text-stone-400">预计剩余</dt><dd className="mt-1 font-mono">{batch.stats.terminal ? formatDuration(etaMs) : '计算中'}</dd></div>
          <div><dt className="text-stone-400">当前吞吐</dt><dd className="mt-1 font-mono">{throughput.toFixed(1)} 图/分</dd></div>
          <div><dt className="text-stone-400">平均单图</dt><dd className="mt-1 font-mono">{batch.stats.terminal ? formatDuration(averageMs) : '计算中'}</dd></div>
          <div><dt className="text-stone-400">可见重试</dt><dd className="mt-1 font-mono">{retryCount}</dd></div>
          <div><dt className="text-stone-400">异常比例</dt><dd className="mt-1 font-mono">{batch.stats.total ? Math.round(((batch.stats.failed + batch.stats.cancelled) / batch.stats.total) * 100) : 0}%</dd></div>
        </dl>
      )}
      <section className="mt-5" aria-label="人工交付验收">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold">人工交付验收</h3>
            <p className="mt-1 text-[10px] leading-4 text-stone-400">QA 通过自动确认；仅 QA 告警/未运行需要人工复核。</p>
          </div>
          <span className="shrink-0 font-mono text-[10px] text-stone-400">
            待复核 {batch.stats.humanReviewPending} / QA 自动确认 {autoAcceptedCount} / 人工已确认 {humanApprovedCount}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="验收筛选">
          {([
            ['pending', `待确认 ${batch.stats.humanReviewPending}`],
            ['warnings', `QA 告警 ${batch.stats.qaNeedsReview + batch.stats.qaFailed}`],
            ['not_run', `QA 未运行 ${batch.stats.qaNotRun}`],
            ['failed', `失败 ${batch.stats.failed}`],
            ['cancelled', `取消 ${batch.stats.cancelled}`],
            ['all', `全部 ${batch.stats.total}`],
            ['approved', `已确认 ${batch.stats.humanReviewApproved}`],
            ['rejected', `已拒绝 ${batch.stats.humanReviewRejected}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setReviewFilter(value)}
              aria-pressed={reviewFilter === value}
              className={`h-7 rounded-md border px-2 text-[10px] font-medium transition-colors ${
                reviewFilter === value
                  ? 'border-[#356c82] bg-[#356c82] text-white'
                  : 'border-stone-300 text-stone-500 hover:bg-white dark:border-white/10 dark:text-stone-400 dark:hover:bg-white/[0.04]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* P2-12: Prompt search within batch items */}
        <input
          type="search"
          value={itemSearch}
          onChange={(e) => setItemSearch(e.target.value)}
          placeholder="搜索提示词…"
          className="mt-2 h-8 w-full rounded-md border border-stone-300 bg-white px-3 text-xs dark:border-white/10 dark:bg-[#191714]"
          aria-label="条目搜索"
        />
        <div className="mt-3 grid max-h-[620px] grid-cols-1 gap-2 overflow-auto pr-1 sm:grid-cols-2">
          {reviewItems.map((item) => {
            const canDecide = item.job.state === 'succeeded' && item.humanReviewStatus === 'pending'
            const qaNote = batchReviewNote(item)
            return (
              <article
                key={item.itemKey}
                className={`overflow-hidden border text-xs [content-visibility:auto] [contain-intrinsic-size:auto_220px] ${
                  focusedItemKey === item.itemKey
                    ? 'border-blue-400 ring-2 ring-blue-400/40'
                    : item.qaStatus === 'needs_review' || item.qaStatus === 'failed' || item.qaStatus === 'not_run'
                    ? 'border-amber-300 bg-amber-50/30 dark:border-amber-400/30 dark:bg-amber-400/[0.04]'
                      : item.humanReviewStatus === 'approved'
                      ? 'border-emerald-200 bg-emerald-50/30 dark:border-emerald-400/20 dark:bg-emerald-400/[0.03]'
                      : 'border-stone-300 bg-white/45 dark:border-white/10 dark:bg-white/[0.02]'
                }`}
              >
                <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 p-2">
                  <div className="aspect-square overflow-hidden border border-stone-200 bg-stone-100 dark:border-white/10 dark:bg-white/[0.04]">
                    <ReviewThumbnail
                      config={config}
                      assetId={item.job.finalAssetId || null}
                      label={`${item.itemKey} 最终产物缩略图`}
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate font-mono text-[10px] font-medium">{item.itemKey}</span>
                      <StatusBadge state={item.job.state} />
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-stone-600 dark:text-stone-300">{item.job.request.input.prompt || '图像编辑任务'}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <QaBadge status={item.qaStatus} />
                      <HumanReviewBadge
                        status={item.humanReviewStatus}
                        autoAccepted={item.humanReview?.actor === 'system'}
                      />
                    </div>
                  </div>
                </div>
                <div className="border-t border-stone-200 px-2 py-2 dark:border-white/[0.08]">
                  <div className="min-h-4 truncate text-[10px] text-stone-400" title={qaNote || undefined}>
                    {qaNote || (item.job.state === 'succeeded' ? '未发现额外 QA 提示' : '该条目没有可交付产物')}
                  </div>
                  <div className="mt-2 flex min-h-7 flex-wrap items-center gap-1.5">
                    {canDecide && (
                      <>
                        <button
                          type="button"
                          onClick={() => onReview(item.itemKey, 'accepted')}
                          disabled={busy}
                          className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                        >
                          <Check className="h-3 w-3" />确认交付
                        </button>
                        <button
                          type="button"
                          onClick={() => onRetryItem(item)}
                          disabled={busy}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-[#356c82]/40 px-2 text-[10px] font-medium text-[#356c82] hover:bg-[#356c82]/10 disabled:opacity-40 dark:border-[#8ec5d7]/30 dark:text-[#8ec5d7]"
                        >
                          <RefreshCw className="h-3 w-3" />重生
                        </button>
                        <button
                          type="button"
                          onClick={() => onReview(item.itemKey, 'rejected')}
                          disabled={busy}
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-red-300 px-2 text-[10px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-400/30 dark:text-red-300"
                        >
                          <Ban className="h-3 w-3" />拒绝
                        </button>
                      </>
                    )}
                    {!canDecide && item.job.state === 'succeeded' && item.humanReviewStatus === 'not_ready' && (
                      <span className="text-[10px] text-stone-400">等待 QA 记录完成</span>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
          {!reviewItems.length && (
            <div className="col-span-full border border-dashed border-stone-300 px-3 py-8 text-center text-xs text-stone-400 dark:border-white/10">
              {itemsLoading ? '正在加载批次条目…' : '当前筛选下没有条目'}
            </div>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between text-[10px] text-stone-400">
          <span>已加载 {itemPage.loaded} / {itemPage.total}</span>
          {itemPage.hasMore && <button type="button" onClick={onLoadMoreItems} className="rounded-md border border-stone-300 px-2 py-1 font-medium hover:text-stone-700 dark:border-white/10">加载更多条目</button>}
        </div>
      </section>
      <div className="mt-5 flex flex-wrap gap-2">
        {batch.state === 'running' && (
          <button type="button" onClick={() => onControl('pause')} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md border border-amber-300 px-3 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-40 dark:border-amber-400/30 dark:text-amber-300">
            <Pause className="h-4 w-4" />暂停批次
          </button>
        )}
        {batch.state === 'paused' && (
          <button type="button" onClick={() => onControl('resume')} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md border border-emerald-300 px-3 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-40 dark:border-emerald-400/30 dark:text-emerald-300">
            <Play className="h-4 w-4" />恢复批次
          </button>
        )}
        {batch.stats.failed > 0 && (
          <button type="button" onClick={() => onControl('retry-failed')} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md border border-[#356c82]/35 px-3 text-xs font-medium text-[#356c82] hover:bg-[#356c82]/10 disabled:opacity-40 dark:border-[#8ec5d7]/30 dark:text-[#8ec5d7]">
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}重试失败项
          </button>
        )}
        {batch.stats.cancelled > 0 && (
          <button type="button" onClick={() => onControl('retry-cancelled')} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md border border-[#356c82]/35 px-3 text-xs font-medium text-[#356c82] hover:bg-[#356c82]/10 disabled:opacity-40 dark:border-[#8ec5d7]/30 dark:text-[#8ec5d7]">
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}继续 {batch.stats.cancelled} 个取消项
          </button>
        )}
        {(() => {
          const qaPassedPending = batch.items.filter((it: ImageBatchItemV1) => it.humanReviewStatus === 'pending' && it.qaStatus === 'passed' && it.job.state === 'succeeded')
          return qaPassedPending.length > 0 ? (
            <button type="button" onClick={() => onBulkReview(qaPassedPending, 'accepted')} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
              <Check className="h-4 w-4" />批量确认 {qaPassedPending.length} 项
            </button>
          ) : null
        })()}
        {(() => {
          const rejectablePending = batch.items.filter((it: ImageBatchItemV1) => it.humanReviewStatus === 'pending' && it.job.state === 'succeeded')
          return rejectablePending.length > 0 ? (
            <button type="button" onClick={() => onBulkReview(rejectablePending, 'rejected')} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md border border-red-300 px-3 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-400/30 dark:text-red-300">
              <X className="h-4 w-4" />批量拒绝 {rejectablePending.length} 项
            </button>
          ) : null
        })()}
        {(batch.state === 'completed' || batch.state === 'archived') && (
          <>
            {batch.state === 'completed' && (
              <button type="button" onClick={() => onArchiveBatch(batch.id)} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-md border border-stone-300 px-3 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40 dark:border-white/10 dark:text-stone-300">
                归档
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                if (!deleteArmed) {
                  setDeleteArmed(true)
                  return
                }
                setDeleteArmed(false)
                onDeleteBatch(batch.id)
              }}
              disabled={busy}
              aria-label={deleteArmed ? '再次点击确认删除批次' : '删除批次'}
              className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-medium disabled:opacity-40 ${
                deleteArmed
                  ? 'border-red-500 bg-red-500 text-white'
                  : 'border-red-300 text-red-600 hover:bg-red-50 dark:border-red-400/30 dark:text-red-300'
              }`}
            >
              {deleteArmed ? '确认删除（不可撤销）' : '删除'}
            </button>
          </>
        )}
      </div>
      <details className="mt-5 border-t border-stone-300 pt-4 dark:border-white/10">
        <summary className="cursor-pointer text-xs font-semibold">批次事件 · {eventPage.total}</summary>
        <ol className="mt-3 space-y-2 text-[10px] text-stone-500 dark:text-stone-400">
          {batch.events.map((event: ImageBatchEventV1, index) => <li key={`${event.createdAt}-${index}`} className="flex justify-between gap-3"><span>{event.event}</span><time className="font-mono">{formatTime(event.createdAt)}</time></li>)}
        </ol>
        {eventPage.hasMore && <button type="button" onClick={onLoadMoreEvents} className="mt-3 rounded-md border border-stone-300 px-2 py-1 text-[10px] font-medium dark:border-white/10">加载更多事件</button>}
      </details>
    </div>
  )
}

