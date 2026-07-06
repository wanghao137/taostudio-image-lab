// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStore } from '../../store'
import { useImageComposer } from '../../hooks/useImageComposer'
import { DEFAULT_PARAMS } from '../../types'

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

describe('useImageComposer (core wiring)', () => {
  it('exposes prompt wired to the store', () => {
    useStore.setState({ prompt: 'a scenic mountain' })
    const { result } = renderHook(() => useImageComposer())
    expect(result.current.prompt).toBe('a scenic mountain')
  })

  it('exposes setPrompt that updates the store', () => {
    useStore.setState({ prompt: '' })
    const { result } = renderHook(() => useImageComposer())
    act(() => result.current.setPrompt('hello'))
    expect(useStore.getState().prompt).toBe('hello')
  })

  it('exposes params wired to the store', () => {
    useStore.setState({ params: { ...DEFAULT_PARAMS, n: 3 } })
    const { result } = renderHook(() => useImageComposer())
    expect(result.current.params.n).toBe(3)
  })

  it('exposes setParams that patches the store', () => {
    useStore.setState({ params: { ...DEFAULT_PARAMS } })
    const { result } = renderHook(() => useImageComposer())
    act(() => result.current.setParams({ n: 7 }))
    expect(useStore.getState().params.n).toBe(7)
  })

  it('exposes submitCurrentMode as a function', () => {
    const { result } = renderHook(() => useImageComposer())
    expect(typeof result.current.submitCurrentMode).toBe('function')
  })

  it('exposes handleFiles as a function', () => {
    const { result } = renderHook(() => useImageComposer())
    expect(typeof result.current.handleFiles).toBe('function')
  })

  it('exposes displaySize as a string', () => {
    const { result } = renderHook(() => useImageComposer())
    expect(typeof result.current.displaySize).toBe('string')
  })

  it('exposes outputImageLimit as a number', () => {
    const { result } = renderHook(() => useImageComposer())
    expect(typeof result.current.outputImageLimit).toBe('number')
  })

  it('exposes capability flags as booleans', () => {
    const { result } = renderHook(() => useImageComposer())
    expect(typeof result.current.canSubmit).toBe('boolean')
    expect(typeof result.current.atImageLimit).toBe('boolean')
    expect(typeof result.current.exactSizeEnabled).toBe('boolean')
  })

  it('exposes the commit callbacks as functions', () => {
    const { result } = renderHook(() => useImageComposer())
    expect(typeof result.current.commitN).toBe('function')
    expect(typeof result.current.commitOutputCompression).toBe('function')
  })

  it('exposes the n-limit wrappers as functions', () => {
    const { result } = renderHook(() => useImageComposer())
    expect(typeof result.current.showAgentNHint).toBe('function')
    expect(typeof result.current.startAgentNHintTouch).toBe('function')
    expect(typeof result.current.handleNInputChange).toBe('function')
    expect(typeof result.current.handleNLimitIncreaseAttempt).toBe('function')
  })
})
