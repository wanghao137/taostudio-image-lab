// 引擎工作台共享基础：常量、状态徽章、展示辅助、轮询相等性检查。
// 从 EngineWorkspace.tsx 提取（#24 拆单体）；BatchInspector/JobInspector/
// NewForms 等子组件和主文件共用这里的一切。

import type { ImageJobStateV1, ImageJobV1, ImageBatchV1, ImageBatchSummaryV1 } from '../../lib/imageTaskApi'
import type { EngineDeliveryRecord } from '../../lib/db'

// ===== 常量 =====

export const ACTIVE_STATES = new Set<ImageJobStateV1>([
  'queued',
  'validating',
  'generating',
  'source_ready',
  'enhancing',
  'finalizing',
])

export const STATE_LABELS: Record<ImageJobStateV1, string> = {
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

export const STATE_TONES: Record<ImageJobStateV1, string> = {
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

// ===== 通用辅助 =====

export function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function formatDuration(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours) return `${hours}时 ${minutes}分`
  if (minutes) return `${minutes}分 ${seconds}秒`
  return `${seconds}秒`
}

export function shortTaskTitle(prompt?: string) {
  const normalized = (prompt || '图像编辑任务').replace(/\s+/g, ' ').trim()
  const sentence = normalized.split(/[。！？.!?\n]/)[0] || normalized
  return sentence.length > 42 ? `${sentence.slice(0, 42)}…` : sentence
}

// ===== 轮询相等性短路 =====
// 3 秒一次的轮询每次都生成全新对象数组，会让工作台在批次运行期间整树重渲染。
// 比较会影响展示的关键字段，未变则不 setState。

export function imageJobsEqual(a: ImageJobV1[], b: ImageJobV1[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || x.state !== y.state || x.updatedAt !== y.updatedAt
      || x.attempts !== y.attempts || x.routeAttempts !== y.routeAttempts
      || x.cancelRequested !== y.cancelRequested
      || x.finalAssetId !== y.finalAssetId || x.error?.message !== y.error?.message) return false
  }
  return true
}

export function imageBatchesEqual(a: ImageBatchSummaryV1[], b: ImageBatchSummaryV1[]) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x.id !== y.id || x.state !== y.state || x.updatedAt !== y.updatedAt
      || JSON.stringify(x.stats) !== JSON.stringify(y.stats)) return false
  }
  return true
}

// ===== 徽章组件 =====

