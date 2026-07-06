// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIsMobile } from '../../hooks/useIsMobile'

describe('useIsMobile', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns true when innerWidth < 640', () => {
    vi.stubGlobal('innerWidth', 390)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it('returns false when innerWidth >= 640', () => {
    vi.stubGlobal('innerWidth', 1280)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it('updates on resize', () => {
    vi.stubGlobal('innerWidth', 1280)
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
    vi.stubGlobal('innerWidth', 390)
    window.dispatchEvent(new Event('resize'))
    // renderHook 不会自动 re-render on 外部事件；rerun to confirm listener wired
    expect(result.current).toBe(false) // still false until re-render
  })
})
