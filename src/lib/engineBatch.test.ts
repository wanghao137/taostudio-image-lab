import { describe, expect, it } from 'vitest'
import {
  countEngineBatchOutputs,
  createEngineBatchRequest,
  parseEngineBatchPrompts,
} from './engineBatch'

describe('Engine UI automated Batch requests', () => {
  it('normalizes prompt lines and counts expanded outputs', () => {
    const prompts = parseEngineBatchPrompts('  Generate 3 poster images  \n\nSingle cover\n')
    expect(prompts).toEqual(['Generate 3 poster images', 'Single cover'])
    expect(countEngineBatchOutputs(prompts)).toBe(4)
  })

  it('creates advisory-QA batch requests with human delivery confirmation by default', () => {
    let sequence = 0
    const request = createEngineBatchRequest({
      name: '  launch set  ',
      prompts: ['Generate 2 poster images', 'Single cover'],
      maxAttempts: 3,
      idFactory: () => `id-${++sequence}`,
      draft: {
        ratio: '1:1',
        model: 'gpt-image-2',
        apiMode: 'images',
        fallbackEnabled: true,
        fallbackModel: 'gpt-5.6-sol',
        fallbackApiMode: 'responses',
        autoRevise: false,
      },
    })

    expect(request).toMatchObject({
      idempotencyKey: 'engine-ui-batch:id-1',
      name: 'launch set',
      automation: {
        enabled: true,
        autoRevise: false,
        maxRevisions: 0,
        revisionRoute: {
          provider: 'configured',
          model: 'gpt-5.6-sol',
          apiMode: 'responses',
        },
      },
      items: [
        {
          itemKey: 'prompt-1',
          copies: 2,
          request: {
            idempotencyKey: 'engine-ui-batch-item:id-2:0',
            generation: {
              provider: 'configured',
              model: 'gpt-image-2',
              apiMode: 'images',
              fallback: {
                provider: 'configured',
                model: 'gpt-5.6-sol',
                apiMode: 'responses',
              },
            },
            output: {
              dimensions: '2880x2880',
              format: 'png',
              quality: 'high',
            },
            retry: { maxAttempts: 3 },
          },
        },
        {
          itemKey: 'prompt-2',
          copies: 1,
          request: { idempotencyKey: 'engine-ui-batch-item:id-3:1' },
        },
      ],
    })
  })
})
