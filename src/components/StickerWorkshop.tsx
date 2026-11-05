import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Film, Loader2, Play, Settings2, Sparkles, Square } from 'lucide-react'
import { submitTask, useStore } from '../store'
import { getSceneImageApiProfile, validateApiProfile } from '../lib/apiProfiles'
import { DEFAULT_GIF_OPTIONS, GIF_MODELS, getGifProfile, validateGifParams, type GifOptions } from '../lib/gif'
import { ensureImageCached } from '../lib/imageCache'
import { safeCreateImageThumbnail } from '../lib/dbWeb'
import { downloadImageIds, withSaveLocation } from '../lib/downloadImages'
import { DEFAULT_PARAMS, type TaskParams, type TaskRecord } from '../types'
import { readLocal, writeLocal } from '../lib/localRecord'

const FIELD = 'w-full rounded-xl border border-stone-200/80 bg-white/70 px-3 py-2.5 text-sm text-stone-800 outline-none transition focus:border-[#df7b57] focus:ring-2 focus:ring-[#df7b57]/15 disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-stone-100'
const BUTTON = 'inline-flex items-center justify-center gap-2 rounded-xl bg-[#df7b57] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#c96a49] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#df7b57] disabled:cursor-not-allowed disabled:opacity-50'
const SECONDARY = 'inline-flex items-center justify-center gap-2 rounded-xl border border-stone-200/80 px-3 py-2 text-xs font-medium text-stone-700 transition hover:bg-stone-100 disabled:opacity-50 dark:border-white/10 dark:text-stone-200 dark:hover:bg-white/5'

function readGifPreferences(): TaskParams {
  const defaults: TaskParams = { ...DEFAULT_PARAMS, output_format: 'gif', gif: { ...DEFAULT_GIF_OPTIONS }, quality: 'auto', moderation: 'auto' }
  try {
    const saved = JSON.parse(readLocal('gif-workbench-v1') ?? 'null') as Partial<TaskParams> | null
    if (!saved) return defaults
    const params = { ...defaults, gif: saved.gif, size: saved.size ?? 'auto', quality: saved.quality ?? 'auto', n: saved.n ?? 1, moderation: saved.moderation ?? 'auto' }
    validateGifParams(params)
    return params
  } catch { return defaults }
}