export function StatusBadge({ state }: { state: ImageJobStateV1 }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium ${STATE_TONES[state]}`}>
      {ACTIVE_STATES.has(state) && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
      {STATE_LABELS[state]}
    </span>
  )
}

export function QaBadge({ status }: { status: ImageBatchV1['items'][number]['qaStatus'] }) {
  const style = status === 'passed'
    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
    : status === 'not_run'
      ? 'bg-stone-100 text-stone-500 dark:bg-white/[0.06] dark:text-stone-400'
      : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
  const label = status === 'passed' ? 'QA 通过' : status === 'not_run' ? 'QA 未运行' : 'QA 告警'
  return <span className={`rounded px-2 py-1 text-[10px] font-medium ${style}`}>{label}</span>
}

export function HumanReviewBadge({
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

export function DeliveryStatus({ record, supported = true }: { record?: EngineDeliveryRecord; supported?: boolean }) {
  if (!record && !supported) return <span className="text-[10px] text-amber-700 dark:text-amber-300">请下载</span>
  if (!record) return <span className="text-[10px] text-stone-400">未保存</span>
  if (!supported && record.status !== 'saved') return <span className="text-[10px] text-amber-700 dark:text-amber-300" title={record.error || undefined}>请下载</span>
  const label = record.status === 'saved'
    ? record.kind === 'batch' && record.savedCount !== record.totalCount
      ? `已保存 ${record.savedCount || 0}/${record.totalCount || 0}`
      : '已保存到本地'
    : record.status === 'partial'
      ? `部分保存 ${record.savedCount || 0}/${record.totalCount || 0}`
    : record.status === 'saving'
      ? `保存中 ${record.savedCount || 0}/${record.totalCount || 1}`
      : record.status === 'needs_permission'
        ? '需要重新授权'
        : record.status === 'pending'
          ? '等待本地目录'
          : record.status === 'unsupported'
            ? '请下载'
            : '保存失败'
  const tone = record.status === 'saved'
    ? 'text-emerald-700 dark:text-emerald-300'
    : record.status === 'partial'
      ? 'text-amber-700 dark:text-amber-300'
    : record.status === 'saving'
      ? 'text-sky-700 dark:text-sky-300'
      : record.status === 'failed' || record.status === 'needs_permission'
        ? 'text-red-600 dark:text-red-300'
        : 'text-amber-700 dark:text-amber-300'
  return <span className={`text-[10px] ${tone}`} title={record.error || undefined}>{label}</span>
}

// ===== 批次展示辅助 =====

export function toBatchSummary(batch: ImageBatchV1): ImageBatchSummaryV1 {
  const { items: _items, events: _events, ...summary } = batch
  return summary
}

export function batchHasActiveAutomation(batch: ImageBatchV1) {
  return batch.automation.enabled && batch.items.some((item) => (
    ['succeeded', 'failed', 'cancelled'].includes(item.job.state)
    && item.automationState !== 'done'
  ))
}

export function batchHasPendingQa(batch: ImageBatchSummaryV1) {
  return batch.automation.enabled
    && batch.state === 'completed'
    && batch.stats.acceptancePending > 0
}

export function batchReviewNote(item: ImageBatchV1['items'][number]) {
  const review = item.review || {}
  const qa = (review.qa || review.qaReference) as { notes?: unknown; reason?: unknown } | undefined
  if (typeof qa?.notes === 'string' && qa.notes.trim()) return qa.notes.trim()
  if (typeof qa?.reason === 'string' && qa.reason.trim()) return qa.reason.trim()
  if (item.failureClass) return item.failureClass
  if (item.recoveryAction) return item.recoveryAction
  return null
}

export type BatchPresentationState = 'running' | 'paused' | 'waiting_qa' | 'waiting_human' | 'partial_failure' | 'rejected' | 'delivery_ready' | 'archived'

export function batchPresentationState(batch: ImageBatchSummaryV1): BatchPresentationState {
  if (batch.state === 'running') return 'running'
  if (batch.state === 'paused') return 'paused'
  if (batch.stats.humanReviewPending > 0 || batch.acceptanceState === 'needs_review') return 'waiting_human'
  if (batchHasPendingQa(batch)) return 'waiting_qa'
  if (batch.stats.failed > 0) return 'partial_failure'
  if (batch.acceptanceState === 'rejected' || batch.stats.rejected > 0) return 'rejected'
  if (batch.stats.accepted > 0 && batch.stats.accepted === batch.stats.total) return 'delivery_ready'
  return 'archived'
}

export function batchStateLabel(batch: ImageBatchSummaryV1) {
  const state = batchPresentationState(batch)
  if (state === 'running') {
    if (batch.runner?.active) return '接管中'
    return (batch.runner?.attempt || 0) > 0 ? '等待接管' : '执行中'
  }
  if (state === 'paused') return batch.pauseReason === 'runner_disconnected' ? '等待接管' : '已暂停'
  if (state === 'waiting_qa') return '待 QA'
  if (state === 'waiting_human') return '待人审'
  if (state === 'partial_failure') return '部分失败'
  if (state === 'rejected') return '已拒绝'
  if (state === 'delivery_ready') return '可交付'
  return '已归档'
}

export function batchStateTone(batch: ImageBatchSummaryV1) {
  const state = batchPresentationState(batch)
  if (state === 'running') return (batch.runner?.attempt || 0) > 0 && !batch.runner?.active
    ? 'text-amber-700 dark:text-amber-300'
    : 'text-sky-700 dark:text-sky-300'
  if (state === 'waiting_qa') return 'text-sky-700 dark:text-sky-300'
  if (state === 'waiting_human' || state === 'paused' || state === 'partial_failure') return 'text-amber-700 dark:text-amber-300'
  if (state === 'rejected') return 'text-red-600 dark:text-red-300'
  if (state === 'delivery_ready') return 'text-emerald-700 dark:text-emerald-300'
  return 'text-stone-500 dark:text-stone-400'
}

export function batchPrimaryAction(batch: ImageBatchSummaryV1) {
  if (batch.stats.humanReviewPending > 0) return `复核 ${batch.stats.humanReviewPending} 项`
  if (batch.stats.failed > 0) return `重试 ${batch.stats.failed} 项`
  if (batch.stats.cancelled > 0) return `继续 ${batch.stats.cancelled} 项`
  if (batch.state === 'paused') return '恢复执行'
  if (batch.state === 'running') return '查看运行进度'
  if (batch.stats.accepted > 0) return `查看 ${batch.stats.accepted} 个合格结果`
  return '查看批次'
}

export function displayBatchName(batch: ImageBatchSummaryV1) {
  const raw = batch.name || batch.id
  const timestampMatch = raw.match(/(\d{8}T\d{6})$/)
  if (!timestampMatch) return raw
  const base = timestampMatch ? raw.slice(0, -timestampMatch[1].length).replace(/[-_\s]+$/, '') : raw
  return `${base || '图像批次'} · ${formatTime(batch.createdAt)} · ${batch.stats.total} 项`
}
