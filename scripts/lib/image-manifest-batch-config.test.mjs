import { describe, expect, it } from 'vitest'
import { resolveImageManifestBatchConfig } from './image-manifest-batch-config.mjs'

const REQUIRED = {
  IMAGE_BATCH_OUTPUT_ROOT: 'C:/batch/output',
  IMAGE_BATCH_MANIFEST_PATH: 'C:/batch/manifest.json',
  IMAGE_BATCH_STATUS_PATH: 'C:/batch/status.json',
}

describe('image manifest batch config', () => {
  it('keeps machine paths and run identity in environment-driven config', () => {
    const config = resolveImageManifestBatchConfig({
      ...REQUIRED,
      IMAGE_BATCH_KEY: 'case library 2026',
      IMAGE_BATCH_NAME: 'Case library',
      IMAGE_BATCH_MIGRATE_INDEXES: '1, 2,invalid,8',
    }, 'C:/repo')

    expect(config.batchKey).toBe('case-library-2026')
    expect(config.batchName).toBe('Case library')
    expect([...config.migrateIndexes]).toEqual([1, 2, 8])
    expect(config.routes).toEqual([
      { name: 'primary', model: 'gpt-image-2', apiMode: 'images' },
      { name: 'fallback', model: 'gpt-5.6-sol', apiMode: 'responses' },
    ])
  })

  it('fails before execution when required machine paths are absent', () => {
    expect(() => resolveImageManifestBatchConfig({}, 'C:/repo'))
      .toThrow('IMAGE_BATCH_OUTPUT_ROOT is required')
  })

  it('rejects unsupported API modes', () => {
    expect(() => resolveImageManifestBatchConfig({
      ...REQUIRED,
      IMAGE_BATCH_PRIMARY_API_MODE: 'chat',
    }, 'C:/repo')).toThrow('IMAGE_BATCH_PRIMARY_API_MODE must be images or responses')
  })
})
