import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import {
  Activity,
  Ban,
  Check,
  ChevronRight,
  CircleAlert,
  Cpu,
  LoaderCircle,
  Layers,
  Maximize2,
  Move,
  Pause,
  Plus,
  Play,
  RefreshCw,
  Server,
  Unplug,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { calculateImageSize } from '../lib/size'
import {
  countEngineBatchOutputs,
  createEngineBatchRequest,
  parseEngineBatchPrompts,
} from '../lib/engineBatch'
import {
  cancelImageJob,
  clearLocalImageTaskApiConfig,
  createImageTaskGeneration,
  createImageJob,
  createImageBatch,
  controlImageBatch,
  getImageBatch,
  getImageAssetBlob,
  getImageAssetThumbnailBlob,
  getImageJob,
  getImageTaskCapabilities,
  listImageBatches,
  listImageJobs,
  replaceImageBatchItemJob,
  readLocalImageTaskApiConfig,
  reviewImageBatchItem,
  retryImageJob,
  saveLocalImageTaskApiConfig,
  type ImageJobStateV1,
  type ImageJobListV1,
  type ImageJobV1,
  type ImageBatchV1,
  type ImageBatchSummaryV1,
  type ImageTaskApiConfig,
  type ImageTaskCapabilitiesV1,
} from '../lib/imageTaskApi'

const ACTIVE_STATES = new Set<ImageJobStateV1>([
  'queued',
  'validating',
  'generating',
  'source_ready',
  'enhancing',
  'finalizing',
])

const STATE_LABELS: Record<ImageJobStateV1, string> = {
  queued: '排队',
  validating: '校验',
  generating: '生成底图',
  source_ready: '底图就绪',
  enhancing: '增强',
  finalizing: '收尾',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

const STATE_TONES: Record<ImageJobStateV1, string> = {
  queued: 'border-stone-300 bg-stone-100 text-stone-600 dark:border-white/10 dark:bg-white/[0.06] dark:text-stone-300',
  validating: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-400/20 dark:bg-sky-400/10 dark:text-sky-300',
  generating: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-400/20 dark:bg-cyan-400/10 dark:text-cyan-300',
  source_ready: 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-400/20 dark:bg-teal-400/10 dark:text-teal-300',
  enhancing: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300',
  finalizing: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-400/20 dark:bg-orange-400/10 dark:text-orange-300',
  succeeded: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300',
  failed: 'border-red-200 bg-red-50 text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300',
  cancelled: 'border-stone-300 bg-stone-100 text-stone-500 dark:border-white/10 dark:bg-white/[0.05] dark:text-stone-400',
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function StatusBadge({ state }: { state: ImageJobStateV1 }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium ${STATE_TONES[state]}`}>
      {ACTIVE_STATES.has(state) && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {STATE_LABELS[state]}
    </span>
  )
}

function QaBadge({ status }: { status: ImageBatchV1['items'][number]['qaStatus'] }) {
  const style = status === 'passed'
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
    : status === 'not_run'
      ? 'bg-stone-100 text-stone-500 dark:bg-white/[0.06] dark:text-stone-400'
      : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
  const label = status === 'passed' ? 'QA 通过' : status === 'not_run' ? 'QA 未运行' : 'QA 告警'
  return <span className={`rounded px-2 py-1 text-[10px] font-medium ${style}`}>{label}</span>
}

function HumanReviewBadge({
  status,
  autoAccepted = false,
}: {
  status: ImageBatchV1['items'][number]['humanReviewStatus']
  autoAccepted?: boolean
}) {
  const style = status === 'approved'
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
    : status === 'rejected'
      ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
      : status === 'not_applicable'
        ? 'bg-stone-100 text-stone-500 dark:bg-white/[0.06] dark:text-stone-400'
      : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
  const label = status === 'approved'
    ? autoAccepted ? 'QA 自动确认' : '人工已确认'
    : status === 'rejected'
      ? '已拒绝'
      : status === 'not_applicable'
        ? '无需人工确认'
        : status === 'not_ready'
          ? '等待生成'
          : '待人工确认'
  return <span className={`rounded px-2 py-1 text-[10px] font-medium ${style}`}>{label}</span>
}

function ReviewThumbnail({
  config,
  assetId,
  label,
}: {
  config: ImageTaskApiConfig
  assetId: string | null
  label: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [fullUrl, setFullUrl] = useState<string | null>(null)
  const [fullState, setFullState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => {
    if (fullUrl) URL.revokeObjectURL(fullUrl)
  }, [fullUrl])

  useEffect(() => {
    setFullUrl(null)
    setFullState('idle')
    setLightboxOpen(false)
  }, [assetId])

  useEffect(() => {
    if (!assetId) {
      setUrl(null)
      setVisible(false)
      return
    }
    setUrl(null)
    const element = containerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '160px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [assetId])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    if (!assetId || !visible) return
    void getImageAssetThumbnailBlob(config, assetId)
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (active) setUrl(null)
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [assetId, config, visible])

  const openFullPreview = async () => {
    if (!assetId || fullState === 'loading') return
    if (fullUrl) {
      setLightboxOpen(true)
      return
    }
    setFullState('loading')
    try {
      const blob = await getImageAssetBlob(config, assetId)
      setFullUrl(URL.createObjectURL(blob))
      setFullState('idle')
      setLightboxOpen(true)
    } catch {
      setFullState('error')
    }
  }

  return (
    <div ref={containerRef} className="relative h-full w-full bg-stone-100 dark:bg-white/[0.04]">
      <button
        type="button"
        onClick={() => void openFullPreview()}
        disabled={!assetId || fullState === 'loading'}
        className="group relative flex h-full w-full items-center justify-center overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#356c82] disabled:cursor-wait"
        aria-label={assetId ? `放大查看 ${label}` : label}
        title={assetId ? '点击查看大图' : undefined}
      >
        {url
          ? <img src={url} alt={label} className="h-full w-full object-cover" loading="lazy" />
          : <span className="text-[10px] text-stone-400">{visible ? '无预览' : '加载预览'}</span>}
        {url && fullState !== 'loading' && (
          <span className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true">
            <Maximize2 className="h-3.5 w-3.5" />
          </span>
        )}
        {fullState === 'loading' && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white" aria-live="polite">
            <LoaderCircle className="h-4 w-4 animate-spin" />
          </span>
        )}
      </button>
      {fullState === 'error' && (
        <p className="absolute inset-x-1 bottom-1 rounded bg-red-900/80 px-1 py-0.5 text-center text-[9px] text-white" role="alert">
          大图加载失败，点击重试
        </p>
      )}
      {lightboxOpen && fullUrl && (
        <EngineAssetLightbox
          initialMode="final"
          sourceUrl={null}
          finalUrl={fullUrl}
          onClose={() => {
            setLightboxOpen(false)
            setFullUrl(null)
          }}
        />
      )}
    </div>
  )
}

function toBatchSummary(batch: ImageBatchV1): ImageBatchSummaryV1 {
  const { items: _items, events: _events, ...summary } = batch
  return summary
}

function batchHasActiveAutomation(batch: ImageBatchV1) {
  return batch.automation.enabled && batch.items.some((item) => (
    ['succeeded', 'failed', 'cancelled'].includes(item.job.state)
    && item.automationState !== 'done'
  ))
}

function batchHasPendingQa(batch: ImageBatchSummaryV1) {
  return batch.automation.enabled
    && batch.state === 'completed'
    && batch.stats.acceptancePending > 0
}

function batchReviewNote(item: ImageBatchV1['items'][number]) {
  const review = item.review || {}
  const qa = (review.qa || review.qaReference) as { notes?: unknown; reason?: unknown } | undefined
  if (typeof qa?.notes === 'string' && qa.notes.trim()) return qa.notes.trim()
  if (typeof qa?.reason === 'string' && qa.reason.trim()) return qa.reason.trim()
  if (item.failureClass) return item.failureClass
  if (item.recoveryAction) return item.recoveryAction
  return null
}

function batchStateLabel(batch: ImageBatchSummaryV1) {
  if (batch.state === 'running') {
    if (batch.runner?.active) return '接管中'
    return (batch.runner?.attempt || 0) > 0 ? '等待接管' : '执行中'
  }
  if (batch.state === 'paused') return batch.pauseReason === 'runner_disconnected' ? '等待接管' : '已暂停'
  if (batchHasPendingQa(batch)) return 'QA 处理中'
  if (batch.acceptanceState === 'needs_review' || batch.acceptanceState === 'rejected') return '待人工复核'
  return '已归档'
}

function batchStateTone(batch: ImageBatchSummaryV1) {
  if (batch.state === 'running') return (batch.runner?.attempt || 0) > 0 && !batch.runner?.active
    ? 'text-amber-700 dark:text-amber-300'
    : 'text-sky-700 dark:text-sky-300'
  if (batch.state === 'paused' || batch.acceptanceState === 'needs_review' || batch.acceptanceState === 'rejected') return 'text-amber-700 dark:text-amber-300'
  if (batchHasPendingQa(batch)) return 'text-sky-700 dark:text-sky-300'
  return 'text-stone-500 dark:text-stone-400'
}

function BatchQueueRow({
  batch,
  selected,
  onSelect,
}: {
  batch: ImageBatchSummaryV1
  selected: boolean
  onSelect: (batch: ImageBatchSummaryV1) => void
}) {
  const issueCount = batch.stats.failed + batch.stats.cancelled + batch.stats.needsReview + batch.stats.rejected
  return (
    <button
      type="button"
      onClick={() => onSelect(batch)}
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-l-2 px-2 py-3 text-left transition-colors hover:bg-white/60 dark:hover:bg-white/[0.03] sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-3 ${selected ? 'border-l-[#356c82] bg-white dark:bg-white/[0.04]' : batch.state === 'running' ? 'border-l-sky-400/70' : issueCount ? 'border-l-amber-400/70' : 'border-l-transparent'}`}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{batch.name || batch.id}</div>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-stone-400">
          <span>{batch.stats.succeeded}/{batch.stats.total} 完成</span>
          {batch.stats.failed > 0 && <span>{batch.stats.failed} 失败</span>}
          {batch.stats.cancelled > 0 && <span>{batch.stats.cancelled} 取消</span>}
          {batch.stats.qaNeedsReview + batch.stats.qaFailed > 0 && <span>{batch.stats.qaNeedsReview + batch.stats.qaFailed} QA 告警</span>}
          {batch.stats.needsReview > 0 && <span>{batch.stats.needsReview} 待人工确认</span>}
        </div>
      </div>
      <time className="hidden self-center whitespace-nowrap text-[10px] text-stone-400 sm:block">{formatTime(batch.updatedAt)}</time>
      <span className={`self-center whitespace-nowrap text-[11px] font-medium ${batchStateTone(batch)}`}>{batchStateLabel(batch)}</span>
    </button>
  )
}

function BatchQueueSection({
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

interface NewJobDraft {
  prompt: string
  ratio: string
  model: string
  apiMode: 'images' | 'responses'
  fallbackEnabled: boolean
  fallbackModel: string
  fallbackApiMode: 'images' | 'responses'
  autoRevise: boolean
}

const DEFAULT_DRAFT: NewJobDraft = {
  prompt: '',
  ratio: '1:1',
  model: '',
  apiMode: 'images',
  fallbackEnabled: true,
  fallbackModel: 'gpt-5.6-sol',
  fallbackApiMode: 'responses',
  autoRevise: false,
}

export default function EngineWorkspace() {
  const initialConfig = useMemo(() => readLocalImageTaskApiConfig(), [])
  const [config, setConfig] = useState<ImageTaskApiConfig | null>(initialConfig)
  const [connectionDraft, setConnectionDraft] = useState({
    baseUrl: initialConfig?.baseUrl || 'http://127.0.0.1:9789',
    token: '',
  })
  const [capabilities, setCapabilities] = useState<ImageTaskCapabilitiesV1 | null>(null)
  const [jobs, setJobs] = useState<ImageJobV1[]>([])
  const [jobStats, setJobStats] = useState<ImageJobListV1['stats'] | null>(null)
  const [batches, setBatches] = useState<ImageBatchSummaryV1[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [filter, setFilter] = useState<ImageJobStateV1 | 'all'>('all')
  const [selectedJob, setSelectedJob] = useState<ImageJobV1 | null>(null)
  const [selectedBatch, setSelectedBatch] = useState<ImageBatchV1 | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string | null>(null)
  const [assetLightbox, setAssetLightbox] = useState<'source' | 'final' | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [showNewJob, setShowNewJob] = useState(false)
  const [showNewBatch, setShowNewBatch] = useState(false)
  const [batchFilter, setBatchFilter] = useState('')
  const [draft, setDraft] = useState<NewJobDraft>(DEFAULT_DRAFT)
  const [batchDraft, setBatchDraft] = useState({ name: '', prompts: '' })
  const selectedJobId = selectedJob?.id
  const inspectorSelectionRef = useRef<{
    version: number
    kind: 'none' | 'job' | 'batch'
    id: string | null
  }>({ version: 0, kind: 'none', id: null })

  const beginInspectorSelection = useCallback((kind: 'none' | 'job' | 'batch', id: string | null) => {
    const next = {
      version: inspectorSelectionRef.current.version + 1,
      kind,
      id,
    }
    inspectorSelectionRef.current = next
    return next.version
  }, [])

  const clearInspectorSelection = useCallback(() => {
    beginInspectorSelection('none', null)
    setSelectedJob(null)
    setSelectedBatch(null)
  }, [beginInspectorSelection])

  const handleSelectJob = useCallback((job: ImageJobV1) => {
    const selectionVersion = beginInspectorSelection('job', job.id)
    setShowNewJob(false)
    setShowNewBatch(false)
    setSelectedBatch(null)
    setSelectedJob(job)
    if (!config) return
    void getImageJob(config, job.id)
      .then((detail) => {
        const selection = inspectorSelectionRef.current
        if (
          selection.version === selectionVersion
          && selection.kind === 'job'
          && selection.id === job.id
        ) setSelectedJob(detail)
      })
      .catch((error) => setWorkspaceError(errorMessage(error)))
  }, [beginInspectorSelection, config])

  const handleSelectBatch = useCallback((batch: ImageBatchSummaryV1) => {
    const selectionVersion = beginInspectorSelection('batch', batch.id)
    setShowNewJob(false)
    setShowNewBatch(false)
    setSelectedJob(null)
    setSelectedBatch(null)
    if (!config) return
    void getImageBatch(config, batch.id)
      .then((detail) => {
        const selection = inspectorSelectionRef.current
        if (
          selection.version === selectionVersion
          && selection.kind === 'batch'
          && selection.id === batch.id
        ) setSelectedBatch(detail)
      })
      .catch((error) => setWorkspaceError(errorMessage(error)))
  }, [beginInspectorSelection, config])

  const refresh = useCallback(async (targetConfig = config, cursor?: string | null) => {
    if (!targetConfig) return
    setRefreshing(true)
    try {
      const result = await listImageJobs(targetConfig, {
        limit: 30,
        cursor: cursor || undefined,
        state: filter === 'all' ? undefined : filter,
      })
      setJobStats(result.stats)
      setJobs((current) => {
        if (cursor) {
          const known = new Set(current.map((job) => job.id))
          return [...current, ...result.items.filter((job) => !known.has(job.id))]
        }
        if (current.length <= result.items.length) return result.items
        const refreshed = new Set(result.items.map((job) => job.id))
        return [...result.items, ...current.filter((job) => !refreshed.has(job.id))].slice(0, current.length)
      })
      const loadedCount = cursor
        ? jobs.length + result.items.length
        : Math.max(jobs.length, result.items.length)
      setNextCursor(loadedCount >= result.stats.matching ? null : result.nextCursor)
      setWorkspaceError(null)
      if (selectedJobId) {
        const selectionVersion = inspectorSelectionRef.current.version
        const detail = await getImageJob(targetConfig, selectedJobId)
        const selection = inspectorSelectionRef.current
        if (
          selection.version === selectionVersion
          && selection.kind === 'job'
          && selection.id === selectedJobId
        ) setSelectedJob(detail)
      }
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setRefreshing(false)
    }
  }, [config, filter, jobs.length, selectedJobId])

  const connect = useCallback(async (candidate: ImageTaskApiConfig, persist: boolean) => {
    setBusy(true)
    setConnectionError(null)
    try {
      const nextCapabilities = await getImageTaskCapabilities(candidate)
      const normalized = persist ? saveLocalImageTaskApiConfig(candidate) : candidate
      setConfig(normalized)
      setCapabilities(nextCapabilities)
      setDraft((current) => current.model
        ? current
        : { ...current, model: nextCapabilities.capabilities.generation.defaultModel || '' })
      const result = await listImageJobs(normalized, { limit: 30 })
      setJobs(result.items)
      setJobStats(result.stats)
      setNextCursor(result.nextCursor)
      setBatches((await listImageBatches(normalized)).items)
    } catch (error) {
      setCapabilities(null)
      setConnectionError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (initialConfig) void connect(initialConfig, false)
  }, [connect, initialConfig])

  const refreshBatches = useCallback(async (targetConfig = config) => {
    if (!targetConfig) return
    try {
      const result = await listImageBatches(targetConfig)
      const next = result.items
      if (selectedBatch?.id) {
        const currentSummary = next.find((batch) => batch.id === selectedBatch.id)
        if (currentSummary && (currentSummary.state === 'running' || batchHasActiveAutomation(selectedBatch))) {
          const selectionVersion = inspectorSelectionRef.current.version
          const detail = await getImageBatch(targetConfig, selectedBatch.id)
          const selection = inspectorSelectionRef.current
          if (
            selection.version === selectionVersion
            && selection.kind === 'batch'
            && selection.id === detail.id
          ) setSelectedBatch(detail)
        }
      }
      setBatches(next)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    }
  }, [config, selectedBatch?.id])

  // Polling must have one stable lifecycle. State arrays are updated on every
  // response, so keeping them in the effect dependency list would tear down
  // and restart the timer after every poll.
  const pollingStateRef = useRef({ config, capabilities, jobs, batches, selectedBatch })
  pollingStateRef.current = { config, capabilities, jobs, batches, selectedBatch }
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const refreshBatchesRef = useRef(refreshBatches)
  refreshBatchesRef.current = refreshBatches

  useEffect(() => {
    if (!config || !capabilities) return
    let timer: number | undefined
    let disposed = false
    let inFlight = false
    let initialPoll = true
    const hasActiveWork = () => {
      const { jobs: currentJobs, batches: currentBatches, selectedBatch: currentSelectedBatch } = pollingStateRef.current
      return currentJobs.some((job) => ACTIVE_STATES.has(job.state))
        || currentBatches.some((batch) => batch.state === 'running')
        || Boolean(currentSelectedBatch && batchHasActiveAutomation(currentSelectedBatch))
    }
    const schedule = () => {
      if (disposed || timer !== undefined) return
      const interval = initialPoll
        ? 3_000
        : document.visibilityState === 'hidden'
          ? 60_000
          : hasActiveWork()
            ? 3_000
            : 15_000
      timer = window.setTimeout(() => {
        timer = undefined
        initialPoll = false
        void run()
      }, interval)
    }
    const run = async () => {
      if (disposed || inFlight) return
      inFlight = true
      const targetConfig = pollingStateRef.current.config
      if (!targetConfig) {
        inFlight = false
        return
      }
      try {
        await Promise.all([
          refreshRef.current(targetConfig, null),
          refreshBatchesRef.current(targetConfig),
        ])
      } finally {
        inFlight = false
        schedule()
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
      initialPoll = false
      void run()
    }
    // `connect` already loaded the first snapshot. Scheduling here avoids a
    // duplicate initial request under React StrictMode's development remount.
    schedule()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [capabilities, config])

  useEffect(() => {
    let finalObjectUrl: string | null = null
    let sourceObjectUrl: string | null = null
    const finalAssetId = selectedJob?.finalAssetId
    const sourceAssetId = selectedJob?.sourceAssetId
    if (!config || (!finalAssetId && !sourceAssetId)) {
      setPreviewUrl(null)
      setSourcePreviewUrl(null)
      return
    }
    if (finalAssetId) {
      void getImageAssetBlob(config, finalAssetId)
        .then((blob) => {
          finalObjectUrl = URL.createObjectURL(blob)
          setPreviewUrl(finalObjectUrl)
        })
        .catch(() => setPreviewUrl(null))
    } else {
      setPreviewUrl(null)
    }
    if (sourceAssetId) {
      void getImageAssetBlob(config, sourceAssetId)
        .then((blob) => {
          sourceObjectUrl = URL.createObjectURL(blob)
          setSourcePreviewUrl(sourceObjectUrl)
        })
        .catch(() => setSourcePreviewUrl(null))
    } else {
      setSourcePreviewUrl(null)
    }
    return () => {
      if (finalObjectUrl) URL.revokeObjectURL(finalObjectUrl)
      if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl)
    }
  }, [config, selectedJob?.finalAssetId, selectedJob?.sourceAssetId])

  const stats = useMemo(() => ({
    total: jobStats?.total ?? jobs.length,
    active: jobStats?.active ?? jobs.filter((job) => ACTIVE_STATES.has(job.state)).length,
    failed: jobStats?.failed ?? jobs.filter((job) => job.state === 'failed').length,
    succeeded: jobStats?.succeeded ?? jobs.filter((job) => job.state === 'succeeded').length,
  }), [jobStats, jobs])

  const batchGroups = useMemo(() => {
    const filtered = batches.filter((batch) => !batchFilter || (batch.name || batch.id).toLowerCase().includes(batchFilter.toLowerCase()))
    const runnerDisconnected = (batch: ImageBatchSummaryV1) => batch.state === 'running' && (batch.runner?.attempt || 0) > 0 && !batch.runner?.active
    const active = filtered.filter((batch) => batch.state === 'running' && !runnerDisconnected(batch))
    const needsAttention = filtered.filter((batch) => !active.includes(batch) && (
      runnerDisconnected(batch)
      || batch.state === 'paused'
      || batchHasPendingQa(batch)
      || batch.acceptanceState === 'needs_review'
      || batch.acceptanceState === 'rejected'
      || batch.stats.failed > 0
      || batch.stats.cancelled > 0
    ))
    const activeIds = new Set(active.map((batch) => batch.id))
    const attentionIds = new Set(needsAttention.map((batch) => batch.id))
    const history = filtered.filter((batch) => !activeIds.has(batch.id) && !attentionIds.has(batch.id))
    return { filtered, active, needsAttention, history }
  }, [batches, batchFilter])

  const loadAllJobs = useCallback(async () => {
    if (!config) return
    setRefreshing(true)
    try {
      const MAX_LOAD = 500
      const all: ImageJobV1[] = []
      let cursor: string | undefined
      do {
        const page = await listImageJobs(config, {
          limit: 100,
          cursor,
          state: filter === 'all' ? undefined : filter,
        })
        all.push(...page.items)
        setJobStats(page.stats)
        cursor = page.nextCursor || undefined
        if (all.length >= MAX_LOAD) break
      } while (cursor)
      setJobs(all)
      setNextCursor(null)
      setWorkspaceError(null)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setRefreshing(false)
    }
  }, [config, filter])

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault()
    await connect(connectionDraft, true)
  }

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    if (!config || !capabilities || !draft.prompt.trim()) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const created = await createImageJob(config, {
        contractVersion: '1',
        idempotencyKey: `engine-ui:${crypto.randomUUID()}`,
        input: { prompt: draft.prompt.trim() },
        composition: { ratio: draft.ratio },
        generation: createImageTaskGeneration({
          provider: 'configured',
          model: draft.model.trim(),
          apiMode: draft.apiMode,
          ...(draft.fallbackEnabled && draft.fallbackModel.trim() ? {
            fallback: {
              provider: 'configured',
              model: draft.fallbackModel.trim(),
              apiMode: draft.fallbackApiMode,
            },
          } : {}),
        }),
        output: {
          ratioMode: 'inherit',
          format: 'png',
          quality: 'high',
          dimensions: calculateImageSize('4K', draft.ratio) || undefined,
          enhancement: 'lanczos3',
          contentClass: 'photo',
        },
        retry: { maxAttempts: capabilities.capabilities.retry.maxAttempts },
      })
      setDraft((current) => ({ ...current, prompt: '' }))
      setShowNewJob(false)
      const detail = await getImageJob(config, created.id)
      beginInspectorSelection('job', detail.id)
      setSelectedBatch(null)
      setSelectedJob(detail)
      await refresh(config, null)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async () => {
    if (!config || !selectedJob) return
    setBusy(true)
    try {
      const cancelled = await cancelImageJob(config, selectedJob.id)
      setSelectedJob(cancelled)
      await refresh(config, null)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const handleCreateBatch = async (event: FormEvent) => {
    event.preventDefault()
    if (!config || !capabilities || !draft.model.trim()) return
    const prompts = parseEngineBatchPrompts(batchDraft.prompts)
    if (!prompts.length) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const batch = await createImageBatch(config, createEngineBatchRequest({
        name: batchDraft.name,
        prompts,
        draft,
        maxAttempts: capabilities.capabilities.retry.maxAttempts,
      }))
      setBatchDraft({ name: '', prompts: '' })
      setShowNewBatch(false)
      setShowNewJob(false)
      beginInspectorSelection('batch', batch.id)
      setSelectedJob(null)
      setSelectedBatch(batch)
      await refreshBatches(config)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const handleBatchControl = async (action: 'pause' | 'resume' | 'retry-failed') => {
    if (!config || !selectedBatch) return
    setBusy(true)
    try {
      const next = await controlImageBatch(config, selectedBatch.id, action)
      applyBatchUpdate(next)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const applyBatchUpdate = useCallback((next: ImageBatchV1) => {
    setSelectedBatch(next)
    setBatches((current) => {
      const summary = toBatchSummary(next)
      const found = current.some((batch) => batch.id === next.id)
      return found
        ? current.map((batch) => batch.id === next.id ? summary : batch)
        : [summary, ...current]
    })
  }, [])

  const handleBatchItemReview = async (
    itemKey: string,
    acceptanceStatus: 'accepted' | 'rejected',
  ) => {
    if (!config || !selectedBatch) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const next = await reviewImageBatchItem(config, selectedBatch.id, itemKey, {
        acceptanceStatus,
        detail: {
          actor: 'human',
          decidedAt: new Date().toISOString(),
          decision: acceptanceStatus === 'accepted' ? 'approved_for_delivery' : 'rejected_by_reviewer',
        },
      })
      applyBatchUpdate(next)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const handleBatchItemRetry = async (item: ImageBatchV1['items'][number]) => {
    if (!config || !selectedBatch || item.job.state !== 'succeeded') return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const next = await replaceImageBatchItemJob(
        config,
        selectedBatch.id,
        item.itemKey,
        {
          ...item.job.request,
          idempotencyKey: `human-review-retry:${crypto.randomUUID()}`,
        },
        'human_review_retry',
      )
      applyBatchUpdate(next)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const handleRetry = async () => {
    if (!config || !selectedJob) return
    setBusy(true)
    try {
      const retried = await retryImageJob(config, selectedJob.id)
      setSelectedJob(retried)
      await refresh(config, null)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const disconnect = () => {
    clearLocalImageTaskApiConfig()
    setConfig(null)
    setCapabilities(null)
    setJobs([])
    setJobStats(null)
    setBatches([])
    clearInspectorSelection()
    setConnectionDraft((current) => ({ ...current, token: '' }))
  }

  if (!capabilities || !config) {
    return (
      <main className="min-h-[calc(100vh-4rem)] bg-[#f4f1ec] px-4 py-8 dark:bg-[#11100e] sm:px-6 sm:py-12">
        <form onSubmit={handleConnect} className="mx-auto max-w-xl border-y border-stone-300 py-8 dark:border-white/10">
          <div className="mb-7 flex items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-950">
              <Cpu className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-50">连接图像任务引擎</h1>
              <p className="mt-1 text-sm leading-6 text-stone-500 dark:text-stone-400">连接信息仅保留在当前标签页会话。引擎必须先在本机或受控服务中启动。</p>
            </div>
          </div>
          <label className="block text-xs font-medium text-stone-500 dark:text-stone-400">
            服务地址
            <input
              value={connectionDraft.baseUrl}
              onChange={(event) => setConnectionDraft((current) => ({ ...current, baseUrl: event.target.value }))}
              className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 outline-none focus:border-[#356c82] dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-100"
              placeholder="http://127.0.0.1:9789"
            />
          </label>
          <label className="mt-4 block text-xs font-medium text-stone-500 dark:text-stone-400">
            Bearer token
            <input
              type="password"
              value={connectionDraft.token}
              onChange={(event) => setConnectionDraft((current) => ({ ...current, token: event.target.value }))}
              className="mt-2 w-full rounded-md border border-stone-300 bg-white px-3 py-2.5 font-mono text-sm text-stone-900 outline-none focus:border-[#356c82] dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-100"
              autoComplete="off"
            />
          </label>
          {connectionError && (
            <div className="mt-4 flex gap-2 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{connectionError}</span>
            </div>
          )}
          <button
            type="submit"
            disabled={busy || !connectionDraft.baseUrl.trim() || !connectionDraft.token.trim()}
            className="mt-6 inline-flex h-10 items-center gap-2 rounded-md bg-stone-900 px-4 text-sm font-medium text-white transition-colors hover:bg-[#356c82] disabled:opacity-40 dark:bg-stone-100 dark:text-stone-950"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Server className="h-4 w-4" />}
            验证并连接
          </button>
        </form>
      </main>
    )
  }

  return (
    <main className="h-[calc(100vh-4rem)] overflow-hidden bg-[#f4f1ec] text-stone-900 dark:bg-[#11100e] dark:text-stone-100">
      <div data-selectable-text="" className="mx-auto flex h-full max-w-[1500px] flex-col px-3 py-4 sm:px-6 sm:py-6">
        <header className="flex flex-col gap-4 border-b border-stone-300 pb-5 dark:border-white/10 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-emerald-700 dark:text-emerald-300">
              <Activity className="h-3.5 w-3.5" />
              引擎在线 · Contract {capabilities.contractVersion}
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal">图像资产流水线</h1>
            <p className="mt-1 max-w-2xl text-sm text-stone-500 dark:text-stone-400">
              任务事实来自服务端队列；当前实现增强器为 {capabilities.capabilities.output.implementedEnhancements.join(', ')}。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refresh(config, null)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-stone-300 bg-white text-stone-600 hover:text-stone-950 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-300"
              title="刷新"
              aria-label="刷新任务"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={disconnect}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-stone-300 bg-white text-stone-600 hover:text-red-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-300"
              title="断开连接"
              aria-label="断开引擎"
            >
              <Unplug className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                clearInspectorSelection()
                setShowNewJob(true)
                setShowNewBatch(false)
              }}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-[#df7b57] px-3 text-sm font-medium text-white hover:bg-[#c96643]"
            >
              <Plus className="h-4 w-4" />
              新建任务
            </button>
            <button
              type="button"
              onClick={() => {
                clearInspectorSelection()
                setShowNewJob(false)
                setShowNewBatch(true)
              }}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-[#356c82]/35 px-3 text-sm font-medium text-[#356c82] hover:bg-[#356c82]/10 dark:text-[#8ec5d7]"
            >
              <Layers className="h-4 w-4" />
              新建批次
            </button>
          </div>
        </header>

        <section className="grid grid-cols-4 border-b border-stone-300 dark:border-white/10">
          {[
            ['任务总数', stats.total],
            ['执行中', stats.active],
            ['已成功', stats.succeeded],
            ['失败', stats.failed],
          ].map(([label, value]) => (
            <div key={label} className="border-r border-stone-300 px-2 py-4 last:border-r-0 dark:border-white/10 sm:px-4">
              <div className="font-mono text-xl font-semibold sm:text-2xl">{value}</div>
              <div className="mt-1 text-[10px] font-medium uppercase text-stone-400 sm:text-xs">{label}</div>
            </div>
          ))}
        </section>

        {workspaceError && (
          <div className="mt-4 flex items-center justify-between border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <span>{workspaceError}</span>
            <button type="button" onClick={() => setWorkspaceError(null)} aria-label="关闭错误"><X className="h-4 w-4" /></button>
          </div>
        )}

        <div className="grid flex-1 overflow-hidden lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
          <section className="order-2 overflow-auto border-b border-stone-300 py-4 dark:border-white/10 lg:order-1 lg:border-b-0 lg:border-r lg:pr-5">
            <div className="mb-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">批次队列</h2>
                <span className="text-[10px] font-medium uppercase text-stone-400">{batchGroups.active.length} 执行中 · {batchGroups.needsAttention.length} 待处理 · {batchGroups.history.length} 历史</span>
              </div>
              {batches.length > 3 && (
                <input
                  type="text"
                  placeholder="筛选批次…"
                  value={batchFilter}
                  onChange={(e) => setBatchFilter(e.target.value)}
                  className="mb-2 w-full rounded-md border border-stone-300 bg-transparent px-2 py-1 text-xs dark:border-white/10"
                />
              )}
              <div id="batch-queue-list" className="border-y border-stone-300 dark:border-white/10">
                <BatchQueueSection title="执行中" batches={batchGroups.active} selectedBatchId={selectedBatch?.id} onSelect={handleSelectBatch} />
                <BatchQueueSection title="待处理" batches={batchGroups.needsAttention} selectedBatchId={selectedBatch?.id} onSelect={handleSelectBatch} />
                <BatchQueueSection title="历史记录" batches={batchGroups.history} selectedBatchId={selectedBatch?.id} onSelect={handleSelectBatch} />
                {!batchGroups.filtered.length && <div className="px-3 py-8 text-center text-xs text-stone-400">还没有匹配的批次</div>}
              </div>
            </div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">任务队列</h2>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <span className="font-mono text-[10px] text-stone-400">
                  已加载 {jobs.length} / {jobStats?.matching ?? jobs.length}
                </span>
                {nextCursor && (
                  <button
                    type="button"
                    onClick={() => void loadAllJobs()}
                    disabled={refreshing}
                    className="h-8 rounded-md border border-stone-300 bg-white px-2 text-xs font-medium text-stone-600 hover:text-stone-950 disabled:opacity-40 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-300"
                  >
                    加载全部（最多 500 条）
                  </button>
                )}
                <select
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value as ImageJobStateV1 | 'all')
                  setJobs([])
                  setJobStats(null)
                  setNextCursor(null)
                  setSelectedJob(null)
                }}
                className="h-8 rounded-md border border-stone-300 bg-white px-2 text-xs outline-none dark:border-white/10 dark:bg-[#191714]"
              >
                <option value="all">全部状态</option>
                {capabilities.capabilities.jobs.states.map((state) => (
                  <option key={state} value={state}>{STATE_LABELS[state]}</option>
                ))}
                </select>
              </div>
            </div>

            <div className="divide-y divide-stone-200 border-y border-stone-300 dark:divide-white/[0.06] dark:border-white/10">
              {jobs.map((job) => (
                <button
                  type="button"
                  key={job.id}
                  onClick={() => handleSelectJob(job)}
                  className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-2 py-3 text-left transition-colors hover:bg-white/60 dark:hover:bg-white/[0.03] sm:grid-cols-[minmax(0,1fr)_120px_90px_auto] sm:px-3 ${selectedJob?.id === job.id ? 'bg-white dark:bg-white/[0.04]' : ''}`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{job.request.input.prompt || '图像编辑任务'}</div>
                    <div className="mt-1 truncate font-mono text-[10px] text-stone-400">{job.id}</div>
                  </div>
                  <div className="hidden self-center text-xs text-stone-500 dark:text-stone-400 sm:block">
                    {job.request.composition.ratio} · {job.request.output.dimensions || '继承'}
                  </div>
                  <div className="hidden self-center text-xs text-stone-400 sm:block">{formatTime(job.updatedAt)}</div>
                  <div className="flex items-center gap-2 self-center">
                    <StatusBadge state={job.state} />
                    <ChevronRight className="h-4 w-4 text-stone-300" />
                  </div>
                </button>
              ))}
              {!jobs.length && (
                <div className="px-4 py-16 text-center text-sm text-stone-400">当前筛选下没有任务</div>
              )}
            </div>
            {nextCursor && (
              <button
                type="button"
                onClick={() => void refresh(config, nextCursor)}
                disabled={refreshing}
                className="mt-3 w-full rounded-md border border-stone-300 py-2 text-xs font-medium text-stone-600 hover:bg-white dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/[0.04]"
              >
                加载更早任务
              </button>
            )}
          </section>

          <aside className="order-1 overflow-auto border-b border-stone-300 py-4 lg:order-2 lg:border-b-0 lg:pb-4 lg:pl-5" style={{scrollbarWidth:'thin'}}>
            {showNewBatch ? (
              <NewBatchForm
                capabilities={capabilities}
                draft={draft}
                batchDraft={batchDraft}
                busy={busy}
                onChange={setBatchDraft}
                onRatioChange={(ratio) => setDraft((current) => ({ ...current, ratio }))}
                onAutoReviseChange={(autoRevise) => setDraft((current) => ({ ...current, autoRevise }))}
                onClose={() => setShowNewBatch(false)}
                onSubmit={handleCreateBatch}
              />
            ) : showNewJob ? (
              <NewJobForm
                capabilities={capabilities}
                draft={draft}
                busy={busy}
                onChange={setDraft}
                onClose={() => setShowNewJob(false)}
                onSubmit={handleCreate}
              />
            ) : selectedBatch ? (
              <BatchInspector
                batch={selectedBatch}
                config={config}
                busy={busy}
                onControl={handleBatchControl}
                onReview={handleBatchItemReview}
                onRetryItem={handleBatchItemRetry}
                onClose={clearInspectorSelection}
              />
            ) : selectedJob ? (
              <JobInspector
                job={selectedJob}
                previewUrl={previewUrl}
                busy={busy}
                onOpenPreview={setAssetLightbox}
                onCancel={handleCancel}
                onRetry={handleRetry}
                onClose={clearInspectorSelection}
              />
            ) : (
              <div className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-300 text-center dark:border-white/10">
                <Cpu className="h-8 w-8 text-stone-300 dark:text-stone-600" />
                <p className="mt-3 text-sm font-medium">选择任务查看执行轨迹</p>
                <p className="mt-1 text-xs text-stone-400">事件、错误和产物都以服务端记录为准</p>
              </div>
            )}
          </aside>
        </div>
      </div>
      {assetLightbox && (previewUrl || sourcePreviewUrl) && (
        <EngineAssetLightbox
          initialMode={assetLightbox}
          sourceUrl={sourcePreviewUrl}
          finalUrl={previewUrl}
          onClose={() => setAssetLightbox(null)}
        />
      )}
    </main>
  )
}

function NewJobForm({
  capabilities,
  draft,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  capabilities: ImageTaskCapabilitiesV1
  draft: NewJobDraft
  busy: boolean
  onChange: (draft: NewJobDraft) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}) {
  return (
    <form data-engine-editor onSubmit={onSubmit}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-medium uppercase text-[#df7b57]">Submit</div>
          <h2 className="mt-1 text-lg font-semibold">新建流水线任务</h2>
        </div>
        <button type="button" onClick={onClose} className="p-2 text-stone-400 hover:text-stone-800 dark:hover:text-white" aria-label="关闭">
          <X className="h-4 w-4" />
        </button>
      </div>
      <label className="mt-5 block text-xs font-medium text-stone-500 dark:text-stone-400">
        提示词
        <textarea
          value={draft.prompt}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
          rows={6}
          className="mt-2 w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2.5 text-sm leading-6 outline-none focus:border-[#356c82] dark:border-white/10 dark:bg-white/[0.04]"
          autoFocus
        />
      </label>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="text-xs font-medium text-stone-500 dark:text-stone-400">
          比例
          <select
            value={draft.ratio}
            onChange={(event) => onChange({ ...draft, ratio: event.target.value })}
            className="mt-2 h-10 w-full rounded-md border border-stone-300 bg-white px-2 text-sm dark:border-white/10 dark:bg-[#191714]"
          >
            {capabilities.capabilities.ratios.map((ratio) => <option key={ratio}>{ratio}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium text-stone-500 dark:text-stone-400">
          API 模式
          <select
            value={draft.apiMode}
            onChange={(event) => onChange({ ...draft, apiMode: event.target.value as NewJobDraft['apiMode'] })}
            className="mt-2 h-10 w-full rounded-md border border-stone-300 bg-white px-2 text-sm dark:border-white/10 dark:bg-[#191714]"
          >
            {capabilities.capabilities.apiModes.map((mode) => <option key={mode}>{mode}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-4 block text-xs font-medium text-stone-500 dark:text-stone-400">
        模型
        <input
          value={draft.model}
          onChange={(event) => onChange({ ...draft, model: event.target.value })}
          className="mt-2 h-10 w-full rounded-md border border-stone-300 bg-white px-3 font-mono text-sm outline-none focus:border-[#356c82] dark:border-white/10 dark:bg-white/[0.04]"
          placeholder="留空则使用引擎默认模型"
        />
      </label>
      <div className="mt-4 border-t border-stone-300 pt-4 dark:border-white/10">
        <label className="flex items-center justify-between gap-3 text-xs font-medium text-stone-500 dark:text-stone-400">
          <span>主路由失败后自动切换备用路由</span>
          <input
            type="checkbox"
            checked={draft.fallbackEnabled}
            onChange={(event) => onChange({ ...draft, fallbackEnabled: event.target.checked })}
            className="h-4 w-4 accent-[#356c82]"
          />
        </label>
        {draft.fallbackEnabled && (
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_120px] gap-3">
            <label className="text-xs font-medium text-stone-500 dark:text-stone-400">
              备用模型
              <input
                value={draft.fallbackModel}
                onChange={(event) => onChange({ ...draft, fallbackModel: event.target.value })}
                className="mt-2 h-10 w-full rounded-md border border-stone-300 bg-white px-3 font-mono text-sm outline-none focus:border-[#356c82] dark:border-white/10 dark:bg-white/[0.04]"
              />
            </label>
            <label className="text-xs font-medium text-stone-500 dark:text-stone-400">
              API 模式
              <select
                value={draft.fallbackApiMode}
                onChange={(event) => onChange({ ...draft, fallbackApiMode: event.target.value as NewJobDraft['fallbackApiMode'] })}
                className="mt-2 h-10 w-full rounded-md border border-stone-300 bg-white px-2 text-sm dark:border-white/10 dark:bg-[#191714]"
              >
                {capabilities.capabilities.apiModes.map((mode) => <option key={mode}>{mode}</option>)}
              </select>
            </label>
          </div>
        )}
      </div>
      <div className="mt-4 border-y border-stone-300 py-3 text-xs text-stone-500 dark:border-white/10 dark:text-stone-400">
        <div className="flex justify-between"><span>规范源图</span><span className="font-mono">{calculateImageSize('2K', draft.ratio)}</span></div>
        <div className="mt-2 flex justify-between"><span>最终产物</span><span className="font-mono">{calculateImageSize('4K', draft.ratio)} PNG</span></div>
        <div className="mt-2 flex justify-between"><span>增强器</span><span className="font-mono">lanczos3</span></div>
      </div>
      <button
        type="submit"
        disabled={busy || !draft.prompt.trim() || !draft.model.trim() || (draft.fallbackEnabled && !draft.fallbackModel.trim())}
        className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#df7b57] px-4 text-sm font-medium text-white hover:bg-[#c96643] disabled:opacity-40"
      >
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        提交任务
      </button>
    </form>
  )
}

function NewBatchForm({
  capabilities,
  draft,
  batchDraft,
  busy,
  onChange,
  onRatioChange,
  onAutoReviseChange,
  onClose,
  onSubmit,
}: {
  capabilities: ImageTaskCapabilitiesV1
  draft: NewJobDraft
  batchDraft: { name: string; prompts: string }
  busy: boolean
  onChange: (draft: { name: string; prompts: string }) => void
  onRatioChange: (ratio: string) => void
  onAutoReviseChange: (autoRevise: boolean) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const prompts = parseEngineBatchPrompts(batchDraft.prompts)
  const promptCount = prompts.length
  const outputCount = countEngineBatchOutputs(prompts)
  return (
    <form data-engine-editor onSubmit={onSubmit}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-medium uppercase text-[#356c82]">Batch</div>
          <h2 className="mt-1 text-lg font-semibold">新建批次</h2>
        </div>
        <button type="button" onClick={onClose} className="p-2 text-stone-400 hover:text-stone-800 dark:hover:text-white" aria-label="关闭">
          <X className="h-4 w-4" />
        </button>
      </div>
      <label className="mt-5 block text-xs font-medium text-stone-500 dark:text-stone-400">
        批次名称
        <input
          value={batchDraft.name}
          onChange={(event) => onChange({ ...batchDraft, name: event.target.value })}
          className="mt-2 h-10 w-full rounded-md border border-stone-300 bg-white px-3 text-sm outline-none focus:border-[#356c82] dark:border-white/10 dark:bg-white/[0.04]"
          placeholder="可选"
        />
      </label>
      <label className="mt-4 block text-xs font-medium text-stone-500 dark:text-stone-400">
        提示词
        <textarea
          value={batchDraft.prompts}
          onChange={(event) => onChange({ ...batchDraft, prompts: event.target.value })}
          rows={12}
          className="mt-2 w-full resize-y rounded-md border border-stone-300 bg-white px-3 py-2.5 text-sm leading-6 outline-none focus:border-[#356c82] dark:border-white/10 dark:bg-white/[0.04]"
          placeholder="每行一个提示词"
          autoFocus
        />
      </label>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-xs font-medium text-stone-500 dark:text-stone-400">
          比例
          <select
            value={draft.ratio}
            onChange={(event) => onRatioChange(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border border-stone-300 bg-white px-2 text-sm dark:border-white/10 dark:bg-[#191714]"
          >
            {capabilities.capabilities.ratios.map((ratio) => <option key={ratio}>{ratio}</option>)}
          </select>
        </label>
        <div className="text-xs font-medium text-stone-500 dark:text-stone-400">
          <div>提示词 / 输出</div>
          <div className="mt-2 h-10 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 font-mono text-sm text-stone-600 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-300">{promptCount} / {outputCount}</div>
        </div>
      </div>
      <div className="mt-4 border-y border-stone-300 py-3 text-xs text-stone-500 dark:border-white/10 dark:text-stone-400">
        <div className="flex justify-between gap-3"><span>主路由</span><span className="truncate font-mono">{draft.model} / {draft.apiMode}</span></div>
        <div className="mt-2 flex justify-between gap-3"><span>备用路由</span><span className="truncate font-mono">{draft.fallbackEnabled ? `${draft.fallbackModel} / ${draft.fallbackApiMode}` : '关闭'}</span></div>
        <div className="mt-2 flex justify-between gap-3"><span>QA 检查模型</span><span className="truncate font-mono">{draft.fallbackModel} / responses</span></div>
        <div className="flex justify-between"><span>规范源图</span><span className="font-mono">{calculateImageSize('2K', draft.ratio)}</span></div>
        <div className="mt-2 flex justify-between"><span>最终产物</span><span className="font-mono">{calculateImageSize('4K', draft.ratio)} PNG (Lanczos3)</span></div>
      </div>
      <label className="mt-4 flex cursor-pointer items-start gap-3 border-l-2 border-amber-300 bg-amber-50/70 px-3 py-3 text-xs text-amber-900 dark:border-amber-400/50 dark:bg-amber-400/10 dark:text-amber-100">
        <input
          type="checkbox"
          checked={draft.autoRevise}
          onChange={(event) => onAutoReviseChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[#356c82]"
        />
        <span>
          <span className="block font-medium">高级：QA 告警后自动修订</span>
          <span className="mt-1 block leading-5 opacity-80">默认仅标记告警并继续执行；开启后最多自动重生两次。</span>
        </span>
      </label>
      <button
        type="submit"
        disabled={busy || promptCount === 0 || !draft.model.trim() || !draft.fallbackModel.trim()}
        className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#356c82] px-4 text-sm font-medium text-white hover:bg-[#2b596b] disabled:opacity-40"
      >
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
        提交批次
      </button>
    </form>
  )
}

function BatchInspector({
  batch,
  config,
  busy,
  onControl,
  onReview,
  onRetryItem,
  onClose,
}: {
  batch: ImageBatchV1
  config: ImageTaskApiConfig
  busy: boolean
  onControl: (action: 'pause' | 'resume' | 'retry-failed') => void
  onReview: (itemKey: string, acceptanceStatus: 'accepted' | 'rejected') => void
  onRetryItem: (item: ImageBatchV1['items'][number]) => void
  onClose: () => void
}) {
  const [reviewFilter, setReviewFilter] = useState<'all' | 'warnings' | 'pending' | 'approved' | 'rejected'>('pending')
  const executionPercentage = batch.stats.total ? Math.round((batch.stats.terminal / batch.stats.total) * 100) : 0
  const autoAcceptedCount = batch.items.filter((item) => item.humanReviewStatus === 'approved' && item.humanReview?.actor === 'system').length
  const humanApprovedCount = Math.max(0, batch.stats.humanReviewApproved - autoAcceptedCount)
  const deliveryDone = batch.stats.accepted + batch.stats.rejected
  const deliveryPercentage = batch.stats.total ? Math.round((deliveryDone / batch.stats.total) * 100) : 0
  const reviewItems = batch.items.filter((item) => {
    if (reviewFilter === 'warnings') return item.qaStatus === 'needs_review' || item.qaStatus === 'failed' || item.qaStatus === 'not_run'
    if (reviewFilter === 'pending') return item.humanReviewStatus === 'pending'
    if (reviewFilter === 'approved') return item.humanReviewStatus === 'approved'
    if (reviewFilter === 'rejected') return item.humanReviewStatus === 'rejected'
    return true
  })
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase text-stone-400">Batch detail</div>
          <h2 className="mt-1 break-all font-mono text-sm font-semibold">{batch.name || batch.id}</h2>
          {batch.automation.enabled && (
            <div className="mt-2 text-[10px] font-medium text-[#356c82] dark:text-[#8ec5d7]">
              自动恢复 · 视觉 QA · 人工确认交付
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-md border border-stone-300 px-2 py-1 text-[11px] font-medium text-stone-600 dark:border-white/10 dark:text-stone-300">
            {batch.state === 'paused' ? '已暂停' : batch.state === 'completed' ? '已完成' : '运行中'}
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
      <div className="mt-5">
        <div className="flex items-center justify-between text-xs text-stone-500 dark:text-stone-400">
          <span>执行进度</span>
          <span className="font-mono">{batch.stats.terminal}/{batch.stats.total} · {executionPercentage}%</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-white/10">
          <div className="h-full rounded-full bg-[#356c82] transition-[width]" style={{ width: `${executionPercentage}%` }} />
        </div>
        <div className="mt-4 flex items-center justify-between text-xs text-stone-500 dark:text-stone-400">
          <span>交付确认进度</span>
          <span className="font-mono">{deliveryDone}/{batch.stats.total} · {deliveryPercentage}%</span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-200 dark:bg-white/10">
          <div className="h-full rounded-full bg-emerald-500 transition-[width]" style={{ width: `${deliveryPercentage}%` }} />
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
            ['warnings', `QA 告警 ${batch.stats.qaNeedsReview + batch.stats.qaFailed + batch.stats.qaNotRun}`],
            ['all', `全部 ${batch.stats.total}`],
            ['approved', `已确认 ${batch.stats.humanReviewApproved}`],
            ['rejected', `已拒绝 ${batch.stats.humanReviewRejected}`],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setReviewFilter(value)}
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
        <div className="mt-3 grid max-h-[620px] grid-cols-1 gap-2 overflow-auto pr-1 sm:grid-cols-2">
          {reviewItems.map((item) => {
            const canDecide = item.job.state === 'succeeded' && item.humanReviewStatus === 'pending'
            const qaNote = batchReviewNote(item)
            return (
              <article
                key={item.itemKey}
                className={`overflow-hidden border text-xs ${
                  item.qaStatus === 'needs_review' || item.qaStatus === 'failed' || item.qaStatus === 'not_run'
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
              当前筛选下没有条目
            </div>
          )}
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
      </div>
    </div>
  )
}

function JobInspector({
  job,
  previewUrl,
  busy,
  onOpenPreview,
  onCancel,
  onRetry,
  onClose,
}: {
  job: ImageJobV1
  previewUrl: string | null
  busy: boolean
  onOpenPreview: (mode: 'source' | 'final') => void
  onCancel: () => void
  onRetry: () => void
  onClose: () => void
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase text-stone-400">Job detail</div>
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
          <div
            role="button"
            tabIndex={0}
            onClick={() => onOpenPreview('final')}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpenPreview('final') }}
            className="group relative overflow-hidden rounded-md border border-stone-300 bg-[repeating-conic-gradient(#ddd_0_25%,#fff_0_50%)_0_0/16px_16px] cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-[#356c82] dark:border-white/10"
            aria-label="放大预览 4K 产物"
          >
            <span className="absolute right-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md bg-black/65 text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Maximize2 className="h-4 w-4" />
            </span>
            {job.sourceAssetId && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onOpenPreview('source') }}
                className="absolute left-2 top-2 z-10 inline-flex h-7 items-center gap-1 rounded-md bg-black/65 px-2 text-[10px] text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
              >
                原图
              </button>
            )}
            <img src={previewUrl} alt="最终产物" className="max-h-[420px] w-full object-contain" />
          </div>
        </div>
      )}

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

function EngineAssetLightbox({
  initialMode,
  sourceUrl,
  finalUrl,
  onClose,
}: {
  initialMode: 'source' | 'final'
  sourceUrl: string | null
  finalUrl: string | null
  onClose: () => void
}) {
  const [mode, setMode] = useState<'source' | 'final'>(
    initialMode === 'source' && sourceUrl ? 'source' : 'final',
  )
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ pointerId: number; x: number; y: number } | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const src = mode === 'source' ? sourceUrl : finalUrl

  const resetView = useCallback(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === '0') resetView()
      if (event.key === '+' || event.key === '=') setScale((value) => Math.min(4, value + 0.25))
      if (event.key === '-') setScale((value) => Math.max(0.5, value - 0.25))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, resetView])

  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  const selectMode = (nextMode: 'source' | 'final') => {
    setMode(nextMode)
    resetView()
  }

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    setScale((value) => Math.max(0.5, Math.min(4, value + (event.deltaY < 0 ? 0.2 : -0.2))))
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ pointerId: event.pointerId, x: event.clientX, y: event.clientY })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    setPosition((value) => ({
      x: value.x + event.clientX - drag.x,
      y: value.y + event.clientY - drag.y,
    }))
    setDrag({ pointerId: event.pointerId, x: event.clientX, y: event.clientY })
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/[0.94] text-white backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="图片放大预览"
    >
      <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-white/15 px-3 sm:px-5">
        <div className="flex items-center gap-1 rounded-md bg-white/10 p-1">
          <button
            type="button"
            onClick={() => selectMode('source')}
            disabled={!sourceUrl}
            className={`h-8 rounded px-3 text-xs font-medium transition disabled:opacity-30 ${mode === 'source' ? 'bg-white text-black' : 'text-white/70 hover:text-white'}`}
          >
            原图
          </button>
          <button
            type="button"
            onClick={() => selectMode('final')}
            disabled={!finalUrl}
            className={`h-8 rounded px-3 text-xs font-medium transition disabled:opacity-30 ${mode === 'final' ? 'bg-white text-black' : 'text-white/70 hover:text-white'}`}
          >
            4K
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setScale((value) => Math.max(0.5, value - 0.25))} className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10" title="缩小" aria-label="缩小">
            <ZoomOut className="h-4 w-4" />
          </button>
          <button type="button" onClick={resetView} className="h-9 min-w-14 rounded-md px-2 font-mono text-xs hover:bg-white/10" title="恢复 100%">
            {Math.round(scale * 100)}%
          </button>
          <button type="button" onClick={() => setScale((value) => Math.min(4, value + 0.25))} className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10" title="放大" aria-label="放大">
            <ZoomIn className="h-4 w-4" />
          </button>
          <span className="mx-1 hidden h-5 w-px bg-white/15 sm:block" />
          <span className="hidden items-center gap-1.5 text-[11px] text-white/45 sm:inline-flex">
            <Move className="h-3.5 w-3.5" />
            拖动查看
          </span>
          <button ref={closeButtonRef} type="button" onClick={onClose} className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70" title="关闭" aria-label="关闭预览">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div
        className={`relative min-h-0 flex-1 touch-none overflow-hidden ${drag ? 'cursor-grabbing' : 'cursor-grab'}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={resetView}
      >
        {src && (
          <img
            src={src}
            alt={mode === 'source' ? '生成原图' : '4K 产物'}
            draggable={false}
            className="absolute left-1/2 top-1/2 max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] select-none object-contain shadow-2xl"
            style={{
              transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px)) scale(${scale})`,
              transformOrigin: 'center',
            }}
          />
        )}
      </div>
    </div>
  )
}
