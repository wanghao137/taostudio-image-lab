// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { PARAMS_EXPANDED_KEY, readParamsExpanded, writeParamsExpanded } from '../InputBar'

describe('InputBar paramsExpanded localStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns false when no stored value (default collapsed)', () => {
    expect(readParamsExpanded()).toBe(false)
  })

  it('returns true when stored value is true', () => {
    localStorage.setItem(PARAMS_EXPANDED_KEY, 'true')
    expect(readParamsExpanded()).toBe(true)
  })

  it('returns false when stored value is not "true"', () => {
    localStorage.setItem(PARAMS_EXPANDED_KEY, 'false')
    expect(readParamsExpanded()).toBe(false)
    localStorage.setItem(PARAMS_EXPANDED_KEY, 'anything')
    expect(readParamsExpanded()).toBe(false)
  })

  it('writeParamsExpanded persists the value', () => {
    writeParamsExpanded(true)
    expect(localStorage.getItem(PARAMS_EXPANDED_KEY)).toBe('true')
    writeParamsExpanded(false)
    expect(localStorage.getItem(PARAMS_EXPANDED_KEY)).toBe('false')
  })
})
