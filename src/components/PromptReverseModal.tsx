import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { ensureImageCached } from '../lib/imageCache'
import { resizeImageHighQuality } from '../lib/imageResizer'
import { getPromptReverseApiProfile } from '../lib/apiProfiles'
import {
  callPromptReverseApi,
  parsePromptReverseResult,
  resolveReverseImageTarget,
  type PromptReverseResult,
} from '../lib/promptReverse'

type Phase = 'loading' | 'noProfile' | 'error' | 'done'

const CLOSE_ICON_PATH = 'M18 6 6 18M6 6l12 12'

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
    if (!source?.imageId) return
    const controller = new AbortController()
    let cancelled = false
    setPhase('loading')
    setResult(null)
    setErrorMsg('')
    setEditedTexts({})
    setElapsed(0)
    setActiveLabel('')
    const timer = window.setInterval(() => setElapsed((e) => e + 1), 1000)

    void (async () => {
      try {
        const { settings } = useStore.getState()
        const profile = getPromptReverseApiProfile(settings)
        if (!profile) {
          setPhase('noProfile')
          return
        }
        const originalDataUrl = await ensureImageCached(source.imageId)
        if (!originalDataUrl) throw new Error('图片不存在或已被清理')
        if (cancelled) return
        setPreviewDataUrl(originalDataUrl)
        const size = await readImageSize(originalDataUrl)
        if (cancelled) return
        setImageSize(size)
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
        setPhase('done')
      } catch (err) {
        if (cancelled || controller.signal.aborted) return
        setErrorMsg(err instanceof Error ? err.message : String(err))
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

  const close = () => setPromptReverseSource(null)

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

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 max-sm:items-end max-sm:justify-stretch max-sm:p-0"
      onClick={close}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900 max-sm:max-h-[92vh] max-sm:rounded-b-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5 dark:border-white/[0.06]">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">反推提示词</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 dark:text-gray-500">反推是对画面的推测而非精确复刻，可编辑后再生成</span>
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
                <p className="text-sm text-gray-600 dark:text-gray-300">暂无可用的反推模型配置。</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">请在 设置 → API 配置 中启用 Agent 独立配置并选择 Responses 类型的文本模型，或将当前激活配置切换为 Responses 模式。</p>
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
