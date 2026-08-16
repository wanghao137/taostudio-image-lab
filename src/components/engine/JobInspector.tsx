import { ArrowLeft, Ban, Check, CircleAlert, Download, HardDrive, LoaderCircle, Maximize2, RefreshCw, X } from 'lucide-react'
import type { ImageJobV1 } from '../../lib/imageTaskApi'
import type { EngineDeliveryRecord } from '../../lib/db'
import { StatusBadge, DeliveryStatus, formatTime, formatDuration, STATE_LABELS, ACTIVE_STATES } from './shared'
import { isEngineLocalDeliverySupported } from '../../lib/engineLocalDelivery'

export default function JobInspector({
  job,
  previewUrl,
  busy,
  delivery,
  deliveryBusy,
  onOpenPreview,
  onSaveDelivery,
  onDownloadDelivery,
  onCancel,
  onRetry,
  onClose,
}: {
  job: ImageJobV1
  previewUrl: string | null
  busy: boolean
  delivery?: EngineDeliveryRecord
  deliveryBusy: boolean
  onOpenPreview: (mode: 'source' | 'final') => void
  onSaveDelivery: () => void
  onDownloadDelivery: () => void
  onCancel: () => void
  onRetry: () => void
  onClose: () => void
}) {
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
          <div className="text-[10px] font-medium text-stone-400">任务详情</div>
          <h2 className="mt-1 break-all font-mono text-sm font-semibold">{job.id}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge state={job.state} />
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

      {previewUrl && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => onOpenPreview('final')}
            className="group relative block w-full overflow-hidden rounded-md border border-stone-300 bg-[repeating-conic-gradient(#ddd_0_25%,#fff_0_50%)_0_0/16px_16px] cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-[#356c82] dark:border-white/10"
            aria-label="放大预览 4K 产物"
          >
            <span className="absolute right-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md bg-black/65 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Maximize2 className="h-4 w-4" />
            </span>
            {job.sourceAssetId && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); onOpenPreview('source') }}
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); onOpenPreview('source') } }}
                className="absolute left-2 top-2 z-10 inline-flex h-7 cursor-pointer items-center gap-1 rounded-md bg-black/65 px-2 text-[10px] text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                aria-label="放大预览原图"
              >
                原图
              </span>
            )}
            <img src={previewUrl} alt="最终产物" className="max-h-[420px] w-full object-contain" />
          </button>
        </div>
      )}

      <div className="mt-4 border-l-2 border-emerald-400 bg-emerald-50/70 px-3 py-3 text-xs text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 shrink-0" />
          <span className="font-medium">本地交付</span>
          <span className="ml-auto"><DeliveryStatus record={delivery} supported={isEngineLocalDeliverySupported()} /></span>
        </div>
        {delivery?.error && <p className="mt-1 break-words leading-5 text-red-700 dark:text-red-300">{delivery.error}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={onSaveDelivery} disabled={deliveryBusy || !isEngineLocalDeliverySupported() || job.state !== 'succeeded'} className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[10px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40">
            {deliveryBusy ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <HardDrive className="h-3 w-3" />}保存到本机
          </button>
          <button type="button" onClick={onDownloadDelivery} disabled={deliveryBusy || job.state !== 'succeeded'} className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-500/40 px-2 text-[10px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-40 dark:text-emerald-100 dark:hover:bg-emerald-400/15">
            <Download className="h-3 w-3" />下载 PNG
          </button>
        </div>
        <p className="mt-2 text-[10px] leading-4 opacity-75">生成成功不等于本地交付成功；两者分别显示状态，保存失败可重试。</p>
      </div>

      <p className="mt-5 text-sm leading-6">{job.request.input.prompt || '图像编辑任务'}</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-stone-300 py-4 text-xs dark:border-white/10">
        <div><dt className="text-stone-400">比例</dt><dd className="mt-1 font-mono">{job.request.composition.ratio}</dd></div>
        <div><dt className="text-stone-400">最终尺寸</dt><dd className="mt-1 font-mono">{job.request.output.dimensions || '继承'}</dd></div>
        <div><dt className="text-stone-400">实际路由</dt><dd className="mt-1 truncate font-mono">{job.actualRoute?.model || job.request.generation.model} / {job.actualRoute?.apiMode || job.request.generation.apiMode || 'images'}</dd></div>
        <div><dt className="text-stone-400">当前路由尝试</dt><dd className="mt-1 font-mono">{job.routeAttempts ?? job.attempts} / {job.maxAttempts}</dd></div>
        <div><dt className="text-stone-400">总尝试次数</dt><dd className="mt-1 font-mono">{job.attempts}</dd></div>
        <div><dt className="text-stone-400">路由</dt><dd className="mt-1 font-mono">{(job.routeIndex ?? 0) === 0 ? '主路由' : '备用路由'}</dd></div>
        <div><dt className="text-stone-400">Provider 调用</dt><dd className="mt-1 font-mono">{job.accounting ? `${job.accounting.calls.length} 次` : '旧服务未提供'}</dd></div>
      </dl>

      {job.error && (
        <div className="mt-4 border-l-2 border-red-500 bg-red-50 px-3 py-3 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <div className="font-mono font-semibold">{job.error.code || 'ENGINE_ERROR'}</div>
          <p className="mt-1 leading-5">{job.error.message}</p>
        </div>
      )}

      <div className="mt-5">
        <h3 className="text-xs font-semibold uppercase text-stone-400">执行轨迹</h3>
        <ol className="mt-3">
          {(job.events || []).map((event, index) => (
            <li key={`${event.createdAt}-${index}`} className="relative grid grid-cols-[16px_minmax(0,1fr)_auto] gap-2 pb-4 text-xs last:pb-0">
              {index < (job.events?.length || 0) - 1 && <span className="absolute left-[7px] top-4 h-[calc(100%-8px)] w-px bg-stone-300 dark:bg-white/10" />}
              <span className={`relative mt-0.5 flex h-4 w-4 items-center justify-center rounded-full ${event.state === 'failed' ? 'bg-red-500 text-white' : event.state === 'succeeded' ? 'bg-emerald-500 text-white' : 'bg-stone-300 text-stone-700 dark:bg-stone-700 dark:text-stone-200'}`}>
                {event.state === 'failed' ? <CircleAlert className="h-2.5 w-2.5" /> : event.state === 'succeeded' ? <Check className="h-2.5 w-2.5" /> : null}
              </span>
              <span className="min-w-0 font-medium">
                {event.detail?.reason === 'route_fallback' ? '切换备用路由' : STATE_LABELS[event.state]}
                {event.detail?.reason === 'route_fallback' && (
                  <span className="mt-1 block truncate font-mono text-[10px] font-normal text-stone-400">
                    {String((event.detail.to as { model?: string } | undefined)?.model || '')}
                  </span>
                )}
              </span>
              <time className="font-mono text-[10px] text-stone-400">{formatTime(event.createdAt)}</time>
            </li>
          ))}
        </ol>
      </div>

      {ACTIVE_STATES.has(job.state) && (
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="mt-6 inline-flex h-9 items-center gap-2 rounded-md border border-red-300 px-3 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-400/30 dark:text-red-300 dark:hover:bg-red-500/10"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
          取消任务
        </button>
      )}
      {job.state === 'failed' && (
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="mt-6 inline-flex h-9 items-center gap-2 rounded-md border border-[#356c82]/35 px-3 text-xs font-medium text-[#356c82] hover:bg-[#356c82]/10 disabled:opacity-40 dark:border-[#8ec5d7]/30 dark:text-[#8ec5d7]"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          重新执行
        </button>
      )}
    </div>
  )
}
