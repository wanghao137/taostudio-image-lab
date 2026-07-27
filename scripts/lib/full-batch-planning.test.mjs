import { describe, expect, it } from 'vitest'
import {
  buildQaRevisionInstruction,
  classifyQaFailure,
  expandReadyEntries,
  extractRequestedImageCount,
  extractStrictRatio,
  shouldUseSolRevision,
  validateReadyEntry,
} from './full-batch-planning.mjs'

describe('full batch planning', () => {
  it('requires an explicit supported ratio instead of inventing 3:4', () => {
    expect(extractStrictRatio('\u8bf7\u505a\u4e00\u5f20\u7ad6\u7248\u6d77\u62a5')).toBeNull()
    expect(extractStrictRatio('\u6a2a\u7248\u6d77\u62a5')).toBeNull()
    expect(extractStrictRatio('\u753b\u5e45\u6bd4\u4f8b 2\uff1a1')).toBe('2:1')
  })

  it('blocks ready entries whose ratio contract is missing or inconsistent', () => {
    const base = {
      index: 12,
      prompt: 'Create one poster at 2:1.',
      folderName: '012-poster',
      generation: { status: 'ready', ratio: '2:1', dimensions: '3840x1920' },
    }
    expect(validateReadyEntry(base)).toBe(base)
    expect(() => validateReadyEntry({
      ...base,
      generation: { ...base.generation, ratio: null },
    })).toThrow('entry 12 has no explicit supported ratio')
    expect(() => validateReadyEntry({
      ...base,
      generation: { ...base.generation, dimensions: '2400x3200' },
    })).toThrow('entry 12 dimensions 2400x3200 do not match ratio 2:1')
  })

  it('extracts explicit multi-image output counts conservatively', () => {
    expect(extractRequestedImageCount('\u751f\u6210 4 \u5f20\u6d77\u62a5')).toBe(4)
    expect(extractRequestedImageCount('\u521b\u4f5c\u4e09\u5e45\u63d2\u753b')).toBe(3)
    expect(extractRequestedImageCount('\u505a\u4e00\u5f20\u4e3b\u89c6\u89c9')).toBe(1)
    expect(extractRequestedImageCount('\u4e00\u7ec4\u89c6\u89c9\u65b9\u6848')).toBe(1)
  })

  it('expands one manifest entry into independent batch items', () => {
    const entries = expandReadyEntries([{
      index: 7,
      prompt: '\u751f\u6210\u4e09\u5f20\u6d77\u62a5',
      folderName: '007-posters',
      promptStatus: 'exact_prompt_recovered',
      duplicateOf: null,
      generation: { status: 'ready', ratio: '1:1', dimensions: '2880x2880' },
    }])
    expect(entries.map((entry) => entry.itemKey)).toEqual(['7:1', '7:2', '7:3'])
    expect(entries.every((entry) => entry.outputCount === 3)).toBe(true)
  })

  it('builds targeted clipping recovery without adding a frame', () => {
    const qa = { edgeClipping: true, notes: '\u6807\u9898\u9876\u90e8\u88ab\u88c1\u5207' }
    expect(classifyQaFailure(qa)).toEqual({
      failureClass: 'edge_clipping',
      recoveryAction: 'recompose',
    })
    const instruction = buildQaRevisionInstruction(qa)
    expect(instruction).toContain('do not shrink the whole artwork into a framed card')
    expect(instruction).not.toContain('70%')
    expect(shouldUseSolRevision('recompose')).toBe(true)
    expect(shouldUseSolRevision('safe_rewrite')).toBe(true)
    expect(shouldUseSolRevision('route_fallback')).toBe(false)
  })
})