export function StickerWorkshop({ onOpenSceneSettings }: { onOpenSceneSettings: () => void }) {
  const settings = useStore((s) => s.settings)
  const prompt = useStore((s) => s.prompt)
  const setPrompt = useStore((s) => s.setPrompt)
  const tasks = useStore((s) => s.tasks)
  const showToast = useStore((s) => s.showToast)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const [initial] = useState(readGifPreferences)
  const [gif, setGif] = useState<GifOptions>(initial.gif!)
  const [quality, setQuality] = useState<TaskParams['quality']>(initial.quality)
  const [size, setSize] = useState(initial.size)
  const [count, setCount] = useState(initial.n)
  const [moderation, setModeration] = useState(initial.moderation)
  const [submitting, setSubmitting] = useState(false)
  const submitLock = useRef(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [outputIndex, setOutputIndex] = useState(0)
  const [downloading, setDownloading] = useState(false)
  const [playing, setPlaying] = useState(() => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  const [preview, setPreview] = useState('')
  const [poster, setPoster] = useState('')
  const [previewError, setPreviewError] = useState('')
  const gifTasks = useMemo(() => tasks.filter((t) => t.params.output_format === 'gif'), [tasks])
  const selected = gifTasks.find((t) => t.id === selectedId) ?? gifTasks[0]
  const running = gifTasks.some((t) => t.status === 'running')
  const profile = useMemo(() => getSceneImageApiProfile(settings, 'sticker'), [settings])
  let profileError = validateApiProfile(profile)
  try { getGifProfile(profile, gif.model) } catch (err) { profileError = err instanceof Error ? err.message : String(err) }
  const params = useMemo<TaskParams>(() => ({ ...DEFAULT_PARAMS, output_format: 'gif', gif, quality, size, n: count, moderation }), [gif, quality, size, count, moderation])
  let parameterError = ''
  try { validateGifParams(params) } catch (err) { parameterError = err instanceof Error ? err.message : String(err) }
  const imageId = selected?.outputImages[outputIndex]
  const animation = selected?.animations?.[outputIndex] ?? (outputIndex === 0 ? selected?.animation : undefined)

  useEffect(() => {
    try { validateGifParams(params); writeLocal('gif-workbench-v1', JSON.stringify(params)) } catch { /* 编辑中的无效值不覆盖上次有效配置。 */ }
  }, [params])

  useEffect(() => {
    let cancelled = false
    setPreview(''); setPoster(''); setPreviewError('')
    if (imageId) void ensureImageCached(imageId).then(async (dataUrl) => {
      if (!cancelled) {
        setPreview(dataUrl ?? '')
        setPreviewError(dataUrl ? '' : '原件暂时无法读取，请在任务详情中检查保存状态')
      }
      if (dataUrl) {
        const thumbnail = await safeCreateImageThumbnail(dataUrl)
        if (!cancelled) setPoster(thumbnail.thumbnailDataUrl ?? '')
      }
    }).catch(() => { if (!cancelled) setPreviewError('无法读取 GIF 原件') })
    return () => { cancelled = true }
  }, [imageId])

  const generate = async () => {
    if (submitLock.current || running || !prompt.trim() || profileError || parameterError) return
    submitLock.current = true
    setSubmitting(true)
    try {
      setSelectedId(null)
      setOutputIndex(0)
      await submitTask({ gif: { prompt: prompt.trim(), params }, ignoreBatchPrompt: true })
    } catch (err) { showToast(`提交失败：${err instanceof Error ? err.message : String(err)}`, 'error') }
    finally { submitLock.current = false; setSubmitting(false) }
  }
  const download = async () => {
    if (!imageId || !selected || downloading) return
    setDownloading(true)
    try {
      const result = await downloadImageIds([imageId], `gif-${selected.id}${selected.outputImages.length > 1 ? `-${outputIndex + 1}` : ''}`)
      if (!result.canceled) showToast(result.successCount ? withSaveLocation('GIF 原件已下载', result.location) : 'GIF 下载失败，请重试', result.successCount ? 'success' : 'error')
    } catch { showToast('GIF 下载失败，请重试', 'error') }
    finally { setDownloading(false) }
  }

  return (
    <section data-no-drag-select data-ui-summary className="mt-4 overflow-hidden rounded-2xl border border-stone-200/80 bg-white/75 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.035]">
      <header className="flex items-center justify-between gap-4 border-b border-stone-200/70 px-5 py-4 dark:border-white/[0.06]">
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-xl bg-[#df7b57]/10 p-2.5 text-[#bd6547]"><Film className="h-5 w-5" aria-hidden /></span>
          <div><h2 className="text-base font-semibold text-stone-900 dark:text-stone-50">GIF 工作台</h2><p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">把角色、场景和创意变成动画</p></div>
        </div>
        <button type="button" onClick={onOpenSceneSettings} className={SECONDARY} aria-label="GIF 场景设置"><Settings2 className="h-4 w-4" aria-hidden /><span className="hidden sm:inline">场景设置</span></button>
      </header>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <form className="min-w-0 space-y-5 p-5 sm:p-6" onSubmit={(event) => { event.preventDefault(); void generate() }}>
          <label className="block">
            <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">描述你的动画</span>
            <textarea aria-label="动画描述" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} maxLength={32000} placeholder="例如：一盏纸灯笼在夜色中轻轻摇晃，暖光逐渐亮起再暗下，镜头固定，首尾自然衔接。" className={`${FIELD} mt-2 min-h-40 resize-y leading-relaxed`} />
            <span className="mt-2 block text-xs leading-relaxed text-stone-500 dark:text-stone-400">写清主体、动作变化、背景与循环方式。支持文字生成，暂不支持上传图片动画化。</span>
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block space-y-2 text-xs font-medium text-stone-600 dark:text-stone-300">生成模型
              <select aria-label="GIF 生成模型" value={gif.model} onChange={(e) => setGif({ ...gif, model: e.target.value as GifOptions['model'] })} className={FIELD}>{GIF_MODELS.map((model) => <option value={model} key={model}>{model.endsWith('flare') ? 'GPT Image 2.6 Flare' : 'GPT Image 2.6 Sunburst'}</option>)}</select>
            </label>
            <label className="block space-y-2 text-xs font-medium text-stone-600 dark:text-stone-300">画质
              <select aria-label="GIF 画质" value={quality} onChange={(e) => setQuality(e.target.value as TaskParams['quality'])} className={FIELD}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">超高 xhigh</option><option value="max">最高 max</option></select>
            </label>
          </div>
          <div className="rounded-xl border border-stone-200/70 p-4 dark:border-white/[0.08]">
            <div className="mb-4 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">动画节奏</h3><output className="font-mono text-xs text-[#bd6547] dark:text-[#ffb096]">{Number.isFinite(gif.frame_count * gif.frame_duration_ms) ? (gif.frame_count * gif.frame_duration_ms / 1000).toFixed(2) : '—'} 秒 / 周期</output></div>
            <div className="grid grid-cols-2 gap-4">
              <label className="block space-y-2 text-xs text-stone-600 dark:text-stone-300">帧数<input aria-label="GIF 帧数" type="number" min={2} max={64} step={1} value={Number.isNaN(gif.frame_count) ? '' : gif.frame_count} onChange={(e) => setGif({ ...gif, frame_count: e.target.valueAsNumber })} className={FIELD} required /><span className="block text-[11px] text-stone-500">2–64 帧，默认 9 帧</span></label>
              <label className="block space-y-2 text-xs text-stone-600 dark:text-stone-300">每帧时长 ms<input aria-label="GIF 每帧时长" type="number" min={20} max={2000} step={10} value={Number.isNaN(gif.frame_duration_ms) ? '' : gif.frame_duration_ms} onChange={(e) => setGif({ ...gif, frame_duration_ms: e.target.valueAsNumber })} className={FIELD} required /></label>
            </div>
            {gif.frame_count > 16 && <p className="mt-3 text-xs leading-relaxed text-amber-700 dark:text-amber-200">指南支持最多 64 帧；当前接口参考仍写 16 帧，部分服务商可能拒绝更高帧数。</p>}
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block space-y-2 text-xs text-stone-600 dark:text-stone-300">每帧尺寸<input aria-label="GIF 每帧尺寸" value={size} onChange={(e) => setSize(e.target.value.trim())} placeholder="auto 或 512x512" className={FIELD} /><span className="block text-[11px] leading-relaxed text-stone-500">auto 自动选择；自定义宽高须为 16 的倍数。</span></label>
              <label className="block space-y-2 text-xs text-stone-600 dark:text-stone-300">生成数量<input aria-label="GIF 生成数量" type="number" min={1} max={10} step={1} value={Number.isNaN(count) ? '' : count} onChange={(e) => setCount(e.target.valueAsNumber)} className={FIELD} required /><span className="block text-[11px] leading-relaxed text-stone-500">帧数、尺寸和数量共同占用像素预算；超限时降低其中一项。</span></label>
            </div>
          </div>
          <details className="text-xs text-stone-600 dark:text-stone-300">
            <summary className="cursor-pointer py-1 font-medium">高级设置</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <label className="space-y-2">规划强度<select aria-label="GIF 规划强度" value={gif.complexity} onChange={(e) => setGif({ ...gif, complexity: e.target.value as GifOptions['complexity'] })} className={FIELD}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
              <label className="space-y-2">内容审核<select aria-label="GIF 内容审核" value={moderation} onChange={(e) => setModeration(e.target.value as TaskParams['moderation'])} className={FIELD}><option value="auto">标准 auto</option><option value="low">较宽松 low</option></select></label>
            </div>
            <p className="mt-3 leading-relaxed text-stone-500">规划强度控制渲染前的规划量，默认高，与画质独立。GIF 不支持流式预览、压缩率或图片编辑。</p>
          </details>
          {profileError && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"><p>{profileError}</p><button type="button" onClick={() => setShowSettings(true)} className={`${SECONDARY} mt-2`}>打开 API 设置</button></div>}
          {parameterError && <p role="alert" className="text-xs text-red-600 dark:text-red-300">{parameterError}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={submitting || running || !prompt.trim() || Boolean(profileError || parameterError)} className={BUTTON}>{submitting || running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}{submitting || running ? '生成中…' : '生成 GIF'}</button>
            <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">每次生成 {Number.isFinite(count) ? count : '—'} 个 GIF<br />使用「{profile.name}」，需已开通 GIF 能力</p>
          </div>
        </form>
        <div className="min-w-0 border-t border-stone-200/70 bg-stone-50/60 p-5 sm:p-6 lg:border-l lg:border-t-0 dark:border-white/[0.06] dark:bg-black/10">
          <div className="mb-4 flex items-center justify-between"><h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">动画预览</h3><span className="text-[11px] text-stone-500">GIF 原件</span></div>
          {selected && selected.outputImages.length > 1 && <div className="mb-3 flex flex-wrap gap-2" aria-label="GIF 结果选择">{selected.outputImages.map((id, index) => <button key={id + index} type="button" aria-pressed={outputIndex === index} onClick={() => setOutputIndex(index)} className={`${SECONDARY} ${outputIndex === index ? 'border-[#df7b57] bg-[#df7b57]/10' : ''}`}>动画 {index + 1}</button>)}</div>}
          <div className="flex aspect-square max-h-[480px] min-h-60 items-center justify-center overflow-hidden rounded-2xl border border-stone-200/80 bg-white dark:border-white/[0.08] dark:bg-stone-900">
            {selected?.status === 'running' ? <div role="status" className="space-y-3 p-6 text-center text-stone-500"><Loader2 className="mx-auto h-7 w-7 animate-spin text-[#df7b57]" aria-hidden /><p className="text-sm">正在生成动画</p><p className="text-xs">完成后自动显示，请保持页面打开</p></div>
              : selected?.status === 'error' ? <p role="alert" className="max-w-full break-words p-6 text-sm leading-relaxed text-red-600 dark:text-red-300">{selected.error || '生成失败，请查看任务详情'}</p>
                : (playing ? preview : poster) ? <img key={`${imageId}-${playing}`} src={playing ? preview : poster} alt={playing ? '生成的 GIF 动画' : 'GIF 静态封面'} className="h-full max-h-[480px] w-full object-contain" onError={() => setPreviewError('浏览器无法显示该文件，请下载原件检查')} />
                  : <div className="p-8 text-center text-stone-400 dark:text-stone-500"><Film className="mx-auto mb-4 h-10 w-10 stroke-1" aria-hidden /><p className="text-sm">{imageId ? '正在读取预览…' : '你的下一段动画，从这里开始'}</p><p className="mt-2 text-xs">角色动作、产品展示、场景循环，都可以</p></div>}
          </div>
          {animation && <p className="mt-3 font-mono text-xs leading-relaxed text-stone-500 dark:text-stone-400">{animation.width} × {animation.height} · {animation.frameCount} 帧 · {(animation.durationMs / 1000).toFixed(2)} 秒 · {(animation.byteLength / 1024).toFixed(0)} KB</p>}
          {Boolean(selected?.gifCompanionCount) && <p className="mt-2 text-xs text-stone-500">服务商另附 {selected?.gifCompanionCount} 张静态辅助图，GIF 原件已单独保存。</p>}
          {animation && selected?.params.gif && (animation.frameCount !== selected.params.gif.frame_count || animation.frameDurationsMs.some((ms) => ms !== selected.params.gif!.frame_duration_ms)) && <p className="mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-200">返回的帧数或时长与请求不同，以上显示文件的实际时序。</p>}
          {animation && selected?.params.size !== 'auto' && selected?.params.size !== `${animation.width}x${animation.height}` && <p className="mt-2 text-xs leading-relaxed text-amber-700 dark:text-amber-200">请求尺寸 {selected?.params.size}，实际返回 {animation.width} × {animation.height}；已保留原件，未缩放或裁切动画。</p>}
          {selected?.status === 'done' && selected.outputImages.length !== selected.params.n && <p className="mt-2 text-xs text-amber-700 dark:text-amber-200">请求 {selected.params.n} 个动画，服务商实际返回 {selected.outputImages.length} 个；未自动补发。</p>}
          {previewError && <p role="alert" className="mt-2 text-xs text-red-600">{previewError}</p>}
          {selected?.outputPersistWarning && <p role="alert" className="mt-3 text-xs leading-relaxed text-amber-700 dark:text-amber-200">本地空间不足，原件尚未完整保存。请立即下载，刷新可能丢失。</p>}
          {selected && <div className="mt-4 flex flex-wrap gap-2">
            {imageId && <><button type="button" onClick={() => setPlaying(!playing)} className={SECONDARY}>{playing ? <Square className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}{playing ? '停止预览' : '播放动画'}</button><button type="button" onClick={() => { void download() }} disabled={downloading} className={SECONDARY}><Download className="h-3.5 w-3.5" aria-hidden />{downloading ? '下载中…' : '下载 GIF 原件'}</button></>}
            <button type="button" onClick={() => useStore.getState().setDetailTaskId(selected.id)} className={SECONDARY}>任务详情</button>
          </div>}
          <p className="mt-4 text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">生成结果保存在当前浏览器。下载保留原始帧与时序；修改描述或节奏后需重新生成。</p>
        </div>
      </div>
      <section className="border-t border-stone-200/70 p-5 sm:p-6 dark:border-white/[0.06]" aria-label="GIF 历史">
        <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">最近的 GIF</h3><span className="text-xs text-stone-500">{gifTasks.length} 个任务</span></div>
        {gifTasks.length ? <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{gifTasks.slice(0, 12).map((task) => <HistoryItem key={task.id} task={task} selected={selected?.id === task.id} onSelect={() => { setSelectedId(task.id); setOutputIndex(0) }} />)}</div> : <p className="py-3 text-xs text-stone-500">生成后的动画会出现在这里，可随时重新预览与下载。</p>}
      </section>
    </section>
  )
}

function HistoryItem({ task, selected, onSelect }: { task: TaskRecord; selected: boolean; onSelect: () => void }) {
  return <button type="button" aria-pressed={selected} onClick={onSelect} className={`min-w-0 rounded-xl border p-3 text-left transition ${selected ? 'border-[#df7b57]/70 bg-[#df7b57]/5' : 'border-stone-200/80 hover:border-[#df7b57]/50 dark:border-white/10'}`}><p className="truncate text-xs font-medium text-stone-800 dark:text-stone-200">{task.prompt}</p><p className="mt-2 text-[11px] text-stone-500">{task.status === 'done' ? '已完成' : task.status === 'running' ? '生成中' : '生成失败'} · {new Date(task.createdAt).toLocaleString('zh-CN')}</p></button>
}

export default StickerWorkshop
