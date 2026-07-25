import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Activity,
  Ban,
  Check,
  ChevronRight,
  CircleAlert,
  Cpu,
  LoaderCircle,
  Plus,
  RefreshCw,
  Server,
  Unplug,
  X,
} from 'lucide-react'
import { calculateImageSize } from '../lib/size'
import {
  cancelImageJob,
  clearLocalImageTaskApiConfig,
  createImageTaskGeneration,
  createImageJob,
  getImageAssetBlob,
  getImageJob,
  getImageTaskCapabilities,
  listImageJobs,
  readLocalImageTaskApiConfig,
  saveLocalImageTaskApiConfig,
  type ImageJobStateV1,
  type ImageJobV1,
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

interface NewJobDraft {
  prompt: string
  ratio: string
  model: string
  apiMode: 'images' | 'responses'
}

const DEFAULT_DRAFT: NewJobDraft = {
  prompt: '',
  ratio: '1:1',
  model: '',
  apiMode: 'images',
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
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [filter, setFilter] = useState<ImageJobStateV1 | 'all'>('all')
  const [selectedJob, setSelectedJob] = useState<ImageJobV1 | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [showNewJob, setShowNewJob] = useState(false)
  const [draft, setDraft] = useState<NewJobDraft>(DEFAULT_DRAFT)
  const selectedJobId = selectedJob?.id

  const refresh = useCallback(async (targetConfig = config, cursor?: string | null) => {
    if (!targetConfig) return
    setRefreshing(true)
    try {
      const result = await listImageJobs(targetConfig, {
        limit: 30,
        cursor: cursor || undefined,
        state: filter === 'all' ? undefined : filter,
      })
      setJobs((current) => cursor ? [...current, ...result.items] : result.items)
      setNextCursor(result.nextCursor)
      setWorkspaceError(null)
      if (selectedJobId) {
        const detail = await getImageJob(targetConfig, selectedJobId)
        setSelectedJob(detail)
      }
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    } finally {
      setRefreshing(false)
    }
  }, [config, filter, selectedJobId])

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
      setNextCursor(result.nextCursor)
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
    if (!config || !capabilities) return
    void refresh(config, null)
    const interval = window.setInterval(() => {
      void refresh(config, null)
    }, 3000)
    return () => window.clearInterval(interval)
  }, [capabilities, config, refresh])

  useEffect(() => {
    let objectUrl: string | null = null
    const assetId = selectedJob?.finalAssetId
    if (!config || !assetId) {
      setPreviewUrl(null)
      return
    }
    void getImageAssetBlob(config, assetId)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob)
        setPreviewUrl(objectUrl)
      })
      .catch(() => setPreviewUrl(null))
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [config, selectedJob?.finalAssetId])

  const stats = useMemo(() => ({
    total: jobs.length,
    active: jobs.filter((job) => ACTIVE_STATES.has(job.state)).length,
    failed: jobs.filter((job) => job.state === 'failed').length,
    succeeded: jobs.filter((job) => job.state === 'succeeded').length,
  }), [jobs])

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
      setSelectedJob(await getImageJob(config, created.id))
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

  const disconnect = () => {
    clearLocalImageTaskApiConfig()
    setConfig(null)
    setCapabilities(null)
    setJobs([])
    setSelectedJob(null)
    setConnectionDraft((current) => ({ ...current, token: '' }))
  }

  if (!capabilities) {
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
    <main className="min-h-[calc(100vh-4rem)] bg-[#f4f1ec] text-stone-900 dark:bg-[#11100e] dark:text-stone-100">
      <div className="mx-auto max-w-[1500px] px-3 py-4 sm:px-6 sm:py-6">
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
                setSelectedJob(null)
                setShowNewJob(true)
              }}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-[#df7b57] px-3 text-sm font-medium text-white hover:bg-[#c96643]"
            >
              <Plus className="h-4 w-4" />
              新建任务
            </button>
          </div>
        </header>

        <section className="grid grid-cols-4 border-b border-stone-300 dark:border-white/10">
          {[
            ['当前页', stats.total],
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

        <div className="grid min-h-[620px] lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
          <section className="border-b border-stone-300 py-4 dark:border-white/10 lg:border-b-0 lg:border-r lg:pr-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">任务队列</h2>
              <select
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value as ImageJobStateV1 | 'all')
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

            <div className="divide-y divide-stone-200 border-y border-stone-300 dark:divide-white/[0.06] dark:border-white/10">
              {jobs.map((job) => (
                <button
                  type="button"
                  key={job.id}
                  onClick={() => {
                    setShowNewJob(false)
                    if (config) void getImageJob(config, job.id).then(setSelectedJob).catch((error) => setWorkspaceError(errorMessage(error)))
                  }}
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

          <aside className="py-4 lg:pl-5">
            {showNewJob ? (
              <NewJobForm
                capabilities={capabilities}
                draft={draft}
                busy={busy}
                onChange={setDraft}
                onClose={() => setShowNewJob(false)}
                onSubmit={handleCreate}
              />
            ) : selectedJob ? (
              <JobInspector
                job={selectedJob}
                previewUrl={previewUrl}
                busy={busy}
                onCancel={handleCancel}
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
    <form onSubmit={onSubmit}>
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
      <div className="mt-4 border-y border-stone-300 py-3 text-xs text-stone-500 dark:border-white/10 dark:text-stone-400">
        <div className="flex justify-between"><span>规范源图</span><span className="font-mono">{calculateImageSize('2K', draft.ratio)}</span></div>
        <div className="mt-2 flex justify-between"><span>最终产物</span><span className="font-mono">{calculateImageSize('4K', draft.ratio)} PNG</span></div>
        <div className="mt-2 flex justify-between"><span>增强器</span><span className="font-mono">lanczos3</span></div>
      </div>
      <button
        type="submit"
        disabled={busy || !draft.prompt.trim() || !draft.model.trim()}
        className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[#df7b57] px-4 text-sm font-medium text-white hover:bg-[#c96643] disabled:opacity-40"
      >
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        提交任务
      </button>
    </form>
  )
}

function JobInspector({
  job,
  previewUrl,
  busy,
  onCancel,
}: {
  job: ImageJobV1
  previewUrl: string | null
  busy: boolean
  onCancel: () => void
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase text-stone-400">Job detail</div>
          <h2 className="mt-1 break-all font-mono text-sm font-semibold">{job.id}</h2>
        </div>
        <StatusBadge state={job.state} />
      </div>

      {previewUrl && (
        <div className="mt-5 overflow-hidden rounded-md border border-stone-300 bg-[repeating-conic-gradient(#ddd_0_25%,#fff_0_50%)_0_0/16px_16px] dark:border-white/10">
          <img src={previewUrl} alt="最终产物" className="max-h-[320px] w-full object-contain" />
        </div>
      )}

      <p className="mt-5 text-sm leading-6">{job.request.input.prompt || '图像编辑任务'}</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-stone-300 py-4 text-xs dark:border-white/10">
        <div><dt className="text-stone-400">比例</dt><dd className="mt-1 font-mono">{job.request.composition.ratio}</dd></div>
        <div><dt className="text-stone-400">最终尺寸</dt><dd className="mt-1 font-mono">{job.request.output.dimensions || '继承'}</dd></div>
        <div><dt className="text-stone-400">模型</dt><dd className="mt-1 truncate font-mono">{job.request.generation.model || '引擎默认'}</dd></div>
        <div><dt className="text-stone-400">执行次数</dt><dd className="mt-1 font-mono">{job.attempts} / {job.maxAttempts}</dd></div>
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
              <span className="font-medium">{STATE_LABELS[event.state]}</span>
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
    </div>
  )
}
