import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useDialogTrap } from '../hooks/useDialogTrap'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'
import { ensureImageCached } from '../lib/imageCache'
import { formatExportFileTime } from '../lib/exportFileName'
import {
  DEFAULT_STICKER_SPLIT_PARAMS,
  buildSplitOptions,
  decodeImageSource,
  rerunStickerSplit,
  splitStickerImage,
  StickerSplitCacheMissError,
  type StickerSplitParams,
} from '../lib/stickerSplit/splitService'
import type { SplitImageData, SplitOutput, SplitRunResult, SquareSetting } from '../lib/stickerSplit/engine'
import { downloadSplitOutput, downloadSplitOutputsZip } from '../lib/stickerSplit/download'
import { outputToCanvas } from '../lib/stickerSplit/animate'
import StickerAnimatePanel from './StickerAnimatePanel'

type Phase = 'loading' | 'ready' | 'error'

/** 画棋盘格底：所见即所得的透明底示意，亮暗主题各取一对灰阶。 */
function drawChecker(ctx: CanvasRenderingContext2D, w: number, h: number, cell: number, dark: boolean) {
  ctx.fillStyle = dark ? '#232328' : '#ececec'
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = dark ? '#2c2c32' : '#e0e0e0'
  for (let y = 0; y < h; y += cell) {
    for (let x = ((y / cell) % 2) * cell; x < w; x += cell * 2) {
      ctx.fillRect(x, y, Math.min(cell, w - x), Math.min(cell, h - y))
    }
  }
}

function isDarkTheme() {
  return document.documentElement.classList.contains('dark')
}

