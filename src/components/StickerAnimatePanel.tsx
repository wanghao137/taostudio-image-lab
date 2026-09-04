import { useEffect, useMemo, useRef, useState } from 'react'
import { zipSync } from 'fflate'
import { useStore } from '../store'
import type { SplitOutput } from '../lib/stickerSplit/engine'
import {
  TimelineRenderer,
  buildTimeline,
  outputToCanvas,
  timelineTotalMs,
  type ComposeSource,
} from '../lib/stickerSplit/animate'
import { encodeApngFromCanvases } from '../lib/stickerSplit/apng'
import { encodeGif } from '../lib/stickerSplit/gifEncode'
import {
  ACTION_FRAME_SIDE,
  ACTION_TEMPLATES,
  generateActionPoseSheet,
  getActionTemplate,
  normalizeCanvasToActionFrame,
  dataUrlToCanvas,
} from '../lib/stickerSplit/actionFrames'

type ExportSize = 512 | 240

/** Skill A 路线节奏：步进关键姿势 起始→预备→峰值→恢复→峰值→预备，每姿势 400ms。 */
const ACTION_POSE_MS = 400

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

/** 动图工作台 —— da-motion-sticker-skill A 路线（Codex 关键姿势）。
 *  每张贴纸一次生成 2×2 姿势表，本地切格组帧；起始帧=原图；步进关键姿势循环。
 *  整层仿射动画按 Skill 禁用，不作为模式或失败回退。 */
