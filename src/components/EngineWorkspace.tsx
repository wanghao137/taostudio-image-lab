import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { useDialogTrap } from '../hooks/useDialogTrap'
import {
  Activity,
  ArrowLeft,
  Ban,
  Check,
  ChevronRight,
  CircleAlert,
  Cpu,
  Download,
  FolderOpen,
  HardDrive,
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
  BATCH_LIST_LIMIT,
  clearLocalImageTaskApiConfig,
  createImageTaskGeneration,
  createImageJob,
  createImageBatch,
  controlImageBatch,
  getImageBatch,
  getImageBatchSummary,
  getImageAssetBlob,
  getImageAssetPreviewBlob,
  getImageAssetThumbnailBlob,
  getImageJob,
  getImageTaskCapabilities,
  listImageBatches,
  listImageBatchEvents,
  listImageBatchItems,
  listAllImageBatchItems,
  listImageJobs,
  replaceImageBatchItemJob,
  readLocalImageTaskApiConfig,
  reviewImageBatchItem,
  retryImageJob,
  saveLocalImageTaskApiConfig,
  subscribeImageTaskEvents,
  bulkReviewBatchItems,
  archiveImageBatch,
  deleteImageBatch,
  pruneAssets,
  type ImageBatchEventV1,
  type ImageBatchItemV1,
  type ImageJobStateV1,
  type ImageJobListV1,
  type ImageJobV1,
  type ImageBatchV1,
  type ImageBatchSummaryV1,
  type ImageTaskApiConfig,
  type ImageTaskCapabilitiesV1,
  ImageTaskApiError,
} from '../lib/imageTaskApi'
import { showBrowserNotification } from '../lib/browserNotification'
import {
  chooseEngineLocalDeliveryDirectory,
  downloadEngineBatch,
  downloadEngineJob,
  getEngineLocalDeliveryDirectory,
  isEngineLocalDeliverySupported,
  saveEngineBatchLocally,
  saveEngineJobLocally,
} from '../lib/engineLocalDelivery'
import { getEngineDeliveryRecord, type EngineDeliveryRecord } from '../lib/db'
import EngineAssetLightbox from './engine/EngineAssetLightbox'
import ReviewThumbnail from './engine/ReviewThumbnail'
import {
  ACTIVE_STATES,
  STATE_LABELS,
  StatusBadge,
  QaBadge,
  HumanReviewBadge,
  DeliveryStatus,
  formatTime,
  errorMessage,
  formatDuration,
  shortTaskTitle,
  imageJobsEqual,
  imageBatchesEqual,
  toBatchSummary,
  batchHasActiveAutomation,
  batchHasPendingQa,
  batchReviewNote,
  batchPresentationState,
  batchStateLabel,
  batchStateTone,
  batchPrimaryAction,
  displayBatchName,
  type BatchPresentationState,
} from './engine/shared'
import { BatchQueueSection, CollapsibleBatchSection } from './engine/BatchQueue'
import { NewJobForm, NewBatchForm, type NewJobDraft, DEFAULT_DRAFT } from './engine/NewForms'
import BatchInspector from './engine/BatchInspector'
import JobInspector from './engine/JobInspector'
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
  const [batchItemsCursor, setBatchItemsCursor] = useState<string | null>(null)
  const [batchEventsCursor, setBatchEventsCursor] = useState<string | null>(null)
  const [batchItemsTotal, setBatchItemsTotal] = useState(0)
  const [batchEventsTotal, setBatchEventsTotal] = useState(0)
  const [eventTransport, setEventTransport] = useState<'sse' | 'polling'>('polling')
  const [statusAnnouncement, setStatusAnnouncement] = useState('')
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
  const [batchFacet, setBatchFacet] = useState<'all' | 'review' | 'failed' | 'cancelled' | 'qa' | 'delivery' | 'low_success' | 'recent' | 'archived'>('all')
  // Historical batch groups (incomplete / archived) are collapsed by default so
  // the high-priority running + needs-attention batches stay visible without
  // being buried under dozens of past batches. Users expand a group on demand.
  const [collapsedBatchGroups, setCollapsedBatchGroups] = useState<Record<string, boolean>>({ '已结束但不完整': true, '历史批次': true })
  const [draft, setDraft] = useState<NewJobDraft>(DEFAULT_DRAFT)
  const [batchDraft, setBatchDraft] = useState({ name: '', prompts: '' })
  const [deliveryDirectoryName, setDeliveryDirectoryName] = useState<string | null>(null)
  const [deliveryRecords, setDeliveryRecords] = useState<Record<string, EngineDeliveryRecord>>({})
  const [deliveryBusy, setDeliveryBusy] = useState(false)
  const [deliveryDirectoryRevision, setDeliveryDirectoryRevision] = useState(0)
  const deliveryBusyCountRef = useRef(0)
  const deliveryDirectoryRevisionRef = useRef(0)
  const deliveryAutoSaveStartedAtRef = useRef<number | null>(null)
  const deliveryResyncRevisionRef = useRef<number | null>(null)
  const deliveryAttemptedRef = useRef(new Set<string>())
  const deliveryRunningRef = useRef(new Set<string>())
  // P1-5: Track which batches were active (running/paused) to detect completion
  const batchActiveRef = useRef(new Set<string>())
  const selectedJobId = selectedJob?.id
  const inspectorOpen = showNewJob || showNewBatch || Boolean(selectedJob || selectedBatch)
  const inspectorRef = useRef<HTMLElement>(null)
  // Sentinel element at the bottom of the job queue. When it scrolls into view
  // and there is a next page, auto-load older jobs instead of forcing the user
  // to click a "load more" button.
  const jobSentinelRef = useRef<HTMLDivElement | null>(null)
  const inspectorSelectionRef = useRef<{
    version: number
    kind: 'none' | 'job' | 'batch'
    id: string | null
  }>({ version: 0, kind: 'none', id: null })

  const setDeliveryRecord = useCallback((record: EngineDeliveryRecord) => {
    setDeliveryRecords((current) => ({ ...current, [`${record.kind}:${record.entityId}`]: record }))
  }, [])

  const beginDeliveryOperation = useCallback(() => {
    deliveryBusyCountRef.current += 1
    setDeliveryBusy(true)
  }, [])

  const endDeliveryOperation = useCallback(() => {
    deliveryBusyCountRef.current = Math.max(0, deliveryBusyCountRef.current - 1)
    setDeliveryBusy(deliveryBusyCountRef.current > 0)
  }, [])

  const refreshDeliveryRecord = useCallback(async (kind: EngineDeliveryRecord['kind'], entityId: string) => {
    try {
      const record = await getEngineDeliveryRecord(kind, entityId)
      if (record) setDeliveryRecord(record)
      return record
    } catch {
      return undefined
    }
  }, [setDeliveryRecord])

  const handleChooseDeliveryDirectory = useCallback(async () => {
    beginDeliveryOperation()
    try {
      const directory = await chooseEngineLocalDeliveryDirectory()
      setDeliveryDirectoryName(directory.name)
      const nextRevision = deliveryDirectoryRevisionRef.current + 1
      deliveryDirectoryRevisionRef.current = nextRevision
      deliveryResyncRevisionRef.current = nextRevision
      setDeliveryDirectoryRevision(nextRevision)
      deliveryAutoSaveStartedAtRef.current = Date.now()
      deliveryAttemptedRef.current.clear()
      setStatusAnnouncement(`本地交付目录已设置为 ${directory.name}`)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setWorkspaceError(errorMessage(error))
    } finally {
      endDeliveryOperation()
    }
  }, [beginDeliveryOperation, endDeliveryOperation])

  const saveJobDelivery = useCallback(async (job: ImageJobV1, force = false) => {
    if (!job.finalAssetId || job.state !== 'succeeded') return
    const key = `job:${job.id}:${job.sourceAssetId || ''}:${job.finalAssetId}`
    if (!force && deliveryAttemptedRef.current.has(key)) return
    if (deliveryRunningRef.current.has(`job:${job.id}`)) return
    deliveryAttemptedRef.current.add(key)
    deliveryRunningRef.current.add(`job:${job.id}`)
    beginDeliveryOperation()
    try {
      const result = await saveEngineJobLocally(config!, job, (progress) => {
        setStatusAnnouncement(`任务 ${job.id} 本地交付：${progress.status === 'saving' ? '保存中' : progress.status === 'saved' ? '已保存' : progress.error || progress.status}`)
      }, force)
      setDeliveryRecord(result.record)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      deliveryRunningRef.current.delete(`job:${job.id}`)
      endDeliveryOperation()
    }
  }, [beginDeliveryOperation, config, endDeliveryOperation, setDeliveryRecord])

  const saveBatchDelivery = useCallback(async (batch: ImageBatchV1 | ImageBatchSummaryV1, force = false, resetSavedItems = false) => {
    const key = `batch:${batch.id}:${batch.state}:${batch.stats.succeeded}:${batch.stats.failed}:${batch.stats.cancelled}:dir${deliveryDirectoryRevision}`
    if (!force && deliveryAttemptedRef.current.has(key)) return
    if (deliveryRunningRef.current.has(`batch:${batch.id}`)) return
    deliveryAttemptedRef.current.add(key)
    deliveryRunningRef.current.add(`batch:${batch.id}`)
    beginDeliveryOperation()
    try {
      const result = await saveEngineBatchLocally(config!, batch, (progress) => {
        setStatusAnnouncement(`批次 ${batch.name || batch.id} 本地交付：${progress.savedCount}/${progress.totalCount} · ${progress.status === 'saving' ? '保存中' : progress.status === 'saved' ? '已保存' : progress.error || progress.status}`)
      }, force, resetSavedItems)
      setDeliveryRecord(result.record)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      deliveryRunningRef.current.delete(`batch:${batch.id}`)
      endDeliveryOperation()
    }
  }, [beginDeliveryOperation, config, endDeliveryOperation, setDeliveryRecord])

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
    void refreshDeliveryRecord('job', job.id)
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
    setSelectedBatch({ ...batch, items: [], events: [] })
    void refreshDeliveryRecord('batch', batch.id)
    setBatchItemsCursor(null)
    setBatchEventsCursor(null)
    setBatchItemsTotal(batch.stats.total)
    setBatchEventsTotal(0)
    if (!config) return
    // Items load independently of the summary + events so the task queue
    // populates (and batch-item rows become clickable) even when the summary
    // fetch is slow. Each callback guards against a stale selection via the
    // version captured at selection time.
    const selectionMatches = () => {
      const selection = inspectorSelectionRef.current
      return selection.version === selectionVersion
        && selection.kind === 'batch'
        && selection.id === batch.id
    }
    // Load ALL items so client-side facet filtering (待确认 / QA告警 / etc.)
    // matches the whole-batch counts shown on the facet tabs. Without this,
    // pending items beyond the first page are invisible until manual load-more.
    void listAllImageBatchItems(config, batch.id)
      .then((items) => {
        if (!selectionMatches()) return
        setSelectedBatch((current) => current?.id === batch.id ? { ...current, items } : current)
        setBatchItemsCursor(null)
        setBatchItemsTotal(items.length)
      })
      .catch((error) => { if (!(error instanceof ImageTaskApiError && error.status === 404)) setWorkspaceError(errorMessage(error)) })
    void Promise.all([
      getImageBatchSummary(config, batch.id),
      listImageBatchEvents(config, batch.id, { limit: 30 }),
    ])
      .then(([summary, eventPage]) => {
        if (!selectionMatches()) return
        setSelectedBatch((current) => current?.id === batch.id
          ? { ...summary, items: current.items, events: eventPage.items }
          : current)
        setBatchEventsCursor(eventPage.nextCursor)
        setBatchEventsTotal(eventPage.total)
      })
      .catch(async (error) => {
        if (error instanceof ImageTaskApiError && error.status === 404) {
          try {
            const detail = await getImageBatch(config, batch.id)
            if (selectionMatches()) {
              setSelectedBatch(detail)
              setBatchItemsTotal(detail.items.length)
              setBatchEventsTotal(detail.events.length)
            }
            return
          } catch (fallbackError) {
            setWorkspaceError(errorMessage(fallbackError))
            return
          }
        }
        setWorkspaceError(errorMessage(error))
      })
  }, [beginInspectorSelection, config, refreshDeliveryRecord])

  const refresh = useCallback(async (targetConfig = config, cursor?: string | null) => {
    if (!targetConfig) return
    setRefreshing(true)
    try {
      const result = await listImageJobs(targetConfig, {
        limit: 30,
        cursor: cursor || undefined,
        state: filter === 'all' ? undefined : filter,
      })
      setJobStats((current) => JSON.stringify(current) === JSON.stringify(result.stats) ? current : result.stats)
      const fetchedIds = new Set(result.items.map((job) => job.id))
      let nextJobs: ImageJobV1[]
      let resolvedCursor: string | null
      if (cursor) {
        // Append-load (older page): keep existing jobs, append only the ones we
        // don't already have, preserving newest-first order.
        const known = new Set(jobs.map((job) => job.id))
        nextJobs = [...jobs, ...result.items.filter((job) => !known.has(job.id))]
        resolvedCursor = nextJobs.length >= result.stats.matching ? null : result.nextCursor
      } else {
        // First-page refresh (SSE poll or manual): replace the first page with
        // the fresh result, but preserve any previously-appended older pages
        // whose jobs did not reappear in the refreshed first page. Older-page
        // jobs are by definition older than the first page, so a job that
        // genuinely belongs to an older page will not be in the fresh first
        // page (unless it moved forward in time, which jobs cannot).
        const olderJobs = jobs.filter((job) => !fetchedIds.has(job.id))
        nextJobs = [...result.items, ...olderJobs]
        // Keep the existing cursor if we still have appended older pages;
        // otherwise adopt the fresh first-page cursor. Only null out when the
        // merged list actually covers everything matching.
        resolvedCursor = nextJobs.length >= result.stats.matching
          ? null
          : (nextCursor ?? result.nextCursor)
      }
      setJobs((current) => imageJobsEqual(current, nextJobs) ? current : nextJobs)
      setNextCursor(resolvedCursor)
      setWorkspaceError(null)
      if (selectedJobId) {
        // 终态任务且列表里它的 updatedAt 未变：跳过详情拉取——否则检查器
        // 每 3 秒被新对象引用重渲染一次，相等性守卫全被绕过。
        const listedJob = result.items.find((job) => job.id === selectedJobId)
          ?? nextJobs.find((job) => job.id === selectedJobId)
        const selectedSnapshot = selectedJob
        if (
          selectedSnapshot
          && listedJob
          && (listedJob.state === 'succeeded' || listedJob.state === 'failed' || listedJob.state === 'cancelled')
          && listedJob.updatedAt === selectedSnapshot.updatedAt
        ) {
          // 详情未变，跳过
        } else {
          const selectionVersion = inspectorSelectionRef.current.version
          const detail = await getImageJob(targetConfig, selectedJobId)
          const selection = inspectorSelectionRef.current
          if (
            selection.version === selectionVersion
            && selection.kind === 'job'
            && selection.id === selectedJobId
          ) {
            setSelectedJob((current) => current && imageJobsEqual([current], [detail]) ? current : detail)
          }
        }
      }
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setRefreshing(false)
    }
  }, [config, filter, jobs, nextCursor, selectedJobId])

  // Auto-load older jobs when the sentinel scrolls into view. Guards against:
  //   - no next page (nextCursor null)
  //   - a load already in flight (refreshing)
  //   - config not ready
  // The refresh callback is stable per its deps; we read nextCursor/refreshing
  // from refs inside the observer callback so we don't have to tear down and
  // rebuild the observer on every state change. (refreshRef is declared below
  // alongside the polling refs; nextCursorRef/refreshingRef are added there too.)
  const nextCursorForObserverRef = useRef(nextCursor)
  nextCursorForObserverRef.current = nextCursor
  const refreshingForObserverRef = useRef(refreshing)
  refreshingForObserverRef.current = refreshing
  // The sentinel div is conditionally rendered (only when jobs exist), so the
  // observer effect must re-run once the first page of jobs mounts the
  // sentinel. hasJobs gates this: it flips false->true exactly once in the
  // normal flow, attaching the observer then; subsequent job updates read the
  // latest cursor/refreshing state through refs without re-running the effect.
  const hasJobs = jobs.length > 0
  useEffect(() => {
    if (!hasJobs) return
    const sentinel = jobSentinelRef.current
    if (!sentinel) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        const cursor = nextCursorForObserverRef.current
        if (cursor && !refreshingForObserverRef.current && pollingStateRef.current.config) {
          void refreshRef.current(pollingStateRef.current.config, cursor)
        }
      }
    }, { rootMargin: '200px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasJobs])
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

  useEffect(() => {
    void getEngineLocalDeliveryDirectory()
      .then((directory) => {
        setDeliveryDirectoryName(directory?.name || null)
        if (directory && deliveryAutoSaveStartedAtRef.current === null) {
          deliveryAutoSaveStartedAtRef.current = Date.now()
        }
      })
      .catch(() => setDeliveryDirectoryName(null))
  }, [])

  useEffect(() => {
    if (!config || !deliveryDirectoryName || deliveryAutoSaveStartedAtRef.current === null) return
    const autoSaveStartedAt = deliveryAutoSaveStartedAtRef.current
    const resyncDirectory = deliveryResyncRevisionRef.current === deliveryDirectoryRevision
    for (const job of jobs) {
      if (job.state === 'succeeded' && job.finalAssetId && (resyncDirectory || new Date(job.updatedAt).getTime() >= autoSaveStartedAt)) void saveJobDelivery(job, resyncDirectory)
    }
    for (const batch of batches) {
      if (batch.state === 'completed' && (resyncDirectory || new Date(batch.updatedAt).getTime() >= autoSaveStartedAt)) void saveBatchDelivery(batch, resyncDirectory, resyncDirectory)
    }
    if (resyncDirectory) deliveryResyncRevisionRef.current = null
  }, [batches, config, deliveryDirectoryName, deliveryDirectoryRevision, jobs, saveBatchDelivery, saveJobDelivery])

  const refreshBatches = useCallback(async (targetConfig = config) => {
    if (!targetConfig) return
    try {
      const result = await listImageBatches(targetConfig)
      const next = result.items
      // P1-5: Fire browser notification when a batch transitions to completed
      const prevActiveRef = batchActiveRef.current
      for (const batch of next) {
        const wasActive = prevActiveRef.has(batch.id)
        const isNowCompleted = batch.state === 'completed'
        if (wasActive && isNowCompleted) {
          const accepted = batch.stats.accepted
          const failed = batch.stats.failed
          showBrowserNotification('批次已完成', {
            body: `${batch.name?.split(' ').slice(0, 3).join(' ') || batch.id.slice(0, 12)} · ${accepted} 成功${failed > 0 ? ` · ${failed} 失败` : ''}`,
            tag: `batch-complete-${batch.id}`,
          })
        }
        if (isNowCompleted) prevActiveRef.delete(batch.id)
        else prevActiveRef.add(batch.id)
      }
      if (selectedBatch?.id) {
        const currentSummary = next.find((batch) => batch.id === selectedBatch.id)
        if (currentSummary) {
          const selectionVersion = inspectorSelectionRef.current.version
          const summary = await getImageBatchSummary(targetConfig, selectedBatch.id)
          const selection = inspectorSelectionRef.current
          if (
            selection.version === selectionVersion
            && selection.kind === 'batch'
            && selection.id === summary.id
          ) {
            setSelectedBatch((current) => current?.id === summary.id ? { ...summary, items: current.items, events: current.events } : current)
          }
        }
      }
      setBatches((current) => imageBatchesEqual(current, next) ? current : next)
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
    if (capabilities.capabilities.events.transport === 'sse') {
      const controller = new AbortController()
      let refreshTimer: number | undefined
      let fallbackTimer: number | undefined
      let fallbackDisposed = false
      const queueRefresh = () => {
        if (refreshTimer !== undefined) return
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          void Promise.all([refreshRef.current(config, null), refreshBatchesRef.current(config)])
        }, 250)
      }
      const runFallbackPoll = async () => {
        if (fallbackDisposed) return
        const targetConfig = pollingStateRef.current.config
        if (targetConfig) {
          await Promise.all([
            refreshRef.current(targetConfig, null),
            refreshBatchesRef.current(targetConfig),
          ]).catch(() => undefined)
        }
        if (!fallbackDisposed) {
          fallbackTimer = window.setTimeout(runFallbackPoll, document.visibilityState === 'hidden' ? 60_000 : 30_000)
        }
      }
      void subscribeImageTaskEvents(config, {
        signal: controller.signal,
        onOpen: () => setEventTransport('sse'),
        onChange: queueRefresh,
      }).catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setEventTransport('polling')
        void runFallbackPoll()
      })
      return () => {
        fallbackDisposed = true
        controller.abort()
        if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
        if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
      }
    }
    setEventTransport('polling')
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
      void getImageAssetPreviewBlob(config, finalAssetId)
        .then((blob) => {
          finalObjectUrl = URL.createObjectURL(blob)
          setPreviewUrl(finalObjectUrl)
        })
        .catch(() => setPreviewUrl(null))
    } else {
      setPreviewUrl(null)
    }
    if (sourceAssetId) {
      void getImageAssetPreviewBlob(config, sourceAssetId)
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
    const filtered = batches.filter((batch) => {
      const haystack = [
        batch.name,
        batch.id,
        batch.createdAt.slice(0, 10),
        ...(batch.facets?.models || []),
        ...(batch.facets?.dimensions || []),
        ...(batch.facets?.failureClasses || []),
      ].filter(Boolean).join(' ').toLowerCase()
      const matchesText = !batchFilter || haystack.includes(batchFilter.toLowerCase())
      const matchesFacet = batchFacet === 'all'
        || (batchFacet === 'review' && batch.stats.humanReviewPending > 0)
        || (batchFacet === 'failed' && batch.stats.failed > 0)
        || (batchFacet === 'cancelled' && batch.stats.cancelled > 0)
        || (batchFacet === 'qa' && batch.stats.qaFailed + batch.stats.qaNeedsReview > 0)
        || (batchFacet === 'delivery' && batchPresentationState(batch) === 'delivery_ready')
        || (batchFacet === 'low_success' && batch.stats.total > 0 && batch.stats.succeeded / batch.stats.total < 0.9)
        || (batchFacet === 'recent' && Date.now() - new Date(batch.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000)
        || (batchFacet === 'archived' && batch.state === 'archived')
      return matchesText && matchesFacet
    })
    const runnerDisconnected = (batch: ImageBatchSummaryV1) => batch.state === 'running' && (batch.runner?.attempt || 0) > 0 && !batch.runner?.active
    const active = filtered.filter((batch) => batch.state === 'running' && !runnerDisconnected(batch))
    const needsAttention = filtered.filter((batch) => !active.includes(batch) && (
      runnerDisconnected(batch)
      || batch.state === 'paused'
      || batchHasPendingQa(batch)
      || batch.acceptanceState === 'needs_review'
      || batch.stats.humanReviewPending > 0
    ))
    const activeIds = new Set(active.map((batch) => batch.id))
    const attentionIds = new Set(needsAttention.map((batch) => batch.id))
    const incomplete = filtered.filter((batch) => !activeIds.has(batch.id) && !attentionIds.has(batch.id) && (
      batch.stats.failed > 0
      || batch.acceptanceState === 'rejected'
      || batch.stats.rejected > 0
    ))
    const incompleteIds = new Set(incomplete.map((batch) => batch.id))
    // Separate archived batches from normal completed history so the user can
    // browse archived batch data without it being buried in the history list.
    const archived = filtered.filter((batch) => !activeIds.has(batch.id) && !attentionIds.has(batch.id) && !incompleteIds.has(batch.id) && batch.state === 'archived')
    const archivedIds = new Set(archived.map((batch) => batch.id))
    const history = filtered.filter((batch) => !activeIds.has(batch.id) && !attentionIds.has(batch.id) && !incompleteIds.has(batch.id) && !archivedIds.has(batch.id))
    // Merge archived into history so the user sees one unified "历史" group.
    // The archived filter (facet dropdown) still works to find them quickly.
    const allHistory = [...history, ...archived]
    return { filtered, active, needsAttention, incomplete, archived: allHistory, history: [] }
  }, [batches, batchFacet, batchFilter])
  const activeOrPendingCount = batchGroups.active.length + batchGroups.needsAttention.length

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

  const handleBatchControl = async (action: 'pause' | 'resume' | 'retry-failed' | 'retry-cancelled') => {
    if (!config || !selectedBatch) return
    setBusy(true)
    try {
      const next = await controlImageBatch(config, selectedBatch.id, action)
      applyBatchUpdate(next)
      setStatusAnnouncement(action === 'retry-cancelled' ? `已重新执行 ${selectedBatch.stats.cancelled} 个取消项` : action === 'retry-failed' ? `已重试 ${selectedBatch.stats.failed} 个失败项` : action === 'pause' ? '批次已暂停' : '批次已恢复')
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

  useEffect(() => {
    if (inspectorOpen) window.requestAnimationFrame(() => inspectorRef.current?.focus())
  }, [inspectorOpen, selectedBatch?.id, selectedJob?.id])

  const loadMoreBatchItems = useCallback(async () => {
    if (!config || !selectedBatch || !batchItemsCursor) return
    const page = await listImageBatchItems(config, selectedBatch.id, { limit: 50, cursor: batchItemsCursor })
    setSelectedBatch((current) => current?.id === selectedBatch.id
      ? { ...current, items: [...current.items, ...page.items] }
      : current)
    setBatchItemsCursor(page.nextCursor)
    setBatchItemsTotal(page.total)
  }, [batchItemsCursor, config, selectedBatch])

  const loadMoreBatchEvents = useCallback(async () => {
    if (!config || !selectedBatch || !batchEventsCursor) return
    const page = await listImageBatchEvents(config, selectedBatch.id, { limit: 30, cursor: batchEventsCursor })
    setSelectedBatch((current) => current?.id === selectedBatch.id
      ? { ...current, events: [...current.events, ...page.items] }
      : current)
    setBatchEventsCursor(page.nextCursor)
    setBatchEventsTotal(page.total)
  }, [batchEventsCursor, config, selectedBatch])

  // Update batch summary fields (stats / state / controlState) from a server
  // response while PRESERVING the locally-loaded items and events. The server
  // batch's items array is paginated and would truncate the user's loaded view,
  // so only the summary fields are taken. Used after review / retry mutations.
  const applyBatchSummaryUpdate = useCallback((next: ImageBatchV1) => {
    setSelectedBatch((current) => current?.id === next.id
      ? { ...next, items: current.items, events: current.events }
      : current)
    setBatches((current) => {
      const summary = toBatchSummary(next)
      const found = current.some((batch) => batch.id === next.id)
      return found
        ? current.map((batch) => batch.id === next.id ? summary : batch)
        : [summary, ...current]
    })
  }, [])

  // Optimistically patch one or more batch items' human-review status locally.
  // This avoids a server refetch that would reset pagination and scroll position
  // — the reviewed item simply slides out of the active facet on its own.
  const patchBatchItemsReview = useCallback((
    itemKeys: string[],
    acceptanceStatus: 'accepted' | 'rejected',
  ) => {
    const decidedAt = new Date().toISOString()
    const decision = acceptanceStatus === 'accepted' ? 'approved_for_delivery' : 'rejected_by_reviewer'
    const humanReviewStatus: ImageBatchItemV1['humanReviewStatus'] = acceptanceStatus === 'accepted' ? 'approved' : 'rejected'
    const keySet = new Set(itemKeys)
    setSelectedBatch((current) => {
      if (!current) return current
      const items = current.items.map((item) =>
        keySet.has(item.itemKey)
          ? { ...item, humanReviewStatus, humanReview: { actor: 'human', decidedAt, decision } }
          : item,
      )
      return { ...current, items }
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
      // Optimistic update: patch summary + the one item locally. No refetch →
      // the loaded items, facet filter, and scroll position all stay put.
      applyBatchSummaryUpdate(next)
      patchBatchItemsReview([itemKey], acceptanceStatus)
      setStatusAnnouncement(acceptanceStatus === 'accepted' ? '已确认该产物可交付' : '已拒绝该产物')
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
      // Optimistic update: preserve loaded items, patch summary, and splice in
      // the retried item from the server response (its job changed). No page-1
      // refetch → view stays put.
      applyBatchSummaryUpdate(next)
      const updatedItem = next.items.find((entry) => entry.itemKey === item.itemKey)
      if (updatedItem) {
        setSelectedBatch((current) => {
          if (!current || current.id !== selectedBatch.id) return current
          return { ...current, items: current.items.map((entry) => entry.itemKey === item.itemKey ? updatedItem : entry) }
        })
      }
      setStatusAnnouncement('已提交该条目重新生成')
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  // P1-4: Bulk review — accept all QA-passed items or reject all pending items
  const handleBulkReview = async (
    items: ImageBatchV1['items'][number][],
    acceptanceStatus: 'accepted' | 'rejected',
  ) => {
    if (!config || !selectedBatch || !items.length) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const itemKeys = items.map((item) => item.itemKey)
      const next = await bulkReviewBatchItems(config, selectedBatch.id, itemKeys, acceptanceStatus)
      // Optimistic update: patch summary + all reviewed items locally. No refetch.
      applyBatchSummaryUpdate(next)
      patchBatchItemsReview(itemKeys, acceptanceStatus)
      setStatusAnnouncement(acceptanceStatus === 'accepted' ? `已批量确认 ${itemKeys.length} 项` : `已批量拒绝 ${itemKeys.length} 项`)
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  // P2-11: Archive / delete batch
  const handleArchiveBatch = async (batchId: string) => {
    if (!config) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const next = await archiveImageBatch(config, batchId)
      applyBatchUpdate(next)
      setStatusAnnouncement('批次已归档')
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteBatch = async (batchId: string) => {
    if (!config) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      await deleteImageBatch(config, batchId)
      setSelectedBatch(null)
      await refreshBatches()
      setStatusAnnouncement('批次已删除')
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  // P0-3: Asset GC
  const handlePruneAssets = async () => {
    if (!config) return
    setBusy(true)
    setWorkspaceError(null)
    try {
      const result = await pruneAssets(config, { includeOrphans: true })
      setStatusAnnouncement(`已清理 ${result.prunedHarvested + result.prunedOrphaned} 个资产文件`)
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
    <main className="h-[calc(100vh-4rem)] supports-[height:100dvh]:h-[calc(100dvh-4rem)] overflow-hidden bg-[#f4f1ec] text-stone-900 dark:bg-[#11100e] dark:text-stone-100">
      <p className="sr-only" aria-live="polite">{statusAnnouncement}</p>
      <div data-selectable-text="" className="mx-auto flex h-full max-w-[1500px] flex-col px-3 py-4 sm:px-6 sm:py-6">
        <header className="flex flex-col gap-4 border-b border-stone-300 pb-5 dark:border-white/10 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase text-emerald-700 dark:text-emerald-300">
              <Activity className="h-3.5 w-3.5" />
              引擎在线 · 协议 v{capabilities.contractVersion}
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-normal">图像资产流水线</h1>
            <p className="mt-1 max-w-2xl text-sm text-stone-500 dark:text-stone-400">
              任务事实来自服务端队列；当前实现增强器为 {capabilities.capabilities.output.implementedEnhancements.join(', ')}。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleChooseDeliveryDirectory()}
              disabled={deliveryBusy || !isEngineLocalDeliverySupported()}
              className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs font-medium ${deliveryDirectoryName ? 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-400/30 dark:text-emerald-300 dark:hover:bg-emerald-500/10' : 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-400/30 dark:text-amber-300 dark:hover:bg-amber-500/10'} disabled:opacity-40`}
              title={isEngineLocalDeliverySupported() ? '选择生成结果自动保存的本地目录' : '当前浏览器不支持目录自动写入'}
            >
              {deliveryBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
              {deliveryDirectoryName ? `交付：${deliveryDirectoryName}` : '设置本地交付'}
            </button>
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
            <div key={label} className="border-r border-stone-300 px-2 py-2 last:border-r-0 dark:border-white/10 sm:px-4 sm:py-4">
              <div className="font-mono text-base font-semibold sm:text-2xl">{value}</div>
              <div className="mt-0.5 text-[9px] font-medium uppercase text-stone-400 sm:mt-1 sm:text-xs">{label}</div>
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
          <section className={`${inspectorOpen ? 'hidden lg:block' : 'order-1'} overflow-auto border-b border-stone-300 py-4 dark:border-white/10 lg:order-1 lg:border-b-0 lg:border-r lg:pr-5`}>
            <div className="mb-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">批次队列</h2>
                <span className="text-[10px] font-medium uppercase text-stone-400">{batchGroups.active.length} 执行中 · {batchGroups.needsAttention.length} 待处理 · {batchGroups.incomplete.length} 异常结束 · {batchGroups.archived.length} 历史</span>
              </div>
              {batches.length >= BATCH_LIST_LIMIT && (
                <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
                  仅显示最近 {BATCH_LIST_LIMIT} 个批次，更早的历史批次未列出。
                </div>
              )}
              {batches.length > 3 && (
                <div className="mb-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                  <input
                    type="search"
                    placeholder="搜索名称、日期、模型、尺寸、失败类型…"
                    value={batchFilter}
                    onChange={(e) => setBatchFilter(e.target.value)}
                    className="h-8 w-full rounded-md border border-stone-300 bg-transparent px-2 text-xs dark:border-white/10"
                  />
                  <select value={batchFacet} onChange={(event) => setBatchFacet(event.target.value as typeof batchFacet)} className="h-8 rounded-md border border-stone-300 bg-white px-2 text-xs dark:border-white/10 dark:bg-[#191714]" aria-label="批次问题筛选">
                    <option value="all">全部批次</option>
                    <option value="review">待人审</option>
                    <option value="failed">有失败</option>
                    <option value="cancelled">有取消</option>
                    <option value="qa">QA 告警</option>
                    <option value="delivery">可交付</option>
                    <option value="low_success">成功率低于 90%</option>
                    <option value="recent">最近 7 天</option>
                    <option value="archived">已归档</option>
                  </select>
                </div>
              )}
              <div id="batch-queue-list" className="border-y border-stone-300 dark:border-white/10">
                {/* Priority groups: running + needs-attention get a min-height quota so
                    historical batches can never push them out of view. The quota only
                    applies while there is something to protect; when both groups are
                    empty it is dropped and an empty-state hint is shown instead of a
                    dead blank strip. */}
                {activeOrPendingCount > 0 ? (
                  <div className="min-h-[120px]">
                    <BatchQueueSection title="执行中" batches={batchGroups.active} selectedBatchId={selectedBatch?.id} onSelect={handleSelectBatch} />
                    <BatchQueueSection title="待处理" batches={batchGroups.needsAttention} selectedBatchId={selectedBatch?.id} onSelect={handleSelectBatch} />
                  </div>
                ) : (
                  <div className="px-3 py-5 text-center text-xs text-stone-400">当前没有执行中或待处理的批次</div>
                )}
                {/* Historical groups: collapsed by default, expand on demand. */}
                <CollapsibleBatchSection
                  title="已结束但不完整"
                  batches={batchGroups.incomplete}
                  selectedBatchId={selectedBatch?.id}
                  onSelect={handleSelectBatch}
                  collapsed={collapsedBatchGroups['已结束但不完整'] ?? false}
                  onToggle={() => setCollapsedBatchGroups((current) => ({ ...current, '已结束但不完整': !current['已结束但不完整'] }))}
                />
                <CollapsibleBatchSection
                  title="历史批次"
                  batches={batchGroups.archived}
                  selectedBatchId={selectedBatch?.id}
                  onSelect={handleSelectBatch}
                  collapsed={collapsedBatchGroups['历史批次'] ?? true}
                  onToggle={() => setCollapsedBatchGroups((current) => ({ ...current, '历史批次': !current['历史批次'] }))}
                />
                {!batchGroups.filtered.length && <div className="px-3 py-8 text-center text-xs text-stone-400">还没有匹配的批次</div>}
              </div>
            </div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">
                {selectedBatch ? `批次条目 · ${selectedBatch.stats?.succeeded ?? 0}/${selectedBatch.stats?.total ?? 0}` : '任务队列'}
              </h2>
              {!selectedBatch && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span className="font-mono text-[10px] text-stone-400">
                    已加载 {jobs.length} / {jobStats?.matching ?? jobs.length}
                  </span>
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
              )}
            </div>

            {selectedBatch ? (
              <div className="divide-y divide-stone-200 border-y border-stone-300 dark:divide-white/[0.06] dark:border-white/10">
                {(selectedBatch.items || []).map((item) => (
                  <button
                    type="button"
                    key={item.itemKey}
                    onClick={() => item.job && handleSelectJob(item.job)}
                    className={`grid w-full grid-cols-[44px_minmax(0,1fr)_auto] gap-3 px-2 py-3 text-left transition-colors [content-visibility:auto] [contain-intrinsic-size:68px] hover:bg-white/60 dark:hover:bg-white/[0.03] sm:grid-cols-[44px_minmax(0,1fr)_120px_90px_auto] sm:px-3 ${selectedJob?.id === item.job?.id ? 'bg-white dark:bg-white/[0.04]' : ''}`}
                  >
                    <div className="h-11 w-11 overflow-hidden border border-stone-200 dark:border-white/10">
                      <ReviewThumbnail config={config} assetId={item.job?.finalAssetId || null} label={`条目 ${item.itemKey}`} interactive={false} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium" title={item.job?.request?.input?.prompt || ''}>
                        {shortTaskTitle(item.job?.request?.input?.prompt || '图像任务')}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="truncate font-mono text-[10px] text-stone-400">{item.itemKey}</span>
                        <QaBadge status={item.qaStatus} />
                        <HumanReviewBadge status={item.humanReviewStatus} autoAccepted={item.humanReview?.actor === 'system'} />
                      </div>
                    </div>
                    <div className="hidden self-center text-xs text-stone-500 dark:text-stone-400 sm:block">
                      {item.job?.request?.composition?.ratio || '—'} · {item.job?.request?.output?.dimensions || '继承'}
                    </div>
                    <div className="hidden self-center text-xs text-stone-400 sm:block">{formatTime(item.job?.updatedAt || new Date().toISOString())}</div>
                    <div className="flex items-center gap-2 self-center">
                      <StatusBadge state={item.job?.state || 'queued'} />
                    </div>
                  </button>
                ))}
                {(!selectedBatch.items || !selectedBatch.items.length) && (
                  <div className="px-4 py-16 text-center text-sm text-stone-400">该批次暂无已加载条目</div>
                )}
                {selectedBatch.items && selectedBatch.items.length > 0 && (
                  <div className="py-3 text-center text-xs text-stone-400">
                    已加载 {selectedBatch.items.length} / {batchItemsTotal} 个条目
                    {batchItemsCursor && (
                      <button type="button" onClick={() => void loadMoreBatchItems()} className="ml-2 rounded-md border border-stone-300 px-2 py-1 font-medium hover:text-stone-700 dark:border-white/10">加载更多</button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="divide-y divide-stone-200 border-y border-stone-300 dark:divide-white/[0.06] dark:border-white/10">
                  {jobs.map((job) => (
                    <button
                      type="button"
                      key={job.id}
                      onClick={() => handleSelectJob(job)}
                      className={`grid w-full grid-cols-[44px_minmax(0,1fr)_auto] gap-3 px-2 py-3 text-left transition-colors [content-visibility:auto] [contain-intrinsic-size:68px] hover:bg-white/60 dark:hover:bg-white/[0.03] sm:grid-cols-[44px_minmax(0,1fr)_120px_90px_auto] sm:px-3 ${selectedJob?.id === job.id ? 'bg-white dark:bg-white/[0.04]' : ''}`}
                    >
                      <div className="h-11 w-11 overflow-hidden border border-stone-200 dark:border-white/10">
                        <ReviewThumbnail config={config} assetId={job.finalAssetId || null} label={`${shortTaskTitle(job.request.input.prompt)} 缩略图`} interactive={false} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium" title={job.request.input.prompt}>{shortTaskTitle(job.request.input.prompt)}</div>
                        <div className="mt-1 truncate font-mono text-[10px] text-stone-400">{job.error?.message || job.id}</div>
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
                {/* Infinite-scroll sentinel */}
                {jobs.length > 0 && (
                  <div ref={jobSentinelRef} className="py-3 text-center text-xs text-stone-400">
                    {nextCursor ? (refreshing ? '加载更早任务…' : '向下滚动加载更多') : '没有更早的任务了'}
                  </div>
                )}
              </>
            )}
          </section>

          <aside ref={inspectorRef} tabIndex={-1} aria-label="流水线详情" className={`${inspectorOpen ? 'order-1 block' : 'hidden lg:block'} overflow-auto border-b border-stone-300 py-4 outline-none lg:order-2 lg:border-b-0 lg:pb-4 lg:pl-5`} style={{scrollbarWidth:'thin'}}>
            {showNewBatch ? (
              <NewBatchForm
                capabilities={capabilities}
                draft={draft}
                batchDraft={batchDraft}
                busy={busy}
                deliveryDirectoryName={deliveryDirectoryName}
                deliverySupported={isEngineLocalDeliverySupported()}
                onChooseDeliveryDirectory={() => void handleChooseDeliveryDirectory()}
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
                deliveryDirectoryName={deliveryDirectoryName}
                deliverySupported={isEngineLocalDeliverySupported()}
                onChooseDeliveryDirectory={() => void handleChooseDeliveryDirectory()}
                onChange={setDraft}
                onClose={() => setShowNewJob(false)}
                onSubmit={handleCreate}
              />
            ) : selectedBatch ? (
              <BatchInspector
                key={selectedBatch.id}
                batch={selectedBatch}
                config={config}
                busy={busy}
                delivery={deliveryRecords[`batch:${selectedBatch.id}`]}
                deliveryBusy={deliveryBusy}
                onControl={handleBatchControl}
                onSaveDelivery={() => void saveBatchDelivery(selectedBatch, true)}
                onDownloadDelivery={() => void downloadEngineBatch(config, selectedBatch).catch((error) => setWorkspaceError(errorMessage(error)))}
                onReview={handleBatchItemReview}
                onRetryItem={handleBatchItemRetry}
                onLoadMoreItems={() => void loadMoreBatchItems()}
                onLoadMoreEvents={() => void loadMoreBatchEvents()}
                itemPage={{ loaded: selectedBatch.items.length, total: batchItemsTotal, hasMore: Boolean(batchItemsCursor) }}
                eventPage={{ loaded: selectedBatch.events.length, total: batchEventsTotal, hasMore: Boolean(batchEventsCursor) }}
                onClose={clearInspectorSelection}
                onBulkReview={handleBulkReview}
                onArchiveBatch={handleArchiveBatch}
                onDeleteBatch={handleDeleteBatch}
                onPruneAssets={handlePruneAssets}
              />
            ) : selectedJob ? (
              <JobInspector
                job={selectedJob}
                previewUrl={previewUrl}
                busy={busy}
                delivery={deliveryRecords[`job:${selectedJob.id}`]}
                deliveryBusy={deliveryBusy}
                onOpenPreview={setAssetLightbox}
                onSaveDelivery={() => void saveJobDelivery(selectedJob, true)}
                onDownloadDelivery={() => void downloadEngineJob(config, selectedJob).catch((error) => setWorkspaceError(errorMessage(error)))}
                onCancel={handleCancel}
                onRetry={handleRetry}
                onClose={clearInspectorSelection}
              />
            ) : (
              <div className="border-y border-stone-300 py-6 dark:border-white/10">
                <div className="flex items-center gap-2 text-xs font-medium text-stone-500 dark:text-stone-300">
                  <Cpu className="h-4 w-4 text-[#356c82]" />流水线摘要
                  <span className="ml-auto font-mono text-[10px] text-stone-400">{eventTransport === 'sse' ? '实时推送' : '轮询同步'}</span>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                  <div><dt className="text-stone-400">待处理批次</dt><dd className="mt-1 font-mono text-lg">{batchGroups.needsAttention.length}</dd></div>
                  <div><dt className="text-stone-400">异常结束</dt><dd className="mt-1 font-mono text-lg">{batchGroups.incomplete.length}</dd></div>
                  <div><dt className="text-stone-400">当前成功率</dt><dd className="mt-1 font-mono text-lg">{stats.total ? Math.round((stats.succeeded / stats.total) * 100) : 0}%</dd></div>
                  <div><dt className="text-stone-400">失败任务</dt><dd className="mt-1 font-mono text-lg text-red-500">{stats.failed}</dd></div>
                </dl>
                <p className="mt-5 text-xs leading-5 text-stone-400">优先处理待人审、失败和取消项；选择批次后查看质量漏斗与建议动作。</p>
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
