import { describe, expect, it } from 'vitest'
import {
  buildQaRevisionPrompt,
  classifyQaVerdict,
  expandBatchRequest,
  validateBatchAutomation,
} from './batch-automation.mjs'

function item(prompt, copies) {
  return {
    itemKey: 'poster',
    ...(copies === undefined ? {} : { copies }),
    request: {
      idempotencyKey: 'batch-output-source-001',
      input: { prompt },
    },
  }
}

describe('batch automation planning', () => {
  it('expands explicit multi-output prompts into independent jobs', () => {
    const expanded = expandBatchRequest({
      idempotencyKey: 'batch-expand-001',
      items: [item('生成 3 张海报')],
    })
    expect(expanded.items).toHaveLength(3)
    expect(expanded.items.map((entry) => entry.itemKey)).toEqual(['poster:1', 'poster:2', 'poster:3'])
    expect(new Set(expanded.items.map((entry) => entry.request.idempotencyKey)).size).toBe(3)
    expect(expanded.items[0]).toMatchObject({
      sourceItemKey: 'poster',
      outputIndex: 1,
      outputCount: 3,
    })
    expect(expanded.items[0].request.input.prompt).toContain('Generate only standalone output 1 of 3')
    expect(expanded.items[0].request.input.prompt).toContain('not a contact sheet')
  })

  it('lets an explicit copies value override prompt inference', () => {
    const expanded = expandBatchRequest({
      idempotencyKey: 'batch-expand-002',
      items: [item('生成 4 张海报', 2)],
    })
    expect(expanded.items).toHaveLength(2)
  })

  it('requires a Responses revision route for automatic QA and recovery', () => {
    expect(validateBatchAutomation({
      enabled: true,
      maxRevisions: 2,
      revisionRoute: { provider: 'configured', model: 'gpt-5.6-sol', apiMode: 'responses' },
    })).toEqual([])
    expect(validateBatchAutomation({
      enabled: true,
      revisionRoute: { provider: 'configured', model: 'gpt-5.6-sol', apiMode: 'images' },
    })).toContain('automation.revisionRoute.apiMode must be responses')
  })

  it('builds focused QA revisions without introducing gray framing', () => {
    const verdict = { edgeClipping: true, notes: 'title clipped' }
    expect(classifyQaVerdict(verdict)).toEqual({
      failureClass: 'edge_clipping',
      recoveryAction: 'recompose',
    })
    const prompt = buildQaRevisionPrompt('Original full-bleed poster', verdict)
    expect(prompt).toContain('Keep a requested full-bleed background full-bleed')
    expect(prompt).not.toContain('70%')
  })
})
