import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { createPortal } from 'react-dom'
import { Move, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useDialogTrap } from '../../hooks/useDialogTrap'

/**
 * 引擎资产放大预览：原图/4K 双模式切换、滚轮缩放、拖拽平移、双击复位。
 * 从 EngineWorkspace.tsx 提取（拆单体第一步）；使用 useDialogTrap 共享
 * 焦点陷阱 + Esc 栈。
 *
 * 必须通过 portal 渲染到 document.body：审查缩略图挂在带
 * content-visibility:auto 的条目卡片内，而 content-visibility 会计算为
 * contain:paint，让卡片成为 fixed 后代的 containing block —— 不走 portal
 * 的话全屏遮罩会被困在卡片小区域里（已在线上复现）。
 */
export default function EngineAssetLightbox({
  initialMode,
  sourceUrl,
  finalUrl,
  onClose,
}: {
  initialMode: 'source' | 'final'
  sourceUrl: string | null
  finalUrl: string | null
  onClose: () => void
}) {
  const [mode, setMode] = useState<'source' | 'final'>(
    initialMode === 'source' && sourceUrl ? 'source' : 'final',
  )
  const [scale, setScale] = useState(1)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{ pointerId: number; x: number; y: number } | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const src = mode === 'source' ? sourceUrl : finalUrl

  const resetView = useCallback(() => {
    setScale(1)
    setPosition({ x: 0, y: 0 })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === '0') resetView()
      if (event.key === '+' || event.key === '=') setScale((value) => Math.min(4, value + 0.25))
      if (event.key === '-') setScale((value) => Math.max(0.5, value - 0.25))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [resetView])

  const trapRef = useDialogTrap({ active: true, onClose, initialFocusRef: closeButtonRef })

  const selectMode = (nextMode: 'source' | 'final') => {
    setMode(nextMode)
    resetView()
  }

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    setScale((value) => Math.max(0.5, Math.min(4, value + (event.deltaY < 0 ? 0.2 : -0.2))))
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ pointerId: event.pointerId, x: event.clientX, y: event.clientY })
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    setPosition((value) => ({
      x: value.x + event.clientX - drag.x,
      y: value.y + event.clientY - drag.y,
    }))
    setDrag({ pointerId: event.pointerId, x: event.clientX, y: event.clientY })
  }

  return createPortal(
    <div
      ref={trapRef}
      data-engine-lightbox
      className="fixed inset-0 z-[100] flex flex-col bg-black/[0.94] text-white backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="图片放大预览"
    >
      <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-white/15 px-3 sm:px-5">
        <div className="flex items-center gap-1 rounded-md bg-white/10 p-1">
          <button
            type="button"
            onClick={() => selectMode('source')}
            disabled={!sourceUrl}
            className={`h-8 rounded px-3 text-xs font-medium transition disabled:opacity-30 ${mode === 'source' ? 'bg-white text-black' : 'text-white/70 hover:text-white'}`}
          >
            原图
          </button>
          <button
            type="button"
            onClick={() => selectMode('final')}
            disabled={!finalUrl}
            className={`h-8 rounded px-3 text-xs font-medium transition disabled:opacity-30 ${mode === 'final' ? 'bg-white text-black' : 'text-white/70 hover:text-white'}`}
          >
            4K
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setScale((value) => Math.max(0.5, value - 0.25))} className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10" title="缩小" aria-label="缩小">
            <ZoomOut className="h-4 w-4" />
          </button>
          <button type="button" onClick={resetView} className="h-9 min-w-14 rounded-md px-2 font-mono text-xs hover:bg-white/10" title="恢复 100%">
            {Math.round(scale * 100)}%
          </button>
          <button type="button" onClick={() => setScale((value) => Math.min(4, value + 0.25))} className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10" title="放大" aria-label="放大">
            <ZoomIn className="h-4 w-4" />
          </button>
          <span className="mx-1 hidden h-5 w-px bg-white/15 sm:block" />
          <span className="hidden items-center gap-1.5 text-[11px] text-white/45 sm:inline-flex">
            <Move className="h-3.5 w-3.5" />
            拖动查看
          </span>
          <button ref={closeButtonRef} type="button" onClick={onClose} className="ml-1 inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70" title="关闭" aria-label="关闭预览">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div
        className={`relative min-h-0 flex-1 touch-none overflow-hidden ${drag ? 'cursor-grabbing' : 'cursor-grab'}`}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={resetView}
      >
        {src && (
          <img
            src={src}
            alt={mode === 'source' ? '生成原图' : '4K 产物'}
            draggable={false}
            className="absolute left-1/2 top-1/2 max-h-[calc(100%-2rem)] max-w-[calc(100%-2rem)] select-none object-contain shadow-2xl"
            style={{
              transform: `translate(calc(-50% + ${position.x}px), calc(-50% + ${position.y}px)) scale(${scale})`,
              transformOrigin: 'center',
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