export default function StickerSplitModal() {
  const source = useStore((s) => s.stickerSplitSource)
  const setStickerSplitSource = useStore((s) => s.setStickerSplitSource)
  const showToast = useStore((s) => s.showToast)

  const close = useCallback(() => setStickerSplitSource(null), [setStickerSplitSource])
  useCloseOnEscape(Boolean(source), close)
  usePreventBackgroundScroll(true)

  const [phase, setPhase] = useState<Phase>('loading')
  const [result, setResult] = useState<SplitRunResult | null>(null)
  const [params, setParams] = useState<StickerSplitParams>(DEFAULT_STICKER_SPLIT_PARAMS)
  const [squareSetting, setSquareSetting] = useState<SquareSetting>('auto')
  const [selected, setSelected] = useState(-1)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [animateOpen, setAnimateOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [nameBase, setNameBase] = useState('stickers')
  const [gapSlider, setGapSlider] = useState(0)
  // 每次新切分结果 +1：作为动图面板的 remount key，避免换图后帧选择残留旧 index
  const [splitVersion, setSplitVersion] = useState(0)

  const imageDataRef = useRef<SplitImageData | null>(null)
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const runTokenRef = useRef(0)
  const rerunTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewScaleRef = useRef(1)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const advancedRef = useRef<HTMLDivElement | null>(null)
  const dragCounterRef = useRef(0)
  const thumbRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  const trapRef = useDialogTrap({ active: true, onClose: close })

  const outputs = result?.outputs ?? []
  const running = phase === 'loading'

  const runFromImageData = useCallback(async (imageData: SplitImageData, nextSquareSetting: SquareSetting, nextParams: StickerSplitParams): Promise<SplitRunResult> => {
    // 完整重算；Worker 缓存缺失（实例被回收）也走这里。
    return await splitStickerImage(imageData, buildSplitOptions('auto', nextParams), nextSquareSetting)
  }, [])

  const applyResult = useCallback((r: SplitRunResult) => {
    setResult(r)
    setSelected(-1)
    setPreviewIndex(null)
    setSplitVersion((v) => v + 1)
    setPhase('ready')
  }, [])

  /** 初始/换图：解码 → 完整切分。srcMustStayAlive 由调用方保证在解码完成前有效。 */
  const runInitial = useCallback(async (src: string, nextNameBase: string) => {
    const token = ++runTokenRef.current
    setPhase('loading')
    setPreviewIndex(null)
    setSelected(-1)
    try {
      const { imageData, display } = await decodeImageSource(src)
      if (token !== runTokenRef.current) {
        display.close()
        return
      }
      imageDataRef.current = imageData
      const displayCanvas = document.createElement('canvas')
      displayCanvas.width = display.width
      displayCanvas.height = display.height
      displayCanvas.getContext('2d')?.drawImage(display, 0, 0)
      sourceCanvasRef.current = displayCanvas
      display.close()
      setNameBase(nextNameBase)
      const r = await runFromImageData(imageData, squareSetting, params)
      if (token !== runTokenRef.current) return
      applyResult(r)
      if (params.gap === 'auto' && r.suggestGap > 0) {
        setGapSlider(Math.min(600, r.suggestGap))
      }
    } catch (err) {
      if (token !== runTokenRef.current) return
      console.error(err)
      setPhase('error')
      showToast(`贴纸切分失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }, [applyResult, params, runFromImageData, showToast, squareSetting])

  // 打开时解析图片来源（imageId → 缓存；否则直连 url）并切分
  useEffect(() => {
    if (!source) return
    let cancelled = false
    ;(async () => {
      let src: string | undefined
      if (source.imageId) src = await ensureImageCached(source.imageId)
      if (!src && source.url) src = source.url
      if (!src) {
        showToast('图片已不存在', 'error')
        close()
        return
      }
      const tasks = useStore.getState().tasks
      let base = `sticker-${formatExportFileTime(new Date())}`
      if (source.imageId) {
        const task = tasks.find((t) => t.outputImages?.includes(source.imageId as string))
        base = task ? `task-${task.id}-sticker` : `image-${source.imageId}-sticker`
      }
      if (cancelled) return
      await runInitial(src, base)
    })()
    return () => {
      cancelled = true
    }
    // 仅在挂载时按当前来源执行一次；换图走 loadNewImage。
  }, [])

  /** 参数/方形输出调整：优先复用 Worker 缓存（resquare 免 analyze，参数重算免传像素）。 */
  const scheduleRerun = useCallback((resquareOnly: boolean, nextParams: StickerSplitParams, nextSquareSetting: SquareSetting) => {
    if (rerunTimerRef.current) clearTimeout(rerunTimerRef.current)
    rerunTimerRef.current = setTimeout(async () => {
      const token = ++runTokenRef.current
      const imageData = imageDataRef.current
      if (!imageData) return
      setPhase('loading')
      try {
        let r: SplitRunResult
        try {
          r = resquareOnly
            ? await rerunStickerSplit(buildSplitOptions('auto', nextParams), nextSquareSetting, true)
            : await rerunStickerSplit(buildSplitOptions('auto', nextParams), nextSquareSetting, false)
        } catch (err) {
          if (!(err instanceof StickerSplitCacheMissError)) throw err
          r = await runFromImageData(imageData, nextSquareSetting, nextParams)
        }
        if (token !== runTokenRef.current) return
        applyResult(r)
      } catch (err) {
        if (token !== runTokenRef.current) return
        console.error(err)
        setPhase('error')
        showToast(`贴纸切分失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    }, 130)
  }, [applyResult, runFromImageData, showToast])

  useEffect(() => () => {
    if (rerunTimerRef.current) clearTimeout(rerunTimerRef.current)
    runTokenRef.current++
  }, [])

  // ---- 参数变化处理（沿用独立工具版语义：auto 优先，拖动即重算） ----
  const imageDims = () => {
    const d = imageDataRef.current
    return d ? { w: d.width, h: d.height } : { w: 0, h: 0 }
  }

  const changeParams = (patch: Partial<StickerSplitParams>) => {
    const next = { ...params, ...patch }
    setParams(next)
    scheduleRerun(false, next, squareSetting)
  }

  const changeSquareSetting = (v: SquareSetting) => {
    setSquareSetting(v)
    scheduleRerun(true, params, v)
  }

  // ---- 主画布：棋盘格 + 原图 + 检测框（选中高亮、其余虚化） ----
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage || !sourceCanvasRef.current || !result) return
    const src = sourceCanvasRef.current
    const stageW = stage.clientWidth - 32
    const stageH = stage.clientHeight - 32
    if (stageW <= 0 || stageH <= 0) return
    const s = Math.min(stageW / src.width, stageH / src.height, 1)
    viewScaleRef.current = s
    canvas.width = Math.max(1, Math.round(src.width * s))
    canvas.height = Math.max(1, Math.round(src.height * s))
    const g = canvas.getContext('2d')
    if (!g) return
    const cell = Math.max(6, Math.round(12 * s * (src.width > 1500 ? 3 : 1)))
    drawChecker(g, canvas.width, canvas.height, cell, isDarkTheme())
    g.imageSmoothingQuality = 'high'
    g.drawImage(src, 0, 0, canvas.width, canvas.height)
    const lw = Math.max(1.5, Math.round(canvas.width / 420))
    for (const b of result.outputs) {
      const sel = selected === b.index
      const dim = selected !== -1 && !sel
      g.strokeStyle = sel ? '#ffffff' : '#f43f5e'
      g.lineWidth = sel ? lw * 1.7 : lw
      g.setLineDash(dim ? [6, 5] : [])
      g.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s)
      g.setLineDash([])
      g.font = `700 ${Math.max(12, Math.round(canvas.width / 55))}px ui-monospace, monospace`
      const label = `#${String(b.index).padStart(2, '0')}`
      const tw = g.measureText(label).width
      const ly = Math.max(0, b.y * s - 22)
      g.fillStyle = sel ? '#ffffff' : '#f43f5e'
      g.fillRect(b.x * s, ly, tw + 13, 20)
      g.fillStyle = sel ? '#0c0c0e' : '#ffffff'
      g.fillText(label, b.x * s + 6.5, ly + 15.5)
    }
  }, [result, selected])

  useEffect(() => {
    if (previewIndex !== null) return
    drawCanvas()
  }, [drawCanvas, previewIndex])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => drawCanvas())
    ro.observe(stage)
    return () => ro.disconnect()
  }, [drawCanvas])

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!result) return
    const canvas = e.currentTarget
    const rect = canvas.getBoundingClientRect()
    const mx = (e.clientX - rect.left) / viewScaleRef.current
    const my = (e.clientY - rect.top) / viewScaleRef.current
    let hit = -1
    for (const b of result.outputs) {
      if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) hit = b.index
    }
    if (hit >= 0) {
      setSelected(hit)
      thumbRefs.current.get(hit)?.scrollIntoView({ block: 'nearest' })
    } else {
      setSelected(-1)
    }
  }

  // ---- 拖拽 / 粘贴换图：模态打开期间在捕获阶段接管，避免落入输入栏 ----
  const loadNewImage = useCallback(async (file: File) => {
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      showToast('请拖入 PNG 或 JPG 图片', 'error')
      return
    }
    const url = URL.createObjectURL(file)
    const base = file.name.replace(/\.(png|jpe?g)$/i, '') || 'stickers'
    try {
      await runInitial(url, base)
    } finally {
      URL.revokeObjectURL(url)
    }
  }, [runInitial, showToast])

  useEffect(() => {
    const hasImageFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const onDragEnter = (e: DragEvent) => {
      if (!hasImageFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current++
      setDragOver(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasImageFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    const onDragLeave = (e: DragEvent) => {
      if (!hasImageFiles(e)) return
      e.stopPropagation()
      dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
      if (dragCounterRef.current === 0) setDragOver(false)
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounterRef.current = 0
      setDragOver(false)
      const file = e.dataTransfer?.files?.[0]
      if (file) void loadNewImage(file)
    }
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            e.stopPropagation()
            void loadNewImage(file)
          }
          break
        }
      }
    }

    window.addEventListener('dragenter', onDragEnter, { capture: true })
    window.addEventListener('dragover', onDragOver, { capture: true })
    window.addEventListener('dragleave', onDragLeave, { capture: true })
    window.addEventListener('drop', onDrop, { capture: true })
    window.addEventListener('paste', onPaste, { capture: true })
    return () => {
      window.removeEventListener('dragenter', onDragEnter, { capture: true })
      window.removeEventListener('dragover', onDragOver, { capture: true })
      window.removeEventListener('dragleave', onDragLeave, { capture: true })
      window.removeEventListener('drop', onDrop, { capture: true })
      window.removeEventListener('paste', onPaste, { capture: true })
    }
  }, [loadNewImage])

  // 高级面板外点击关闭
  useEffect(() => {
    if (!advancedOpen) return
    const onDown = (e: MouseEvent) => {
      if (advancedRef.current && e.target instanceof Node && !advancedRef.current.contains(e.target)) {
        setAdvancedOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [advancedOpen])

  // ---- 下载 ----
  const handleDownloadAll = async () => {
    if (!outputs.length || downloading) return
    setDownloading(true)
    try {
      const count = await downloadSplitOutputsZip(outputs, nameBase)
      showToast(`已导出 ${count} 张贴纸（zip）`, 'success')
    } catch (err) {
      console.error(err)
      showToast('导出失败', 'error')
    } finally {
      setDownloading(false)
    }
  }

  const handleDownloadOne = async (output: SplitOutput) => {
    try {
      await downloadSplitOutput(output, nameBase, output.index - 1, outputs.length)
    } catch (err) {
      console.error(err)
      showToast('下载失败', 'error')
    }
  }

  const previewOutput = useMemo(() => (previewIndex !== null ? outputs.find((o) => o.index === previewIndex) ?? null : null), [outputs, previewIndex])

  const statusText = useMemo(() => {
    if (phase === 'loading') return '切分中…'
    if (phase === 'error' || !result) return '切分失败'
    if (!outputs.length) return '0 张 — 没识别到内容'
    return `切出 ${outputs.length} 张${result.square ? ' · 方形 1:1' : ''}${result.source === 'alpha' ? ' · 透明底' : ' · 单色底'}`
  }, [outputs.length, phase, result])

  if (!source) return null

  return (
    <div
      ref={(el) => {
        trapRef.current = el
      }}
      data-no-drag-select
      role="dialog"
      aria-modal="true"
      aria-label="拆分贴纸"
      className="fixed inset-0 z-[80] flex flex-col bg-gray-50 dark:bg-gray-900 animate-modal-in"
    >
      {/* 顶栏 */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-200/80 dark:border-white/[0.06] px-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <svg className="h-4 w-4 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="3" />
            <path d="M20.4 20.4 8.5 8.5M14.5 6.5l3 3L6 21" />
          </svg>
          拆分贴纸
        </div>
        <span className={`text-xs ${outputs.length ? 'text-gray-500 dark:text-gray-400' : 'text-red-500'}`}>{statusText}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-xl border border-gray-200/80 bg-white/80 dark:border-white/10 dark:bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 transition hover:bg-gray-100 dark:hover:bg-white/[0.08]"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            高级选项
          </button>
          <button
            type="button"
            onClick={close}
            className="rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 dark:hover:bg-white/[0.06]"
            aria-label="关闭"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* 主区：动图工作台 / 切分视图 */}
      {animateOpen && outputs.length > 0 ? (
        <StickerAnimatePanel key={splitVersion} outputs={outputs} nameBase={nameBase} showToast={showToast} />
      ) : (
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* 左：原图 + 检测框 / 单张大图预览 */}
        <div
          ref={stageRef}
          className="relative flex h-64 shrink-0 items-center justify-center overflow-hidden p-4 md:h-auto md:min-h-0 md:flex-1 md:shrink"
          onClick={() => setAdvancedOpen(false)}
        >
          {previewOutput ? (
            <BigPreview output={previewOutput} onBack={() => setPreviewIndex(null)} onDownload={() => void handleDownloadOne(previewOutput)} downloading={downloading} />
          ) : (
            <>
              <canvas
                ref={canvasRef}
                onClick={onCanvasClick}
                className={`max-h-full max-w-full cursor-crosshair rounded-xl shadow-sm ring-1 ring-gray-200/70 dark:ring-white/[0.06] ${outputs.length ? '' : 'invisible'}`}
              />
              {!outputs.length && (
                <div className="absolute inset-4 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-300 text-gray-400 dark:border-white/10 dark:text-gray-500">
                  {running ? (
                    <>
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-white/10 dark:border-t-blue-400" />
                      <p className="text-sm">正在切分…</p>
                    </>
                  ) : (
                    <>
                      <div className="text-4xl grayscale-[0.3]">✂️</div>
                      <p className="text-base text-gray-600 dark:text-gray-300">把拼图拖进来，自动拆好</p>
                      <p className="text-xs">或点击右下角「换一张」· Ctrl+V 粘贴</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500">透明底 PNG / 单色底 JPG · 全程本地处理，不上传</p>
                    </>
                  )}
                </div>
              )}
              {outputs.length > 0 && running && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-[1px] dark:bg-black/40">
                  <div className="flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-xs font-medium text-gray-700 shadow-lg dark:bg-black/70 dark:text-gray-200">
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-white/20 dark:border-t-blue-400" />
                    正在重新切分…
                  </div>
                </div>
              )}
            </>
          )}

          {dragOver && (
            <div className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-500 bg-blue-500/5 backdrop-blur-[1px]">
              <div className="text-3xl">✂️</div>
              <p className="text-sm font-medium text-blue-500">松手开始切分</p>
            </div>
          )}
        </div>

        {/* 右：缩略图网格 */}
        <div className="flex min-h-0 flex-1 flex-col border-t border-gray-200/80 dark:border-white/[0.06] md:w-80 md:flex-none md:border-l md:border-t-0">
          <div className="shrink-0 px-4 pt-3 pb-2 text-xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">
            切好的贴纸{outputs.length ? ` · ${outputs.length}` : ''} · 点开看大图
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
            <div className="grid grid-cols-3 gap-2 md:grid-cols-2">
              {outputs.map((o) => (
                <OutputThumb
                  key={o.index}
                  output={o}
                  selected={selected === o.index}
                  registerRef={(el) => {
                    if (el) thumbRefs.current.set(o.index, el)
                    else thumbRefs.current.delete(o.index)
                  }}
                  onClick={() => {
                    setSelected(o.index)
                    setPreviewIndex(o.index)
                  }}
                  onDownload={() => void handleDownloadOne(o)}
                />
              ))}
            </div>
            {phase === 'ready' && !outputs.length && (
              <p className="px-2 pt-6 text-center text-xs text-red-500">
                没切出来？展开「高级选项」把分离阈值调高一点
              </p>
            )}
          </div>
        </div>
      </div>
      )}

      {/* 底栏 */}
      <div className="flex h-16 shrink-0 items-center gap-3 border-t border-gray-200/80 dark:border-white/[0.06] px-4">
        <button
          type="button"
          disabled={!outputs.length}
          onClick={() => {
            setAnimateOpen((v) => !v)
            setPreviewIndex(null)
          }}
          className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-4 py-2.5 text-sm font-semibold transition active:scale-95 ${
            outputs.length
              ? animateOpen
                ? 'border border-blue-200/80 bg-white/80 text-blue-600 hover:bg-blue-50 dark:border-blue-400/20 dark:bg-white/[0.04] dark:text-blue-300'
                : 'bg-blue-500 text-white shadow-md hover:bg-blue-600 hover:shadow-blue-500/25'
              : 'cursor-not-allowed bg-gray-100 text-gray-400 shadow-none dark:bg-white/10 dark:text-white/40'
          }`}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="m22 8-6 4 6 4V8Z" />
            <rect x="2" y="6" width="14" height="12" rx="2" />
          </svg>
          {animateOpen ? '返回切图' : '做成动图'}
        </button>
        <button
          type="button"
          disabled={!outputs.length || downloading}
          onClick={() => void handleDownloadAll()}
          className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-5 py-2.5 text-sm font-semibold transition active:scale-95 ${
            outputs.length && !downloading
              ? 'bg-blue-500 text-white shadow-md hover:bg-blue-600 hover:shadow-blue-500/25'
              : 'cursor-not-allowed bg-gray-100 text-gray-400 shadow-none dark:bg-white/10 dark:text-white/40'
          }`}
        >
          {downloading ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ) : (
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
          )}
          {downloading ? '打包中…' : `下载全部${outputs.length ? `（${outputs.length}）` : ''}`}
        </button>
        <p className="hidden text-xs text-gray-400 dark:text-gray-500 sm:block">
          像素级切分：不带邻居像素、不丢自己的像素{result?.square ? '，1:1 居中' : ''}
        </p>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="ml-auto flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-gray-200/80 bg-white/80 px-3 py-2 text-xs font-medium text-gray-600 transition hover:bg-gray-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
          换一张
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void loadNewImage(file)
          }}
        />
      </div>

      {/* 高级选项面板 */}
      {advancedOpen && (
        <AdvancedPanel
          ref={advancedRef}
          params={params}
          gapSlider={gapSlider}
          squareSetting={squareSetting}
          source={result?.source ?? 'alpha'}
          suggestGap={result?.suggestGap ?? 0}
          imageDims={imageDims()}
          onParams={(patch) => changeParams(patch)}
          onGapSlider={(v) => setGapSlider(v)}
          onSquare={changeSquareSetting}
        />
      )}
    </div>
  )
}

