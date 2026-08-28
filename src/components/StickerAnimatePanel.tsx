import { useEffect, useMemo, useRef, useState } from 'react'
import { zipSync } from 'fflate'
import type { SplitOutput } from '../lib/stickerSplit/engine'
import {
  MOTION_PRESETS,
  TimelineRenderer,
  buildTimeline,
  outputToCanvas,
  timelineTotalMs,
  type ComposeSource,
  type MotionPreset,
} from '../lib/stickerSplit/animate'
import { encodeApngFromCanvases } from '../lib/stickerSplit/apng'
import { encodeGif } from '../lib/stickerSplit/gifEncode'

type AnimateMode = 'sequence' | 'single'
type ExportSize = 512 | 240

interface StickerAnimatePanelProps {
  outputs: SplitOutput[]
  nameBase: string
  showToast: (message: string, type: 'success' | 'error' | 'info') => void
}

function isDarkTheme() {
  return document.documentElement.classList.contains('dark')
}

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

function formatKb(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

const segBtn = (active: boolean) =>
  `flex-1 whitespace-nowrap border-r border-gray-200 px-2 py-1.5 text-xs transition last:border-r-0 dark:border-white/10 ${
    active ? 'bg-blue-500 font-medium text-white' : 'text-gray-500 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-white/[0.06]'
  }`

/** 动图工作台：预览走导出同一条时间线；右列为帧选择。 */
export default function StickerAnimatePanel({ outputs, nameBase, showToast }: StickerAnimatePanelProps) {
  const [mode, setMode] = useState<AnimateMode>('sequence')
  const [selectedPoses, setSelectedPoses] = useState<Set<number>>(() => new Set(outputs.map((o) => o.index)))
  const [singleIndex, setSingleIndex] = useState(outputs[0]?.index ?? 1)
  const [preset, setPreset] = useState<MotionPreset>('bounce')
  const [poseMs, setPoseMs] = useState(160)
  const [crossfade, setCrossfade] = useState(true)
  const [pingPong, setPingPong] = useState(true)
  const [exportSize, setExportSize] = useState<ExportSize>(512)
  const [busy, setBusy] = useState<'gif' | 'apng' | 'batch' | null>(null)

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const sources = useMemo<ComposeSource[]>(
    () => outputs.map((o) => ({ index: o.index, canvas: outputToCanvas(o) })),
    [outputs],
  )

  const sequencePoses = useMemo(() => {
    const selected = outputs.filter((o) => selectedPoses.has(o.index)).map((o) => o.index)
    return selected.length >= 2 ? selected : outputs.length ? [outputs[0].index] : []
  }, [outputs, selectedPoses])

  const timeline = useMemo(
    () => buildTimeline({ poses: mode === 'sequence' ? sequencePoses : [singleIndex], pingPong, crossfade, poseMs, motionPreset: preset }),
    [mode, sequencePoses, singleIndex, pingPong, crossfade, poseMs, preset],
  )

  const activeSources = useMemo(
    () => sources.filter((s) => (mode === 'sequence' ? sequencePoses.includes(s.index) : s.index === singleIndex)),
    [mode, sequencePoses, singleIndex, sources],
  )
  const uniformMaxDim = useMemo(
    () => Math.max(1, ...activeSources.map((s) => Math.max(s.canvas.width, s.canvas.height))),
    [activeSources],
  )

  // 预览：按墙钟时间步进离散时间线（与导出帧一致）
  useEffect(() => {
    const preview = previewCanvasRef.current
    if (!preview || !activeSources.length) return
    preview.width = 512
    preview.height = 512
    const pctx = preview.getContext('2d')
    if (!pctx) return
    const renderer = new TimelineRenderer(activeSources, uniformMaxDim, 512)
    const totalMs = timelineTotalMs(timeline)
    let raf = 0
    const start = performance.now()
    const draw = (now: number) => {
      let elapsed = (now - start) % totalMs
      let step = timeline[timeline.length - 1]
      let acc = 0
      for (const s of timeline) {
        acc += s.delayMs
        if (elapsed < acc) {
          step = s
          break
        }
      }
      renderer.render(step, preset)
      drawChecker(pctx, preview.width, preview.height, 16, isDarkTheme())
      pctx.drawImage(renderer.canvas, 0, 0)
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [activeSources, uniformMaxDim, timeline, preset])

  const collectGifFrames = (size: number, poses: number[], useCrossfade: boolean, forBatch: boolean) => {
    const frames: Array<{ data: Uint8ClampedArray; width: number; height: number; delayMs: number }> = []
    const tl = buildTimeline({ poses, pingPong, crossfade: forBatch ? false : useCrossfade, poseMs, motionPreset: preset })
    const srcs = sources.filter((s) => poses.includes(s.index))
    const maxDim = Math.max(1, ...srcs.map((s) => Math.max(s.canvas.width, s.canvas.height)))
    const renderer = new TimelineRenderer(srcs, maxDim, size)
    for (const step of tl) {
      renderer.render(step, preset)
      const ctx = renderer.canvas.getContext('2d')
      if (!ctx) continue
      frames.push({ data: ctx.getImageData(0, 0, size, size).data, width: size, height: size, delayMs: step.delayMs })
    }
    return frames
  }

  const exportGif = async () => {
    if (busy || !activeSources.length) return
    setBusy('gif')
    try {
      const blob = encodeGif(collectGifFrames(exportSize, mode === 'sequence' ? sequencePoses : [singleIndex], crossfade, false))
      triggerDownload(blob, `${nameBase}-anim.gif`)
      showToast(`GIF 已导出（${formatKb(blob.size)}）`, 'success')
    } catch (err) {
      console.error(err)
      showToast('GIF 导出失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const exportApng = async () => {
    if (busy || !activeSources.length) return
    setBusy('apng')
    try {
      const poses = mode === 'sequence' ? sequencePoses : [singleIndex]
      const tl = buildTimeline({ poses, pingPong, crossfade, poseMs, motionPreset: preset })
      const srcs = sources.filter((s) => poses.includes(s.index))
      const maxDim = Math.max(1, ...srcs.map((s) => Math.max(s.canvas.width, s.canvas.height)))
      const renderer = new TimelineRenderer(srcs, maxDim, exportSize)
      const frames: Array<{ canvas: HTMLCanvasElement; delayMs: number }> = []
      for (const step of tl) {
        renderer.render(step, preset)
        // 每帧克隆快照，避免复用同一画布导致内容被下一帧覆盖
        const snapshot = document.createElement('canvas')
        snapshot.width = exportSize
        snapshot.height = exportSize
        snapshot.getContext('2d')?.drawImage(renderer.canvas, 0, 0)
        frames.push({ canvas: snapshot, delayMs: step.delayMs })
      }
      const blob = await encodeApngFromCanvases(frames)
      triggerDownload(blob, `${nameBase}-anim.png`)
      showToast(`APNG 已导出（${formatKb(blob.size)}）`, 'success')
    } catch (err) {
      console.error(err)
      showToast('APNG 导出失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const exportBatch = async () => {
    if (busy) return
    setBusy('batch')
    try {
      const files: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}
      for (let i = 0; i < outputs.length; i++) {
        const frames = collectGifFrames(exportSize, [outputs[i].index], false, true)
        const blob = encodeGif(frames)
        const bytes = new Uint8Array(await blob.arrayBuffer())
        files[`${nameBase}-${String(i + 1).padStart(2, '0')}-anim.gif`] = [bytes, { mtime: new Date() }]
      }
      const zipped = zipSync(files, { level: 6 })
      const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
      const zipBlob = new Blob([buffer], { type: 'application/zip' })
      triggerDownload(zipBlob, `${nameBase}-anim.zip`)
      showToast(`已批量导出 ${outputs.length} 个 GIF（${formatKb(zipBlob.size)}）`, 'success')
    } catch (err) {
      console.error(err)
      showToast('批量导出失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  const totalMs = timelineTotalMs(timeline)
  const frameCount = timeline.length

  return (
    <div className="flex h-full min-h-0 w-full flex-col md:flex-row">
      {/* 左：预览 + 控制 */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative flex h-56 shrink-0 items-center justify-center p-4 md:h-auto md:min-h-0 md:flex-1">
          <canvas
            ref={previewCanvasRef}
            className="max-h-full max-w-full rounded-xl shadow-sm ring-1 ring-gray-200/70 dark:ring-white/[0.06]"
          />
          {busy && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-[1px] dark:bg-black/40">
              <div className="flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-xs font-medium text-gray-700 shadow-lg dark:bg-black/70 dark:text-gray-200">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-white/20 dark:border-t-blue-400" />
                {busy === 'batch' ? '批量生成中…' : '编码中…'}
              </div>
            </div>
          )}
        </div>

        <div className="max-h-[46%] shrink-0 space-y-3 overflow-y-auto overscroll-contain border-t border-gray-200/80 px-4 py-3 dark:border-white/[0.06]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
              <button type="button" className={`w-16 ${segBtn(mode === 'sequence')}`} onClick={() => setMode('sequence')}>姿势轮播</button>
              <button type="button" className={`w-16 ${segBtn(mode === 'single')}`} onClick={() => setMode('single')}>单张动效</button>
            </div>
            <div className="flex overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
              {MOTION_PRESETS.map((p) => (
                <button key={p.value} type="button" className={segBtn(preset === p.value)} onClick={() => setPreset(p.value)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-500 dark:text-gray-400">
            {mode === 'sequence' && (
            <label className="flex items-center gap-2">
              <span>帧时长</span>
              <input
                type="range"
                min={60}
                max={240}
                step={20}
                value={poseMs}
                onChange={(e) => setPoseMs(Number(e.target.value))}
                className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-gray-200 outline-none dark:bg-white/10 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:shadow-md"
              />
              <span className="font-mono">{poseMs}ms</span>
            </label>
            )}
            <div className="flex overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
              <button type="button" className={`w-14 ${segBtn(!crossfade)}`} onClick={() => setCrossfade(false)}>硬切</button>
              <button type="button" className={`w-14 ${segBtn(crossfade)}`} onClick={() => setCrossfade(true)}>溶解</button>
            </div>
            <button
              type="button"
              onClick={() => setPingPong((v) => !v)}
              className={`rounded-lg border px-2.5 py-1.5 transition ${
                pingPong
                  ? 'border-blue-300 bg-blue-50 text-blue-600 dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-blue-300'
                  : 'border-gray-200 text-gray-400 dark:border-white/10 dark:text-gray-500'
              }`}
            >
              往返循环 {pingPong ? '开' : '关'}
            </button>
            <div className="flex overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
              <button type="button" className={`w-14 ${segBtn(exportSize === 512)}`} onClick={() => setExportSize(512)}>512</button>
              <button type="button" className={`w-16 ${segBtn(exportSize === 240)}`} onClick={() => setExportSize(240)}>240·微信</button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void exportGif()}
              className="flex items-center gap-1.5 rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white shadow-md transition hover:bg-blue-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              导出 GIF
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void exportApng()}
              className="flex items-center gap-1.5 rounded-xl border border-blue-200/80 bg-white/80 px-4 py-2 text-sm font-semibold text-blue-600 transition hover:bg-blue-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-400/20 dark:bg-white/[0.04] dark:text-blue-300 dark:hover:bg-blue-500/10"
            >
              导出 APNG
            </button>
            <button
              type="button"
              disabled={busy !== null || outputs.length < 2}
              onClick={() => void exportBatch()}
              className="flex items-center gap-1.5 rounded-xl border border-gray-200/80 bg-white/80 px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
            >
              批量 GIF×{outputs.length}
            </button>
            <span className="ml-auto font-mono text-[11px] text-gray-400 dark:text-gray-500">
              {frameCount} 帧 · {(totalMs / 1000).toFixed(1)}s · {mode === 'sequence' ? `${sequencePoses.length} 个姿势` : `#${String(singleIndex).padStart(2, '0')}`}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
            GIF 适配微信（1-bit 透明，光晕按阈值二值化）；APNG 保留完整半透明。点击右侧缩略图{mode === 'sequence' ? '增删轮播姿势（至少 2 个）' : '选择动效主体'}。
          </p>
        </div>
      </div>

      {/* 右：帧选择 */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-gray-200/80 dark:border-white/[0.06] md:w-64 md:flex-none md:border-l md:border-t-0">
        <div className="shrink-0 px-4 pt-3 pb-2 text-xs font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500">
          {mode === 'sequence' ? '轮播姿势' : '动效主体'}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
          <div className="grid grid-cols-3 gap-2">
            {outputs.map((o) => {
              const active = mode === 'sequence' ? selectedPoses.has(o.index) : o.index === singleIndex
              return (
                <button
                  key={o.index}
                  type="button"
                  onClick={() => {
                    if (mode === 'sequence') {
                      setSelectedPoses((prev) => {
                        const next = new Set(prev)
                        if (next.has(o.index)) next.delete(o.index)
                        else next.add(o.index)
                        return next
                      })
                    } else {
                      setSingleIndex(o.index)
                    }
                  }}
                  className={`relative overflow-hidden rounded-lg border transition ${
                    active
                      ? 'border-blue-500 ring-1 ring-blue-500'
                      : 'border-gray-200/80 opacity-60 hover:opacity-100 dark:border-white/[0.08]'
                  }`}
                >
                  <FrameThumb output={o} />
                  <span className="absolute left-1 top-1 rounded bg-black/60 px-1 font-mono text-[10px] font-bold text-white backdrop-blur-sm">
                    #{String(o.index).padStart(2, '0')}
                  </span>
                  {mode === 'sequence' && (
                    <span
                      className={`absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
                        active ? 'bg-blue-500 text-white' : 'bg-black/50 text-white/70'
                      }`}
                    >
                      {active ? '✓' : ''}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function FrameThumb({ output }: { output: SplitOutput }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const side = 72
    const k = Math.min(side / output.w, side / output.h)
    canvas.width = Math.max(1, Math.round(output.w * k))
    canvas.height = Math.max(1, Math.round(output.h * k))
    const g = canvas.getContext('2d')
    if (!g) return
    drawChecker(g, canvas.width, canvas.height, 6, isDarkTheme())
    g.imageSmoothingQuality = 'high'
    g.drawImage(outputToCanvas(output), 0, 0, canvas.width, canvas.height)
  }, [output])

  return (
    <div className="flex h-[72px] items-center justify-center">
      <canvas ref={canvasRef} className="block max-h-full max-w-full" />
    </div>
  )
}
