import type { FormEvent } from 'react'
import { FolderOpen, HardDrive, Layers, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react'
import { calculateImageSize } from '../../lib/size'
import { countEngineBatchOutputs, parseEngineBatchPrompts } from '../../lib/engineBatch'
import type { ImageTaskCapabilitiesV1 } from '../../lib/imageTaskApi'

export interface NewJobDraft {
  prompt: string
  ratio: string
  model: string
  apiMode: 'images' | 'responses'
  fallbackEnabled: boolean
  fallbackModel: string
  fallbackApiMode: 'images' | 'responses'
  autoRevise: boolean
}

export const DEFAULT_DRAFT: NewJobDraft = {
  prompt: '',
  ratio: '1:1',
  model: '',
  apiMode: 'images',
  fallbackEnabled: true,
  fallbackModel: 'gpt-5.6-sol',
  fallbackApiMode: 'responses',
  autoRevise: false,
}


export function NewJobForm({
  capabilities,
  draft,
  busy,
  deliveryDirectoryName,
  deliverySupported,
  onChooseDeliveryDirectory,
  onChange,
  onClose,
  onSubmit,
}: {
  capabilities: ImageTaskCapabilitiesV1
  draft: NewJobDraft
  busy: boolean
  deliveryDirectoryName: string | null
  deliverySupported: boolean
  onChooseDeliveryDirectory: () => void
  onChange: (draft: NewJobDraft) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}) {
  return (
    <form data-engine-editor onSubmit={onSubmit}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-medium text-[#df7b57]">单次生成</div>
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
          list="engine-model-suggestions"
          autoComplete="off"
        />
        <datalist id="engine-model-suggestions">
          {capabilities.capabilities.generation.defaultModel
            ? <option value={capabilities.capabilities.generation.defaultModel} />
            : null}
        </datalist>
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
      <div className="mt-4 flex items-start gap-3 border-l-2 border-emerald-400 bg-emerald-50/70 px-3 py-3 text-xs text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100">
        <HardDrive className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">生成成功后自动交付到本机</div>
          <div className="mt-1 leading-5 opacity-80">
            {deliveryDirectoryName ? `保存位置：${deliveryDirectoryName}/jobs/...` : deliverySupported ? '尚未选择目录；提交后可在详情中重试保存。' : '当前浏览器不支持目录写入，生成后提供 PNG 下载。'}
          </div>
          {deliverySupported && (
            <button type="button" onClick={onChooseDeliveryDirectory} className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-emerald-500/40 px-2 text-[10px] font-medium text-emerald-800 hover:bg-emerald-100 dark:text-emerald-100 dark:hover:bg-emerald-400/15">
              <FolderOpen className="h-3 w-3" />{deliveryDirectoryName ? '更换目录' : '选择本地目录'}
            </button>
          )}
        </div>
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


export function NewBatchForm({
  capabilities,
  draft,
  batchDraft,
  busy,
  deliveryDirectoryName,
  deliverySupported,
  onChooseDeliveryDirectory,
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
  deliveryDirectoryName: string | null
  deliverySupported: boolean
  onChooseDeliveryDirectory: () => void
  onChange: (draft: { name: string; prompts: string }) => void
  onRatioChange: (ratio: string) => void
  onAutoReviseChange: (autoRevise: boolean) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}) {
  const prompts = parseEngineBatchPrompts(batchDraft.prompts)
  const promptCount = prompts.length
  const outputCount = countEngineBatchOutputs(prompts)
  const finalDimensions = calculateImageSize('4K', draft.ratio) || ''
  const [width, height] = finalDimensions.split('x').map(Number)
  const estimatedStorageMb = width && height ? Math.max(1, Math.round((width * height * 4 * outputCount * 0.45) / 1024 / 1024)) : 0
  const estimatedMinutes = Math.max(1, Math.ceil(outputCount * 1.5))
  return (
    <form data-engine-editor onSubmit={onSubmit}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-medium text-[#356c82]">批量任务</div>
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
        <div className="mb-3 text-[10px] font-semibold uppercase text-stone-400">提交前检查</div>
        <div className="flex justify-between"><span>总任务 / 预计请求</span><span className="font-mono">{outputCount} / {outputCount}</span></div>
        <div className="mt-2 flex justify-between"><span>预计耗时</span><span className="font-mono">约 {estimatedMinutes} 分钟</span></div>
        <div className="mt-2 flex justify-between"><span>预计存储</span><span className="font-mono">约 {estimatedStorageMb} MB</span></div>
        <div className="mt-2 flex justify-between"><span>失败策略</span><span className="font-mono">最多 {capabilities.capabilities.retry.maxAttempts} 次 / 路由</span></div>
        <div className="mt-2 flex justify-between"><span>视觉 QA</span><span className="font-mono">启用</span></div>
        <div className="my-3 border-t border-stone-200 dark:border-white/[0.08]" />
        <div className="flex justify-between gap-3"><span>主路由</span><span className="truncate font-mono">{draft.model} / {draft.apiMode}</span></div>
        <div className="mt-2 flex justify-between gap-3"><span>备用路由</span><span className="truncate font-mono">{draft.fallbackEnabled ? `${draft.fallbackModel} / ${draft.fallbackApiMode}` : '关闭'}</span></div>
        <div className="mt-2 flex justify-between gap-3"><span>QA 检查模型</span><span className="truncate font-mono">{draft.fallbackModel} / responses</span></div>
        <div className="flex justify-between"><span>规范源图</span><span className="font-mono">{calculateImageSize('2K', draft.ratio)}</span></div>
        <div className="mt-2 flex justify-between"><span>最终产物</span><span className="font-mono">{calculateImageSize('4K', draft.ratio)} PNG (Lanczos3)</span></div>
      </div>
      <div className="mt-4 flex items-start gap-3 border-l-2 border-emerald-400 bg-emerald-50/70 px-3 py-3 text-xs text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100">
        <HardDrive className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">批次完成后自动交付全部成功产物</div>
          <div className="mt-1 leading-5 opacity-80">
            {deliveryDirectoryName ? `保存位置：${deliveryDirectoryName}/batches/...` : deliverySupported ? '尚未选择目录；批次完成后可在详情中重试保存。' : '当前浏览器不支持目录写入，批次详情提供 ZIP 下载。'}
          </div>
          {deliverySupported && (
            <button type="button" onClick={onChooseDeliveryDirectory} className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-emerald-500/40 px-2 text-[10px] font-medium text-emerald-800 hover:bg-emerald-100 dark:text-emerald-100 dark:hover:bg-emerald-400/15">
              <FolderOpen className="h-3 w-3" />{deliveryDirectoryName ? '更换目录' : '选择本地目录'}
            </button>
          )}
        </div>
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