/** 缩略图：隔离后的输出像素直接绘制（所见即所得），hover 出现单张下载。 */
function OutputThumb({
  output,
  selected,
  registerRef,
  onClick,
  onDownload,
}: {
  output: SplitOutput
  selected: boolean
  registerRef: (el: HTMLButtonElement | null) => void
  onClick: () => void
  onDownload: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const side = 104
    const k = Math.min(side / output.w, side / output.h)
    canvas.width = Math.max(1, Math.round(output.w * k))
    canvas.height = Math.max(1, Math.round(output.h * k))
    const g = canvas.getContext('2d')
    if (!g) return
    drawChecker(g, canvas.width, canvas.height, 7, isDarkTheme())
    g.imageSmoothingQuality = 'high'
    g.drawImage(outputToCanvas(output), 0, 0, canvas.width, canvas.height)
  }, [output])

  return (
    <button
      type="button"
      ref={registerRef}
      onClick={onClick}
      className={`group relative rounded-xl border p-1.5 text-left transition ${
        selected
          ? 'border-blue-500 ring-1 ring-blue-500'
          : 'border-gray-200/80 hover:border-gray-300 dark:border-white/[0.08] dark:hover:border-white/20'
      }`}
    >
      <div className="flex h-[104px] items-center justify-center overflow-hidden rounded-lg">
        <canvas ref={canvasRef} className="block max-h-full max-w-full" />
      </div>
      <div className="mt-1 flex items-center justify-between px-0.5 font-mono text-[10px] text-gray-400 dark:text-gray-500">
        <span className={selected ? 'font-bold text-blue-500' : 'font-bold text-gray-600 dark:text-gray-300'}>
          #{String(output.index).padStart(2, '0')}
        </span>
        <span>{output.w}×{output.h}</span>
      </div>
      <span
        role="button"
        tabIndex={-1}
        title="下载这张"
        onClick={(e) => {
          e.stopPropagation()
          onDownload()
        }}
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white opacity-0 backdrop-blur-sm transition group-hover:opacity-100 hover:bg-black/80"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
      </span>
    </button>
  )
}

