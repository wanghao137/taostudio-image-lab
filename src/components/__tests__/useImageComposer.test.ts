// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useImageComposer } from '../../hooks/useImageComposer'

describe('useImageComposer (seed)', () => {
  it('exposes nLimitHint with visible/show/hide', () => {
    const { result } = renderHook(() => useImageComposer())
    expect(result.current.nLimitHint).toBeDefined()
    expect(typeof result.current.nLimitHint.show).toBe('function')
    expect(typeof result.current.nLimitHint.hide).toBe('function')
    expect(result.current.nLimitHint.visible).toBe(false)
  })

  it('showNLimitHint shows the hint', () => {
    const { result } = renderHook(() => useImageComposer())
    act(() => result.current.showNLimitHint())
    expect(result.current.nLimitHint.visible).toBe(true)
  })

  it('hideNLimitHint hides the hint', () => {
    const { result } = renderHook(() => useImageComposer())
    act(() => result.current.showNLimitHint())
    act(() => result.current.hideNLimitHint())
    expect(result.current.nLimitHint.visible).toBe(false)
  })

  it('clearAgentNHintTouchTimer is a function', () => {
    const { result } = renderHook(() => useImageComposer())
    expect(typeof result.current.clearAgentNHintTouchTimer).toBe('function')
  })
})
