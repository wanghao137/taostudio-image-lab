import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent, RefObject } from 'react'

export interface MobileSheetOptions {
  open: boolean
  onClose: () => void
  enabled?: boolean // 默认 true；false 时 hook 不生效（供测试 / 桌面端短路）
  dismissThreshold?: number // 默认 80（px），下滑超过此值触发 onClose
}

export interface MobileSheetController {
  sheetRef: RefObject<HTMLDivElement | null> // 绑到 sheet 根元素
  dragTranslateY: number // 当前后拉偏移（px），用于 transform
  onDragStart: (e: PointerEvent) => void
  onDragMove: (e: PointerEvent) => void
  onDragEnd: () => void
  keyboardInset: number // visualViewport.height 变化时给底部的让位
}

export function useMobileSheet(
  options: MobileSheetOptions,
): MobileSheetController {
  const { open, onClose, enabled = true, dismissThreshold = 80 } = options
  const sheetRef = useRef<HTMLDivElement>(null)
  const [dragTranslateY, setDragTranslateY] = useState(0)
  const [keyboardInset, setKeyboardInset] = useState(0)
  const dragStartY = useRef<number | null>(null)
  const dragging = useRef(false)
  // 后拉偏移的实时值（同步可读），用于 onDragEnd 判定阈值；
  // 状态版本仅用于渲染 transform，二者始终同步。
  const liveTranslateY = useRef(0)

  // 仅在 open 时生效
  const active = enabled && open

  const onDragStart = useCallback(
    (e: PointerEvent) => {
      if (!active) return
      // 只在抓手/sheet 顶部触发；这里简化为整个 sheet 可拖。
      // 调用方可绑定到抓手元素以限制触发区。
      dragStartY.current = e.clientY
      dragging.current = true
      liveTranslateY.current = 0
      ;(e.target as Element | null)?.setPointerCapture?.(e.pointerId)
    },
    [active],
  )

  const onDragMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current || dragStartY.current === null) return
      const dy = e.clientY - dragStartY.current
      if (dy > 0) {
        liveTranslateY.current = dy // 同步更新阈值判定值
        setDragTranslateY(dy) // 只允许下拉
      }
    },
    [],
  )

  const onDragEnd = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    if (liveTranslateY.current > dismissThreshold) {
      onClose()
    }
    liveTranslateY.current = 0
    setDragTranslateY(0)
    dragStartY.current = null
  }, [dismissThreshold, onClose])

  // 键盘适配：visualViewport 变化时，给底部留出键盘高度
  useEffect(() => {
    if (!active) {
      setKeyboardInset(0)
      return
    }
    const vv = window.visualViewport
    if (!vv) return
    const update = () => {
      const inset = window.innerHeight - vv.height - vv.offsetTop
      setKeyboardInset(inset > 0 ? inset : 0)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
    }
  }, [active])

  return {
    sheetRef,
    dragTranslateY,
    onDragStart,
    onDragMove,
    onDragEnd,
    keyboardInset,
  }
}