/** 左侧大图预览：棋盘格底 + 底部操作条。 */
function BigPreview({
  output,
  onBack,
  onDownload,
  downloading,
}: {
  output: SplitOutput
  onBack: () => void
  onDownload: () => void
  downloading: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const draw = () => {
      const maxW = Math.max(1, container.clientWidth - 8)
      const maxH = Math.max(1, container.clientHeight - 8)
      const k = Math.min(maxW / output.w, maxH / output.h)
      canvas.width = Math.max(1, Math.round(output.w * k))
      canvas.height = Math.max(1, Math.round(output.h * k))
      const g = canvas.getContext('2d')
      if (!g) return
      drawChecker(g, canvas.width, canvas.height, 12, isDarkTheme())
      g.imageSmoothingQuality = 'high'
      g.drawImage(outputToCanvas(output), 0, 0, canvas.width, canvas.height)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(container)
    return () => ro.disconnect()
  }, [output])

  return (
    <div ref={containerRef} className="relative flex h-full w-full items-center justify-center">
      <canvas
        ref={canvasRef}
        className="max-h-full max-w-full rounded-xl shadow-sm ring-1 ring-gray-200/70 dark:ring-white/[0.06]"
      />
      <span className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-0.5 font-mono text-xs font-bold text-white backdrop-blur-sm">
        #{String(output.index).padStart(2, '0')} · {output.w}×{output.h} px
      </span>
      <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-gray-200/80 bg-white/90 p-1.5 shadow-2xl backdrop-blur-xl dark:border-white/15 dark:bg-black/60">
        <button
          type="button"
          onClick={onDownload}
          disabled={downloading}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition active:scale-95 enabled:bg-blue-500 enabled:text-white enabled:hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400 dark:disabled:bg-white/10 dark:disabled:text-white/40"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          下载这张
        </button>
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 dark:text-white/90 dark:hover:bg-white/15"
        >
          返回原图
        </button>
      </div>
    </div>
  )
}

