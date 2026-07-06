// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMobileSheet } from '../../hooks/useMobileSheet'

describe('useMobileSheet', () => {
  it('returns zero translate when closed', () => {
    const { result } = renderHook(() =>
      useMobileSheet({ open: false, onClose: () => {} }),
    )
    expect(result.current.dragTranslateY).toBe(0)
  })

  it('calls onClose when drag exceeds threshold', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() =>
      useMobileSheet({ open: true, onClose }),
    )
    // 模拟下拉 120px（>默认阈值 80）
    act(() => {
      result.current.onDragStart({ clientY: 100, pointerId: 1 } as any)
      result.current.onDragMove({ clientY: 220, pointerId: 1 } as any)
      result.current.onDragEnd()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when drag below threshold', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() =>
      useMobileSheet({ open: true, onClose }),
    )
    act(() => {
      result.current.onDragStart({ clientY: 100, pointerId: 1 } as any)
      result.current.onDragMove({ clientY: 140, pointerId: 1 } as any) // 只拉了 40
      result.current.onDragEnd()
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('is inert when enabled=false', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() =>
      useMobileSheet({ open: true, onClose, enabled: false }),
    )
    act(() => {
      result.current.onDragStart({ clientY: 100, pointerId: 1 } as any)
      result.current.onDragMove({ clientY: 500, pointerId: 1 } as any)
      result.current.onDragEnd()
    })
    expect(onClose).not.toHaveBeenCalled()
  })
})
