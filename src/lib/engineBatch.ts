import { extractRequestedImageCount } from '../../packages/image-job-core/index.mjs'
import { calculateImageSize } from './size'
import {
  createImageTaskGeneration,
  type ImageBatchCreateRequestV1,
} from './imageTaskApi'

export interface EngineBatchGenerationDraft {
  ratio: string
  model: string
  apiMode: 'images' | 'responses'
  fallbackEnabled: boolean
  fallbackModel: string
  fallbackApiMode: 'images' | 'responses'
}

export function parseEngineBatchPrompts(value: string) {
  return value.split(/\r?\n/).map((prompt) => prompt.trim()).filter(Boolean)
}

export function countEngineBatchOutputs(prompts: string[]) {
  return prompts.reduce((total, prompt) => total + extractRequestedImageCount(prompt), 0)
}

export function createEngineBatchRequest(options: {
  name: string
  prompts: string[]
  draft: EngineBatchGenerationDraft
  maxAttempts: number
  idFactory?: () => string
}): ImageBatchCreateRequestV1 {
  const { name, prompts, draft, maxAttempts } = options
  const idFactory = options.idFactory || (() => crypto.randomUUID())
  return {
    idempotencyKey: `engine-ui-batch:${idFactory()}`,
    ...(name.trim() ? { name: name.trim() } : {}),
    automation: {
      enabled: true,
      maxRevisions: 2,
      revisionRoute: {
        provider: 'configured',
        model: draft.fallbackModel.trim(),
        apiMode: 'responses',
      },
    },
    items: prompts.map((prompt, index) => ({
      itemKey: `prompt-${index + 1}`,
      copies: extractRequestedImageCount(prompt),
      request: {
        contractVersion: '1',
        idempotencyKey: `engine-ui-batch-item:${idFactory()}:${index}`,
        input: { prompt },
        composition: { ratio: draft.ratio },
        generation: createImageTaskGeneration({
          provider: 'configured',
          model: draft.model.trim(),
          apiMode: draft.apiMode,
          ...(draft.fallbackEnabled && draft.fallbackModel.trim() ? {
            fallback: {
              provider: 'configured',
              model: draft.fallbackModel.trim(),
              apiMode: draft.fallbackApiMode,
            },
          } : {}),
        }),
        output: {
          ratioMode: 'inherit',
          format: 'png',
          quality: 'high',
          dimensions: calculateImageSize('4K', draft.ratio) || undefined,
          enhancement: 'lanczos3',
          contentClass: 'photo',
        },
        retry: { maxAttempts },
      },
    })),
  }
}
