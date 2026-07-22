import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS, type StoredImage, type TaskRecord } from '../types'
import {
  buildLocalAutoSaveFolderName,
  buildLocalAutoSaveMetadata,
  buildLocalAutoSavePromptText,
  getLocalAutoSaveEligibility,
  isConfirmed4kSize,
  isLocalAutoSaveSupported,
} from './localAutoSave'
import { formatExportFileTime } from './exportFileName'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-gallery-4k',
    prompt: '城市夜晚人像 / cinematic <test> prompt',
    params: {
      ...DEFAULT_PARAMS,
      size: '2160x3840',
      exact_size: true,
      quality: 'high',
      output_format: 'png',
    },
    apiProvider: 'openai',
    apiProfileName: '默认',
    apiModel: 'gpt-image-2',
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: ['image-a'],
    status: 'done',
    error: null,
    createdAt: Date.UTC(2026, 6, 7, 13, 35, 12),
    finishedAt: Date.UTC(2026, 6, 7, 13, 36, 12),
    elapsed: 60000,
    ...overrides,
  }
}

function image(overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id: 'image-a',
    dataUrl: 'data:image/png;base64,AAAA',
    source: 'generated',
    width: 2160,
    height: 3840,
    createdAt: Date.UTC(2026, 6, 7, 13, 36, 0),
    ...overrides,
  }
}

