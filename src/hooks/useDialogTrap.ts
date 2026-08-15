import { useEffect, useRef } from 'react'
import { useCloseOnEscape } from './useCloseOnEscape'

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 模态对话框共享原语：焦点陷阱（Tab 循环）+ 初始聚焦 + Esc 关闭。
 * 两套放大器（画廊 Lightbox / 引擎资产 Lightbox）此前各写一份（只有引擎版有
 * 焦点陷阱）——现在统一从这里取；普通模态（DetailModal 等）仍直接用
 * useCloseOnEscape。
 *
 * Esc 走 useCloseOnEscape 的全局栈（一次只关最顶层），避免叠层模态一次 Esc
 * 关两层；这里只补充 Tab 循环与初始聚焦。
 *
 * 返回应挂到对话框根元素的 ref。
 */
export function useDialogTrap(options: {
  active: boolean
  onClose: () => void
  /** 初始聚焦的子元素 ref；不传则聚焦第一个可聚焦项 */
  initialFocusRef?: React.RefObject<HTMLElement | null>
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const { active, onClose, initialFocusRef } = options

  useCloseOnEscape(active, onClose)

  useEffect(() => {
    if (!active) return
    const dialog = dialogRef.current
    if (!dialog) return

    // 初始聚焦
    const initial = initialFocusRef?.current
      ?? dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
    initial?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusables = dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const activeEl = document.activeElement as HTMLElement | null
      if (event.shiftKey && (activeEl === first || !dialog.contains(activeEl))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [active, initialFocusRef])

  return dialogRef
}

/** 对话框根元素的标准 a11y 属性（配合 useDialogTrap 的 ref 使用）。 */
export const dialogA11yProps = (label: string) => ({
  role: 'dialog' as const,
  'aria-modal': true as const,
  'aria-label': label,
})