export default function StickerAnimatePanel({ outputs, nameBase, showToast }: StickerAnimatePanelProps) {
  const [subjectIndex, setSubjectIndex] = useState(outputs[0]?.index ?? 1)
  const [actionTemplateId, setActionTemplateId] = useState(ACTION_TEMPLATES[0].id)
  const [aiFrameCanvases, setAiFrameCanvases] = useState<HTMLCanvasElement[]>([])
  const [genState, setGenState] = useState<{ running: boolean; error?: string; info?: string }>({ running: false })
  const [batchState, setBatchState] = useState<{ running: boolean; done: number; total: number } | null>(null)
  const [exportSize, setExportSize] = useState<ExportSize>(512)
  const [busy, setBusy] = useState<'gif' | 'apng' | 'batch' | null>(null)

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const sources = useMemo<ComposeSource[]>(
    () => outputs.map((o) => ({ index: o.index, canvas: outputToCanvas(o) })),
    [outputs],
  )

  // 帧源：原图帧（与生成帧同一归一化管线）+ 姿势表三帧（预备/峰值/恢复，index 从 2 起）
  const aiSources = useMemo<ComposeSource[]>(() => {
    const original = sources.find((s) => s.index === subjectIndex)
    if (!original) return []
    try {
      const normalized = normalizeCanvasToActionFrame(original.canvas)
      return [{ index: 1, canvas: normalized }, ...aiFrameCanvases.map((canvas, i) => ({ index: i + 2, canvas }))]
    } catch {
      return []
    }
  }, [sources, subjectIndex, aiFrameCanvases])

  // 切换角色时清空上一个角色的姿势帧，避免新旧混切
  useEffect(() => {
    setAiFrameCanvases([])
    setGenState({ running: false })
  }, [subjectIndex])

  // Skill 步进关键姿势时间线：S→A→P→R→P→A，每姿势 400ms，无溶解、无刚体叠加
  const currentPoses = aiSources.map((s) => s.index)
  const timeline = useMemo(
    () => buildTimeline({ poses: currentPoses, pingPong: true, crossfade: false, poseMs: ACTION_POSE_MS, motionPreset: 'none' }),
    [currentPoses],
  )

  const activeSources = useMemo(
    () => aiSources.filter((s) => currentPoses.includes(s.index)),
    [aiSources, currentPoses],
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
      renderer.render(step, 'none')
      drawChecker(pctx, preview.width, preview.height, 16, isDarkTheme())
      pctx.drawImage(renderer.canvas, 0, 0)
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [activeSources, uniformMaxDim, timeline])

  const collectFrames = (size: number, frames: HTMLCanvasElement[]) => {
    const poses = frames.map((_, i) => i + 1)
    const tl = buildTimeline({ poses, pingPong: true, crossfade: false, poseMs: ACTION_POSE_MS, motionPreset: 'none' })
    const srcs = frames.map((canvas, i) => ({ index: i + 1, canvas }))
    const maxDim = Math.max(1, ...srcs.map((s) => Math.max(s.canvas.width, s.canvas.height)))
    const renderer = new TimelineRenderer(srcs, maxDim, size)
    const out: Array<{ data: Uint8ClampedArray; width: number; height: number; delayMs: number }> = []
    for (const step of tl) {
      renderer.render(step, 'none')
      const ctx = renderer.canvas.getContext('2d')
      if (!ctx) continue
      out.push({ data: ctx.getImageData(0, 0, size, size).data, width: size, height: size, delayMs: step.delayMs })
    }
    return out
  }

  /** 生成 2×2 姿势表（一次调用），帧即时进预览。 */
  const generateFrames = async () => {
    if (genState.running || busy) return
    const template = getActionTemplate(actionTemplateId)
    const sticker = outputs.find((o) => o.index === subjectIndex)
    if (!template || !sticker) return
    const stickerDataUrl = outputToCanvas(sticker).toDataURL('image/png')
    const { settings, params } = useStore.getState()

    setAiFrameCanvases([])
    setGenState({ running: true })
    try {
      const sheet = await generateActionPoseSheet(settings, params, stickerDataUrl, template.motion)
      const canvases = await Promise.all(sheet.poses.map((p) => dataUrlToCanvas(p.dataUrl)))
      setAiFrameCanvases(canvases)
      const notes = [
        `姿势差 ${sheet.motionDifferences.map((d) => d.toFixed(2)).join('/')}`,
        sheet.paletteAutocorrect ? '已色板自愈' : null,
      ].filter(Boolean)
      setGenState({ running: false, info: notes.join(' · ') })
      showToast(`姿势表生成完成（预备/峰值/恢复 3 帧）`, 'success')
    } catch (err) {
      console.error(err)
      setGenState({ running: false, error: err instanceof Error ? err.message : String(err) })
      showToast(`姿势表生成失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const exportGif = async () => {
    if (busy || !aiFrameCanvases.length) return
    setBusy('gif')
    try {
      const frames = [aiSources[0].canvas, ...aiFrameCanvases]
      const blob = encodeGif(collectFrames(exportSize, frames))
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
    if (busy || !aiFrameCanvases.length) return
    setBusy('apng')
    try {
      const frames = [aiSources[0].canvas, ...aiFrameCanvases]
      const poses = frames.map((_, i) => i + 1)
      const tl = buildTimeline({ poses, pingPong: true, crossfade: false, poseMs: ACTION_POSE_MS, motionPreset: 'none' })
      const srcs = frames.map((canvas, i) => ({ index: i + 1, canvas }))
      const maxDim = Math.max(1, ...srcs.map((s) => Math.max(s.canvas.width, s.canvas.height)))
      const renderer = new TimelineRenderer(srcs, maxDim, exportSize)
      const snaps: Array<{ canvas: HTMLCanvasElement; delayMs: number }> = []
      for (const step of tl) {
        renderer.render(step, 'none')
        // 每帧克隆快照，避免复用同一画布导致内容被下一帧覆盖
        const snapshot = document.createElement('canvas')
        snapshot.width = exportSize
        snapshot.height = exportSize
        snapshot.getContext('2d')?.drawImage(renderer.canvas, 0, 0)
        snaps.push({ canvas: snapshot, delayMs: step.delayMs })
      }
      const blob = await encodeApngFromCanvases(snaps)
      triggerDownload(blob, `${nameBase}-anim.png`)
      showToast(`APNG 已导出（${formatKb(blob.size)}）`, 'success')
    } catch (err) {
      console.error(err)
      showToast('APNG 导出失败', 'error')
    } finally {
      setBusy(null)
    }
  }

  /** 批量：整套贴纸逐张生成姿势表并导出 GIF（每张一次生成调用，带进度）。 */
  const exportBatch = async () => {
    if (busy || batchState?.running) return
    const template = getActionTemplate(actionTemplateId)
    if (!template) return
    const { settings, params } = useStore.getState()
    setBusy('batch')
    setBatchState({ running: true, done: 0, total: outputs.length })
    try {
      const files: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}
      let failed = 0
      for (let i = 0; i < outputs.length; i++) {
        const output = outputs[i]
        const stickerDataUrl = outputToCanvas(output).toDataURL('image/png')
        try {
          const sheet = await generateActionPoseSheet(settings, params, stickerDataUrl, template.motion)
          const poseCanvases = await Promise.all(sheet.poses.map((p) => dataUrlToCanvas(p.dataUrl)))
          const original = normalizeCanvasToActionFrame(outputToCanvas(output))
          const blob = encodeGif(collectFrames(exportSize, [original, ...poseCanvases]))
          files[`${nameBase}-${String(i + 1).padStart(2, '0')}-anim.gif`] = [new Uint8Array(await blob.arrayBuffer()), { mtime: new Date() }]
        } catch (err) {
          console.error(`批量第 ${i + 1} 张失败`, err)
          failed++
        }
        setBatchState({ running: true, done: i + 1, total: outputs.length })
      }
      if (Object.keys(files).length > 0) {
        const zipped = zipSync(files, { level: 6 })
        const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
        triggerDownload(new Blob([buffer], { type: 'application/zip' }), `${nameBase}-anim.zip`)
      }
      const okCount = Object.keys(files).length
      showToast(
        failed ? `批量完成：成功 ${okCount} 张，失败 ${failed} 张（已跳过）` : `已批量导出 ${okCount} 个动作 GIF（${template.label}）`,
        failed ? 'info' : 'success',
      )
    } catch (err) {
      console.error(err)
      showToast('批量导出失败', 'error')
    } finally {
      setBusy(null)
      setBatchState(null)
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
          {(busy || genState.running) && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/50 backdrop-blur-[1px] dark:bg-black/40">
              <div className="flex items-center gap-2 rounded-full bg-white/90 px-4 py-2 text-xs font-medium text-gray-700 shadow-lg dark:bg-black/70 dark:text-gray-200">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-white/20 dark:border-t-blue-400" />
                {busy === 'batch' && batchState ? `批量生成中 ${batchState.done}/${batchState.total}…` : busy ? '编码中…' : '生成姿势表…'}
              </div>
            </div>
          )}
        </div>

        <div className="max-h-[46%] shrink-0 space-y-3 overflow-y-auto overscroll-contain border-t border-gray-200/80 px-4 py-3 dark:border-white/[0.06]">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-gray-200 dark:border-white/10">
              {ACTION_TEMPLATES.map((t) => (
                <button key={t.id} type="button" className={segBtn(actionTemplateId === t.id)} onClick={() => setActionTemplateId(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={genState.running || busy !== null}
              onClick={() => void generateFrames()}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-xl bg-blue-500 px-4 py-2 text-xs font-semibold text-white shadow-md transition hover:bg-blue-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {genState.running ? '生成中…' : aiFrameCanvases.length ? '重新生成' : '生成姿势表'}
            </button>
            {genState.error && <span className="text-xs text-red-500">{genState.error}</span>}
            {genState.info && <span className="text-[11px] text-gray-400 dark:text-gray-500">{genState.info}</span>}
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-gray-500 dark:text-gray-400">
            <label className="flex items-center gap-2">
              <span>导出尺寸</span>
              <select
                value={exportSize}
                onChange={(e) => setExportSize(Number(e.target.value) === 240 ? 240 : 512)}
                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs dark:border-white/10 dark:bg-gray-800"
              >
                <option value={512}>512</option>
                <option value={240}>240（微信）</option>
              </select>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!aiFrameCanvases.length || busy !== null}
                onClick={() => void exportGif()}
                className="rounded-xl bg-gray-900 px-3.5 py-1.5 text-xs font-semibold text-white shadow transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
              >
                导出 GIF
              </button>
              <button
                type="button"
                disabled={!aiFrameCanvases.length || busy !== null}
                onClick={() => void exportApng()}
                className="rounded-xl border border-gray-300 px-3.5 py-1.5 text-xs font-medium text-gray-600 transition hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:text-gray-300 dark:hover:border-white/30"
              >
                导出 APNG
              </button>
              <button
                type="button"
                disabled={busy !== null || genState.running}
                onClick={() => void exportBatch()}
                className="rounded-xl border border-gray-300 px-3.5 py-1.5 text-xs font-medium text-gray-600 transition hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:text-gray-300 dark:hover:border-white/30"
              >
                批量整套（{outputs.length} 张）
              </button>
            </div>
            <span className="font-mono">
              {frameCount} 帧 · {(totalMs / 1000).toFixed(1)}s
            </span>
          </div>

          <p className="text-[11px] leading-relaxed text-gray-400 dark:text-gray-500">
            关键姿势路线：每张贴纸一次生成 2×2 姿势表（预备/峰值/恢复），首帧用原图，按 起始→预备→峰值→恢复→峰值→预备 步进循环（每姿势 {ACTION_POSE_MS}ms）。
            GIF 适配微信（1-bit 透明）；APNG 保留完整半透明。批量 = 每张一次生成调用（约 1~2 分钟/张），失败张自动跳过。
          </p>
        </div>
      </div>

      {/* 右：角色选择 + 姿势帧条 */}
      <div className="flex w-full shrink-0 flex-col border-t border-gray-200/80 md:w-56 md:border-l md:border-t-0 dark:border-white/[0.06]">
        <p className="px-3 pt-3 text-[11px] font-medium text-gray-500 dark:text-gray-400">角色</p>
        <div className="grid min-h-0 flex-1 grid-cols-3 content-start gap-2 overflow-y-auto p-3">
          {outputs.map((o) => (
            <button
              key={o.index}
              type="button"
              onClick={() => setSubjectIndex(o.index)}
              className={`group relative overflow-hidden rounded-lg border-2 transition ${
                o.index === subjectIndex ? 'border-blue-500 shadow-md' : 'border-transparent hover:border-gray-300 dark:hover:border-white/20'
              }`}
              title={`#${String(o.index).padStart(2, '0')}`}
            >
              <Thumb output={o} />
              <span className="absolute bottom-0.5 left-1 rounded bg-black/45 px-1 text-[9px] font-medium text-white">
                {String(o.index).padStart(2, '0')}
              </span>
            </button>
          ))}
        </div>
        {aiFrameCanvases.length > 0 && (
          <div className="border-t border-gray-200/80 p-3 dark:border-white/[0.06]">
            <p className="mb-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">关键姿势（原图 + 生成 3 帧）</p>
            <div className="flex gap-2">
              {[aiSources[0], ...aiFrameCanvases.map((canvas, i) => ({ index: i + 2, canvas }))].map((src, i) => (
                <div key={src.index} className="relative flex-1 overflow-hidden rounded-lg ring-1 ring-gray-200/70 dark:ring-white/[0.06]">
                  <canvas
                    className="block w-full"
                    ref={(el) => {
                      if (!el) return
                      el.width = ACTION_FRAME_SIDE
                      el.height = ACTION_FRAME_SIDE
                      el.getContext('2d')?.drawImage(src.canvas, 0, 0)
                    }}
                  />
                  <span className="absolute bottom-0.5 left-1 rounded bg-black/45 px-1 text-[9px] font-medium text-white">
                    {['原图', '预备', '峰值', '恢复'][i] ?? i}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Thumb({ output }: { output: SplitOutput }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.width = output.w
    el.height = output.h
    el.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(output.data), output.w, output.h), 0, 0)
  }, [output])
  return <canvas ref={ref} className="block w-full" />
}