describe('local auto-save pure helpers', () => {
  it('detects support only for desktop Chrome and Edge with File System Access API support', () => {
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
    const chromium = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/126.0.0.0 Safari/537.36'
    const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0'
    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
    const androidChrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'

    expect(isLocalAutoSaveSupported({ showDirectoryPicker: () => null, navigator: { userAgent: chrome } })).toBe(true)
    expect(isLocalAutoSaveSupported({ showDirectoryPicker: () => null, navigator: { userAgent: edge } })).toBe(true)
    expect(isLocalAutoSaveSupported({ showDirectoryPicker: () => null, navigator: { userAgent: chromium } })).toBe(false)
    expect(isLocalAutoSaveSupported({ showDirectoryPicker: () => null, navigator: { userAgent: firefox } })).toBe(false)
    expect(isLocalAutoSaveSupported({ showDirectoryPicker: () => null, navigator: { userAgent: safari } })).toBe(false)
    expect(isLocalAutoSaveSupported({ showDirectoryPicker: () => null, navigator: { userAgent: androidChrome } })).toBe(false)
    expect(isLocalAutoSaveSupported({ showDirectoryPicker: () => null, navigator: { userAgent: chrome, userAgentData: { mobile: true } } })).toBe(false)
    expect(isLocalAutoSaveSupported({ navigator: { userAgent: chrome } })).toBe(false)
  })

  it('prefers userAgentData brands when identifying desktop Chrome and Edge', () => {
    const genericDesktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36'
    const chromeShell = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

    expect(isLocalAutoSaveSupported({
      showDirectoryPicker: () => null,
      navigator: {
        userAgent: genericDesktop,
        userAgentData: {
          mobile: false,
          brands: [
            { brand: 'Chromium', version: '126' },
            { brand: 'Google Chrome', version: '126' },
          ],
        },
      },
    })).toBe(true)
    expect(isLocalAutoSaveSupported({
      showDirectoryPicker: () => null,
      navigator: {
        userAgent: genericDesktop,
        userAgentData: {
          mobile: false,
          brands: [
            { brand: 'Chromium', version: '126' },
            { brand: 'Microsoft Edge', version: '126' },
          ],
        },
      },
    })).toBe(true)
    expect(isLocalAutoSaveSupported({
      showDirectoryPicker: () => null,
      navigator: {
        userAgent: chromeShell,
        userAgentData: {
          mobile: false,
          brands: [{ brand: 'Chromium', version: '126' }],
        },
      },
    })).toBe(false)
  })

  it('requires exact-size 4K intent and actual 4K dimensions', () => {
    expect(getLocalAutoSaveEligibility(task(), [image()])).toEqual({ eligible: true })
    expect(getLocalAutoSaveEligibility(task({ params: { ...DEFAULT_PARAMS, size: '2880x2880', exact_size: true } }), [
      image({ width: 2880, height: 2880 }),
    ])).toEqual({ eligible: true })
    expect(getLocalAutoSaveEligibility(task({ params: { ...DEFAULT_PARAMS, size: '1024x1024', exact_size: true } }), [image()])).toEqual({
      eligible: false,
      status: 'not_applicable',
      reason: 'not_4k_intent',
    })
    expect(getLocalAutoSaveEligibility(task(), [image({ width: 1024, height: 1024 })])).toEqual({
      eligible: false,
      status: 'not_applicable',
      reason: 'not_4k_actual',
    })
  })

  it('excludes partial-success tasks with failed output slots', () => {
    expect(getLocalAutoSaveEligibility(task({
      outputErrors: [{ requestIndex: 1, error: 'rate limit' }],
    }), [image()])).toEqual({
      eligible: false,
      status: 'not_applicable',
      reason: 'partial_failure',
    })
  })

  it('requires supplied images to match task outputs by id and order', () => {
    const multiOutputTask = task({ outputImages: ['image-a', 'image-b'] })

    expect(getLocalAutoSaveEligibility(multiOutputTask, [
      image({ id: 'image-a' }),
      image({ id: 'image-b' }),
    ])).toEqual({ eligible: true })
    expect(getLocalAutoSaveEligibility(multiOutputTask, [
      image({ id: 'image-b' }),
      image({ id: 'image-a' }),
    ])).toEqual({ eligible: false, status: 'failed', reason: 'missing_image' })
    expect(getLocalAutoSaveEligibility(multiOutputTask, [
      image({ id: 'image-a' }),
      image({ id: 'image-c' }),
    ])).toEqual({ eligible: false, status: 'failed', reason: 'missing_image' })
  })

  it('excludes Agent tasks from the first version', () => {
    expect(getLocalAutoSaveEligibility(task({ sourceMode: 'agent' }), [image()])).toEqual({
      eligible: false,
      status: 'not_applicable',
      reason: 'agent_task',
    })
    expect(getLocalAutoSaveEligibility(task({ agentConversationId: 'conversation-legacy' }), [image()])).toEqual({
      eligible: false,
      status: 'not_applicable',
      reason: 'agent_task',
    })
    expect(getLocalAutoSaveEligibility(task({ agentRoundId: 'round-legacy' }), [image()])).toEqual({
      eligible: false,
      status: 'not_applicable',
      reason: 'agent_task',
    })
  })

  it('formats safe folder names with duplicate suffixes', () => {
    const folder = buildLocalAutoSaveFolderName(task(), { width: 2160, height: 3840 }, new Set())
    const expectedBase = `${formatExportFileTime(new Date(task().createdAt))}_2160x3840_城市夜晚人像-cinematic`
    expect(folder).toBe(expectedBase)

    const duplicate = buildLocalAutoSaveFolderName(task(), { width: 2160, height: 3840 }, new Set([folder]))
    expect(duplicate).toBe(`${expectedBase}-2`)
  })

  it('trims trailing punctuation and spaces from prompt prefixes', () => {
    const baseTask = task({ prompt: '  城市夜晚人像。!!!   ' })

    expect(buildLocalAutoSaveFolderName(baseTask, { width: 2160, height: 3840 }, new Set()))
      .toBe(`${formatExportFileTime(new Date(baseTask.createdAt))}_2160x3840_城市夜晚人像`)
  })

  it('formats folder timestamps without UTC component conversion', () => {
    const originalGetUTCFullYear = Date.prototype.getUTCFullYear
    Date.prototype.getUTCFullYear = () => {
      throw new Error('folder timestamp should use local export formatting')
    }

    try {
      const folder = buildLocalAutoSaveFolderName(task(), { width: 2160, height: 3840 }, new Set())
      expect(folder.startsWith(`${formatExportFileTime(new Date(task().createdAt))}_2160x3840_`)).toBe(true)
    } finally {
      Date.prototype.getUTCFullYear = originalGetUTCFullYear
    }
  })

  it('builds prompt text and metadata without credentials', () => {
    const promptText = buildLocalAutoSavePromptText(task(), { width: 2160, height: 3840 })
    expect(promptText).toContain('提示词：')
    expect(promptText).toContain('城市夜晚人像')
    expect(promptText).toContain('尺寸：2160x3840')

    const metadata = buildLocalAutoSaveMetadata(task(), [{ image: image(), fileName: 'image-1.png' }])
    expect(metadata.api).toEqual({ provider: 'openai', profileName: '默认', model: 'gpt-image-2' })
    expect(JSON.stringify(metadata)).not.toContain('apiKey')
    expect(JSON.stringify(metadata)).not.toContain('bearer')
  })

  it('accepts the app 4K preset sizes', () => {
    expect(isConfirmed4kSize({ width: 2880, height: 2880 })).toBe(true)
    expect(isConfirmed4kSize({ width: 3456, height: 2304 })).toBe(true)
    expect(isConfirmed4kSize({ width: 2304, height: 3456 })).toBe(true)
    expect(isConfirmed4kSize({ width: 3840, height: 2160 })).toBe(true)
    expect(isConfirmed4kSize({ width: 2160, height: 3840 })).toBe(true)
    expect(isConfirmed4kSize({ width: 3200, height: 2400 })).toBe(true)
    expect(isConfirmed4kSize({ width: 2400, height: 3200 })).toBe(true)
    expect(isConfirmed4kSize({ width: 3840, height: 1646 })).toBe(true)
    expect(isConfirmed4kSize({ width: 3840, height: 1600 })).toBe(false)
    expect(isConfirmed4kSize({ width: 2048, height: 4096 })).toBe(false)
  })
})
