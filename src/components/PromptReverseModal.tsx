import { useCallback, useEffect, useRef, useState } from 'react'
import { createInputImageFromFile, deleteImageIfUnreferenced, useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { ensureImageCached } from '../lib/imageCache'
import { resizeImageHighQuality } from '../lib/imageResizer'
import { getPromptReverseApiProfile, getTextApiProfileResolution } from '../lib/apiProfiles'
import {
  callPromptReverseApi,
  parsePromptReverseResult,
  resolveReverseImageTarget,
  type PromptReverseImageType,
  type PromptReverseResult,
} from '../lib/promptReverse'

type Phase = 'loading' | 'noProfile' | 'error' | 'done'

const CLOSE_ICON_PATH = 'M18 6 6 18M6 6l12 12'

const IMAGE_TYPE_LABELS: Record<PromptReverseImageType, string> = {
  portrait: '人像摄影',
  illustration: '插画动漫',
  poster: '海报版式',
  product: '产品图',
  general: '通用',
}

function readImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('图片无法读取'))
    img.src = dataUrl
  })
}

export default function PromptReverseModal() {
  const source = useStore((s) => s.promptReverseSource)
  const setPromptReverseSource = useStore((s) => s.setPromptReverseSource)
  const showToast = useStore((s) => s.showToast)
  const settings = useStore((s) => s.settings)
  const textApiResolution = getTextApiProfileResolution(settings)
  const imageId = source?.imageId ?? null
  const dropZoneFileInputRef = useRef<HTMLInputElement>(null)

  // 孤儿上传图的回收统一由 store 的 setPromptReverseSource 负责（替换/置空时清理旧 id）。
  const close = useCallback(() => setPromptReverseSource(null), [setPromptReverseSource])
  useCloseOnEscape(Boolean(source), close)

  // 落区拿图（粘贴/拖拽/选择共用）：入库后替换 source，effect 自动开始反推；旧图由 store 清理。
  const acceptReverseFile = useCallback(async (file: File) => {
    try {
      const image = await createInputImageFromFile(file)
      if (!image) {
        showToast('请粘贴或选择有效图片', 'error')
        return
      }
      // 入库是异步的：等待期间用户可能已 ESC 关闭模态，此时不再复活模态，回收刚入库的图。
      if (!useStore.getState().promptReverseSource) {
        void deleteImageIfUnreferenced(image.id)
        return
      }
      setPromptReverseSource({ imageId: image.id })
    } catch (err) {
      showToast(`图片读取失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [setPromptReverseSource, showToast])

  // 落区态监听全局粘贴：模态打开期间 InputBar 的参考图粘贴让位（见 InputBar 全局 paste 监听）。
  useEffect(() => {
    if (!source || imageId) return
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files
      if (!files?.length) return
      const file = Array.from(files).find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      void acceptReverseFile(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [source, imageId, acceptReverseFile])

  const [phase, setPhase] = useState<Phase>('loading')
  const [result, setResult] = useState<PromptReverseResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [previewDataUrl, setPreviewDataUrl] = useState('')
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null)
  const [activeLabel, setActiveLabel] = useState('')
  const [editedTexts, setEditedTexts] = useState<Record<string, string>>({})
  const [elapsed, setElapsed] = useState(0)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    const requestId = source?.imageId
    if (!requestId) return
    const controller = new AbortController()
    let cancelled = false
    setPhase('loading')
    setResult(null)
    setErrorMsg('')
    setEditedTexts({})
    setElapsed(0)
    setActiveLabel('')
    // 换一张时组件不卸载，旧图预览/角标必须随新一轮清空，否则闪旧图甚至挂在错误态旁。
    setPreviewDataUrl('')
    setImageSize(null)
    const timer = window.setInterval(() => setElapsed((e) => e + 1), 1000)

    void (async () => {
      try {
        const { settings } = useStore.getState()
        // 图片预览与尺寸先就位：即使无可用 profile（noProfile 态）也能看到图。
        const originalDataUrl = await ensureImageCached(requestId)
        if (!originalDataUrl) throw new Error('图片不存在或已被清理')
        if (cancelled) return
        setPreviewDataUrl(originalDataUrl)
        const size = await readImageSize(originalDataUrl)
        if (cancelled) return
        setImageSize(size)
        const profile = getPromptReverseApiProfile(settings)
        if (!profile) {
          window.clearInterval(timer)
          setPhase('noProfile')
          return
        }
        const target = resolveReverseImageTarget(size.width, size.height)
        const requestImage = target
          ? await resizeImageHighQuality(originalDataUrl, target.width, target.height, 'contain')
          : originalDataUrl
        if (cancelled) return
        const text = await callPromptReverseApi({ settings, profile, imageDataUrl: requestImage, signal: controller.signal })
        if (cancelled) return
        const parsed = parsePromptReverseResult(text)
        if (!parsed) throw new Error('反推返回格式无法解析，请重试')
        setResult(parsed)
        setActiveLabel(parsed.prompts[0]?.label ?? '')
        window.clearInterval(timer)
        setPhase('done')
      } catch (err) {
        if (cancelled || controller.signal.aborted) return
        setErrorMsg(err instanceof Error ? err.message : String(err))
        window.clearInterval(timer)
        setPhase('error')
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [source?.imageId, retryTick])

  if (!source) return null

  const activeCandidate = result?.prompts.find((p) => p.label === activeLabel) ?? result?.prompts[0] ?? null
  const activeText = activeCandidate ? (editedTexts[activeCandidate.label] ?? activeCandidate.text) : ''

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`已复制${label}`, 'success')
    } catch {
      showToast('复制失败，请手动选择文本', 'error')
    }
  }

  const handleFillPrompt = () => {
    if (!activeCandidate || !activeText.trim()) return
    const { setPrompt, recordPromptHistory, params } = useStore.getState()
    setPrompt(activeText.trim())
    recordPromptHistory(activeText.trim(), params)
    showToast('已填入提示词并记入历史', 'success')
    close()
  }

  const openSettings = () => {
    useStore.getState().setShowSettings(true)
    close()
  }

  const retry = () => setRetryTick((t) => t + 1)
  // 换一张：清空当前源回落区，旧上传图由 store 的替换清理回收。
  const resetToDropZone = () => setPromptReverseSource({ imageId: null })

  // 落区态：等待粘贴/拖入/选择图片。
  if (!imageId) {
    return (
      <div
        data-no-drag-select
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 max-sm:items-end max-sm:justify-stretch max-sm:p-0"
        onClick={close}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="反推提示词"
          className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900 max-sm:max-h-[92vh] max-sm:rounded-b-none"
          onClick={(e) => e.stopPropagation()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'))
            if (file) void acceptReverseFile(file)
          }}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5 dark:border-white/[0.06]">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">反推提示词</h2>
            <button
              type="button"
              onClick={close}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-300"
              aria-label="关闭"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d={CLOSE_ICON_PATH} />
              </svg>
            </button>
          </div>
          <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-4 p-8">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 dark:bg-blue-500/10">
              <svg className="h-8 w-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.8}>
                <rect x="8" y="3" width="12" height="14" rx="2" />
                <path d="M16 21H6a2 2 0 01-2-2V7" strokeLinecap="round" />
                <path d="M12 10v4M10 12h4" strokeLinecap="round" />
              </svg>
            </div>
            <div className="text-center">
              <p className="text-sm text-gray-700 dark:text-gray-200">按 <kbd className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs dark:border-white/10 dark:bg-white/5">Ctrl</kbd>+<kbd className="rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-xs dark:border-white/10 dark:bg-white/5">V</kbd> 粘贴图片，或将图片拖到这里</p>
              <p className="mt-1.5 text-xs text-gray-400 dark:text-gray-500">反推是对画面的推测而非精确复刻，可编辑后再生成</p>
            </div>
            <button
              type="button"
              onClick={() => dropZoneFileInputRef.current?.click()}
              className="rounded-xl bg-blue-500 px-4 py-2 text-sm text-white transition hover:bg-blue-600"
            >
              选择本地图片
            </button>
            <input
              ref={dropZoneFileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file) void acceptReverseFile(file)
              }}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 max-sm:items-end max-sm:justify-stretch max-sm:p-0"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="反推提示词"
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900 max-sm:max-h-[92vh] max-sm:rounded-b-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5 dark:border-white/[0.06]">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">反推提示词</h2>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-gray-400 dark:text-gray-500 md:inline">反推是对画面的推测而非精确复刻，可编辑后再生成</span>
            {(phase === 'done' || phase === 'error') && (
              <button
                type="button"
                onClick={resetToDropZone}
                className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 transition hover:bg-gray-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]"
              >
                换一张
              </button>
            )}
            <button
              type="button"
              onClick={close}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-300"
              aria-label="关闭"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d={CLOSE_ICON_PATH} />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden max-sm:flex-col">
          <div className="flex w-2/5 shrink-0 items-center justify-center bg-gray-50 p-4 dark:bg-white/[0.02] max-sm:h-44 max-sm:w-full">
            {previewDataUrl ? (
              <div className="relative flex h-full items-center justify-center">
                <img src={previewDataUrl} alt="待反推图片" className="max-h-full max-w-full rounded-lg object-contain" />
                {imageSize && (
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-sm">
                    {imageSize.width}×{imageSize.height}
                  </span>
                )}
              </div>
            ) : (
              <div className="h-24 w-24 animate-pulse rounded-lg bg-gray-200 dark:bg-white/[0.06]" />
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {phase === 'loading' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
                  <span>正在反推…</span>
                  <span className="tabular-nums">{elapsed}s</span>
                </div>
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-4 animate-pulse rounded bg-gray-100 dark:bg-white/[0.05]" style={{ width: `${90 - i * 12}%` }} />
                ))}
              </div>
            )}

            {phase === 'noProfile' && (
              <div className="space-y-3 py-8 text-center">
                <p className="text-sm text-gray-600 dark:text-gray-300">暂无可用的反推文本模型。</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  {textApiResolution.reason === 'ambiguous'
                    ? '存在多个文本模型配置，自动模式无法选择。请在 设置 → API 配置 → 文本模型服务 指定一项。'
                    : '当前生图配置不支持文本请求，也没有其他可用的文本配置。请在 设置 → API 配置 新建一个「OpenAI 兼容 · Responses 模式」配置（生图配置无需切换）。'}
                </p>
                <button
                  type="button"
                  onClick={openSettings}
                  className="rounded-xl bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600 transition"
                >
                  打开设置
                </button>
              </div>
            )}

            {phase === 'error' && (
              <div className="space-y-3 py-8 text-center">
                <p className="text-sm text-red-500">反推失败：{errorMsg}</p>
                <div className="flex justify-center gap-2">
                  <button type="button" onClick={retry} className="rounded-xl bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600 transition">
                    重试
                  </button>
                  <button type="button" onClick={close} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.04]">
                    关闭
                  </button>
                </div>
              </div>
            )}

            {phase === 'done' && result && (
              <div className="space-y-4">
                <div>
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
                    {IMAGE_TYPE_LABELS[result.imageType]}
                  </span>
                </div>
                {result.breakdown.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-gray-400 dark:text-gray-500">画面解构</div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {result.breakdown.map((item) => (
                        <div key={item.dimension} className="rounded-xl border border-gray-100 bg-gray-50/60 px-3 py-2 dark:border-white/[0.05] dark:bg-white/[0.02]">
                          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{item.dimension}</div>
                          <div className="mt-0.5 text-[13px] leading-relaxed text-gray-700 dark:text-gray-300">{item.text}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    {result.prompts.map((candidate) => (
                      <button
                        key={candidate.label}
                        type="button"
                        onClick={() => setActiveLabel(candidate.label)}
                        className={`rounded-lg px-2.5 py-1 text-xs transition ${
                          candidate.label === activeLabel
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'
                        }`}
                      >
                        {candidate.label}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={activeText}
                    onChange={(e) => activeCandidate && setEditedTexts((prev) => ({ ...prev, [activeCandidate.label]: e.target.value }))}
                    rows={6}
                    className="w-full resize-y rounded-xl border border-gray-200 bg-white/60 px-3 py-2.5 text-sm leading-relaxed text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400 dark:text-gray-500">{activeText.length} 字 · 编辑后以编辑版为准</span>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => handleCopy(activeText, '提示词')} className="rounded-xl border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.04]">
                        复制
                      </button>
                      <button type="button" onClick={handleFillPrompt} className="rounded-xl bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600">
                        填入提示词
                      </button>
                    </div>
                  </div>
                </div>

                {result.promptEn && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-medium text-gray-400 dark:text-gray-500">英文镜像（可直接用于英文生图 API）</div>
                      <button type="button" onClick={() => handleCopy(result.promptEn as string, '英文提示词')} className="text-xs text-blue-500 hover:text-blue-600">
                        复制
                      </button>
                    </div>
                    <p className="max-h-28 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50/60 px-3 py-2 text-[13px] leading-relaxed text-gray-600 dark:border-white/[0.05] dark:bg-white/[0.02] dark:text-gray-400">
                      {result.promptEn}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