/** 高级选项浮层：默认折叠，出问题才碰。 */
function AdvancedPanel({
  ref,
  params,
  gapSlider,
  squareSetting,
  source,
  suggestGap,
  imageDims,
  onParams,
  onGapSlider,
  onSquare,
}: {
  ref: React.RefObject<HTMLDivElement | null>
  params: StickerSplitParams
  gapSlider: number
  squareSetting: SquareSetting
  source: 'alpha' | 'color'
  suggestGap: number
  imageDims: { w: number; h: number }
  onParams: (patch: Partial<StickerSplitParams>) => void
  onGapSlider: (v: number) => void
  onSquare: (v: SquareSetting) => void
}) {
  const sliderClass =
    'w-full h-1.5 cursor-pointer appearance-none rounded-full bg-gray-200 outline-none dark:bg-white/10 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:shadow-md'

  const minSizePx = (v: number) => Math.max(8, Math.round((v / 100) * imageDims.w * imageDims.h * 0.004))
  const paddingPx = (v: number) => Math.max(2, Math.round((v * Math.max(imageDims.w, imageDims.h)) / 2600))

    return (
      <div
        ref={ref}
        className="absolute right-3 top-14 z-30 w-[320px] rounded-xl border border-gray-200/80 bg-white/95 p-4 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-gray-800/95 max-sm:left-3 max-sm:w-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>方形输出</span>
            <span className="font-mono">{squareSetting === 'auto' ? '自动' : squareSetting === 'on' ? '方形' : '原始'}</span>
          </div>
          <div className="flex overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
            {([['auto', '自动'], ['on', '方形'], ['off', '原始']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => onSquare(v)}
                className={`flex-1 border-r border-gray-200 py-1.5 text-xs transition last:border-r-0 dark:border-white/10 ${
                  squareSetting === v
                    ? 'bg-blue-500 font-medium text-white'
                    : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-white/[0.06]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">1:1 画布、贴纸居中；自动 = 多数贴纸接近方形时开启</p>
        </div>

        {source === 'alpha' ? (
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>分离阈值</span>
              <span className="font-mono">{params.threshold}</span>
            </div>
            <input type="range" min={1} max={254} value={params.threshold} className={sliderClass} onChange={(e) => onParams({ threshold: Number(e.target.value) })} />
            <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">贴纸互相粘住时调高；切出来残缺时调低</p>
          </div>
        ) : (
          <div className="mb-3">
            <div className="mb-1.5 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>背景容差</span>
              <span className="font-mono">{params.tolerance}</span>
            </div>
            <input type="range" min={1} max={120} value={params.tolerance} className={sliderClass} onChange={(e) => onParams({ tolerance: Number(e.target.value) })} />
            <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">单色底图片背景没扣干净时调小</p>
          </div>
        )}

        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>挂靠距离</span>
            <span className="font-mono">{params.gap === 'auto' ? `自动${suggestGap > 0 ? `（≈${suggestGap}px）` : ''}` : `${params.gap}px`}</span>
          </div>
          <input
            type="range"
            min={0}
            max={600}
            value={gapSlider}
            className={sliderClass}
            onChange={(e) => {
              const v = Number(e.target.value)
              onGapSlider(v)
              onParams({ gap: v === 0 ? 'auto' : v })
            }}
            onDoubleClick={() => {
              onGapSlider(0)
              onParams({ gap: 'auto' })
            }}
          />
          <p className="mt-1 text-[11px] text-gray-400 dark:text-gray-500">小装饰（爱心/星星）离主体多远还算一张，双击恢复自动</p>
        </div>

        <div className="mb-3">
          <div className="mb-1.5 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>忽略噪点</span>
            <span className="font-mono">{params.minSize === 'auto' ? '自动' : `${params.minSize}px`}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={displayMinSizeSlider(params.minSize, imageDims)}
            className={sliderClass}
            onChange={(e) => {
              const v = Number(e.target.value)
              onParams({ minSize: v === 0 || !imageDims.w ? 'auto' : minSizePx(v) })
            }}
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
            <span>边缘留白</span>
            <span className="font-mono">{params.padding === 'auto' ? '自动' : imageDims.w ? `${params.padding}px` : ''}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={displayPaddingSlider(params.padding, imageDims)}
            className={sliderClass}
            onChange={(e) => {
              const v = Number(e.target.value)
              onParams({ padding: v === 0 || !imageDims.w ? 'auto' : paddingPx(v) })
            }}
          />
        </div>
      </div>
    )
  }

function displayMinSizeSlider(minSize: number | 'auto', dims: { w: number; h: number }): number {
  if (minSize === 'auto' || !dims.w) return 0
  return Math.min(100, Math.round((minSize / (dims.w * dims.h * 0.004)) * 100))
}

function displayPaddingSlider(padding: number | 'auto', dims: { w: number; h: number }): number {
  if (padding === 'auto' || !dims.w) return 0
  return Math.min(100, Math.round((padding * 2600) / Math.max(dims.w, dims.h)))
}
