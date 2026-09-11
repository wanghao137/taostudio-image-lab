import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_SETTINGS, getCustomProviderDefinition, getSceneImageApiProfile, normalizeSettings, switchApiProfileProvider } from './lib/apiProfiles'
import type { AgentConversation, AppSettings, ExportData, SkillSummary, StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
import { hasActiveDataOperations } from './lib/dataOperations'
import { normalizePersistedState } from './lib/persistedState'
import { setPresetConfig } from './lib/presetConfig'
import { migratePersistedState } from './lib/persistedState'
vi.mock('./lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  const agentConversations = new Map<string, AgentConversation>()
  let localAutoSaveDirectoryHandle: {
    id: string
    handle: FileSystemDirectoryHandle
    name?: string
    updatedAt: number
  } | undefined
  let engineDeliveryDirectoryHandle: {
    id: string
    handle: FileSystemDirectoryHandle
    name?: string
    updatedAt: number
  } | undefined
  const sceneDirectoryHandles = new Map<string, {
    id: string
    handle: FileSystemDirectoryHandle
    name?: string
    updatedAt: number
  }>()
  let imageSeq = 0
  let taskGeneration = 0

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: vi.fn(async (task: TaskRecord, expectedGeneration?: number) => {
      if (expectedGeneration !== undefined && expectedGeneration !== taskGeneration) return task.id
      tasks.set(task.id, task)
      return task.id
    }),
    getTaskGeneration: async () => taskGeneration,
    clearTasksAndAdvanceGeneration: vi.fn(async () => {
      taskGeneration += 1
      tasks.clear()
      return taskGeneration
    }),
    deleteTask: vi.fn(async (id: string, expectedGeneration?: number) => {
      if (expectedGeneration !== undefined && expectedGeneration !== taskGeneration) return
      tasks.delete(id)
    }),
    commitTaskDeletion: vi.fn(async (deletedTaskIds: string[], updatedTasks: TaskRecord[], updatedConversations: AgentConversation[], expectedGeneration?: number) => {
      if (expectedGeneration !== undefined && expectedGeneration !== taskGeneration) return
      for (const id of deletedTaskIds) tasks.delete(id)
      for (const task of updatedTasks) tasks.set(task.id, task)
      for (const conversation of updatedConversations) agentConversations.set(conversation.id, conversation)
    }),
    clearTasks: vi.fn(async () => {
      tasks.clear()
    }),
    getAllAgentConversations: async () => [...agentConversations.values()],
    putAgentConversation: async (conversation: AgentConversation, expectedGeneration?: number) => {
      if (expectedGeneration !== undefined && expectedGeneration !== taskGeneration) return conversation.id
      agentConversations.set(conversation.id, conversation)
      return conversation.id
    },
    deleteAgentConversation: async (id: string) => {
      agentConversations.delete(id)
    },
    clearAgentConversations: vi.fn(async (expectedGeneration?: number) => {
      if (expectedGeneration !== undefined && expectedGeneration !== taskGeneration) return
      agentConversations.clear()
    }),
    replaceAgentConversations: async (conversations: AgentConversation[], expectedGeneration?: number) => {
      if (expectedGeneration !== undefined && expectedGeneration !== taskGeneration) return
      agentConversations.clear()
      for (const conversation of conversations) agentConversations.set(conversation.id, conversation)
    },
    getLocalAutoSaveDirectoryHandle: async () => localAutoSaveDirectoryHandle,
    putLocalAutoSaveDirectoryHandle: async (handle: FileSystemDirectoryHandle) => {
      localAutoSaveDirectoryHandle = {
        id: 'directory',
        handle,
        name: handle.name,
        updatedAt: Date.now(),
      }
      return 'directory'
    },
    clearLocalAutoSaveDirectoryHandle: async () => {
      localAutoSaveDirectoryHandle = undefined
    },
    getEngineDeliveryDirectoryHandle: async () => engineDeliveryDirectoryHandle,
    putEngineDeliveryDirectoryHandle: async (handle: FileSystemDirectoryHandle) => {
      engineDeliveryDirectoryHandle = {
        id: 'engineDeliveryDirectory',
        handle,
        name: handle.name,
        updatedAt: Date.now(),
      }
      return 'engineDeliveryDirectory'
    },
    clearEngineDeliveryDirectoryHandle: async () => {
      engineDeliveryDirectoryHandle = undefined
    },
    SCENE_DIRECTORY_KEY_PREFIX: 'sceneDirectory:',
    getSceneDirectoryHandle: vi.fn(async (sceneId: string) => sceneDirectoryHandles.get(sceneId)),
    putSceneDirectoryHandle: vi.fn(async (sceneId: string, handle: FileSystemDirectoryHandle) => {
      const record = {
        id: `sceneDirectory:${sceneId}`,
        handle,
        name: handle.name,
        updatedAt: Date.now(),
      }
      sceneDirectoryHandles.set(sceneId, record)
      return record.id
    }),
    clearSceneDirectoryHandle: vi.fn(async (sceneId: string) => {
      sceneDirectoryHandles.delete(sceneId)
    }),
    listSceneDirectoryHandles: vi.fn(async () => [...sceneDirectoryHandles.values()]),
    SKILLS_ROOT_DIRECTORY_KEY: 'skillsDirectory',
    getSkillsRootDirectoryHandle: vi.fn(async () => undefined),
    putSkillsRootDirectoryHandle: vi.fn(async () => undefined),
    clearSkillsRootDirectoryHandle: vi.fn(async () => undefined),
    getImage: async (id: string) => images.get(id),
    getStoredImageThumbnail: async (id: string) => thumbnails.get(id),
    getImageThumbnail: async (id: string) => thumbnails.get(id),
    getStoredFreshImageThumbnail: async (id: string) => thumbnails.get(id),
    getAllImageIds: async () => [...images.keys()],
    getAllImages: async () => [...images.values()],
    putImage: async (image: StoredImage) => {
      images.set(image.id, image)
      return image.id
    },
    putImageThumbnail: async (thumbnail: StoredImageThumbnail) => {
      thumbnails.set(thumbnail.id, thumbnail)
      return thumbnail.id
    },
    deleteImage: vi.fn(async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    }),
    clearImages: vi.fn(async () => {
      images.clear()
      thumbnails.clear()
    }),
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
    storeImageWithSize: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      const size = dataUrl.match(/(\d+)x(\d+)/)
      const width = size ? Number(size[1]) : undefined
      const height = size ? Number(size[2]) : undefined
      images.set(id, { id, dataUrl, source, createdAt: Date.now(), width, height })
      return { id, width, height }
    },
    StorageQuotaError: class StorageQuotaError extends Error {
      imageId: string
      width?: number
      height?: number
      constructor(options: { imageId: string; width?: number; height?: number }) {
        super('浏览器存储空间不足，图片未能持久化。')
        this.name = 'StorageQuotaError'
        this.imageId = options.imageId
        this.width = options.width
        this.height = options.height
      }
    },
    isQuotaExceededError: (error: unknown) => {
      return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'QuotaExceededError')
    },
    estimateStorage: async () => null,
    migrateImagesToBlobs: async () => ({ migrated: 0, skipped: 0 }),
    getImageMetadata: async (id: string) => images.get(id) as { createdAt?: number } | undefined,
    getImageRecord: async (id: string) => images.get(id),
  }
})
vi.mock('./lib/skillWorkshop/skillExpansionApi', () => ({
  callSkillExpansionApi: vi.fn(async () => '### 01\n默认扩写条目文本内容\n\n### 02\n第二条扩写条目文本内容'),
}))
vi.mock('./lib/localAutoSaveWriter', () => ({
  LocalAutoSavePermissionError: class LocalAutoSavePermissionError extends Error {
    constructor() {
      super('需要重新授权保存位置')
      this.name = 'LocalAutoSavePermissionError'
    }
  },
  writeLocalAutoSaveArchive: vi.fn(async (params: { folderName: string; files: Array<{ name: string }> }) => ({
    folderName: params.folderName,
    files: params.files.map((file) => file.name),
  })),
}))
vi.mock('./lib/api', () => ({
  callImageApi: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
  })),
}))
vi.mock('./lib/falAiImageApi', () => ({
  getFalErrorMessage: vi.fn((err: unknown) => err instanceof Error ? err.message : String(err)),
  getFalQueuedImageResult: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
  })),
}))
vi.mock('./lib/openaiCompatibleImageApi', () => ({
  // store.ts 仅从该模块导入恢复轮询入口；请求侧经被 mock 的 ./lib/api 走，
  // 此处 mock 让「自定义异步恢复链」在测试中可观测且不发真实请求。
  getCustomQueuedImageResult: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
  })),
}))
vi.mock('./lib/transparentImage', () => ({
  GREEN_KEY_COLOR: '#00FF00',
  MAGENTA_KEY_COLOR: '#FF00FF',
  createTransparentOutputMeta: vi.fn((prompt: string) => ({
    transparentOutput: true,
    effectivePrompt: `transparent:${prompt}`,
  })),
  getTransparentRequestParams: vi.fn((params: typeof DEFAULT_PARAMS) => ({
    ...params,
    output_format: params.output_format === 'webp' ? 'webp' : 'png',
    output_compression: params.output_format === 'webp' ? params.output_compression : null,
    transparent_output: true,
  })),
  buildNativeTransparentPrompt: vi.fn((prompt: string) => `${prompt}\n\n背景必须完全透明`),
  removeKeyedBackgroundFromDataUrl: vi.fn(async (dataUrl: string) => `transparent:${dataUrl}`),
}))
vi.mock('./lib/exactImageSize', () => ({
  getExactImageSizeTarget: vi.fn((params: { size: string; exact_size: boolean }) => {
    if (!params.exact_size || params.size === 'auto') return null
    const match = params.size.match(/^(\d+)x(\d+)$/)
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null
  }),
  resizeImageDataUrlToExactSize: vi.fn(async (
    dataUrl: string,
    target: { width: number; height: number },
    _outputFormat: string,
    fitMode = 'cover',
  ) => {
    const sourceMatch = dataUrl.match(/(\d+)x(\d+)/)
    const rawSourceWidth = sourceMatch ? Number(sourceMatch[1]) : 1024
    const rawSourceHeight = sourceMatch ? Number(sourceMatch[2]) : 1024
    if (rawSourceWidth === target.width && rawSourceHeight === target.height) {
      return {
        dataUrl,
        sourceDataUrl: dataUrl,
        width: rawSourceWidth,
        height: rawSourceHeight,
        sourceWidth: rawSourceWidth,
        sourceHeight: rawSourceHeight,
        rawSourceWidth,
        rawSourceHeight,
        sourceNormalized: false,
        resized: false,
      }
    }
    const ratioMatches = rawSourceWidth * target.height === target.width * rawSourceHeight
    const canonicalSource = ratioMatches
      ? { width: rawSourceWidth, height: rawSourceHeight }
      : target.width === 2160 && target.height === 3840
        ? { width: 720, height: 1280 }
        : target.width === 3840 && target.height === 1646
          ? { width: 1920, height: 823 }
          : target
    return {
      dataUrl: `data:image/png;base64,resized-${target.width}x${target.height}`,
      // 与真实 resizeImageDataUrlToExactSize 语义一致：sourceDataUrl 保留 provider 原始输出
      sourceDataUrl: dataUrl,
      width: target.width,
      height: target.height,
      sourceWidth: canonicalSource.width,
      sourceHeight: canonicalSource.height,
      rawSourceWidth,
      rawSourceHeight,
      sourceNormalized: !ratioMatches,
      resized: true,
      drawPlan: {
        mode: fitMode,
        sourceWidth: canonicalSource.width,
        sourceHeight: canonicalSource.height,
        targetWidth: target.width,
        targetHeight: target.height,
        scale: 1,
        drawX: 0,
        drawY: 0,
        drawWidth: target.width,
        drawHeight: target.height,
        aspectMismatch: canonicalSource.width * target.height !== target.width * canonicalSource.height,
      },
    }
  }),
}))
vi.mock('./lib/canvasImage', () => ({
  // store.ts 仅用 validateMaskMatchesImage（浏览器 canvas 校验，node 环境不可用）；
  // mock 为 partial 让遮罩提交链在测试中可走通。
  validateMaskMatchesImage: vi.fn(async () => 'partial'),
}))
vi.mock('./lib/inputPreprocess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/inputPreprocess')>()
  return {
    ...actual,
    preprocessInputImagesForTarget: vi.fn(async (
      images: Array<{ dataUrl: string; width?: number; height?: number }>,
      _target: { width: number; height: number },
      policy?: string,
    ) => {
      // 默认实现：显式 crop/outpaint 时返回可辨识的处理图；auto/off 不处理
      if (policy !== 'crop' && policy !== 'outpaint') {
        return { images: images.map((img) => ({ dataUrl: img.dataUrl, width: img.width ?? 0, height: img.height ?? 0 })), policy: 'none' }
      }
      const longEdge = 1536
      return {
        images: images.map((img, index) => ({
          dataUrl: `data:image/png;base64,pre-${policy}-${index + 1}`,
          width: policy === 'crop' ? 1024 : longEdge,
          height: policy === 'crop' ? 1536 : longEdge,
        })),
        policy,
        ...(policy === 'outpaint' ? { promptHint: 'mock-outpaint-hint' } : {}),
      }
    }),
  }
})
import { clearAgentConversations, clearImages, clearLocalAutoSaveDirectoryHandle, clearSceneDirectoryHandle, clearSkillsRootDirectoryHandle, clearTasks, clearTasksAndAdvanceGeneration, commitTaskDeletion, deleteImage as deleteDbImage, deleteTask as deleteDbTask, getAllAgentConversations, getAllImageIds, getAllTasks, getEngineDeliveryDirectoryHandle, getImage, getLocalAutoSaveDirectoryHandle, getSceneDirectoryHandle, getSkillsRootDirectoryHandle, getStoredFreshImageThumbnail, listSceneDirectoryHandles, putAgentConversation, putEngineDeliveryDirectoryHandle, putImage, putImageThumbnail, putLocalAutoSaveDirectoryHandle, putSceneDirectoryHandle, putSkillsRootDirectoryHandle, putTask as putDbTask, SCENE_DIRECTORY_KEY_PREFIX } from './lib/db'
import { callImageApi } from './lib/api'
import { callSkillExpansionApi } from './lib/skillWorkshop/skillExpansionApi'
import { resizeImageDataUrlToExactSize } from './lib/exactImageSize'
import { preprocessInputImagesForTarget } from './lib/inputPreprocess'
import { formatExportFileTime } from './lib/exportFileName'
import { calculateImageSize } from './lib/size'
import { getFalQueuedImageResult } from './lib/falAiImageApi'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import { LocalAutoSavePermissionError, writeLocalAutoSaveArchive } from './lib/localAutoSaveWriter'
import { removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { __resetTasksClearedForTests, authorizeLocalAutoSaveDirectory, clearData, clearFailedTasks, deleteFavoriteCollection, editOutputs, ensureImageCached, getErrorToastMessage, getLocalAutoSaveRetryableTaskCount, getPersistedState, getTaskApiProfile, importData, initStore, removeMultipleTasks, removeTask, restoreExplicitPresetConfig, restoreLocalAutoSavePermissionOnUserActivation, retryPendingLocalAutoSaves, retryTask, reuseConfig, runLocalAutoSaveForTask, selectLocalAutoSaveDirectory, submitTask, taskMatchesFilterStatus, taskMatchesSearchQuery, updateTaskInStore, useStore } from './store'

const commitTaskDeletionImplementation = vi.mocked(commitTaskDeletion).getMockImplementation()!
const deleteDbImageImplementation = vi.mocked(deleteDbImage).getMockImplementation()!

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

describe('error toast messages', () => {
  it('drops long error detail after the failure title', () => {
    expect(getErrorToastMessage('图像生成失败：接口拒绝了很长的提示词内容')).toBe('图像生成失败')
  })

  it('uses a generic message for long raw errors without a title', () => {
    expect(getErrorToastMessage(`invalid request ${'x'.repeat(90)}`)).toBe('操作失败，请查看详情')
  })
})

function agentConversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conversation-a',
    title: '新对话',
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...overrides,
  }
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function importFile(data: ExportData, files: Record<string, Uint8Array> = {}): File {
  const zipped = zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(data)) })
  const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength)
  return { name: 'backup.zip', size: zipped.byteLength, arrayBuffer: async () => buffer.slice(0) } as File
}

function localAutoSaveSettings(enabled = true, localAutoSaveOverrides: Partial<AppSettings['localAutoSave']> = {}) {
  const profile = createDefaultOpenAIProfile({ id: 'local-auto-save-profile', apiKey: 'test-key' })
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    apiKey: 'test-key',
    profiles: [profile],
    activeProfileId: profile.id,
    localAutoSave: {
      enabled,
      directoryName: enabled ? 'Archive' : null,
      lastSavedAt: null,
      lastSavedFolderName: null,
      ...localAutoSaveOverrides,
    },
  })
}

function localAutoSaveTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return task({
    prompt: '城市夜晚人像',
    params: {
      ...DEFAULT_PARAMS,
      size: '2160x3840',
      exact_size: true,
      quality: 'high',
      output_format: 'png',
    },
    outputImages: ['image-a'],
    status: 'done',
    createdAt: Date.UTC(2026, 6, 7, 13, 35, 12),
    finishedAt: Date.UTC(2026, 6, 7, 13, 36, 12),
    ...overrides,
  })
}

function localAutoSaveImage(overrides: Partial<StoredImage> = {}): StoredImage {
  return {
    id: 'image-a',
    dataUrl: 'data:image/png;base64,AAAA',
    width: 2160,
    height: 3840,
    source: 'generated',
    createdAt: Date.UTC(2026, 6, 7, 13, 36, 0),
    ...overrides,
  }
}

function fakeDirectoryHandle(name = 'Archive') {
  return { name } as unknown as FileSystemDirectoryHandle
}

interface LocalAutoSaveTestWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  navigator: {
    userAgent?: string
    userAgentData?: {
      mobile: boolean
      brands: Array<{ brand: string; version: string }>
    }
  }
}

function getLocalAutoSaveTestWindow() {
  const target = globalThis as typeof globalThis & { window?: LocalAutoSaveTestWindow }
  if (!target.window) {
    Object.defineProperty(target, 'window', {
      configurable: true,
      writable: true,
      value: { navigator: { userAgent: '' } },
    })
  }
  return target.window
}

function setLocalAutoSaveBrowserSupport(supported: boolean, picker = vi.fn(async () => fakeDirectoryHandle())) {
  const testWindow = getLocalAutoSaveTestWindow()
  Object.defineProperty(testWindow, 'showDirectoryPicker', {
    configurable: true,
    value: picker,
  })
  Object.defineProperty(testWindow.navigator, 'userAgentData', {
    configurable: true,
    value: {
      mobile: !supported,
      brands: [{ brand: 'Google Chrome', version: '126' }],
    },
  })
  return picker
}

async function waitForAssertion(assertion: () => void) {
  const deadline = Date.now() + 1000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  throw lastError
}

describe('local auto-save store integration', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    await clearLocalAutoSaveDirectoryHandle()
    vi.mocked(callImageApi).mockClear()
    vi.mocked(putDbTask).mockClear()
    vi.mocked(writeLocalAutoSaveArchive).mockClear()
    const testWindow = getLocalAutoSaveTestWindow()
    Object.defineProperty(testWindow, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(testWindow.navigator, 'userAgentData', {
      configurable: true,
      value: undefined,
    })
    useStore.setState({
      settings: localAutoSaveSettings(),
      tasks: [],
      localAutoSaveRunningTaskIds: {},
      showToast: vi.fn(),
    })
  })

  it('auto-saves eligible gallery 4K tasks without changing generation status', async () => {
    const directory = fakeDirectoryHandle()
    await putLocalAutoSaveDirectoryHandle(directory)
    await putImage(localAutoSaveImage())
    const galleryTask = localAutoSaveTask()
    useStore.getState().setTasks([galleryTask])

    await runLocalAutoSaveForTask(galleryTask.id)

    const expectedFolderName = `${formatExportFileTime(new Date(galleryTask.createdAt))}_2160x3840_城市夜晚人像`
    const saved = useStore.getState().tasks[0]
    expect(saved.status).toBe('done')
    expect(saved.localAutoSave).toMatchObject({
      status: 'saved',
      folderName: expectedFolderName,
      files: ['image-1.png', 'prompt.txt', 'metadata.json'],
    })
    expect(writeLocalAutoSaveArchive).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeLocalAutoSaveArchive).mock.calls[0]?.[0]).toMatchObject({
      rootHandle: directory,
      folderName: expectedFolderName,
    })
  })

  it('persists the final saved status when the saving write resolves late', async () => {
    const directory = fakeDirectoryHandle()
    await putLocalAutoSaveDirectoryHandle(directory)
    await putImage(localAutoSaveImage())
    const galleryTask = localAutoSaveTask({ id: 'race-task' })
    useStore.getState().setTasks([galleryTask])

    const putTaskMock = vi.mocked(putDbTask)
    const defaultPutTask = putTaskMock.getMockImplementation()
    if (!defaultPutTask) throw new Error('putTask mock implementation missing')
    let releaseSavingWrite: (() => void) | undefined
    const savingWriteStarted = new Promise<void>((resolve) => {
      putTaskMock.mockImplementationOnce(async (nextTask) => {
        expect(nextTask.localAutoSave?.status).toBe('saving')
        const blockedSavingWrite = new Promise<void>((release) => {
          releaseSavingWrite = release
        })
        resolve()
        await blockedSavingWrite
        return defaultPutTask(nextTask)
      })
    })

    const run = runLocalAutoSaveForTask(galleryTask.id)
    await savingWriteStarted
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (!releaseSavingWrite) throw new Error('saving write did not start')
    releaseSavingWrite()
    await run
    await new Promise((resolve) => setTimeout(resolve, 0))

    const persisted = (await getAllTasks()).find((item) => item.id === galleryTask.id)
    expect(persisted?.localAutoSave?.status).toBe('saved')
  })

  it('marks Agent tasks as not_applicable', async () => {
    useStore.getState().setTasks([localAutoSaveTask({
      id: 'agent-task',
      sourceMode: 'agent',
    })])

    await runLocalAutoSaveForTask('agent-task')

    expect(useStore.getState().tasks[0].localAutoSave).toEqual({
      status: 'not_applicable',
      error: 'agent_task',
    })
    expect(writeLocalAutoSaveArchive).not.toHaveBeenCalled()
  })

  it('does not auto-save partial-success gallery tasks', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle())
    await putImage(localAutoSaveImage())
    useStore.getState().setTasks([localAutoSaveTask({
      id: 'partial-task',
      outputErrors: [{ requestIndex: 1, error: 'rate limit' }],
    })])

    await runLocalAutoSaveForTask('partial-task')

    expect(useStore.getState().tasks[0].localAutoSave).toEqual({
      status: 'not_applicable',
      error: 'partial_failure',
    })
    expect(writeLocalAutoSaveArchive).not.toHaveBeenCalled()
  })

  it('marks missing stored images as failed', async () => {
    useStore.getState().setTasks([localAutoSaveTask({
      id: 'missing-image-task',
      outputImages: ['missing-image'],
    })])

    await runLocalAutoSaveForTask('missing-image-task')

    expect(useStore.getState().tasks[0].localAutoSave).toEqual({
      status: 'failed',
      error: '图片数据已不存在',
    })
  })

  it('marks eligible tasks as pending when no directory is selected', async () => {
    await putImage(localAutoSaveImage())
    useStore.getState().setTasks([localAutoSaveTask({ id: 'pending-task' })])

    await runLocalAutoSaveForTask('pending-task')

    expect(useStore.getState().tasks[0].localAutoSave).toEqual({
      status: 'pending',
      error: '未选择保存位置',
    })
    expect(writeLocalAutoSaveArchive).not.toHaveBeenCalled()
  })

  it('does not write with a stored handle when settings have no selected directory', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('Archive'))
    await putImage(localAutoSaveImage())
    useStore.setState({
      settings: localAutoSaveSettings(true, { directoryName: null }),
    })
    useStore.getState().setTasks([localAutoSaveTask({ id: 'drift-task' })])

    await runLocalAutoSaveForTask('drift-task')

    expect(writeLocalAutoSaveArchive).not.toHaveBeenCalled()
    expect(useStore.getState().tasks[0].localAutoSave?.status).toBe('pending')
    expect(await getLocalAutoSaveDirectoryHandle()).toBeUndefined()
    expect(useStore.getState().settings.localAutoSave.directoryName).toBeNull()
  })

  it('does not write when the stored handle name differs from the selected directory', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('Archive'))
    await putImage(localAutoSaveImage())
    useStore.setState({
      settings: localAutoSaveSettings(true, { directoryName: 'Imported Archive' }),
    })
    useStore.getState().setTasks([localAutoSaveTask({ id: 'mismatched-directory-task' })])

    await runLocalAutoSaveForTask('mismatched-directory-task')

    expect(writeLocalAutoSaveArchive).not.toHaveBeenCalled()
    expect(useStore.getState().tasks[0].localAutoSave?.status).toBe('pending')
    expect(await getLocalAutoSaveDirectoryHandle()).toBeUndefined()
    expect(useStore.getState().settings.localAutoSave.directoryName).toBeNull()
  })

  it('marks permission errors as needs_permission', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle())
    vi.mocked(writeLocalAutoSaveArchive).mockRejectedValueOnce(new LocalAutoSavePermissionError())
    await putImage(localAutoSaveImage())
    useStore.getState().setTasks([localAutoSaveTask({ id: 'permission-task' })])

    await runLocalAutoSaveForTask('permission-task')

    expect(useStore.getState().tasks[0].localAutoSave).toEqual({
      status: 'needs_permission',
      error: '需要重新授权保存位置',
    })
  })

  it('reauthorizes the stored directory without opening the folder picker again', async () => {
    const requestPermission = vi.fn(async () => 'granted' as PermissionState)
    const directory = {
      name: 'Archive',
      queryPermission: vi.fn(async () => 'prompt' as PermissionState),
      requestPermission,
    } as unknown as FileSystemDirectoryHandle
    await putLocalAutoSaveDirectoryHandle(directory)
    const picker = setLocalAutoSaveBrowserSupport(true)

    await expect(authorizeLocalAutoSaveDirectory()).resolves.toBe(true)

    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(picker).not.toHaveBeenCalled()
    expect(await getLocalAutoSaveDirectoryHandle()).toMatchObject({ handle: directory, name: 'Archive' })
    expect(useStore.getState().showToast).toHaveBeenCalledWith('原保存位置已重新授权', 'success')
  })

  it('selects a directory only when strict desktop browser support passes', async () => {
    const unsupportedPicker = setLocalAutoSaveBrowserSupport(false)

    await selectLocalAutoSaveDirectory()

    expect(unsupportedPicker).not.toHaveBeenCalled()
    expect(useStore.getState().showToast).toHaveBeenCalledWith('本地自动保存仅支持桌面 Chrome/Edge', 'error')

    useStore.setState({ settings: localAutoSaveSettings(false, { directoryName: null }) })
    const directory = fakeDirectoryHandle('Desktop Archive')
    const supportedPicker = setLocalAutoSaveBrowserSupport(true, vi.fn(async () => directory))

    await selectLocalAutoSaveDirectory()

    expect(supportedPicker).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(await getLocalAutoSaveDirectoryHandle()).toMatchObject({ handle: directory, name: 'Desktop Archive' })
    expect(useStore.getState().settings.localAutoSave.enabled).toBe(true)
    expect(useStore.getState().settings.localAutoSave.directoryName).toBe('Desktop Archive')
  })

  it('merges local auto-save setting patches without clearing saved directory metadata', () => {
    useStore.setState({
      settings: localAutoSaveSettings(true, {
        directoryName: 'Desktop Archive',
        lastSavedAt: 1_788_888_888,
        lastSavedFolderName: '20260708_2160x3840_城市夜晚人像',
      }),
    })

    useStore.getState().setSettings({
      localAutoSave: {
        enabled: false,
      },
    } as unknown as Partial<AppSettings>)

    expect(useStore.getState().settings.localAutoSave).toEqual({
      enabled: false,
      directoryName: 'Desktop Archive',
      lastSavedAt: 1_788_888_888,
      lastSavedFolderName: '20260708_2160x3840_城市夜晚人像',
    })
  })

  it('counts and retries pending, failed, permission, and stale saving local auto-saves', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle())
    await putImage(localAutoSaveImage({ id: 'image-pending' }))
    await putImage(localAutoSaveImage({ id: 'image-failed' }))
    await putImage(localAutoSaveImage({ id: 'image-needs-permission' }))
    await putImage(localAutoSaveImage({ id: 'image-saving' }))
    await putImage(localAutoSaveImage({ id: 'image-saved' }))
    const tasks = [
      localAutoSaveTask({ id: 'pending-task', outputImages: ['image-pending'], localAutoSave: { status: 'pending' } }),
      localAutoSaveTask({ id: 'failed-task', outputImages: ['image-failed'], localAutoSave: { status: 'failed', error: 'disk full' } }),
      localAutoSaveTask({ id: 'permission-task', outputImages: ['image-needs-permission'], localAutoSave: { status: 'needs_permission', error: '需要重新授权保存位置' } }),
      localAutoSaveTask({ id: 'saving-task', outputImages: ['image-saving'], localAutoSave: { status: 'saving' } }),
      localAutoSaveTask({ id: 'saved-task', outputImages: ['image-saved'], localAutoSave: { status: 'saved', folderName: 'saved', files: ['image-1.png'] } }),
      localAutoSaveTask({ id: 'skipped-task', localAutoSave: { status: 'not_applicable', error: 'not_4k_intent' } }),
    ]
    useStore.getState().setTasks(tasks)

    expect(getLocalAutoSaveRetryableTaskCount(tasks)).toBe(4)

    await retryPendingLocalAutoSaves()

    expect(writeLocalAutoSaveArchive).toHaveBeenCalledTimes(4)
    expect(useStore.getState().tasks.filter((item) => item.localAutoSave?.status === 'saved')).toHaveLength(5)
  })

  it('does not retry local auto-saves while the setting is disabled', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle())
    await putImage(localAutoSaveImage({ id: 'image-pending' }))
    useStore.setState({
      settings: localAutoSaveSettings(false),
    })
    useStore.getState().setTasks([
      localAutoSaveTask({ id: 'pending-task', outputImages: ['image-pending'], localAutoSave: { status: 'pending' } }),
    ])

    await retryPendingLocalAutoSaves()

    expect(writeLocalAutoSaveArchive).not.toHaveBeenCalled()
    expect(useStore.getState().tasks[0].localAutoSave?.status).toBe('pending')
  })

  it('clears the stored directory handle when clearing config resets local auto-save settings', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle())

    await clearData({ clearConfig: true, clearTasks: false })

    expect(await getLocalAutoSaveDirectoryHandle()).toBeUndefined()
  })

  it('clears the engine delivery directory handle together with the gallery handle when clearing config', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('4K'))
    await putEngineDeliveryDirectoryHandle(fakeDirectoryHandle('批量'))

    await clearData({ clearConfig: true, clearTasks: false })

    expect(await getLocalAutoSaveDirectoryHandle()).toBeUndefined()
    expect(await getEngineDeliveryDirectoryHandle()).toBeUndefined()
  })

  it('keeps the engine delivery directory handle when importing config', async () => {
    await putEngineDeliveryDirectoryHandle(fakeDirectoryHandle('批量'))
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: localAutoSaveSettings(true, { directoryName: 'Imported Archive' }),
    }), { importConfig: true, importTasks: false })

    expect(imported).toBe(true)
    expect(await getEngineDeliveryDirectoryHandle()).toMatchObject({ name: '批量' })
  })

  it('clears the stored directory handle and imported archive metadata when importing local auto-save settings', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('Old Archive'))
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: localAutoSaveSettings(true, {
        directoryName: 'Imported Archive',
        lastSavedAt: 1,
        lastSavedFolderName: '2026-07-07_13-35-12_2160x3840_城市夜晚人像',
      }),
    }), { importConfig: true, importTasks: false })

    expect(imported).toBe(true)
    expect(useStore.getState().settings.localAutoSave.enabled).toBe(true)
    expect(useStore.getState().settings.localAutoSave.directoryName).toBeNull()
    expect(useStore.getState().settings.localAutoSave.lastSavedAt).toBeNull()
    expect(useStore.getState().settings.localAutoSave.lastSavedFolderName).toBeNull()
    expect(await getLocalAutoSaveDirectoryHandle()).toBeUndefined()
  })

  it('marks imported local auto-save states as pending because archive files are not imported', async () => {
    await putImage(localAutoSaveImage({ id: 'image-a' }))
    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [
        localAutoSaveTask({
          id: 'imported-saved-task',
          localAutoSave: {
            status: 'saved',
            folderName: '2026-07-07_13-35-12_2160x3840_城市夜晚人像',
            files: ['image-1.png', 'prompt.txt', 'metadata.json'],
            savedAt: 1,
          },
        }),
      ],
      imageFiles: {
        'image-a': {
          path: 'images/image-a.png',
          source: 'generated',
          width: 2160,
          height: 3840,
          createdAt: 1,
        },
      },
    }, { 'images/image-a.png': new Uint8Array([1, 2]) }), { importConfig: false, importTasks: true })

    expect(imported).toBe(true)
    const importedTask = useStore.getState().tasks.find((task) => task.id === 'imported-saved-task')
    expect(importedTask?.localAutoSave).toEqual({
      status: 'pending',
      error: '导入的数据不包含本地归档文件，请重新补保存',
    })
    expect(getLocalAutoSaveRetryableTaskCount(useStore.getState().tasks)).toBe(1)
  })

  it('schedules local auto-save after successful gallery task generation', async () => {
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle())
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,2160x3840AAAAAAA'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: localAutoSaveSettings(),
      prompt: '城市夜晚人像',
      params: {
        ...DEFAULT_PARAMS,
        size: '2160x3840',
        exact_size: true,
        quality: 'high',
        output_format: 'png',
      },
      inputImages: [],
      maskDraft: null,
      tasks: [],
      showToast: vi.fn(),
    })

    await submitTask()
    await waitForAssertion(() => expect(writeLocalAutoSaveArchive).toHaveBeenCalledTimes(1))

    const saved = useStore.getState().tasks[0]
    expect(saved.status).toBe('done')
    expect(saved.localAutoSave?.status).toBe('saved')
  })

  it('keeps quota-failed output images in memory and marks the task instead of failing it', async () => {
    const dbModule = await import('./lib/db')
    const quotaError = new dbModule.StorageQuotaError({ imageId: 'quota-image-1', width: 1024, height: 1024 })
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,QUOTA'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    const storeImageWithSizeSpy = vi.spyOn(dbModule, 'storeImageWithSize').mockImplementationOnce(async () => {
      throw quotaError
    })

    const showToast = vi.fn()
    useStore.setState({
      settings: localAutoSaveSettings(false),
      prompt: '配额测试',
      params: { ...DEFAULT_PARAMS },
      inputImages: [],
      maskDraft: null,
      tasks: [],
      showToast,
    })

    try {
      await submitTask()
      await waitForAssertion(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

      const savedTask = useStore.getState().tasks[0]
      expect(savedTask.outputImages).toEqual(['quota-image-1'])
      expect(savedTask.outputPersistWarning).toBe(true)
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('存储空间不足'), 'error')
      // 核心断言：图必须真的留在内存（钉在 LRU 之外），否则"未持久化"标记是空话
      expect(await ensureImageCached('quota-image-1')).toBe('data:image/png;base64,QUOTA')
    } finally {
      storeImageWithSizeSpy.mockRestore()
    }
  })
})


describe('generation concurrency queue', () => {
  beforeEach(() => {
    __resetTasksClearedForTests()
    vi.mocked(callImageApi).mockReset()
  })

  it('runs at most 2 gallery generations concurrently and queues the rest', async () => {
    let inFlight = 0
    let maxInFlight = 0
    let released = 0
    vi.mocked(callImageApi).mockReset().mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      released += 1
      inFlight -= 1
      return {
        images: ['data:image/png;base64,VEVTVP=='],
        actualParams: {},
        actualParamsList: [],
        revisedPrompts: [],
      }
    })

    useStore.setState({
      settings: localAutoSaveSettings(false),
      tasks: [],
      inputImages: [],
      maskDraft: null,
      prompt: '队列测试',
      showToast: vi.fn(),
    })

    // 连续提交 5 个任务：并发上限 2，其余排队
    for (let i = 0; i < 5; i += 1) {
      await submitTask()
    }
    await waitForAssertion(() => expect(useStore.getState().tasks.filter((item) => item.status === 'done')).toHaveLength(5))

    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(released).toBe(5)
  })
})

describe('data operation locking', () => {
  it('detects running and recoverable work before import or export', () => {
    expect(hasActiveDataOperations([task({ status: 'running' })])).toBe(true)
    expect(hasActiveDataOperations([task({ falRecoverable: true })])).toBe(true)
    expect(hasActiveDataOperations([task()])).toBe(false)
    expect(hasActiveDataOperations([])).toBe(false)
  })
})

describe('favorite collection deletion', () => {
  const collectionA = { id: 'collection-a', name: '收藏夹 A', createdAt: 1, updatedAt: 1 }
  const collectionB = { id: 'collection-b', name: '收藏夹 B', createdAt: 1, updatedAt: 1 }

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    useStore.setState({
      tasks: [],
      favoriteCollections: [collectionA, collectionB],
      defaultFavoriteCollectionId: collectionA.id,
      activeFavoriteCollectionId: collectionA.id,
      selectedFavoriteCollectionIds: [collectionA.id],
      selectedTaskIds: [],
      inputImages: [],
      galleryInputDraft: null,
      showToast: vi.fn(),
    })
  })

  it('keeps tasks that are still referenced by another collection when deleting collection tasks', async () => {
    const sharedTask = task({
      id: 'shared-task',
      isFavorite: true,
      favoriteCollectionIds: [collectionA.id, collectionB.id],
    })
    const collectionOnlyTask = task({
      id: 'collection-only-task',
      isFavorite: true,
      favoriteCollectionIds: [collectionA.id],
    })
    useStore.setState({ tasks: [sharedTask, collectionOnlyTask] })
    await putDbTask(sharedTask)
    await putDbTask(collectionOnlyTask)

    await deleteFavoriteCollection(collectionA.id, true)

    const state = useStore.getState()
    expect(state.favoriteCollections.map((collection) => collection.id)).toEqual([collectionB.id])
    expect(state.activeFavoriteCollectionId).toBeNull()
    expect(state.selectedFavoriteCollectionIds).toEqual([])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({
      id: sharedTask.id,
      isFavorite: true,
      favoriteCollectionIds: [collectionB.id],
    })
    expect((await getAllTasks()).map((item) => item.id)).toEqual([sharedTask.id])
  })
})

describe('mask draft lifecycle in store actions', () => {
  beforeEach(() => {
    vi.mocked(callImageApi).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockReset().mockImplementation(async (dataUrl) => `transparent:${dataUrl}`)
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, transparentBackgroundMethod: 'local' })),
      },
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('preserves an existing mask when quick edit-output adds outputs as references', async () => {
    const maskDraft = {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    }
    useStore.setState({
      inputImages: [imageA],
      maskDraft,
    })

    await editOutputs(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskDraft).toEqual(maskDraft)
  })

  it('clears an invalid mask draft when submit cannot find the mask target image', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: 'missing-image',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await submitTask()

    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('shows a submitted toast after creating a gallery task', async () => {
    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.showToast).toHaveBeenCalledWith('任务已提交', 'success')
  })

  it('提交的任务记录提交时的场景 sceneId', async () => {
    useStore.setState({ settings: { ...useStore.getState().settings, activeScene: 'sticker' } })
    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const task = useStore.getState().tasks[0]
    expect(task.sceneId).toBe('sticker')
  })

  it('重试生成的新任务记录重试时的场景 sceneId', async () => {
    useStore.setState({ settings: { ...useStore.getState().settings, activeScene: 'sticker' } })
    await retryTask(task())
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(useStore.getState().tasks[0].sceneId).toBe('sticker')
  })

  it('stores decoded image size as actual size when the API omits size', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,actual-1254x1254'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '2048x2048' },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const [task] = useStore.getState().tasks
    expect(task.actualParams).toMatchObject({ size: '1254x1254', output_format: 'png', n: 1 })
    expect(task.actualParamsByImage?.[task.outputImages[0]]).toMatchObject({ size: '1254x1254', output_format: 'png' })
    await clearTasks()
    await clearImages()
  })

  it('keeps API-returned actual size over decoded image size', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,actual-1254x1254'],
      actualParams: { output_format: 'png', size: '1024x1024' },
      actualParamsList: [{ output_format: 'png', size: '1024x1024' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '2048x2048' },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const [task] = useStore.getState().tasks
    expect(task.actualParams?.size).toBe('1024x1024')
    expect(task.actualParamsByImage?.[task.outputImages[0]].size).toBe('1024x1024')
    await clearTasks()
    await clearImages()
  })

  it('preserves a 4K exact-size output while limiting the Codex CLI provider request to 1K', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(resizeImageDataUrlToExactSize).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,actual-1254x1254'],
      actualParams: { output_format: 'png', quality: 'high', size: '1254x1254' },
      actualParamsList: [{ output_format: 'png', quality: 'high', size: '1254x1254' }],
      revisedPrompts: ['Generate at 720x1280 resolution. poster'],
    })
    const codexProfile = createDefaultOpenAIProfile({
      id: 'gallery-codex-profile',
      apiKey: 'test-key',
      codexCli: true,
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [codexProfile],
        activeProfileId: codexProfile.id,
      }),
      prompt: 'poster',
      params: {
        ...DEFAULT_PARAMS,
        size: '2160x3840',
        exact_size: true,
        quality: 'high',
        output_format: 'png',
      },
    })

    await submitTask()
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

    expect(vi.mocked(callImageApi).mock.calls[0]?.[0].prompt).not.toContain('Target frame')
    expect(vi.mocked(callImageApi).mock.calls[0]?.[0].params.size).toBe('720x1280')
    expect(resizeImageDataUrlToExactSize).toHaveBeenCalledWith(
      'data:image/png;base64,actual-1254x1254',
      { width: 2160, height: 3840 },
      'png',
      'cover',
    )
    const [task] = useStore.getState().tasks
    expect(task.exactSizeOriginalImages).toHaveLength(1)
    expect(task.exactSizeTransforms?.[task.outputImages[0]]).toMatchObject({
      mode: 'cover',
      sourceWidth: 720,
      sourceHeight: 1280,
      rawSourceWidth: 1254,
      rawSourceHeight: 1254,
      sourceNormalized: true,
      targetWidth: 2160,
      targetHeight: 3840,
      aspectMismatch: false,
    })
    expect(task.actualParams).toMatchObject({ size: '2160x3840', output_format: 'png', quality: 'high', n: 1 })
    expect(task.actualParamsByImage?.[task.outputImages[0]]).toMatchObject({ size: '2160x3840', output_format: 'png', quality: 'high' })
    expect(task.revisedPromptByImage?.[task.outputImages[0]]).toBe('poster')
    const outputImage = await getImage(task.outputImages[0])
    const sourceImage = await getImage(task.exactSizeOriginalImages![0])
    expect(outputImage?.dataUrl).toBe('data:image/png;base64,resized-2160x3840')
    // sourceDataUrl 语义 = provider 原始输出（方图），最终输出为 cover 裁切到目标比例
    expect(sourceImage).toMatchObject({
      dataUrl: 'data:image/png;base64,actual-1254x1254',
      width: 1254,
      height: 1254,
    })
    await clearTasks()
    await clearImages()
  })

  it('stores transparent background output after local post-processing', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,generated'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '单主体贴纸素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        output_compression: null,
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'transparent:单主体贴纸素材',
      params: expect.objectContaining({
        output_format: 'png',
        output_compression: null,
        transparent_output: true,
      }),
    }))
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,generated')
    const [task] = useStore.getState().tasks
    expect(task).toMatchObject({
      prompt: '单主体贴纸素材',
      transparentOutput: true,
      transparentPrompt: 'transparent:单主体贴纸素材',
      status: 'done',
    })
    expect(task.transparentOriginalImages).toHaveLength(1)
    const outputImage = await getImage(task.outputImages[0])
    const originalImage = await getImage(task.transparentOriginalImages![0])
    expect(outputImage?.dataUrl).toBe('transparent:data:image/png;base64,generated')
    expect(originalImage?.dataUrl).toBe('data:image/png;base64,generated')
    await clearTasks()
    await clearImages()
  })

  it('stores locally post-processed transparent output as WebP', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/webp;base64,generated'],
      actualParams: { output_format: 'webp' },
      actualParamsList: [{ output_format: 'webp' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '单主体贴纸素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'webp',
        output_compression: 25,
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        output_format: 'webp',
        output_compression: 25,
        transparent_output: true,
      }),
    }))
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith(
      'data:image/webp;base64,generated',
      undefined,
      'webp',
      25,
    )
    await clearTasks()
    await clearImages()
  })

  it('keeps native transparent output unchanged and requests API transparency', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,native-transparent'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, baseUrl: 'https://api.example.com/v1', apiKey: 'test-key' },
      prompt: '透明玻璃瓶',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      nativeTransparentBackground: true,
    }))
    expect(removeKeyedBackgroundFromDataUrl).not.toHaveBeenCalled()
    const [task] = useStore.getState().tasks
    expect(task.transparentOutput).toBeUndefined()
    expect(task.transparentPrompt).toBeUndefined()
    expect(task.transparentOriginalImages).toBeUndefined()
    await clearTasks()
    await clearImages()
  })

  it('augments the request prompt with the native transparent instruction', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,native-transparent-hint'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, baseUrl: 'https://api.example.com/v1', apiKey: 'test-key' },
      prompt: '透明玻璃瓶',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      nativeTransparentBackground: true,
      prompt: expect.stringContaining('背景必须完全透明'),
    }))
    // 提示词增强只作用于请求：任务本身仍按原生透明记录，不触发本地后处理。
    const [task] = useStore.getState().tasks
    expect(task.transparentOutput).toBeUndefined()
    await clearTasks()
    await clearImages()
  })

  it('falls back to the original output when transparent post-processing fails', async () => {
    const { callImageApi } = await import('./lib/api')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockRejectedValueOnce(new Error('post-process failed'))
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,generated'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '单主体贴纸素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        output_compression: null,
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const [task] = useStore.getState().tasks
    expect(task).toMatchObject({
      transparentOutput: true,
      status: 'done',
    })
    expect(task.transparentOriginalImages).toEqual([''])
    const outputImage = await getImage(task.outputImages[0])
    expect(outputImage?.dataUrl).toBe('data:image/png;base64,generated')
    warnSpy.mockRestore()
    await clearTasks()
    await clearImages()
  })

  it('supports transparent background post-processing for fal gallery tasks', async () => {
    const { callImageApi } = await import('./lib/api')
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,fal-generated'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [{ ...falProfile, transparentBackgroundMethod: 'local' }],
        activeProfileId: falProfile.id,
      }),
      prompt: '单主体图标素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        output_format: 'png',
        transparent_output: true,
      }),
    }))
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,fal-generated')
    const [task] = useStore.getState().tasks
    expect(task.apiProvider).toBe('fal')
    expect(task.transparentOutput).toBe(true)
    expect(task.transparentOriginalImages).toHaveLength(1)
    await clearTasks()
    await clearImages()
  })

  it('preserves selected image mentions when replacing a mask target with an equivalent image id', () => {
    const replacement = { id: 'image-a-replacement', dataUrl: imageA.dataUrl }
    const prompt = `参考 ${getSelectedImageMentionLabel(0)} 生成`
    useStore.setState({
      prompt,
      inputImages: [imageA, imageB],
    })

    useStore.getState().setInputImages([replacement, imageB], {
      equivalentImageIds: { [imageA.id]: replacement.id },
    })

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([replacement.id, imageB.id])
    expect(state.prompt).toBe(prompt)
  })
})

describe('input persistence setting', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      appMode: 'gallery',
      prompt: 'prompt',
      inputImages: [imageA],
      galleryInputDraft: null,
      dismissedCodexCliPrompts: [],
    })
  })

  it('persists input when restart input restore is enabled', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('prompt')
    expect(persisted.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
  })

  it('persists uploaded image dimensions while stripping preview payloads', () => {
    useStore.setState({
      inputImages: [{ id: imageA.id, dataUrl: imageA.dataUrl, width: 1536, height: 1024 }],
    })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.inputImages).toEqual([{ id: imageA.id, dataUrl: '', width: 1536, height: 1024 }])
  })

  it('restores persisted uploaded image dimensions for ratio-aware actions', () => {
    const migrated = migratePersistedState({
      settings: { ...DEFAULT_SETTINGS },
      appMode: 'gallery',
      prompt: 'prompt',
      inputImages: [{ id: imageA.id, dataUrl: '', width: 1536, height: 1024 }],
    }) as { inputImages: Array<{ id: string; dataUrl: string; width?: number; height?: number }> }

    expect(migrated.inputImages).toEqual([{ id: imageA.id, dataUrl: '', width: 1536, height: 1024 }])
  })

  it('hydrates persisted input dimensions from IndexedDB during startup', async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    await putImage({
      id: imageA.id,
      dataUrl: imageA.dataUrl,
      source: 'upload',
      createdAt: 1,
      width: 1536,
      height: 1024,
    })
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      appMode: 'gallery',
      prompt: 'prompt',
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      galleryInputDraft: null,
      tasks: [],
      showToast: vi.fn(),
    })

    await initStore()

    expect(useStore.getState().inputImages).toEqual([
      { id: imageA.id, dataUrl: imageA.dataUrl, width: 1536, height: 1024 },
    ])
  })

  it('omits input when restart input restore is disabled', () => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false },
      prompt: '不应持久化的可见输入',
      inputImages: [imageA],
      galleryInputDraft: {
        prompt: '不应持久化的画廊草稿',
        inputImages: [imageA],
        maskDraft: null,
        maskEditorImageId: null,
      },
    })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted).not.toHaveProperty('inputImages')
    expect(persisted.galleryInputDraft).toBeNull()
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })

  it('persists and restores normalized dismissed preset provider IDs', () => {
    useStore.setState({
      dismissedPresetProfileIds: ['profile-a'],
      dismissedPresetProviderIds: ['provider-a'],
    })

    const persisted = getPersistedState(useStore.getState())
    const restored = normalizePersistedState({
      ...persisted,
      dismissedPresetProviderIds: ['provider-a', 1, null, 'provider-b'],
    }, useStore.getState())!

    expect(persisted.dismissedPresetProviderIds).toEqual(['provider-a'])
    expect(restored.dismissedPresetProviderIds).toEqual(['provider-a', 'provider-b'])
  })
})

describe('preset deletion state', () => {
  afterEach(() => {
    setPresetConfig(null)
    useStore.setState({ previousPresetConfig: null })
  })

  it('removes an untouched preset after deployment removes it', async () => {
    const providers = [
      { id: 'preset-provider-a', name: 'Provider A', submit: { path: 'a' } },
      { id: 'preset-provider-b', name: 'Provider B', submit: { path: 'b' } },
    ]
    const profiles = [
      createDefaultOpenAIProfile({ id: 'preset-profile-a', provider: providers[0].id, isDefault: true }),
      createDefaultOpenAIProfile({ id: 'preset-profile-b', provider: providers[1].id }),
    ]
    const previous = { customProviders: providers, profiles }
    const next = { customProviders: [providers[0]], profiles: [profiles[0]] }
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      previousPresetConfig: null,
      tasks: [],
    })
    setPresetConfig(previous)
    await useStore.getState().setPresetImportedSettings(previous)

    setPresetConfig(next)
    await useStore.getState().setPresetImportedSettings(next)

    const state = useStore.getState()
    expect(state.settings.profiles.map((profile) => profile.id)).toEqual(['preset-profile-a'])
    expect(state.settings.customProviders.map((provider) => provider.id)).toEqual(['preset-provider-a'])
  })

  it('removes untouched presets when deployment removes the entire preset config', async () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id, isDefault: true })
    const preset = { customProviders: [provider], profiles: [profile] }
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      previousPresetConfig: null,
      tasks: [],
    })
    setPresetConfig(preset)
    await useStore.getState().setPresetImportedSettings(preset)

    setPresetConfig(null)
    await useStore.getState().setPresetImportedSettings({ customProviders: [], profiles: [] })

    const state = useStore.getState()
    expect(state.settings.profiles.map((item) => item.id)).toEqual([DEFAULT_SETTINGS.profiles[0].id])
    expect(state.settings.customProviders).toEqual([])
    expect(state.previousPresetConfig).toBeNull()
  })

  it('clearData clears both dismissal lists and reapplies the current preset', async () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({
      id: 'preset-profile',
      isDefault: true,
      provider: provider.id,
      model: 'preset-model',
    })
    const preset = { customProviders: [provider], profiles: [profile] }
    setPresetConfig(preset)
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [],
        profiles: [createDefaultFalProfile({ id: 'user-profile' })],
        activeProfileId: 'user-profile',
      }),
      dismissedPresetProfileIds: [profile.id],
      dismissedPresetProviderIds: [provider.id],
      dismissedCodexCliPrompts: ['prompt-a'],
    })

    await clearData({ clearConfig: true, clearTasks: false })

    const state = useStore.getState()
    expect(state.dismissedPresetProfileIds).toEqual([])
    expect(state.dismissedPresetProviderIds).toEqual([])
    expect(state.dismissedCodexCliPrompts).toEqual([])
    expect(state.settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
    expect(state.settings.profiles).toEqual([expect.objectContaining({ id: profile.id, provider: provider.id })])
  })

  it('restores an explicitly reimported preset provider', () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id })
    setPresetConfig({ customProviders: [provider], profiles: [profile] })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [],
        profiles: [{ ...profile, provider: 'openai' }],
      }),
      dismissedPresetProviderIds: [provider.id],
    })

    const state = useStore.getState()
    state.restorePresetProvider(provider.id)
    state.setSettings({ customProviders: [provider], profiles: [profile] })

    expect(useStore.getState().dismissedPresetProviderIds).toEqual([])
    expect(useStore.getState().settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
    expect(useStore.getState().settings.profiles[0].provider).toBe(provider.id)
  })

  it('restores only preset IDs explicitly selected by a URL import', async () => {
    const providers = [
      { id: 'preset-provider-a', name: 'Preset Provider A', submit: { path: 'generate-a' } },
      { id: 'preset-provider-b', name: 'Preset Provider B', submit: { path: 'generate-b' } },
    ]
    const profiles = [
      createDefaultOpenAIProfile({ id: 'preset-profile-a', provider: providers[0].id, isDefault: true }),
      createDefaultOpenAIProfile({ id: 'preset-profile-b', provider: providers[1].id }),
    ]
    setPresetConfig({ customProviders: providers, profiles })
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      dismissedPresetProviderIds: providers.map((provider) => provider.id),
      dismissedPresetProfileIds: profiles.map((profile) => profile.id),
    })

    const restored = await restoreExplicitPresetConfig({
      providerIds: [providers[0].id, 'not-a-preset'],
      profileIds: [profiles[0].id, 'not-a-preset'],
    })

    const state = useStore.getState()
    expect(restored).toBe(true)
    expect(state.dismissedPresetProviderIds).toEqual([providers[1].id])
    expect(state.dismissedPresetProfileIds).toEqual([profiles[1].id])
    expect(state.settings.customProviders).toEqual([expect.objectContaining({ id: providers[0].id })])
    expect(state.settings.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: profiles[0].id })]))
  })
})

describe('fal task recovery', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    vi.mocked(getFalQueuedImageResult).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockReset().mockImplementation(async (dataUrl) => `transparent:${dataUrl}`)
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [falProfile],
        activeProfileId: falProfile.id,
      }),
      tasks: [],
      inputImages: [],
      galleryInputDraft: null,
      showToast: vi.fn(),
    })
  })

  it('applies transparent post-processing when a fal task recovers', async () => {
    const falTask = task({
      id: 'fal-transparent-task',
      apiProvider: 'fal',
      apiProfileId: 'fal-profile',
      apiProfileName: 'fal',
      apiModel: 'fal-model',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
      transparentOutput: true,
      transparentPrompt: 'transparent:prompt',
      status: 'error',
      error: '连接已断开，等待自动恢复',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      finishedAt: null,
      elapsed: null,
    })
    await putDbTask(falTask)
    vi.mocked(getFalQueuedImageResult).mockResolvedValueOnce({
      images: ['data:image/png;base64,fal-recovered'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })

    await initStore()
    await vi.waitFor(() => {
      expect(useStore.getState().tasks.find((item) => item.id === falTask.id)).toMatchObject({ status: 'done', falRecoverable: false })
    })

    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,fal-recovered')
    const recovered = useStore.getState().tasks.find((item) => item.id === falTask.id)
    expect(recovered).toMatchObject({
      status: 'done',
      falRecoverable: false,
      transparentOutput: true,
    })
    expect(recovered?.transparentOriginalImages).toHaveLength(1)
    const outputImage = await getImage(recovered!.outputImages[0])
    const originalImage = await getImage(recovered!.transparentOriginalImages![0])
    expect(outputImage?.dataUrl).toBe('transparent:data:image/png;base64,fal-recovered')
    expect(originalImage?.dataUrl).toBe('data:image/png;base64,fal-recovered')
  })

})

describe('data import', () => {
  beforeEach(async () => {
    useStore.setState({
      tasks: [],
      showToast: vi.fn(),
    })
    await clearTasks()
  })

  it('restores favorite collections and default collection when importing task data', async () => {
    await clearTasks()
    const importedCollections = [
      { id: 'imported-collection-a', name: '导入收藏夹 A', createdAt: 1, updatedAt: 1 },
      { id: 'imported-collection-b', name: '导入收藏夹 B', createdAt: 2, updatedAt: 2 },
    ]
    const importedTask = task({
      id: 'imported-favorite-task',
      isFavorite: true,
      favoriteCollectionIds: [importedCollections[1].id],
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [importedTask],
      favoriteCollections: importedCollections,
      defaultFavoriteCollectionId: importedCollections[1].id,
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.favoriteCollections).toEqual(expect.arrayContaining(importedCollections))
    expect(state.defaultFavoriteCollectionId).toBe(importedCollections[1].id)
    expect(state.tasks.find((item) => item.id === importedTask.id)).toMatchObject({
      favoriteCollectionIds: [importedCollections[1].id],
      isFavorite: true,
    })
    expect((await getAllTasks()).find((item) => item.id === importedTask.id)).toMatchObject({
      favoriteCollectionIds: [importedCollections[1].id],
      isFavorite: true,
    })
  })

  it('imports a complete multipart backup selected in any order', async () => {
    await clearTasks()
    await clearImages()
    const importedTask = task({ id: 'multipart-task', outputImages: ['multipart-image-a', 'multipart-image-b'] })
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 1, total: 2 },
      tasks: [importedTask],
      favoriteCollections: [],
      agentConversations: [],
      imageFiles: { 'multipart-image-a': { path: 'images/image-a.png' } },
    }, { 'images/image-a.png': new Uint8Array([1, 2]) })
    const part2 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 2, total: 2 },
      tasks: [task({ id: 'multipart-task-2' })],
      imageFiles: { 'multipart-image-b': { path: 'images/image-b.png' } },
    }, { 'images/image-b.png': new Uint8Array([3, 4]) })

    const imported = await importData([part2, part1], { importConfig: false, importTasks: true })

    expect(imported).toBe(true)
    expect((await getAllTasks()).some((item) => item.id === importedTask.id)).toBe(true)
    expect((await getAllTasks()).some((item) => item.id === 'multipart-task-2')).toBe(true)
    expect(await getImage('multipart-image-a')).toMatchObject({ dataUrl: 'data:image/png;base64,AQI=' })
    expect(await getImage('multipart-image-b')).toMatchObject({ dataUrl: 'data:image/png;base64,AwQ=' })
  })

  it('imports multiple regular backups together', async () => {
    await clearTasks()
    await clearImages()
    const sharedCollection = { id: 'regular-collection-shared', name: '共享收藏夹', createdAt: 1, updatedAt: 1 }
    const collectionA = { id: 'regular-collection-a', name: '普通备份 A', createdAt: 1, updatedAt: 1 }
    const collectionB = { id: 'regular-collection-b', name: '普通备份 B', createdAt: 2, updatedAt: 2 }
    const sharedTask = task({ id: 'regular-task-shared', outputImages: ['regular-image-shared'] })
    const backupA = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [sharedTask, task({ id: 'regular-task-a', outputImages: ['regular-image-a'], favoriteCollectionIds: [collectionA.id], isFavorite: true })],
      favoriteCollections: [sharedCollection, collectionA],
      defaultFavoriteCollectionId: collectionA.id,
      imageFiles: {
        'regular-image-shared': { path: 'images/shared.png' },
        'regular-image-a': { path: 'images/image-a.png' },
      },
    }, {
      'images/shared.png': new Uint8Array([5, 6]),
      'images/image-a.png': new Uint8Array([1, 2]),
    })
    const backupB = importFile({
      version: 3,
      exportedAt: new Date(1).toISOString(),
      tasks: [sharedTask, task({ id: 'regular-task-b', outputImages: ['regular-image-b'], favoriteCollectionIds: [collectionB.id], isFavorite: true })],
      favoriteCollections: [sharedCollection, collectionB],
      defaultFavoriteCollectionId: collectionB.id,
      imageFiles: {
        'regular-image-shared': { path: 'images/shared.png' },
        'regular-image-b': { path: 'images/image-b.png' },
      },
    }, {
      'images/shared.png': new Uint8Array([5, 6]),
      'images/image-b.png': new Uint8Array([3, 4]),
    })

    const imported = await importData([backupA, backupB], { importConfig: false, importTasks: true })

    const state = useStore.getState()
    const taskIds = (await getAllTasks()).map((item) => item.id)
    const collectionIds = state.favoriteCollections.map((collection) => collection.id)
    expect(imported).toBe(true)
    expect(taskIds).toEqual(expect.arrayContaining(['regular-task-shared', 'regular-task-a', 'regular-task-b']))
    expect(taskIds.filter((id) => id === sharedTask.id)).toHaveLength(1)
    expect(await getImage('regular-image-shared')).toMatchObject({ dataUrl: 'data:image/png;base64,BQY=' })
    expect(await getImage('regular-image-a')).toMatchObject({ dataUrl: 'data:image/png;base64,AQI=' })
    expect(await getImage('regular-image-b')).toMatchObject({ dataUrl: 'data:image/png;base64,AwQ=' })
    expect(collectionIds).toEqual(expect.arrayContaining([sharedCollection.id, collectionA.id, collectionB.id]))
    expect(collectionIds.filter((id) => id === sharedCollection.id)).toHaveLength(1)
  })

  it('deduplicates shared config when merging multiple regular backups', async () => {
    const sharedProfile = createDefaultOpenAIProfile({ id: 'regular-profile-shared', name: '共享配置', apiKey: 'shared-key' })
    const profileA = createDefaultOpenAIProfile({ id: 'regular-profile-a', name: '普通配置 A', apiKey: 'key-a' })
    const profileB = createDefaultOpenAIProfile({ id: 'regular-profile-b', name: '普通配置 B', apiKey: 'key-b' })
    const backupA = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [sharedProfile, profileA], activeProfileId: profileA.id }),
    })
    const backupB = importFile({
      version: 3,
      exportedAt: new Date(1).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [sharedProfile, profileB], activeProfileId: profileB.id }),
    })

    const imported = await importData([backupA, backupB], { importConfig: true, importTasks: false })

    const apiKeys = useStore.getState().settings.profiles.map((profile) => profile.apiKey)
    expect(imported).toBe(true)
    expect(apiKeys).toEqual(expect.arrayContaining(['shared-key', 'key-a', 'key-b']))
    expect(apiKeys.filter((apiKey) => apiKey === 'shared-key')).toHaveLength(1)
  })

  it('preserves internal IDs when restoring config', async () => {
    const provider = {
      id: 'backup-provider-id',
      name: 'Backup Provider',
      submit: { path: 'v1/generate' },
    }
    const profile = createDefaultOpenAIProfile({
      id: 'backup-profile-id',
      isDefault: true,
      provider: provider.id,
      model: 'model-v1',
    })
    useStore.setState({ settings: DEFAULT_SETTINGS })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [provider], profiles: [profile], activeProfileId: profile.id }),
    }), { importConfig: true, importTasks: false })
    await useStore.getState().setPresetImportedSettings({
      customProviders: [{ id: provider.id, name: 'Backup Provider', submit: { path: 'v2/generate' } }],
      profiles: [{ ...profile, provider: provider.id, model: 'model-v2' }],
    })

    const settings = useStore.getState().settings
    expect(imported).toBe(true)
    expect(settings.customProviders[0]).toMatchObject({ id: provider.id })
    expect(settings.profiles[0]).toMatchObject({ id: profile.id })
  })

  it('restores dismissed preset provider and profile IDs explicitly included in a backup', async () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id })
    const otherProfile = createDefaultOpenAIProfile({ id: 'other-preset-profile' })
    setPresetConfig({ customProviders: [provider], profiles: [profile, otherProfile] })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [],
        profiles: [{ ...profile, provider: 'openai' }],
      }),
      dismissedPresetProviderIds: [provider.id],
      dismissedPresetProfileIds: [profile.id, 'other-preset-profile'],
    })

    try {
      const imported = await importData(importFile({
        version: 3,
        exportedAt: new Date(0).toISOString(),
        settings: normalizeSettings({
          ...DEFAULT_SETTINGS,
          customProviders: [provider],
          profiles: [profile],
          activeProfileId: profile.id,
        }),
      }), { importConfig: true, importTasks: false })

      expect(imported).toBe(true)
      expect(useStore.getState().dismissedPresetProviderIds).toEqual([])
      expect(useStore.getState().dismissedPresetProfileIds).toEqual(['other-preset-profile'])
      expect(useStore.getState().settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
      expect(useStore.getState().settings.profiles[0].provider).toBe(provider.id)
    } finally {
      setPresetConfig(null)
    }
  })

  it('preserves imported task references when restoring config into a non-empty workspace', async () => {
    await clearTasks()
    const localProfile = createDefaultFalProfile({ id: 'local-profile', apiKey: 'local-key' })
    const provider = { id: 'backup-provider', name: 'Backup Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'backup-profile', provider: provider.id, apiKey: 'backup-key' })
    const importedTask = task({ id: 'backup-task', apiProfileId: profile.id, apiProvider: provider.id })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [localProfile], activeProfileId: localProfile.id }),
      tasks: [],
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [provider], profiles: [profile], activeProfileId: profile.id }),
      tasks: [importedTask],
      imageFiles: {},
    }), { importConfig: true, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.settings.profiles.map((item) => item.id)).toEqual(expect.arrayContaining([localProfile.id, profile.id]))
    expect(getTaskApiProfile(state.settings, state.tasks.find((item) => item.id === importedTask.id)!)).toMatchObject({ id: profile.id, provider: provider.id })
  })

  it('rejects an incomplete multipart backup before importing data', async () => {
    await clearTasks()
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 1, total: 2 },
      tasks: [task({ id: 'incomplete-task' })],
      imageFiles: {},
    })

    const imported = await importData([part1], { importConfig: false, importTasks: true })

    expect(imported).toBe(false)
    expect((await getAllTasks()).some((item) => item.id === 'incomplete-task')).toBe(false)
  })

  it('validates image entries in every part before writing earlier parts', async () => {
    await clearImages()
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 1, total: 2 },
      tasks: [],
      imageFiles: { 'preflight-image-a': { path: 'images/image-a.png' } },
    }, { 'images/image-a.png': new Uint8Array([1, 2]) })
    const part2 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 2, total: 2 },
      imageFiles: { 'preflight-image-b': { path: 'images/missing.png' } },
    })

    const imported = await importData([part1, part2], { importConfig: false, importTasks: true })

    expect(imported).toBe(false)
    expect(await getImage('preflight-image-a')).toBeUndefined()
  })

  it('imports config with running tasks without requiring image parts', async () => {
    useStore.setState({ tasks: [task({ status: 'running' })] })
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'config-backup', index: 1, total: 3 },
      settings: DEFAULT_SETTINGS,
      tasks: [],
      imageFiles: { 'unused-image': { path: 'images/missing.png' } },
    })

    const imported = await importData([part1], { importConfig: true, importTasks: false })

    expect(imported).toBe(true)
  })

})

// clearFailedTasks 目前没有 UI 调用方，但仍是 store 导出；保留其测试直到有明确清理决定。
describe('gallery failed-task cleanup and filtering', () => {
  beforeEach(async () => {
    __resetTasksClearedForTests()
    await clearTasks()
  })

  it('clears only failed gallery tasks', async () => {
    const failedA = task({ id: 'failed-a', status: 'error', error: '生成失败', outputImages: ['failed-image-a'] })
    const failedB = task({ id: 'failed-b', status: 'error', error: '生成失败', outputImages: ['failed-image-b'] })
    const done = task({ id: 'done-task', status: 'done', outputImages: ['done-image'] })
    const running = task({ id: 'running-task', status: 'running', finishedAt: null, elapsed: null })
    useStore.setState({
      tasks: [failedA, done, failedB, running],
      selectedTaskIds: ['failed-a', 'done-task', 'failed-b'],
      showToast: vi.fn(),
    })

    await clearFailedTasks()

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual(['done-task', 'running-task'])
    expect(state.selectedTaskIds).toEqual(['done-task'])
    expect(state.showToast).toHaveBeenCalledWith('已删除 2 个任务', 'success')
  })

  it('matches partial failures in failed filters and searches error text', () => {
    const partial = task({
      id: 'partial-task',
      status: 'done',
      outputImages: ['done-image-a', 'done-image-b'],
      outputErrors: [{ requestIndex: 2, error: 'Failed to fetch' }],
    })

    expect(taskMatchesFilterStatus(partial, 'error')).toBe(true)
    expect(taskMatchesFilterStatus(partial, 'done')).toBe(true)
    expect(taskMatchesSearchQuery(partial, 'failed to fetch')).toBe(true)
  })

  it('clears partial failure markers without deleting successful outputs', async () => {
    const partial = task({
      id: 'partial-task',
      status: 'done',
      outputImages: ['done-image-a'],
      outputErrors: [{ requestIndex: 1, error: 'Failed to fetch' }],
    })
    useStore.setState({ tasks: [partial], selectedTaskIds: ['partial-task'], showToast: vi.fn() })

    await clearFailedTasks(['partial-task'])

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ id: 'partial-task', outputImages: ['done-image-a'], outputErrors: undefined })
    expect(state.selectedTaskIds).toEqual([])
    expect(state.showToast).toHaveBeenCalledWith('已清除 1 条部分失败记录', 'success')
  })

  it('keeps failed tasks created after the cleanup snapshot', async () => {
    const failedAtConfirmOpen = task({ id: 'failed-at-confirm-open', status: 'error', error: '生成失败' })
    const failedAfterConfirmOpen = task({ id: 'failed-after-confirm-open', status: 'error', error: '生成失败' })
    useStore.setState({ tasks: [failedAtConfirmOpen] })
    const failedTaskIds = useStore.getState().tasks
      .filter((item) => item.status === 'error')
      .map((item) => item.id)
    useStore.setState({ tasks: [failedAtConfirmOpen, failedAfterConfirmOpen] })

    await clearFailedTasks(failedTaskIds)

    expect(useStore.getState().tasks.map((item) => item.id)).toEqual(['failed-after-confirm-open'])
  })
})

describe('task deletion', () => {
  beforeEach(async () => {
    __resetTasksClearedForTests()
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    vi.mocked(callImageApi).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(commitTaskDeletion).mockReset().mockImplementation(commitTaskDeletionImplementation)
    vi.mocked(deleteDbImage).mockReset().mockImplementation(deleteDbImageImplementation)
    vi.mocked(getFalQueuedImageResult).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockReset().mockImplementation(async (dataUrl) => `transparent:${dataUrl}`)
    useStore.setState({
      tasks: [],
      selectedTaskIds: [],
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      galleryInputDraft: null,
      streamPreviews: {},
      streamPreviewSlots: {},
      detailTaskId: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('removes a deleted task from the current selection', async () => {
    const deleted = task({ id: 'task-deleted' })
    const remaining = task({ id: 'task-remaining' })
    await putDbTask(deleted)
    await putDbTask(remaining)
    useStore.setState({ tasks: [deleted, remaining], selectedTaskIds: [deleted.id, remaining.id] })

    await removeTask(deleted)

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual([remaining.id])
    expect(state.selectedTaskIds).toEqual([remaining.id])
    expect((await getAllTasks()).map((item) => item.id)).toEqual([remaining.id])
    expect(state.showToast).toHaveBeenCalledWith('任务已删除', 'success')
  })

  it('still deletes the target DB record when atomic deletion fails', async () => {
    const deleted = task({ id: 'task-deleted' })
    const remaining = task({ id: 'task-live' })
    await putDbTask(deleted)
    await putDbTask(remaining)
    useStore.setState({ tasks: [deleted, remaining] })
    vi.mocked(commitTaskDeletion).mockRejectedValueOnce(new Error('payload write failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await removeTask(deleted)

    expect((await getAllTasks()).map((item) => item.id)).toEqual([remaining.id])
    expect(warn).toHaveBeenCalledWith('原子清理任务关联数据失败，改用逐项持久化', expect.any(Error))
    warn.mockRestore()
  })

  it('restores an orphan image and thumbnail referenced during the check-delete window', async () => {
    const deleteImage = vi.mocked(deleteDbImage).getMockImplementation()!
    vi.mocked(deleteDbImage).mockImplementationOnce(async (id) => {
      await deleteImage(id)
      useStore.setState({ tasks: [task({ id: 'new-task', inputImageIds: [id] })] })
    })
    await putImage({ id: 'referenced-late', dataUrl: 'data:image/png;base64,second', createdAt: 1 })
    await putImageThumbnail({
      id: 'referenced-late',
      thumbnailDataUrl: 'data:image/webp;base64,thumb',
      width: 10,
      height: 10,
      thumbnailVersion: 2,
    })
    const deleted = task({ id: 'task-deleted', outputImages: ['referenced-late'] })
    useStore.setState({ tasks: [deleted] })

    await removeTask(deleted)

    await expect(getImage('referenced-late')).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,second' })
    await expect(getStoredFreshImageThumbnail('referenced-late')).resolves.toMatchObject({ thumbnailDataUrl: 'data:image/webp;base64,thumb' })
    expect(deleteDbImage).toHaveBeenCalledTimes(1)
  })

  it('does not open deleted gallery task details after a late rejection', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    await removeTask(useStore.getState().tasks[0])
    request.reject(new Error('late gallery rejection'))
    await request.promise.catch(() => {})

    expect(useStore.getState().tasks).toEqual([])
    expect(useStore.getState().detailTaskId).toBeNull()
  })

  it('does not schedule fal recovery after a deleted task rejects late', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    vi.mocked(callImageApi).mockImplementationOnce((opts) => {
      opts.onFalRequestEnqueued?.({ requestId: 'fal-request', endpoint: 'fal-endpoint' })
      return request.promise
    })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [falProfile], activeProfileId: falProfile.id }),
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    await removeTask(useStore.getState().tasks[0])
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    request.reject(new Error('Failed to fetch'))
    await request.promise.catch(() => {})

    expect(useStore.getState().tasks).toEqual([])
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    setTimeoutSpy.mockRestore()
  })

  it('does not schedule custom recovery after a deleted task rejects late', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const customProfile = {
      ...createDefaultOpenAIProfile({ id: 'custom-profile', apiKey: 'custom-key', apiMode: 'images' }),
      provider: 'custom-async',
    }
    vi.mocked(callImageApi).mockImplementationOnce((opts) => {
      opts.onCustomTaskEnqueued?.({ taskId: 'custom-task' })
      return request.promise
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [customProfile],
        activeProfileId: customProfile.id,
        customProviders: [{
          id: 'custom-async',
          name: 'Custom Async',
          submit: { path: 'submit', taskIdPath: 'data.id' },
          poll: {
            path: 'tasks/{task_id}',
            statusPath: 'data.status',
            successValues: ['done'],
            failureValues: ['failed'],
            result: { imageUrlPaths: ['data.images.*.url'] },
          },
        }],
      }),
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    await removeTask(useStore.getState().tasks[0])
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    request.reject(new Error('Failed to fetch'))
    await request.promise.catch(() => {})

    expect(useStore.getState().tasks).toEqual([])
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(useStore.getState().detailTaskId).toBeNull()
    setTimeoutSpy.mockRestore()
  })

  it('preserves concurrent task deletion, creation, and updates', async () => {
    const deletedA = task({ id: 'task-a' })
    const deletedB = task({ id: 'task-b' })
    const existing = task({ id: 'task-existing' })
    const created = task({ id: 'task-created' })
    await putDbTask(deletedA)
    await putDbTask(deletedB)
    await putDbTask(existing)
    useStore.setState({
      tasks: [deletedA, deletedB, existing],
      selectedTaskIds: [deletedA.id, deletedB.id],
    })
    const firstCommitStarted = deferred<void>()
    const releaseFirstCommit = deferred<void>()
    let transactionQueue = Promise.resolve()
    let commitCount = 0
    vi.mocked(commitTaskDeletion).mockImplementation((...args) => {
      const commitIndex = ++commitCount
      const transaction = transactionQueue.then(async () => {
        if (commitIndex === 1) {
          firstCommitStarted.resolve()
          await releaseFirstCommit.promise
        }
        await commitTaskDeletionImplementation(...args)
        return undefined
      })
      transactionQueue = transaction.catch(() => {})
      return transaction
    })

    const deletionA = removeTask(deletedA)
    await firstCommitStarted.promise
    useStore.setState((state) => ({
      tasks: [created, ...state.tasks.map((item) => item.id === existing.id ? { ...item, prompt: 'updated' } : item)],
    }))
    const createTask = putDbTask(created)
    const updateTask = putDbTask({ ...existing, prompt: 'updated' })
    const deletionB = removeTask(deletedB)
    releaseFirstCommit.resolve()
    await Promise.all([deletionA, deletionB, createTask, updateTask])
    await transactionQueue

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual([created.id, existing.id])
    expect(state.tasks.find((item) => item.id === existing.id)?.prompt).toBe('updated')
    expect(state.selectedTaskIds).toEqual([])
    expect(commitTaskDeletion).toHaveBeenCalledTimes(2)
    const storedTasks = await getAllTasks()
    expect(storedTasks.map((item) => item.id).sort()).toEqual([created.id, existing.id].sort())
    expect(storedTasks.find((item) => item.id === existing.id)?.prompt).toBe('updated')
  })

  it('counts duplicate and missing ids only when they match an existing task', async () => {
    const deleted = task({ id: 'task-deleted' })
    const remaining = task({ id: 'task-remaining' })
    await putDbTask(deleted)
    await putDbTask(remaining)
    useStore.setState({ tasks: [deleted, remaining], selectedTaskIds: [deleted.id, 'task-missing'] })

    await removeMultipleTasks([deleted.id, deleted.id, 'task-missing'])

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual([remaining.id])
    expect(state.selectedTaskIds).toEqual([])
    expect((await getAllTasks()).map((item) => item.id)).toEqual([remaining.id])
    expect(state.showToast).toHaveBeenCalledWith('已删除 1 个任务', 'success')
  })

  it('does not show a success toast when no task id exists', async () => {
    const showToast = vi.fn()
    useStore.setState({ selectedTaskIds: ['task-missing'], showToast })

    await removeMultipleTasks(['task-missing', 'task-missing'])
    await removeTask(task({ id: 'another-missing-task' }))

    expect(useStore.getState().selectedTaskIds).toEqual([])
    expect(showToast).not.toHaveBeenCalled()
  })

  it('removes gallery output images stored while the task is being deleted', async () => {
    const { callImageApi } = await import('./lib/api')
    const postProcess = deferred<string>()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,late-gallery-output'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockImplementationOnce(() => postProcess.promise)
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, transparentBackgroundMethod: 'local' })),
      },
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'png', transparent_output: true },
    })

    await submitTask()
    await vi.waitFor(() => expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledTimes(1))
    const runningTask = useStore.getState().tasks[0]
    expect(runningTask?.status).toBe('running')
    expect(await getAllImageIds()).toHaveLength(1)

    await removeTask(runningTask)
    postProcess.resolve('data:image/png;base64,late-transparent-output')
    await postProcess.promise
    await vi.waitFor(async () => expect(await getAllImageIds()).toEqual([]))

    expect(useStore.getState().tasks).toEqual([])
    expect(await getAllImageIds()).toEqual([])
  })

  it('removes exact-size source images stored after a gallery task is deleted', async () => {
    const { callImageApi } = await import('./lib/api')
    const postProcess = deferred<Awaited<ReturnType<typeof resizeImageDataUrlToExactSize>>>()
    vi.mocked(resizeImageDataUrlToExactSize).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,late-exact-1024x1024'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    vi.mocked(resizeImageDataUrlToExactSize).mockImplementationOnce(() => postProcess.promise)
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      appMode: 'gallery',
      prompt: 'prompt',
      params: {
        ...DEFAULT_PARAMS,
        size: '2160x3840',
        exact_size: true,
        output_format: 'png',
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(resizeImageDataUrlToExactSize).toHaveBeenCalledTimes(1))
    const runningTask = useStore.getState().tasks[0]
    await removeTask(runningTask)
    postProcess.resolve({
      dataUrl: 'data:image/png;base64,resized-2160x3840',
      sourceDataUrl: 'data:image/png;base64,source-720x1280',
      width: 2160,
      height: 3840,
      sourceWidth: 720,
      sourceHeight: 1280,
      rawSourceWidth: 1024,
      rawSourceHeight: 1024,
      sourceNormalized: true,
      resized: true,
      drawPlan: {
        mode: 'cover',
        sourceWidth: 720,
        sourceHeight: 1280,
        targetWidth: 2160,
        targetHeight: 3840,
        scale: 3,
        drawX: 0,
        drawY: 0,
        drawWidth: 2160,
        drawHeight: 3840,
        aspectMismatch: false,
      },
    })

    await vi.waitFor(async () => expect(await getAllImageIds()).toEqual([]))
    expect(useStore.getState().tasks).toEqual([])
  })

  it('clears stream previews and ignores partial images arriving after deletion', async () => {
    const { callImageApi } = await import('./lib/api')
    let emitPartialImage: () => void = () => {}
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce((opts) => {
      emitPartialImage = () => opts.onPartialImage?.({ image: 'data:image/png;base64,partial', requestIndex: 1 })
      return request.promise
    })
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    const runningTask = useStore.getState().tasks[0]
    emitPartialImage()
    expect(useStore.getState().streamPreviews[runningTask.id]).toContain('partial')
    expect(useStore.getState().streamPreviewSlots[runningTask.id]?.['1']).toContain('partial')

    await removeTask(runningTask)
    expect(useStore.getState().streamPreviews[runningTask.id]).toBeUndefined()
    expect(useStore.getState().streamPreviewSlots[runningTask.id]).toBeUndefined()
    emitPartialImage()
    expect(useStore.getState().streamPreviews[runningTask.id]).toBeUndefined()
    expect(useStore.getState().streamPreviewSlots[runningTask.id]).toBeUndefined()

    request.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await request.promise
    await vi.waitFor(() => {
      expect(useStore.getState().tasks).toEqual([])
      expect(useStore.getState().streamPreviews[runningTask.id]).toBeUndefined()
      expect(useStore.getState().streamPreviewSlots[runningTask.id]).toBeUndefined()
    })
  })

})

describe('reused task API profile', () => {
  const openaiProfile = createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'openai-key' })
  const falProfile = createDefaultFalProfile({ id: 'fal-profile', name: 'fal 配置', apiKey: 'fal-key' })

  beforeEach(async () => {
    await clearTasks()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [openaiProfile, falProfile],
        activeProfileId: openaiProfile.id,
        reuseTaskApiProfileTemporarily: true,
      }),
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('resolves a task API profile by stored profile id', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    expect(resolved?.id).toBe(falProfile.id)
  })

  it('does not resolve a task API profile by stored name or model', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({
      apiProvider: 'fal',
      apiProfileName: falProfile.name,
      apiModel: falProfile.model,
    }))

    expect(resolved).toBeNull()
  })

  it('keeps unlocked preset settings and task profile references on refresh', async () => {
    const provider = { id: 'provider-internal', name: 'Custom Provider', submit: { path: 'v1/generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'profile-internal', isDefault: true, provider: provider.id, model: 'model-v1' })
    const sourceTask = task({ apiProvider: provider.id, apiProfileId: profile.id })
    await putDbTask(sourceTask)
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [profile, openaiProfile],
        customProviders: [provider],
        activeProfileId: openaiProfile.id,
      }),
      tasks: [sourceTask],
      reusedTaskApiProfileId: profile.id,
    })

    await useStore.getState().setPresetImportedSettings({
      customProviders: [{ id: provider.id, name: provider.name, submit: { path: 'v2/generate' } }],
      profiles: [{ ...profile, provider: provider.id, model: 'model-v2' }],
    })

    const state = useStore.getState()
    expect(state.tasks[0]).toMatchObject({
      apiProfileId: profile.id,
      apiProvider: provider.id,
    })
    expect(state.settings.profiles[0]).toMatchObject({ id: profile.id, model: 'model-v1' })
    expect(state.settings.customProviders[0]).toMatchObject({ id: provider.id, submit: { path: 'generate' } })
    expect(state.reusedTaskApiProfileId).toBe(profile.id)
    expect((await getAllTasks())[0]).toMatchObject({
      apiProfileId: profile.id,
      apiProvider: provider.id,
    })
  })

  it('does not change an unlocked preset provider on refresh', async () => {
    const oldProvider = { id: 'provider-old', name: 'Old Provider', submit: { path: 'old' } }
    const profile = createDefaultOpenAIProfile({ id: 'stable-profile', isDefault: true, provider: oldProvider.id })
    const sourceTask = task({ apiProvider: oldProvider.id, apiProfileId: profile.id })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [oldProvider], profiles: [profile] }),
      tasks: [sourceTask],
    })

    await useStore.getState().setPresetImportedSettings({
      customProviders: [{ id: 'provider-new', name: 'New Provider', submit: { path: 'new' } }],
      profiles: [{ ...profile, provider: 'provider-new', model: 'model-new' }],
    })

    expect(getTaskApiProfile(useStore.getState().settings, sourceTask)).toMatchObject({
      id: profile.id,
      provider: 'provider-old',
      model: 'gpt-image-2.5-flare',
    })
  })

  it('reuses the task API profile temporarily without switching the active profile', async () => {
    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBe(falProfile.id)
    expect(state.params).toMatchObject({ n: 4, size: '1360x1024', quality: 'high' })
    expect(state.showToast).toHaveBeenCalledWith('已临时复用该任务的 API 配置「fal 配置」', 'success')
  })

  it('keeps selected image mentions when reusing a task with different current input images', async () => {
    await clearImages()
    await putImage(imageA)
    await putImage(imageB)
    const taskPrompt = `参考 ${getSelectedImageMentionLabel(1)} 生成`

    useStore.setState({
      prompt: `当前 ${getSelectedImageMentionLabel(1)}`,
      inputImages: [
        { id: 'current-x', dataUrl: 'data:image/png;base64,x' },
        { id: 'current-y', dataUrl: 'data:image/png;base64,y' },
      ],
    })

    await reuseConfig(task({
      apiProvider: 'openai',
      apiProfileId: openaiProfile.id,
      prompt: taskPrompt,
      inputImageIds: [imageA.id, imageB.id],
    }))

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])
    expect(state.prompt).toBe(taskPrompt)
  })

  it('clears temporary reuse when switching current settings to the reused API profile', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    useStore.getState().setSettings({ activeProfileId: falProfile.id })

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(falProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.reusedTaskApiProfileMissing).toBe(false)
  })

  it('normalizes reused params to the current API profile when temporary reuse is disabled', async () => {
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        reuseTaskApiProfileTemporarily: false,
      }),
    })

    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
  })

  it('preserves Codex CLI exact-size intent when reusing a 4K task', async () => {
    const codexProfile = createDefaultOpenAIProfile({
      id: 'reuse-codex-profile',
      apiKey: 'codex-key',
      codexCli: true,
    })
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [codexProfile],
        activeProfileId: codexProfile.id,
      }),
    })

    await reuseConfig(task({
      apiProfileId: codexProfile.id,
      params: { ...DEFAULT_PARAMS, size: '2160x3840', exact_size: true, quality: 'high' },
    }))

    expect(useStore.getState().params).toMatchObject({
      size: '2160x3840',
      exact_size: true,
    })
  })

  it('preserves Codex CLI exact-size intent when retrying a 4K task', async () => {
    const codexProfile = createDefaultOpenAIProfile({
      id: 'retry-codex-profile',
      apiKey: 'codex-key',
      codexCli: true,
    })
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: [],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [codexProfile],
        activeProfileId: codexProfile.id,
      }),
    })

    await retryTask(task({
      apiProfileId: codexProfile.id,
      params: { ...DEFAULT_PARAMS, size: '2160x3840', exact_size: true, quality: 'high' },
    }))

    expect(useStore.getState().tasks[0].params).toMatchObject({
      size: '2160x3840',
      exact_size: true,
    })
  })

  it('asks whether to submit with current API profile when the reused API profile is missing', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: 'missing-profile' }))

    const state = useStore.getState()
    expect(state.tasks).toEqual([])
    expect(state.setConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '找不到 API 配置',
      message: '找不到复用任务所使用的 API 配置「未知配置」，要使用当前的 API 配置「默认」提交任务吗？',
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
    }))
    expect(state.showSettings).toBe(false)
  })
})

describe('restoreLocalAutoSavePermissionOnUserActivation', () => {
  function fakePermissionHandle(opts: {
    query?: PermissionState
    request?: PermissionState
    onRequest?: (descriptor: { mode: 'readwrite' }) => void
  }): { handle: FileSystemDirectoryHandle; querySpy: ReturnType<typeof vi.fn>; requestSpy: ReturnType<typeof vi.fn> } {
    const querySpy = vi.fn(async () => opts.query as PermissionState)
    const requestSpy = vi.fn(async (descriptor: { mode: 'readwrite' }) => {
      opts.onRequest?.(descriptor)
      return opts.request as PermissionState
    })
    return {
      handle: {
        name: 'Archive',
        queryPermission: opts.query !== undefined ? querySpy : undefined,
        requestPermission: opts.request !== undefined ? requestSpy : undefined,
      } as unknown as FileSystemDirectoryHandle,
      querySpy,
      requestSpy,
    }
  }

  // 安装可控的 window 事件方法：捕获注册的监听器，测试可直接触发它。
  // jsdom 的 window 不一定把 addEventListener/dispatchEvent 作为可枚举方法暴露，
  // 所以这里显式定义到 window 上，覆盖恢复器的调用目标。
  type CapturedListener = (event: Event) => void
  function installControlledWindowEvents() {
    const listeners = new Map<string, Set<CapturedListener>>()
    const win = window as unknown as {
      addEventListener?: unknown
      removeEventListener?: unknown
    }
    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: (type: string, listener: CapturedListener) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(listener)
      },
    })
    Object.defineProperty(window, 'removeEventListener', {
      configurable: true,
      writable: true,
      value: (type: string, listener: CapturedListener) => {
        listeners.get(type)?.delete(listener)
      },
    })
    return {
      // jsdom 在每个测试间会重置 window，这里只清空捕获的监听器集合即可
      restore() {
        listeners.clear()
        win.addEventListener = undefined
        win.removeEventListener = undefined
      },
      trigger(type: string) {
        const set = listeners.get(type)
        if (!set) return
        const event = new Event(type)
        for (const listener of [...set]) listener(event)
      },
      count: () =>
        [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    }
  }

  // 触发已挂载的一次性 pointerdown 监听器并等其异步链跑完
  async function fireOneShotUserActivation(events: ReturnType<typeof installControlledWindowEvents>) {
    events.trigger('pointerdown')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    await clearLocalAutoSaveDirectoryHandle()
    vi.mocked(callImageApi).mockClear()
    vi.mocked(writeLocalAutoSaveArchive).mockClear()
    setLocalAutoSaveBrowserSupport(true)
    // 重置恢复器的 window 级挂载标志，确保每个用例从干净状态开始
    delete (window as unknown as Record<string, unknown>).__taostudioLocalAutoSaveRestoreAttached
    useStore.setState({
      settings: localAutoSaveSettings(true),
      tasks: [],
      localAutoSaveRunningTaskIds: {},
      showToast: vi.fn(),
    })
  })

  it('does nothing when local auto-save is disabled', async () => {
    useStore.setState({ settings: localAutoSaveSettings(false) })
    const { handle, querySpy, requestSpy } = fakePermissionHandle({ query: 'prompt', request: 'granted' })
    await putLocalAutoSaveDirectoryHandle(handle)

    await restoreLocalAutoSavePermissionOnUserActivation()

    expect(querySpy).not.toHaveBeenCalled()
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('does nothing when directoryName is empty', async () => {
    useStore.setState({ settings: localAutoSaveSettings(true, { directoryName: null }) })
    const { handle, querySpy, requestSpy } = fakePermissionHandle({ query: 'prompt', request: 'granted' })
    await putLocalAutoSaveDirectoryHandle(handle)

    await restoreLocalAutoSavePermissionOnUserActivation()

    expect(querySpy).not.toHaveBeenCalled()
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('does nothing when no handle is stored in IndexedDB', async () => {
    const { querySpy } = fakePermissionHandle({ query: 'prompt' })

    // 不 putLocalAutoSaveDirectoryHandle，IDB 为空

    await restoreLocalAutoSavePermissionOnUserActivation()

    expect(querySpy).not.toHaveBeenCalled()
  })

  it('does not attach listener when permission is already granted', async () => {
    const { handle, requestSpy } = fakePermissionHandle({ query: 'granted', request: 'granted' })
    await putLocalAutoSaveDirectoryHandle(handle)

    await restoreLocalAutoSavePermissionOnUserActivation()

    // granted 路径不请求权限、不挂监听器
    expect(requestSpy).not.toHaveBeenCalled()
  })

  it('attaches one-shot listener and restores on first user activation when permission is prompt', async () => {
    const showToast = vi.fn()
    useStore.setState({ showToast })
    const events = installControlledWindowEvents()
    try {
      const { handle, requestSpy } = fakePermissionHandle({ query: 'prompt', request: 'granted' })
      await putLocalAutoSaveDirectoryHandle(handle)

      await restoreLocalAutoSavePermissionOnUserActivation()

      // 监听器已挂载（pointerdown + keydown），但尚未触发权限请求
      expect(events.count()).toBeGreaterThan(0)
      expect(requestSpy).not.toHaveBeenCalled()

      await fireOneShotUserActivation(events)

      expect(requestSpy).toHaveBeenCalledWith({ mode: 'readwrite' })
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Archive'), 'success')
    } finally {
      events.restore()
    }
  })

  it('stays silent when user denies the permission prompt', async () => {
    const showToast = vi.fn()
    useStore.setState({ showToast })
    const events = installControlledWindowEvents()
    try {
      const { handle, requestSpy } = fakePermissionHandle({ query: 'prompt', request: 'denied' })
      await putLocalAutoSaveDirectoryHandle(handle)

      await restoreLocalAutoSavePermissionOnUserActivation()
      await fireOneShotUserActivation(events)

      expect(requestSpy).toHaveBeenCalledWith({ mode: 'readwrite' })
      expect(showToast).not.toHaveBeenCalled()
    } finally {
      events.restore()
    }
  })

  it('does not attach listener when permission was explicitly denied', async () => {
    const { handle, requestSpy } = fakePermissionHandle({ query: 'denied', request: 'granted' })
    await putLocalAutoSaveDirectoryHandle(handle)

    await restoreLocalAutoSavePermissionOnUserActivation()

    expect(requestSpy).not.toHaveBeenCalled()
  })
})

describe('clearData', () => {
  function fakeDirectoryHandle(name = 'Archive') {
    return { name } as unknown as FileSystemDirectoryHandle
  }

  beforeEach(async () => {
    vi.mocked(clearTasks).mockClear()
    vi.mocked(clearTasksAndAdvanceGeneration).mockClear()
    vi.mocked(clearAgentConversations).mockClear()
    vi.mocked(clearImages).mockClear()
    __resetTasksClearedForTests()
    await clearTasks()
    await clearAgentConversations()
    await clearImages()
    await clearLocalAutoSaveDirectoryHandle()
    useStore.setState({
      tasks: [],
      inputImages: [],
      maskDraft: null,
      settings: normalizeSettings(DEFAULT_SETTINGS),
      params: { ...DEFAULT_PARAMS },
      favoriteCollections: [],
      defaultFavoriteCollectionId: null,
      showToast: vi.fn(),
    })
  })

  it('clears all tasks, conversations, and images from IndexedDB and memory', async () => {
    // Populate data
    await putDbTask(task({ id: 'task-1' }))
    await putDbTask(task({ id: 'task-2' }))
    await putAgentConversation(agentConversation({ id: 'conv-1' }))
    await putAgentConversation(agentConversation({ id: 'conv-2' }))
    await putImage({ id: 'img-a', dataUrl: 'data:image/png;base64,aaa', source: 'upload', createdAt: 1 })
    await putImage({ id: 'img-b', dataUrl: 'data:image/png;base64,bbb', source: 'generated', createdAt: 2 })

    // Verify populated
    expect((await getAllTasks()).length).toBe(2)
    expect((await getAllAgentConversations()).length).toBe(2)
    expect((await getAllImageIds()).length).toBe(2)

    useStore.setState({
      tasks: [task({ id: 'task-1' }), task({ id: 'task-2' })],
    })

    // Clear
    await clearData({ clearTasks: true, clearConfig: false })

    // IndexedDB must be empty（agent 会话表随清空一并清理）
    expect((await getAllTasks()).length).toBe(0)
    expect((await getAllAgentConversations()).length).toBe(0)
    expect((await getAllImageIds()).length).toBe(0)

    // Memory must be empty
    expect(useStore.getState().tasks.length).toBe(0)

    // Toast must report success
    expect(useStore.getState().showToast).toHaveBeenCalledWith('所选数据已清空', 'success')
  })

  it('initStore finds nothing after full clear (simulated page reload)', async () => {
    // Populate data via IndexedDB
    await putDbTask(task({ id: 'task-1', prompt: 'test prompt' }))
    await putAgentConversation(agentConversation({ id: 'conv-1' }))
    await putImage({ id: 'img-1', dataUrl: 'data:image/png;base64,xxx', source: 'generated', createdAt: 1 })

    useStore.setState({
      tasks: [task({ id: 'task-1', prompt: 'test prompt' })],
    })

    // Clear everything
    await clearData({ clearTasks: true, clearConfig: true })

    // Simulate page reload: initStore should find nothing（含一次性清理后的 agent 会话表）
    await initStore()

    expect(useStore.getState().tasks.length).toBe(0)
    expect((await getAllTasks()).length).toBe(0)
    expect((await getAllAgentConversations()).length).toBe(0)
  })

  it('clears config without touching tasks when clearTasks is false', async () => {
    await putDbTask(task({ id: 'task-1' }))
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('Saved Archive'))
    useStore.setState({
      tasks: [task({ id: 'task-1' })],
      settings: localAutoSaveSettings(true, { directoryName: 'Saved Archive' }),
    })

    await clearData({ clearTasks: false, clearConfig: true })

    // Tasks must survive
    expect(useStore.getState().tasks.length).toBe(1)
    expect((await getAllTasks()).length).toBe(1)

    // Config must be reset
    expect(await getLocalAutoSaveDirectoryHandle()).toBeUndefined()
    expect(useStore.getState().settings.localAutoSave.directoryName).toBeNull()
  })

  it('clears tasks without touching config when clearConfig is false', async () => {
    await putDbTask(task({ id: 'task-1' }))
    await putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('Saved Archive'))
    useStore.setState({
      tasks: [task({ id: 'task-1' })],
      settings: localAutoSaveSettings(true, { directoryName: 'Saved Archive' }),
    })

    await clearData({ clearTasks: true, clearConfig: false })

    // Tasks must be gone
    expect(useStore.getState().tasks.length).toBe(0)
    expect((await getAllTasks()).length).toBe(0)

    // Config must survive
    const handle = await getLocalAutoSaveDirectoryHandle()
    expect(handle).toBeDefined()
    expect(handle!.name).toBe('Saved Archive')
  })

  it('reports partial failure when task clear throws', async () => {
    // 让第一次 clearTasks 调用抛出异常，模拟 IndexedDB 事务失败
    vi.mocked(clearTasksAndAdvanceGeneration).mockRejectedValueOnce(new DOMException('QuotaExceededError', 'QuotaExceededError'))

    await clearData({ clearTasks: true, clearConfig: false })

    expect(useStore.getState().showToast).toHaveBeenCalledWith(
      '部分数据清空失败，可重试清空；若持续失败请使用「重建数据库」',
      'error',
    )
  })

  it('reports partial failure when images clear throws', async () => {
    vi.mocked(clearImages).mockRejectedValueOnce(new Error('IndexedDB connection lost'))

    await clearData({ clearTasks: true, clearConfig: false })

    expect(useStore.getState().showToast).toHaveBeenCalledWith(
      '部分数据清空失败，可重试清空；若持续失败请使用「重建数据库」',
      'error',
    )
  })

  it('does not show error toast when all clears succeed', async () => {
    await putDbTask(task({ id: 'task-1' }))
    useStore.setState({ tasks: [task({ id: 'task-1' })] })

    await clearData({ clearTasks: true, clearConfig: false })

    expect(useStore.getState().showToast).toHaveBeenCalledWith('所选数据已清空', 'success')
    expect(useStore.getState().showToast).not.toHaveBeenCalledWith(
      '部分数据清空失败，可重试清空；若持续失败请使用「重建数据库」',
      'error',
    )
  })

  it('cancels pending fal recovery timers so cleared tasks do not resurrect', async () => {
    // Setup a fal profile and a recoverable fal task
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [falProfile], activeProfileId: falProfile.id }),
      showToast: vi.fn(),
    })
    const falTask = task({
      id: 'fal-recoverable-task',
      apiProvider: 'fal',
      apiProfileId: 'fal-profile',
      apiProfileName: 'fal',
      apiModel: 'fal-model',
      status: 'error',
      error: '连接已断开，等待自动恢复',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      finishedAt: null,
      elapsed: null,
    })
    await putDbTask(falTask)
    // initStore schedules a fal recovery timer (delayMs=0)
    await initStore()

    // Clear data — this must cancel the pending recovery timer
    await clearData({ clearTasks: true, clearConfig: false })

    // Make getFalQueuedImageResult return a result so that IF the timer
    // were still alive, it would write data back.
    vi.mocked(getFalQueuedImageResult).mockResolvedValueOnce({
      images: ['data:image/png;base64,resurrected'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })

    // Flush all pending timers + microtasks
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    // The task must NOT have been resurrected
    expect((await getAllTasks()).length).toBe(0)
    expect(useStore.getState().tasks.length).toBe(0)
    // getFalQueuedImageResult should not have been called after clear
    expect(vi.mocked(getFalQueuedImageResult)).not.toHaveBeenCalled()
  })

  it('cancels pending custom recovery timers so cleared tasks do not resurrect', async () => {
    const customTask = task({
      id: 'custom-recoverable-task',
      apiProvider: 'custom',
      customTaskId: 'custom-request-id',
      status: 'error',
      error: '连接已断开，等待自动恢复',
      customRecoverable: true,
      finishedAt: null,
      elapsed: null,
    })
    await putDbTask(customTask)
    await initStore()

    await clearData({ clearTasks: true, clearConfig: false })

    // Flush timers
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect((await getAllTasks()).length).toBe(0)
  })

  it('does not resurrect a gallery task when its in-flight generation resolves after clear', async () => {
    // 用一个可控的 callImageApi，模拟"生成已发起 → 用户清除 → 生成回调返回"的时序
    const apiDeferred = deferred<{ images: string[]; actualParams: Record<string, unknown>; actualParamsList: Array<Partial<Record<string, unknown>>>; revisedPrompts: (string | null)[] }>()
    vi.mocked(callImageApi).mockReturnValueOnce(apiDeferred.promise as ReturnType<typeof callImageApi>)
    useStore.setState({
      settings: localAutoSaveSettings(false, { enabled: false }),
      prompt: '测试提示词',
      params: { ...DEFAULT_PARAMS },
      inputImages: [],
      maskDraft: null,
      tasks: [],
      showToast: vi.fn(),
    })

    await submitTask() // 创建 running 任务并触发 executeTask（卡在 callImageApi）
    expect(useStore.getState().tasks.length).toBe(1)
    expect(useStore.getState().tasks[0].status).toBe('running')

    // 用户在此期间清除了数据
    await clearData({ clearTasks: true, clearConfig: false })
    expect(useStore.getState().tasks.length).toBe(0)
    expect((await getAllTasks()).length).toBe(0)

    // 记录清除后 IDB put 调用次数
    const putCallsBeforeResolve = vi.mocked(putDbTask).mock.calls.length

    // 生成回调返回，executeTask 尝试 storeTaskOutputImages + updateTaskInStore + putTask
    apiDeferred.resolve({
      images: ['data:image/png;base64,resurrected'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })

    // 等待所有微任务/宏任务落定
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    // 关键断言：任务不得复活（内存与 IDB 均为空）
    expect(useStore.getState().tasks.length).toBe(0)
    expect((await getAllTasks()).length).toBe(0)
    // 清除后不应再有任务被写入 IndexedDB（putTask 守卫生效）
    expect(vi.mocked(putDbTask).mock.calls.length).toBe(putCallsBeforeResolve)
  })

  it('does not write to IndexedDB when putTask runs after clear even if a task lingers in memory', async () => {
    await clearData({ clearTasks: true, clearConfig: false })
    expect((await getAllTasks()).length).toBe(0)

    // 模拟飞行中回调闭包仍持有任务引用：手动把一个"运行中"任务放回内存。
    // （飞行中的流式回调闭包就是这种场景。）
    const lingeringTask = task({ id: 'lingering-task', status: 'running', finishedAt: null, elapsed: null })
    useStore.setState({ tasks: [lingeringTask] })

    const putCallsBefore = vi.mocked(putDbTask).mock.calls.length
    // 回调尝试把它标记为完成并写入 —— putTask 必须因 tasksCleared 成为空操作
    updateTaskInStore('lingering-task', { status: 'done', outputImages: ['img-1'] })

    // 关键断言：clearData 之后，putTask 不得写入 IndexedDB
    expect(vi.mocked(putDbTask).mock.calls.length).toBe(putCallsBefore)
    expect((await getAllTasks()).length).toBe(0)
  })

  it('allows new task writes after clear via initStore reset (autosave unaffected)', async () => {
    // 清除数据（仅任务，保留配置 → 自动保存目录句柄不清理）
    const handle = fakeDirectoryHandle('AutoArchive')
    await putLocalAutoSaveDirectoryHandle(handle)
    useStore.setState({ settings: localAutoSaveSettings(true, { directoryName: 'AutoArchive' }) })
    await putDbTask(task({ id: 'old-task' }))
    useStore.setState({ tasks: [task({ id: 'old-task' })] })

    await clearData({ clearTasks: true, clearConfig: false })
    expect((await getAllTasks()).length).toBe(0)
    expect(useStore.getState().tasks.length).toBe(0)

    // 清任务不应影响自动保存目录句柄（autosave 功能完整）
    const dirHandle = await getLocalAutoSaveDirectoryHandle()
    expect(dirHandle).toBeDefined()
    expect(useStore.getState().settings.localAutoSave.enabled).toBe(true)

    // initStore 重置清除标志后，重新写入的任务能正常加载，putTask 不再被阻止
    __resetTasksClearedForTests() // 模拟页面刷新后 initStore 的重置
    await initStore()
    await putDbTask(task({ id: 'fresh-task', prompt: 'fresh' }))
    await initStore()
    expect(useStore.getState().tasks.some((t) => t.id === 'fresh-task')).toBe(true)

    // 清除后正常生成的新任务，自动保存应能更新其状态（不报错、不复活旧数据）
    useStore.setState({
      tasks: [task({ id: 'fresh-task', status: 'done', outputImages: [], localAutoSave: { status: 'pending' } })],
    })
    await runLocalAutoSaveForTask('fresh-task')
    // fresh-task 仍在，旧任务未复活
    expect(useStore.getState().tasks.length).toBe(1)
    expect(useStore.getState().tasks[0].id).toBe('fresh-task')
  })
})

describe('image cleanup plan (#20)', () => {
  const NOW = 2_000_000_000_000
  const OLD = NOW - 40 * 24 * 60 * 60 * 1000

  it('counts failed-task partials and stale original copies, excluding protected outputs', async () => {
    const { getCleanupPlan } = await import('./store')
    const tasks: TaskRecord[] = [
      task({
        id: 'cleanup-failed',
        status: 'error',
        createdAt: NOW,
        streamPartialImageIds: ['partial-1', 'partial-2'],
      }),
      task({
        id: 'cleanup-stale',
        status: 'done',
        createdAt: OLD,
        transparentOriginalImages: ['trans-copy-1'],
        exactSizeOriginalImages: ['exact-copy-1', 'exact-copy-2'],
        outputImages: ['exact-copy-1'], // 受保护：同时是输出图
      }),
      task({
        id: 'cleanup-fresh',
        status: 'done',
        createdAt: NOW,
        transparentOriginalImages: ['fresh-copy'], // 未满 30 天，不算
      }),
    ]
    const plan = getCleanupPlan(tasks, NOW)
    expect(plan.failedPartialCount).toBe(2)
    // trans-copy-1 + exact-copy-2（exact-copy-1 受保护被排除）
    expect(plan.staleOriginalCopyCount).toBe(2)
    expect(plan.taskCount).toBe(2)
  })

  it('runImageCleanup removes orphaned images and strips task references', async () => {
    const dbModule = await import('./lib/db')
    const { runImageCleanup } = await import('./store')
    const deleteSpy = vi.spyOn(dbModule, 'deleteImage')

    const tasks: TaskRecord[] = [
      task({
        id: 'cleanup-target',
        status: 'error',
        createdAt: NOW,
        streamPartialImageIds: ['partial-a'],
        outputImages: ['out-a'],
      }),
    ]
    useStore.setState({ tasks, showToast: vi.fn() })
    const removed = await runImageCleanup(useStore.getState().tasks)

    expect(removed).toBe(1)
    expect(deleteSpy).toHaveBeenCalledWith('partial-a')
    expect(deleteSpy).not.toHaveBeenCalledWith('out-a')
    const updated = useStore.getState().tasks.find((t) => t.id === 'cleanup-target')
    expect(updated?.streamPartialImageIds).toBeUndefined()
    expect(updated?.outputImages).toEqual(['out-a'])

    deleteSpy.mockRestore()
  })
})

describe('prompt reverse source orphan cleanup', () => {
  it('replacing or clearing the reverse source deletes unreferenced upload images', async () => {
    const dbModule = await import('./lib/db')
    const { useStore } = await import('./store')
    const { id: a } = await dbModule.storeImageWithSize('data:image/png;base64,AAA-100x100', 'upload')
    const { id: b } = await dbModule.storeImageWithSize('data:image/png;base64,BBB-100x100', 'upload')
    const { setPromptReverseSource } = useStore.getState()

    setPromptReverseSource({ imageId: a })
    setPromptReverseSource({ imageId: b })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await dbModule.getImage(a)).toBeUndefined()
    expect(await dbModule.getImage(b)).toBeDefined()

    setPromptReverseSource(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await dbModule.getImage(b)).toBeUndefined()
  })

  it('keeps task-referenced images when the reverse source is replaced or cleared', async () => {
    const dbModule = await import('./lib/db')
    const { useStore } = await import('./store')
    const { id } = await dbModule.storeImageWithSize('data:image/png;base64,CCC-100x100', 'upload')
    useStore.setState({ tasks: [task({ id: 'reverse-ref-task', outputImages: [id] })] })

    useStore.getState().setPromptReverseSource({ imageId: id })
    useStore.getState().setPromptReverseSource(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await dbModule.getImage(id)).toBeDefined()

    useStore.setState({ tasks: [] })
  })
})

describe('prompt reverse drop-zone state', () => {
  it('opening the drop zone (imageId null) does not trigger cleanup; transitioning through it recycles the old image', async () => {
    const dbModule = await import('./lib/db')
    const { useStore } = await import('./store')
    const { id: a } = await dbModule.storeImageWithSize('data:image/png;base64,DDD-100x100', 'upload')
    const { id: b } = await dbModule.storeImageWithSize('data:image/png;base64,EEE-100x100', 'upload')

    // 落区打开：null → {a}
    useStore.getState().setPromptReverseSource({ imageId: null })
    useStore.getState().setPromptReverseSource({ imageId: a })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await dbModule.getImage(a)).toBeDefined()

    // 换一张回落区：{a} → null（a 应被回收）
    useStore.getState().setPromptReverseSource({ imageId: null })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await dbModule.getImage(a)).toBeUndefined()

    // 落区粘贴新图：null → {b}
    useStore.getState().setPromptReverseSource({ imageId: b })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await dbModule.getImage(b)).toBeDefined()

    // 关闭：{b} → null（b 应被回收）
    useStore.getState().setPromptReverseSource(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await dbModule.getImage(b)).toBeUndefined()
  })
})

describe('场景 actions 与保存链', () => {
  // 场景句柄 Map 在 db mock 中跨测试持久（Task 3 事实），需显式清到空起始。
  async function clearAllSceneDirectoryHandles() {
    for (const record of await listSceneDirectoryHandles()) {
      await clearSceneDirectoryHandle(record.id.slice(SCENE_DIRECTORY_KEY_PREFIX.length))
    }
  }

  function sceneSettings(sceneSaveDirectoryNames: Partial<Record<'portrait' | 'general' | 'sticker' | 'skill', string>> = {}) {
    const profile = createDefaultOpenAIProfile({ id: 'scene-settings-profile', apiKey: 'test-key' })
    return normalizeSettings({
      ...DEFAULT_SETTINGS,
      apiKey: 'test-key',
      profiles: [profile],
      activeProfileId: profile.id,
      localAutoSave: {
        enabled: true,
        directoryName: 'GlobalArchive',
        lastSavedAt: null,
        lastSavedFolderName: null,
      },
      scenes: Object.fromEntries(
        Object.entries(sceneSaveDirectoryNames).map(([sceneId, directoryName]) => [
          sceneId,
          { saveDirectoryName: directoryName },
        ]),
      ),
    })
  }

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    await clearLocalAutoSaveDirectoryHandle()
    await clearAllSceneDirectoryHandles()
    vi.mocked(callImageApi).mockClear()
    vi.mocked(putDbTask).mockClear()
    vi.mocked(writeLocalAutoSaveArchive).mockClear()
    const testWindow = getLocalAutoSaveTestWindow()
    Object.defineProperty(testWindow, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(testWindow.navigator, 'userAgentData', {
      configurable: true,
      value: undefined,
    })
    useStore.setState({
      settings: sceneSettings(),
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      localAutoSaveRunningTaskIds: {},
      gallerySceneFilter: 'general',
      // T1 场景草稿隔离：sceneDrafts 跨测试持久会串味（上一用例的草稿被下一用例当成"已有草稿"载入），
      // 与 prompt/inputImages 一起显式重置，保证每个用例都从"首次进入"语义开始。
      prompt: '',
      inputImages: [],
      sceneDrafts: {},
      showToast: vi.fn(),
    })
  })

  afterEach(async () => {
    // 场景句柄 Map 跨测试持久：结束时也清一次，避免泄漏到文件内后续新增的用例
    await clearAllSceneDirectoryHandles()
  })

  it('setActiveScene 切换场景并应用默认参数、重置画廊过滤', () => {
    useStore.setState({
      settings: normalizeSettings({
        scenes: { sticker: { defaults: { ratio: '1:1', tier: '1K', transparentBackground: true } } },
      }),
      params: { ...DEFAULT_PARAMS },
    })
    useStore.getState().setActiveScene('sticker')
    expect(useStore.getState().settings.activeScene).toBe('sticker')
    expect(useStore.getState().gallerySceneFilter).toBe('sticker')
    expect(useStore.getState().params.transparent_output).toBe(true)
    expect(useStore.getState().params.size).toBe(calculateImageSize('1K', '1:1'))
  })

  it('场景默认 transparentBackground:false 时，setActiveScene 强制关闭已开启的 transparent_output', () => {
    useStore.setState({
      settings: normalizeSettings({
        scenes: { sticker: { defaults: { transparentBackground: false } } },
      }),
      params: { ...DEFAULT_PARAMS, transparent_output: true, output_format: 'png' },
    })
    useStore.getState().setActiveScene('sticker')
    expect(useStore.getState().params.transparent_output).toBe(false)
  })

  it('setActiveScene 不重复触发同场景切换', () => {
    useStore.setState({
      settings: normalizeSettings({
        scenes: { sticker: { defaults: { ratio: '1:1', tier: '1K' } } },
      }),
      params: { ...DEFAULT_PARAMS, size: '1536x1024' },
      gallerySceneFilter: 'all',
    })
    // activeScene 默认 general → sticker 会应用默认参数
    useStore.getState().setActiveScene('sticker')
    expect(useStore.getState().params.size).toBe(calculateImageSize('1K', '1:1'))

    // sticker → sticker：场景与参数都不再变化（用户手动改过的 size 不被覆盖）
    useStore.setState({ params: { ...DEFAULT_PARAMS, size: '1024x1536' } })
    useStore.getState().setActiveScene('sticker')
    expect(useStore.getState().settings.activeScene).toBe('sticker')
    expect(useStore.getState().params.size).toBe('1024x1536')
  })

  it('setActiveScene 同场景重复调用修复漂移的画廊过滤，但不重放默认参数', () => {
    useStore.setState({
      settings: normalizeSettings({
        activeScene: 'sticker',
        scenes: { sticker: { defaults: { ratio: '1:1', tier: '1K' } } },
      }),
      params: { ...DEFAULT_PARAMS, size: '1024x1536' },
      gallerySceneFilter: 'all',
    })

    // 刷新后 filter 漂移到 all（或别的场景）时，再点当前场景 Tab 只同步过滤、不重放默认参数
    useStore.getState().setActiveScene('sticker')

    expect(useStore.getState().settings.activeScene).toBe('sticker')
    expect(useStore.getState().gallerySceneFilter).toBe('sticker')
    expect(useStore.getState().params.size).toBe('1024x1536')
  })

  it('initStore 刷新后画廊过滤跟随持久化恢复的 activeScene', async () => {
    // 模拟刷新：activeScene 由 persist 恢复为 portrait，filter 停在初始 general
    useStore.setState({
      settings: { ...sceneSettings(), activeScene: 'portrait' },
      gallerySceneFilter: 'general',
    })

    await initStore()

    expect(useStore.getState().settings.activeScene).toBe('portrait')
    expect(useStore.getState().gallerySceneFilter).toBe('portrait')
  })

  it('场景配置 actions 只更新目标场景字段', () => {
    const profile = createDefaultOpenAIProfile({ id: 'scene-bind-profile', apiKey: 'test-key' })
    useStore.setState({
      settings: normalizeSettings({ profiles: [profile], activeProfileId: profile.id }),
    })

    useStore.getState().setSceneImageProfileId('portrait', profile.id)
    useStore.getState().setSceneTextProfileId('portrait', null)
    useStore.getState().setSceneDefaults('sticker', { ratio: '3:4', tier: '2K' })

    const scenes = useStore.getState().settings.scenes
    expect(scenes.portrait.imageProfileId).toBe('scene-bind-profile')
    expect(scenes.portrait.textProfileId).toBeNull()
    expect(scenes.sticker.defaults).toMatchObject({ ratio: '3:4', tier: '2K' })
    expect(scenes.general.imageProfileId).toBeNull()
    expect(scenes.general.defaults.ratio).toBeUndefined()
  })

  it('setSceneImageOverrides merge 进目标场景，不动其他字段与其他场景', () => {
    const profile = createDefaultOpenAIProfile({ id: 'scene-override-profile', apiKey: 'test-key' })
    useStore.setState({
      settings: normalizeSettings({
        profiles: [profile],
        activeProfileId: profile.id,
        scenes: {
          portrait: {
            imageProfileId: profile.id,
            imageProviderId: 'openai',
            imageModelOverride: 'old-model',
            imageGenerationModelOverride: 'old-igm',
            saveDirectoryName: null,
            defaults: { ratio: '3:4' },
          },
        },
      }),
    })

    useStore.getState().setSceneImageOverrides('portrait', { imageProviderId: 'custom-x' })

    const portrait = useStore.getState().settings.scenes.portrait
    // 未出现在 patch 中的字段原样保留
    expect(portrait.imageProfileId).toBe('scene-override-profile')
    expect(portrait.imageModelOverride).toBe('old-model')
    expect(portrait.imageGenerationModelOverride).toBe('old-igm')
    expect(portrait.defaults).toEqual({ ratio: '3:4' })
    expect(portrait.saveDirectoryName).toBeNull()
    // patch 字段被覆盖
    expect(portrait.imageProviderId).toBe('custom-x')

    // 支持清空单个字段，其余不动
    useStore.getState().setSceneImageOverrides('portrait', { imageModelOverride: null })
    expect(useStore.getState().settings.scenes.portrait.imageModelOverride).toBeNull()
    expect(useStore.getState().settings.scenes.portrait.imageProviderId).toBe('custom-x')

    // 其他场景不受影响
    expect(useStore.getState().settings.scenes.general.imageProviderId).toBeNull()
    expect(useStore.getState().settings.scenes.general.imageModelOverride).toBeNull()
  })

  it('setGallerySceneFilter 支持 all 与具体场景', () => {
    useStore.getState().setGallerySceneFilter('all')
    expect(useStore.getState().gallerySceneFilter).toBe('all')
    useStore.getState().setGallerySceneFilter('portrait')
    expect(useStore.getState().gallerySceneFilter).toBe('portrait')
  })

  it('selectSceneSaveDirectory 选择目录后写入场景句柄与场景设置，不动全局目录', async () => {
    const sceneDirectory = fakeDirectoryHandle('StickerFolder')
    const picker = setLocalAutoSaveBrowserSupport(true, vi.fn(async () => sceneDirectory))

    await useStore.getState().selectSceneSaveDirectory('sticker')

    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(await getSceneDirectoryHandle('sticker')).toMatchObject({ handle: sceneDirectory, name: 'StickerFolder' })
    expect(useStore.getState().settings.scenes.sticker.saveDirectoryName).toBe('StickerFolder')
    // 全局目录与全局 localAutoSave 设置不受场景选择影响
    expect(await getLocalAutoSaveDirectoryHandle()).toBeUndefined()
    expect(useStore.getState().settings.localAutoSave.directoryName).toBe('GlobalArchive')
    expect(useStore.getState().showToast).toHaveBeenCalledWith('场景保存位置已设置', 'success')
  })

  it('selectSceneSaveDirectory 在不支持的浏览器提示且不抛错', async () => {
    const unsupportedPicker = setLocalAutoSaveBrowserSupport(false)

    await useStore.getState().selectSceneSaveDirectory('sticker')

    expect(unsupportedPicker).not.toHaveBeenCalled()
    expect(await getSceneDirectoryHandle('sticker')).toBeUndefined()
    expect(useStore.getState().settings.scenes.sticker.saveDirectoryName).toBeNull()
    expect(useStore.getState().showToast).toHaveBeenCalledWith('本地自动保存仅支持桌面 Chrome/Edge', 'error')
  })

  it('clearSceneSaveDirectory 清除场景句柄与场景设置', async () => {
    const sceneDirectory = fakeDirectoryHandle('StickerFolder')
    await putSceneDirectoryHandle('sticker', sceneDirectory)
    useStore.setState({ settings: sceneSettings({ sticker: 'StickerFolder' }) })

    await useStore.getState().clearSceneSaveDirectory('sticker')

    expect(await getSceneDirectoryHandle('sticker')).toBeUndefined()
    expect(useStore.getState().settings.scenes.sticker.saveDirectoryName).toBeNull()
  })

  it('场景句柄可用时，任务落盘收到场景句柄', async () => {
    const globalDirectory = fakeDirectoryHandle('GlobalArchive')
    const sceneDirectory = fakeDirectoryHandle('StickerFolder')
    await putLocalAutoSaveDirectoryHandle(globalDirectory)
    await putSceneDirectoryHandle('sticker', sceneDirectory)
    await putImage(localAutoSaveImage())
    useStore.setState({ settings: sceneSettings({ sticker: 'StickerFolder' }) })
    const sceneTask = localAutoSaveTask({ id: 'scene-save-task', sceneId: 'sticker' })
    useStore.getState().setTasks([sceneTask])

    await runLocalAutoSaveForTask(sceneTask.id)

    expect(writeLocalAutoSaveArchive).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeLocalAutoSaveArchive).mock.calls[0]?.[0]).toMatchObject({ rootHandle: sceneDirectory })
    expect(useStore.getState().tasks[0].localAutoSave).toMatchObject({ status: 'saved' })
  })

  it('场景句柄缺失时，任务落盘回落全局句柄', async () => {
    const globalDirectory = fakeDirectoryHandle('GlobalArchive')
    await putLocalAutoSaveDirectoryHandle(globalDirectory)
    await putImage(localAutoSaveImage())
    useStore.setState({ settings: sceneSettings() })
    const sceneTask = localAutoSaveTask({ id: 'scene-fallback-task', sceneId: 'sticker' })
    useStore.getState().setTasks([sceneTask])

    await runLocalAutoSaveForTask(sceneTask.id)

    expect(writeLocalAutoSaveArchive).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeLocalAutoSaveArchive).mock.calls[0]?.[0]).toMatchObject({ rootHandle: globalDirectory })
    expect(useStore.getState().tasks[0].localAutoSave).toMatchObject({ status: 'saved' })
  })

  it('场景句柄目录名与设置不一致时，清除场景句柄并回落全局', async () => {
    const globalDirectory = fakeDirectoryHandle('GlobalArchive')
    const renamedDirectory = fakeDirectoryHandle('RenamedElsewhere')
    await putLocalAutoSaveDirectoryHandle(globalDirectory)
    await putSceneDirectoryHandle('sticker', renamedDirectory)
    await putImage(localAutoSaveImage())
    useStore.setState({ settings: sceneSettings({ sticker: 'StickerFolder' }) })
    const sceneTask = localAutoSaveTask({ id: 'scene-mismatch-task', sceneId: 'sticker' })
    useStore.getState().setTasks([sceneTask])

    await runLocalAutoSaveForTask(sceneTask.id)

    expect(vi.mocked(writeLocalAutoSaveArchive).mock.calls[0]?.[0]).toMatchObject({ rootHandle: globalDirectory })
    expect(await getSceneDirectoryHandle('sticker')).toBeUndefined()
    expect(useStore.getState().settings.scenes.sticker.saveDirectoryName).toBeNull()
  })

  it('authorizeAllLocalAutoSaveDirectories：全局句柄缺失但场景句柄授权成功，返回 true 并补跑 pending 归档', async () => {
    const requestPermission = vi.fn(async () => 'granted' as PermissionState)
    const sceneHandle = {
      name: 'StickerFolder',
      queryPermission: vi.fn(async () => 'prompt' as PermissionState),
      requestPermission,
    } as unknown as FileSystemDirectoryHandle
    await putSceneDirectoryHandle('sticker', sceneHandle)
    await putImage(localAutoSaveImage())
    // 无全局目录配置（directoryName 为空、IndexedDB 无全局句柄），只有场景目录
    const settings = sceneSettings({ sticker: 'StickerFolder' })
    useStore.setState({
      settings: { ...settings, localAutoSave: { ...settings.localAutoSave, directoryName: null } },
      tasks: [localAutoSaveTask({
        id: 'scene-needs-permission-task',
        sceneId: 'sticker',
        localAutoSave: { status: 'needs_permission', error: '需要重新授权保存位置' },
      })],
    })

    await expect(useStore.getState().authorizeAllLocalAutoSaveDirectories()).resolves.toBe(true)

    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(writeLocalAutoSaveArchive).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeLocalAutoSaveArchive).mock.calls[0]?.[0]).toMatchObject({ rootHandle: sceneHandle })
    expect(useStore.getState().tasks[0].localAutoSave).toMatchObject({ status: 'saved' })
    expect(useStore.getState().showToast).toHaveBeenCalledWith('保存位置已重新授权', 'success')
  })

  it('authorizeAllLocalAutoSaveDirectories：全部句柄拒绝授权时返回 false 且不写盘', async () => {
    const sceneHandle = {
      name: 'StickerFolder',
      queryPermission: vi.fn(async () => 'prompt' as PermissionState),
      requestPermission: vi.fn(async () => 'denied' as PermissionState),
    } as unknown as FileSystemDirectoryHandle
    await putSceneDirectoryHandle('sticker', sceneHandle)
    const settings = sceneSettings({ sticker: 'StickerFolder' })
    useStore.setState({
      settings: { ...settings, localAutoSave: { ...settings.localAutoSave, directoryName: null } },
      tasks: [localAutoSaveTask({ id: 'scene-denied-task', sceneId: 'sticker', localAutoSave: { status: 'needs_permission' } })],
    })

    await expect(useStore.getState().authorizeAllLocalAutoSaveDirectories()).resolves.toBe(false)

    expect(writeLocalAutoSaveArchive).not.toHaveBeenCalled()
    expect(useStore.getState().tasks[0].localAutoSave).toMatchObject({ status: 'needs_permission' })
    expect(useStore.getState().showToast).toHaveBeenCalledWith('未获得文件夹写入权限，请允许后重试', 'error')
  })
})

describe('场景草稿隔离（T1 sceneDrafts）', () => {
  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        profiles: [createDefaultOpenAIProfile({ id: 'scene-draft-profile', apiKey: 'test-key' })],
        activeProfileId: 'scene-draft-profile',
        apiKey: 'test-key',
        scenes: {
          portrait: { defaults: { ratio: '3:4', tier: '2K' } },
          sticker: { defaults: { ratio: '1:1', tier: '1K' } },
        },
      }),
      params: { ...DEFAULT_PARAMS },
      prompt: '',
      inputImages: [],
      galleryInputDraft: null,
      sceneDrafts: {},
      appMode: 'gallery',
      gallerySceneFilter: 'general',
      maskDraft: null,
      maskEditorImageId: null,
      showToast: vi.fn(),
    })
  })

  it('切走场景保存草稿，切回整体恢复 prompt/params/输入图', () => {
    useStore.getState().setActiveScene('portrait')
    useStore.getState().setPrompt('人像提示词')
    useStore.getState().addInputImage(imageA)
    useStore.getState().setParams({ quality: 'high', n: 3 })

    // 切到 sticker：portrait 草稿保存，sticker 首次进入为空白工作区（不带出 portrait 的参数）
    useStore.getState().setActiveScene('sticker')
    expect(useStore.getState().prompt).toBe('')
    expect(useStore.getState().inputImages).toEqual([])
    expect(useStore.getState().params.quality).toBe('auto')
    expect(useStore.getState().params.n).toBe(1)
    expect(useStore.getState().params.size).toBe(calculateImageSize('1K', '1:1'))
    expect(useStore.getState().sceneDrafts.portrait).toMatchObject({
      prompt: '人像提示词',
      params: { quality: 'high', n: 3 },
      inputImageIds: [imageA.id],
    })

    // 切回 portrait：prompt/params/输入图全量恢复（同会话内存 memo，dataUrl 同步可用）
    useStore.getState().setActiveScene('portrait')
    expect(useStore.getState().prompt).toBe('人像提示词')
    expect(useStore.getState().params).toMatchObject({
      quality: 'high',
      n: 3,
      size: calculateImageSize('2K', '3:4'),
    })
    expect(useStore.getState().inputImages).toEqual([imageA])
  })

  it('首次进入场景：prompt/图片置空，params 以 DEFAULT_PARAMS+场景 defaults 初始化', () => {
    useStore.setState({
      prompt: '通用创作的提示词',
      inputImages: [imageA],
      params: { ...DEFAULT_PARAMS, quality: 'max', size: '1024x1024' },
    })
    useStore.getState().setActiveScene('portrait')

    expect(useStore.getState().prompt).toBe('')
    expect(useStore.getState().inputImages).toEqual([])
    expect(useStore.getState().params).toEqual({ ...DEFAULT_PARAMS, size: calculateImageSize('2K', '3:4') })
    // 离开的 general 场景草稿已保存，不丢用户内容
    expect(useStore.getState().sceneDrafts.general).toMatchObject({
      prompt: '通用创作的提示词',
      params: { quality: 'max', size: '1024x1024' },
      inputImageIds: [imageA.id],
    })
  })

  it('迁移：升级后首次启动把全局草稿归属当前场景，首次切换不清空用户草稿', async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    // 模拟老版本升级：只有全局 prompt/params/inputImages，没有 sceneDrafts
    useStore.setState({
      prompt: '升级前的全局草稿',
      params: { ...DEFAULT_PARAMS, quality: 'max' },
      inputImages: [imageA],
      sceneDrafts: {},
    })

    await initStore()

    expect(useStore.getState().sceneDrafts.general).toMatchObject({
      prompt: '升级前的全局草稿',
      params: { quality: 'max' },
      inputImageIds: [imageA.id],
    })

    useStore.getState().setActiveScene('portrait')
    expect(useStore.getState().prompt).toBe('')
    useStore.getState().setActiveScene('general')
    expect(useStore.getState().prompt).toBe('升级前的全局草稿')
    expect(useStore.getState().params.quality).toBe('max')
    expect(useStore.getState().inputImages).toEqual([imageA])
  })

  it('skill 场景不保存也不载入草稿，底部输入区状态在进出时保持', () => {
    useStore.setState({
      prompt: '通用草稿',
      params: { ...DEFAULT_PARAMS, quality: 'high' },
      inputImages: [imageA],
    })

    useStore.getState().setActiveScene('skill')
    // skill 有独立输入区：全局输入原样保留，不存草稿键
    expect(useStore.getState().prompt).toBe('通用草稿')
    expect(useStore.getState().params.quality).toBe('high')
    expect(useStore.getState().inputImages).toEqual([imageA])
    expect((useStore.getState().sceneDrafts as Record<string, unknown>).skill).toBeUndefined()

    useStore.getState().setActiveScene('general')
    // 离开 skill 没有保存草稿；进入 general 恢复的是离开 general 时保存的草稿
    expect(useStore.getState().prompt).toBe('通用草稿')
    expect(useStore.getState().params.quality).toBe('high')
    expect(useStore.getState().inputImages).toEqual([imageA])
    expect(Object.keys(useStore.getState().sceneDrafts)).not.toContain('skill')
  })

  it('engine 模式下切换场景：草稿隔离照常生效，galleryInputDraft 不被改写', () => {
    useStore.setState({
      appMode: 'engine',
      galleryInputDraft: { prompt: '引擎前的画廊草稿', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: 1 },
    })
    useStore.getState().setActiveScene('portrait')
    expect(useStore.getState().galleryInputDraft?.prompt).toBe('引擎前的画廊草稿')
    expect(useStore.getState().prompt).toBe('')
  })

  it('刷新后切回场景：草稿图片按 id 从 IndexedDB 水合；已不存在的图片被丢弃', async () => {
    await clearImages()
    await putImage({ id: 'scene-hydrate-image', dataUrl: 'data:image/png;base64,hydrate', source: 'upload', createdAt: 1 })
    // 模拟 persist 恢复后的形态：草稿只有 id 引用（无 dataUrl），当前停在 general（输入为空）
    useStore.setState({
      sceneDrafts: {
        portrait: {
          prompt: '刷新前的提示词',
          params: { ...DEFAULT_PARAMS, quality: 'high' },
          inputImageIds: ['scene-hydrate-image', 'scene-missing-image'],
        },
      },
    })

    useStore.getState().setActiveScene('portrait')
    expect(useStore.getState().prompt).toBe('刷新前的提示词')
    // 同步阶段先按 id 恢复占位，dataUrl 由异步水合补齐
    expect(useStore.getState().inputImages).toEqual([
      { id: 'scene-hydrate-image', dataUrl: '' },
      { id: 'scene-missing-image', dataUrl: '' },
    ])

    await vi.waitFor(() => {
      expect(useStore.getState().inputImages).toEqual([
        { id: 'scene-hydrate-image', dataUrl: 'data:image/png;base64,hydrate' },
      ])
    })
  })

  it('切换场景后遮罩目标图不在新场景输入中时清除遮罩', () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: { targetImageId: imageA.id, maskDataUrl: 'data:image/png;base64,mask', updatedAt: 1 },
      maskEditorImageId: imageA.id,
    })
    useStore.getState().setActiveScene('portrait')
    expect(useStore.getState().maskDraft).toBeNull()
    expect(useStore.getState().maskEditorImageId).toBeNull()

    // general 草稿只存了图片引用，没有遮罩
    useStore.getState().setActiveScene('general')
    expect(useStore.getState().inputImages.map((img) => img.id)).toEqual([imageA.id])
    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('持久化语义：sceneDrafts 跟随 persistInputOnRestart 保存（仅 id 引用，不含 skill 键）', () => {
    useStore.setState({ prompt: '草稿', inputImages: [imageA] })
    useStore.getState().setActiveScene('portrait')

    const persisted = getPersistedState(useStore.getState())
    expect(persisted.sceneDrafts?.general).toMatchObject({ prompt: '草稿', inputImageIds: [imageA.id] })
    expect(persisted.sceneDrafts && 'skill' in persisted.sceneDrafts).toBe(false)

    useStore.setState({ settings: { ...useStore.getState().settings, persistInputOnRestart: false } })
    expect(getPersistedState(useStore.getState())).not.toHaveProperty('sceneDrafts')
  })

  it('持久化恢复：normalizePersistedState 校验 sceneDrafts 字段并丢弃 skill/非法场景键', () => {
    const restored = normalizePersistedState({
      settings: { ...DEFAULT_SETTINGS },
      params: { ...DEFAULT_PARAMS },
      sceneDrafts: {
        general: {
          prompt: '持久化草稿',
          params: { ...DEFAULT_PARAMS, quality: 'high' },
          inputImageIds: ['img-1', 42, null],
        },
        skill: { prompt: '不应恢复', params: { ...DEFAULT_PARAMS }, inputImageIds: [] },
        bogus: { prompt: '非法场景键', params: { ...DEFAULT_PARAMS }, inputImageIds: [] },
      },
    }, useStore.getState())!

    expect(restored.sceneDrafts.general).toEqual({
      prompt: '持久化草稿',
      params: { ...DEFAULT_PARAMS, quality: 'high' },
      inputImageIds: ['img-1'],
    })
    expect(Object.keys(restored.sceneDrafts)).toEqual(['general'])
  })
})

describe('场景 provider 覆盖执行链（Fix Round 1）', () => {
  // openai 当前 + sb2api-async（内置异步自定义 provider，带 poll/taskIdPath）草稿：
  // 全局切换过服务商再切回的真实形态；场景覆盖到 sb2api-async。
  const SB2API_ASYNC = getCustomProviderDefinition({}, 'sb2api-async')!

  function buildAsyncOverrideSettings() {
    const base = createDefaultOpenAIProfile({ id: 'scene-exec-profile', name: '场景执行配置', apiKey: 'openai-key' })
    let onAsync = switchApiProfileProvider(base, 'sb2api-async', SB2API_ASYNC ?? undefined)
    onAsync = { ...onAsync, baseUrl: 'https://async.example.com/v1', apiKey: 'async-key', model: 'async-model' }
    const profileWithDraft = switchApiProfileProvider(onAsync, 'openai')
    return normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [profileWithDraft],
      activeProfileId: profileWithDraft.id,
      activeScene: 'skill',
      scenes: {
        skill: {
          imageProfileId: profileWithDraft.id,
          imageProviderId: 'sb2api-async',
          imageModelOverride: null,
          imageGenerationModelOverride: null,
        },
      },
    })
  }

  function resetExecutionState(overrides: Partial<ReturnType<typeof useStore.getState>> = {}) {
    useStore.setState({
      settings: buildAsyncOverrideSettings(),
      prompt: '场景覆盖执行链',
      params: { ...DEFAULT_PARAMS },
      inputImages: [],
      maskDraft: null,
      tasks: [],
      showToast: vi.fn(),
      ...overrides,
    })
  }

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    vi.mocked(callImageApi).mockClear()
    vi.mocked(putDbTask).mockClear()
    vi.mocked(getCustomQueuedImageResult).mockClear()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('场景覆盖为异步自定义 provider：执行链走异步轮询路径，不调度 OpenAI 看门狗（晚到成功不丢）', async () => {
    vi.useFakeTimers()
    const apiDeferred = deferred<{ images: string[]; actualParams: Record<string, unknown>; actualParamsList: Array<Partial<Record<string, unknown>>>; revisedPrompts: (string | null)[] }>()
    vi.mocked(callImageApi).mockReturnValueOnce(apiDeferred.promise as ReturnType<typeof callImageApi>)
    resetExecutionState()

    await submitTask()
    expect(useStore.getState().tasks.length).toBe(1)
    const taskId = useStore.getState().tasks[0].id
    // 打点侧（请求链）：任务快照记录覆盖后 provider
    expect(useStore.getState().tasks[0].apiProvider).toBe('sb2api-async')
    await vi.advanceTimersByTimeAsync(0) // 让 executeTask 跑到 callImageApi 挂起

    // 推进超过看门狗全窗口（timeout 600s + 宽限 1830s）：若执行链误挂 raw provider
    // （openai），会调度 OpenAI 看门狗并在此误杀排队/轮询中的任务。
    await vi.advanceTimersByTimeAsync(600_000 + (600 * 4 + 30 - 600) * 1000 + 1_000)
    const midTask = useStore.getState().tasks.find((t) => t.id === taskId)
    expect(midTask?.status).toBe('running')
    expect(useStore.getState().showToast).not.toHaveBeenCalledWith('OpenAI 任务请求超时', 'error')

    // 晚到的成功结果不丢（看门狗误杀后这里会停留在 error 且图片被清理）
    apiDeferred.resolve({
      images: ['data:image/png;base64,11x11'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    await vi.advanceTimersByTimeAsync(0)
    const doneTask = useStore.getState().tasks.find((t) => t.id === taskId)
    expect(doneTask?.status).toBe('done')
    expect(doneTask?.outputImages.length).toBe(1)
  })

  it('场景覆盖为异步自定义 provider：capRequestSize 用覆盖后 provider 判定，4K 请求不收口；isAsyncCustomTask 正确分类', async () => {
    vi.mocked(callImageApi).mockImplementationOnce(async (opts) => {
      opts.onCustomTaskEnqueued?.({ taskId: 'async-queued-task-1' })
      return {
        images: ['data:image/png;base64,11x11'],
        actualParams: {},
        actualParamsList: [],
        revisedPrompts: ['接口改写后的提示词'],
      } as Awaited<ReturnType<typeof callImageApi>>
    })
    resetExecutionState({ params: { ...DEFAULT_PARAMS, size: '3072x2048', exact_size: true } })

    await submitTask()
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

    const doneTask = useStore.getState().tasks[0]
    expect(doneTask.status).toBe('done')
    expect(doneTask.customTaskId).toBe('async-queued-task-1')

    // 执行侧传给请求链的 settings 与请求链同源：场景解析后 provider 是覆盖值
    const requestSettings = vi.mocked(callImageApi).mock.calls[0][0].settings
    expect(getSceneImageApiProfile(requestSettings, 'skill').provider).toBe('sb2api-async')
    // capRequestSize 用覆盖后 provider：openai 才收口 4K → 此处保持原尺寸
    const requestParams = vi.mocked(callImageApi).mock.calls[0][0].params
    expect(requestParams.size).toBe('3072x2048')
    expect(requestParams.exact_size).toBe(true)
    // isAsyncCustomTask 分类正确（openai 误分类会把接口改写提示词存成 revisedPromptByImage）
    expect(doneTask.revisedPromptByImage).toBeUndefined()
  })

  it('getCustomRecoveryProfile 覆盖场景可解析：断网恢复轮询拿到覆盖后的 profile 而非被相等性检查禁用', async () => {
    vi.useFakeTimers()
    vi.mocked(callImageApi).mockImplementationOnce(async (opts) => {
      opts.onCustomTaskEnqueued?.({ taskId: 'async-queued-task-2' })
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    vi.mocked(getCustomQueuedImageResult).mockResolvedValueOnce({
      images: ['data:image/png;base64,9x9'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    resetExecutionState()

    await submitTask()
    await vi.advanceTimersByTimeAsync(0) // 请求 AbortError → customRecoverable + 10s 恢复定时器
    const errorTask = useStore.getState().tasks[0]
    expect(errorTask.status).toBe('error')
    expect(errorTask.customRecoverable).toBe(true)
    expect(errorTask.customTaskId).toBe('async-queued-task-2')

    await vi.advanceTimersByTimeAsync(10_000) // CUSTOM_RECOVERY_POLL_MS

    // 恢复链用覆盖后的 profile（sb2api-async + 草稿 baseUrl）成功轮询并恢复任务；
    // 若 raw profile 参与 taskProfile.provider === task.apiProvider 相等性检查，恢复会被禁用。
    expect(vi.mocked(getCustomQueuedImageResult)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(getCustomQueuedImageResult).mock.calls[0][0]).toMatchObject({
      provider: 'sb2api-async',
      baseUrl: 'https://async.example.com/v1',
      apiKey: 'async-key',
    })
    const recoveredTask = useStore.getState().tasks[0]
    expect(recoveredTask.status).toBe('done')
    expect(recoveredTask.customRecoverable).toBe(false)
  })

  it('任务场景未引用该配置时守卫不命中：仍走 raw provider 语义（OpenAI 看门狗正常调度，覆盖不跨场景泄漏）', async () => {
    vi.useFakeTimers()
    const apiDeferred = deferred<{ images: string[]; actualParams: Record<string, unknown>; actualParamsList: Array<Partial<Record<string, unknown>>>; revisedPrompts: (string | null)[] }>()
    vi.mocked(callImageApi).mockReturnValueOnce(apiDeferred.promise as ReturnType<typeof callImageApi>)
    // skill 场景引用 P 并覆盖 sb2api-async；但 activeScene=general（未引用具体配置）→
    // 任务打点用全局激活链（raw openai），守卫不命中，执行链保持 raw provider 语义。
    const settings = buildAsyncOverrideSettings()
    resetExecutionState({ settings: normalizeSettings({ ...settings, activeScene: 'general', scenes: { skill: settings.scenes.skill } }) })

    await submitTask()
    expect(useStore.getState().tasks[0].apiProvider).toBe('openai')
    await vi.advanceTimersByTimeAsync(0)

    // raw openai 任务照常调度看门狗：推进全窗口后按超时失败（守卫修复不改变非覆盖路径）
    await vi.advanceTimersByTimeAsync(600_000 + (600 * 4 + 30 - 600) * 1000 + 1_000)
    const timedOutTask = useStore.getState().tasks[0]
    expect(timedOutTask.status).toBe('error')
    expect(timedOutTask.error).toContain('请求超时')
    expect(useStore.getState().showToast).toHaveBeenCalledWith('OpenAI 任务请求超时', 'error')
  })
})


// ===== Skill 工坊 store 链（P2 Task 4）=====

function skillSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: 'builtin-skill',
    name: '内置 Skill',
    description: '内置描述',
    source: 'builtin',
    body: 'SKILL 正文',
    ...overrides,
  }
}

function skillFrontmatterMarkdown(name: string, description: string) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# 正文标题\n\n正文内容`
}

/** 本地目录扫描 fake：无 SKILL.md 时 getFileHandle 抛 NotFoundError，模拟真实句柄语义 */
function fakeSkillDirectory(name: string, files: Record<string, string>) {
  return {
    kind: 'directory',
    name,
    getFileHandle: async (fileName: string) => {
      if (!(fileName in files)) throw new DOMException('NotFoundError', 'NotFoundError')
      return {
        kind: 'file',
        name: fileName,
        getFile: async () => ({ text: async () => files[fileName] }) as unknown as File,
      }
    },
  } as unknown as FileSystemDirectoryHandle
}

function fakeSkillsRoot(entries: Array<[string, FileSystemHandle]>) {
  return {
    kind: 'directory',
    name: 'skills-root',
    // 同步迭代器满足 for-await 的降级协议，真实句柄的 entries() 是异步迭代器
    entries: () => entries[Symbol.iterator]() as unknown as AsyncIterableIterator<[string, FileSystemHandle]>,
  } as unknown as FileSystemDirectoryHandle
}

describe('Skill 工坊 store 链', () => {
  const BUILTIN_SKILL_A = 'vibeshot-candid-photography'
  const BUILTIN_SKILL_B = 'voyeur-style-photographer'
  let fetchMock: ReturnType<typeof vi.spyOn> | null = null

  beforeEach(() => {
    // store 为模块级单例，工坊 state 跨用例残留会互相污染
    useStore.setState({
      skills: { builtin: [], builtinLoading: false, local: [], localRootName: null, scanning: false },
      activeSkillId: null,
      skillInputDraft: '',
      skillExpansion: { status: 'idle', error: null, entries: [] },
    })
  })

  afterEach(() => {
    fetchMock?.mockRestore()
    fetchMock = null
    vi.mocked(callSkillExpansionApi).mockClear()
    vi.mocked(putSkillsRootDirectoryHandle).mockClear()
    vi.mocked(clearSkillsRootDirectoryHandle).mockClear()
  })

  it('loadBuiltinSkills：并行加载内置 skill，解析 frontmatter 并自动选中第一个', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const path = String(url)
      if (path.includes(BUILTIN_SKILL_A)) return new Response(skillFrontmatterMarkdown('Vibeshot 抓拍', '生活感人像'), { status: 200 })
      if (path.includes(BUILTIN_SKILL_B)) return new Response(skillFrontmatterMarkdown('', '偷窥风格描述'), { status: 200 })
      return new Response('not found', { status: 404 })
    })

    await useStore.getState().loadBuiltinSkills()

    const { builtin, builtinLoading } = useStore.getState().skills
    expect(builtin).toHaveLength(2)
    expect(builtin[0]).toMatchObject({ id: BUILTIN_SKILL_A, name: 'Vibeshot 抓拍', description: '生活感人像', source: 'builtin' })
    expect(builtin[0].body).toContain('正文内容')
    // frontmatter name 为空时回退目录名
    expect(builtin[1].name).toBe(BUILTIN_SKILL_B)
    expect(builtinLoading).toBe(false)
    expect(useStore.getState().activeSkillId).toBe(BUILTIN_SKILL_A)
  })

  it('loadBuiltinSkills：单个内置 skill 加载失败时静默跳过，其余照常', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes(BUILTIN_SKILL_A)) throw new Error('network down')
      return new Response(skillFrontmatterMarkdown('Voyeur 风格', '偷窥风格描述'), { status: 200 })
    })

    await useStore.getState().loadBuiltinSkills()

    expect(useStore.getState().skills.builtin.map((skill) => skill.id)).toEqual([BUILTIN_SKILL_B])
    expect(useStore.getState().skills.builtinLoading).toBe(false)
  })

  it('loadBuiltinSkills：已有选中 skill 时再次加载不覆盖用户选择', async () => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      if (String(url).includes(BUILTIN_SKILL_A)) return new Response(skillFrontmatterMarkdown('Vibeshot 抓拍', '生活感人像'), { status: 200 })
      if (String(url).includes(BUILTIN_SKILL_B)) return new Response(skillFrontmatterMarkdown('Voyeur 风格', '偷窥风格描述'), { status: 200 })
      return new Response('not found', { status: 404 })
    })

    await useStore.getState().loadBuiltinSkills()
    expect(useStore.getState().activeSkillId).toBe(BUILTIN_SKILL_A)

    // 用户手动切到 B 后再次加载（组件重挂载等场景）：不得把选中拉回第一个
    useStore.getState().setActiveSkill(BUILTIN_SKILL_B)
    await useStore.getState().loadBuiltinSkills()

    expect(useStore.getState().skills.builtin).toHaveLength(2)
    expect(useStore.getState().activeSkillId).toBe(BUILTIN_SKILL_B)
  })

  it('runSkillExpansion：无文本模型配置时进入 error 且文案引导设置，不调 API', async () => {
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS }),
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '主题：夜市',
      skillExpansion: { status: 'idle', error: null, entries: [] },
      showToast: vi.fn(),
    })

    await useStore.getState().runSkillExpansion()

    const expansion = useStore.getState().skillExpansion
    expect(expansion.status).toBe('error')
    expect(expansion.error).toContain('未找到可用的文本模型配置')
    expect(expansion.error).toContain('设置')
    expect(callSkillExpansionApi).not.toHaveBeenCalled()
  })

  it('runSkillExpansion：成功扩写后解析为全 enabled 条目且状态回 idle', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'text-profile', apiKey: 'test-key', apiMode: 'responses' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [textProfile], activeProfileId: textProfile.id, textApiProfileId: textProfile.id }),
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '主题：夜市拿铁',
      skillExpansion: { status: 'idle', error: null, entries: [] },
      showToast: vi.fn(),
    })
    vi.mocked(callSkillExpansionApi).mockResolvedValueOnce('### 01\n第一条夜市提示词内容\n\n### 02\n第二条拿铁提示词内容')

    await useStore.getState().runSkillExpansion()

    expect(callSkillExpansionApi).toHaveBeenCalledWith(expect.objectContaining({
      skillBody: 'SKILL 正文',
      userInput: '主题：夜市拿铁',
    }))
    const expansion = useStore.getState().skillExpansion
    expect(expansion.status).toBe('idle')
    expect(expansion.error).toBeNull()
    expect(expansion.entries.map((entry) => entry.text)).toEqual(['第一条夜市提示词内容', '第二条拿铁提示词内容'])
    expect(expansion.entries.every((entry) => entry.enabled)).toBe(true)
  })

  it('runSkillExpansion：API 报错时进入 error 并保留原因', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'text-profile', apiKey: 'test-key', apiMode: 'responses' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [textProfile], activeProfileId: textProfile.id, textApiProfileId: textProfile.id }),
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '主题：夜市',
      skillExpansion: { status: 'idle', error: null, entries: [] },
      showToast: vi.fn(),
    })
    vi.mocked(callSkillExpansionApi).mockRejectedValueOnce(new Error('Skill 扩写接口未返回文本内容'))

    await useStore.getState().runSkillExpansion()

    expect(useStore.getState().skillExpansion.status).toBe('error')
    expect(useStore.getState().skillExpansion.error).toContain('未返回文本内容')
  })

  it('runSkillExpansion：校验失败（输入为空）时进入 error 且保留既有条目', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'text-profile', apiKey: 'test-key', apiMode: 'responses' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [textProfile], activeProfileId: textProfile.id, textApiProfileId: textProfile.id }),
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '   ',
      skillExpansion: {
        status: 'idle',
        error: null,
        entries: [{ id: 'entry-1', text: '已扩写的条目', enabled: true }],
      },
      showToast: vi.fn(),
    })

    await useStore.getState().runSkillExpansion()

    const expansion = useStore.getState().skillExpansion
    expect(expansion.status).toBe('error')
    expect(expansion.error).toContain('请输入锚点内容')
    // 校验失败不动 entries：保留已扩写结果供用户改输入后重试
    expect(expansion.entries).toEqual([{ id: 'entry-1', text: '已扩写的条目', enabled: true }])
    expect(callSkillExpansionApi).not.toHaveBeenCalled()
  })

  it('runSkillExpansion：重复触发时旧请求被 abort，后 resolve 的旧结果不回写', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'text-profile', apiKey: 'test-key', apiMode: 'responses' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [textProfile], activeProfileId: textProfile.id, textApiProfileId: textProfile.id }),
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '主题：夜市',
      skillExpansion: { status: 'idle', error: null, entries: [] },
      showToast: vi.fn(),
    })

    let resolveSlow!: (value: string) => void
    vi.mocked(callSkillExpansionApi).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveSlow = resolve }),
    )
    const slowRun = useStore.getState().runSkillExpansion()
    expect(useStore.getState().skillExpansion.status).toBe('running')

    // 第二次触发：应 abort 第一次的请求并接管「最新 run」
    vi.mocked(callSkillExpansionApi).mockImplementationOnce(async () => '### 01\n第二次扩写条目内容')
    await useStore.getState().runSkillExpansion()
    expect(useStore.getState().skillExpansion.entries.map((entry) => entry.text)).toEqual(['第二次扩写条目内容'])

    // 第一次请求此时才 resolve：守卫应拦截回写，状态不得被拉乱
    resolveSlow('### 01\n第一次过期扩写条目内容')
    await slowRun

    const expansion = useStore.getState().skillExpansion
    expect(expansion.status).toBe('idle')
    expect(expansion.error).toBeNull()
    expect(expansion.entries.map((entry) => entry.text)).toEqual(['第二次扩写条目内容'])
  })

  it('abortSkillExpansion：中断在飞请求立即回 idle 清空条目，孤儿结果后到不回写', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'text-profile', apiKey: 'test-key', apiMode: 'responses' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [textProfile], activeProfileId: textProfile.id, textApiProfileId: textProfile.id }),
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '主题：夜市',
      skillExpansion: { status: 'idle', error: null, entries: [] },
      showToast: vi.fn(),
    })

    let resolveInFlight!: (value: string) => void
    vi.mocked(callSkillExpansionApi).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveInFlight = resolve }),
    )
    const inFlight = useStore.getState().runSkillExpansion()
    expect(useStore.getState().skillExpansion.status).toBe('running')

    useStore.getState().abortSkillExpansion()
    expect(useStore.getState().skillExpansion.status).toBe('idle')
    expect(useStore.getState().skillExpansion.entries).toEqual([])

    // 在飞请求最终 resolve：不得把过期结果写回
    resolveInFlight('### 01\n过期扩写条目内容')
    await inFlight

    const expansion = useStore.getState().skillExpansion
    expect(expansion.status).toBe('idle')
    expect(expansion.entries).toEqual([])
  })

  it('setActiveSkill：切换 skill 时中止在飞扩写，过期结果后到不回写', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'text-profile', apiKey: 'test-key', apiMode: 'responses' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [textProfile], activeProfileId: textProfile.id, textApiProfileId: textProfile.id }),
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '主题：夜市',
      skillExpansion: { status: 'idle', error: null, entries: [] },
      showToast: vi.fn(),
    })

    let resolveInFlight!: (value: string) => void
    vi.mocked(callSkillExpansionApi).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveInFlight = resolve }),
    )
    const inFlight = useStore.getState().runSkillExpansion()
    expect(useStore.getState().skillExpansion.status).toBe('running')

    // 切换到另一个 skill：在飞扩写应被 abort 并重置为空状态
    useStore.getState().setActiveSkill('skill-b')
    expect(useStore.getState().activeSkillId).toBe('skill-b')
    expect(useStore.getState().skillExpansion).toEqual({ status: 'idle', error: null, entries: [] })
    const captured = vi.mocked(callSkillExpansionApi).mock.calls[0]?.[0]
    expect(captured?.signal?.aborted).toBe(true)

    // 在飞请求最终 resolve：过期结果不得写回新 skill 的扩写状态
    resolveInFlight('### 01\n过期扩写条目内容')
    await inFlight

    const expansion = useStore.getState().skillExpansion
    expect(expansion.status).toBe('idle')
    expect(expansion.error).toBeNull()
    expect(expansion.entries).toEqual([])
  })

  it('setActiveSkill：同 id 重复调用不中断在飞扩写，结果照常回写', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'text-profile', apiKey: 'test-key', apiMode: 'responses' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [textProfile], activeProfileId: textProfile.id, textApiProfileId: textProfile.id }),
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '主题：夜市',
      skillExpansion: { status: 'idle', error: null, entries: [] },
      showToast: vi.fn(),
    })

    let resolveInFlight!: (value: string) => void
    vi.mocked(callSkillExpansionApi).mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveInFlight = resolve }),
    )
    const inFlight = useStore.getState().runSkillExpansion()
    expect(useStore.getState().skillExpansion.status).toBe('running')

    // 同 id 重复点击：幂等返回，不 abort 在飞扩写、不重置状态
    useStore.getState().setActiveSkill('builtin-skill')
    expect(useStore.getState().skillExpansion.status).toBe('running')
    const captured = vi.mocked(callSkillExpansionApi).mock.calls[0]?.[0]
    expect(captured?.signal?.aborted).toBe(false)

    resolveInFlight('### 01\n正常扩写条目内容')
    await inFlight

    const expansion = useStore.getState().skillExpansion
    expect(expansion.status).toBe('idle')
    expect(expansion.entries.map((entry) => entry.text)).toEqual(['正常扩写条目内容'])
    expect(useStore.getState().activeSkillId).toBe('builtin-skill')
  })

  it('setActiveSkill 切换 skill 时重置扩写条目，updateSkillEntry/removeSkillEntry 精确增改', () => {
    useStore.setState({
      activeSkillId: 'skill-a',
      skillExpansion: {
        status: 'idle',
        error: null,
        entries: [
          { id: 'entry-1', text: '第一条', enabled: true },
          { id: 'entry-2', text: '第二条', enabled: true },
        ],
      },
    })

    useStore.getState().setActiveSkill('skill-b')
    expect(useStore.getState().activeSkillId).toBe('skill-b')
    expect(useStore.getState().skillExpansion).toEqual({ status: 'idle', error: null, entries: [] })

    // 切换后重建条目，验证条目级增改不受 skill 切换影响
    useStore.setState({
      skillExpansion: {
        status: 'idle',
        error: null,
        entries: [
          { id: 'entry-1', text: '第一条', enabled: true },
          { id: 'entry-2', text: '第二条', enabled: true },
        ],
      },
    })
    useStore.getState().updateSkillEntry('entry-1', { text: '改写后的提示词', enabled: false })
    expect(useStore.getState().skillExpansion.entries[0]).toEqual({ id: 'entry-1', text: '改写后的提示词', enabled: false })
    expect(useStore.getState().skillExpansion.entries[1].text).toBe('第二条')

    useStore.getState().removeSkillEntry('entry-1')
    expect(useStore.getState().skillExpansion.entries.map((entry) => entry.id)).toEqual(['entry-2'])
  })

  it('generateFromSkillEntries：逐条目提交生成任务并携带 skill 溯源与 skill 场景', async () => {
    const imageProfile = createDefaultOpenAIProfile({ id: 'image-profile', apiKey: 'test-key' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [imageProfile], activeProfileId: imageProfile.id, activeScene: 'skill' }),
      prompt: '',
      params: { ...DEFAULT_PARAMS },
      inputImages: [],
      maskDraft: null,
      tasks: [],
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '锚点输入原文',
      skillExpansion: {
        status: 'idle',
        error: null,
        entries: [
          { id: 'entry-1', text: '第一条生成提示词', enabled: true },
          { id: 'entry-2', text: '被禁用的提示词', enabled: false },
          { id: 'entry-3', text: '第三条生成提示词', enabled: true },
        ],
      },
      showToast: vi.fn(),
    })

    await useStore.getState().generateFromSkillEntries()

    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(2)
    // setPrompt → submitTask 顺序提交，画廊最新在前
    expect(tasks.map((task) => task.prompt)).toEqual(['第三条生成提示词', '第一条生成提示词'])
    for (const task of tasks) {
      expect(task.skillId).toBe('builtin-skill')
      expect(task.skillInput).toBe('锚点输入原文')
      expect(task.sceneId).toBe('skill')
    }
    expect(useStore.getState().showToast).toHaveBeenCalledWith('已提交 2 个生成任务', 'success')
  })

  it('generateFromSkillEntries：提交前清空画廊遗留参考图与遮罩，任务保持纯文生图', async () => {
    const imageProfile = createDefaultOpenAIProfile({ id: 'image-profile', apiKey: 'test-key' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [imageProfile], activeProfileId: imageProfile.id, activeScene: 'skill' }),
      prompt: '',
      params: { ...DEFAULT_PARAMS },
      // 模拟用户在画廊挂了参考图与遮罩但未提交，随后切到工坊批量生成
      inputImages: [imageA],
      maskDraft: { targetImageId: imageA.id, maskDataUrl: 'data:image/png;base64,mask', updatedAt: 1 },
      tasks: [],
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '锚点输入原文',
      skillExpansion: {
        status: 'idle',
        error: null,
        entries: [{ id: 'entry-1', text: '第一条生成提示词', enabled: true }],
      },
      showToast: vi.fn(),
    })

    await useStore.getState().generateFromSkillEntries()

    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(1)
    // 提交的任务不含参考图/遮罩字段：不会变成计费编辑请求
    expect(tasks[0].inputImageIds).toEqual([])
    expect(tasks[0].maskImageId).toBeNull()
    expect(tasks[0].maskTargetImageId).toBeNull()
    // skill 溯源字段不受影响
    expect(tasks[0].skillId).toBe('builtin-skill')
    expect(tasks[0].skillInput).toBe('锚点输入原文')
    expect(tasks[0].sceneId).toBe('skill')
    // 全局输入态已被清空
    expect(useStore.getState().inputImages).toEqual([])
    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('generateFromSkillEntries：没有 enabled 条目时 toast 提示且零提交', async () => {
    const imageProfile = createDefaultOpenAIProfile({ id: 'image-profile', apiKey: 'test-key' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [imageProfile], activeProfileId: imageProfile.id, activeScene: 'skill' }),
      tasks: [],
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '锚点输入原文',
      skillExpansion: {
        status: 'idle',
        error: null,
        entries: [{ id: 'entry-1', text: '被禁用的提示词', enabled: false }],
      },
      showToast: vi.fn(),
    })

    await useStore.getState().generateFromSkillEntries()

    expect(useStore.getState().tasks).toHaveLength(0)
    expect(useStore.getState().showToast).toHaveBeenCalledWith('没有已启用的提示词条目', 'error')
  })

  it('generateFromSkillEntries：单条提交抛错时中断循环并 toast 失败位置，不产生 unhandled rejection', async () => {
    const imageProfile = createDefaultOpenAIProfile({ id: 'image-profile', apiKey: 'test-key' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [imageProfile], activeProfileId: imageProfile.id, activeScene: 'skill' }),
      prompt: '',
      params: { ...DEFAULT_PARAMS },
      inputImages: [],
      maskDraft: null,
      tasks: [],
      skills: { ...useStore.getState().skills, builtin: [skillSummary()] },
      activeSkillId: 'builtin-skill',
      skillInputDraft: '锚点输入原文',
      skillExpansion: {
        status: 'idle',
        error: null,
        entries: [
          { id: 'entry-1', text: '第一条生成提示词', enabled: true },
          { id: 'entry-2', text: '第二条生成提示词', enabled: true },
        ],
      },
      showToast: vi.fn(),
    })
    const dbModule = await import('./lib/db')
    vi.mocked(putDbTask).mockRejectedValueOnce(new dbModule.StorageQuotaError({ imageId: 'quota-task-1' }))

    await useStore.getState().generateFromSkillEntries()

    // 第 1 条提交即抛错：循环中断，第 2 条不再提交（任务记录在 persist 前已入列，保留可见）
    const tasks = useStore.getState().tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0].prompt).toBe('第一条生成提示词')
    expect(useStore.getState().showToast).toHaveBeenCalledWith('已提交 0 个生成任务（第 1 条提交失败）', 'error')
    expect(useStore.getState().showToast).not.toHaveBeenCalledWith('已提交 2 个生成任务', 'success')
  })

  it('importSkillsRootDirectory：选目录后扫描一级子目录 SKILL.md 并持久化句柄', async () => {
    const root = fakeSkillsRoot([
      ['with-skill', fakeSkillDirectory('with-skill', { 'SKILL.md': skillFrontmatterMarkdown('本地 Skill A', '本地描述') })],
      ['no-skill', fakeSkillDirectory('no-skill', {})],
      ['readme.txt', { kind: 'file', name: 'readme.txt' } as unknown as FileSystemHandle],
    ])
    const picker = setLocalAutoSaveBrowserSupport(true, vi.fn(async () => root))
    useStore.setState({ showToast: vi.fn() })

    await useStore.getState().importSkillsRootDirectory()

    expect(picker).toHaveBeenCalledWith({ mode: 'readwrite' })
    const { local, localRootName, scanning } = useStore.getState().skills
    expect(local).toHaveLength(1)
    expect(local[0]).toMatchObject({ id: 'with-skill', name: '本地 Skill A', description: '本地描述', source: 'local' })
    expect(localRootName).toBe('skills-root')
    expect(scanning).toBe(false)
    expect(putSkillsRootDirectoryHandle).toHaveBeenCalledWith(root)
    expect(useStore.getState().showToast).toHaveBeenCalledWith('已导入 1 个本地 skill', 'success')
  })

  it('refreshLocalSkills：句柄授权通过时重新扫描本地 skill', async () => {
    const root = fakeSkillsRoot([
      ['local-dir', fakeSkillDirectory('local-dir', { 'SKILL.md': skillFrontmatterMarkdown('重新扫描', '描述') })],
    ])
    // 真实句柄必有 queryPermission；测试 fake 显式授予
    Object.defineProperty(root, 'queryPermission', {
      configurable: true,
      value: vi.fn(async () => 'granted' as PermissionState),
    })
    vi.mocked(getSkillsRootDirectoryHandle).mockResolvedValueOnce({
      id: 'skillsDirectory',
      handle: root,
      name: 'skills-root',
      updatedAt: 1,
    })
    useStore.setState({ showToast: vi.fn() })

    await useStore.getState().refreshLocalSkills()

    expect(useStore.getState().skills.local).toHaveLength(1)
    expect(useStore.getState().skills.local[0]).toMatchObject({ id: 'local-dir', name: '重新扫描', source: 'local' })
    expect(useStore.getState().skills.scanning).toBe(false)
  })

  it('refreshLocalSkills：授权被拒时提示错误且不更新列表', async () => {
    const requestPermission = vi.fn(async () => 'denied' as PermissionState)
    const handle = {
      kind: 'directory',
      name: 'skills-root',
      queryPermission: vi.fn(async () => 'prompt' as PermissionState),
      requestPermission,
    } as unknown as FileSystemDirectoryHandle
    vi.mocked(getSkillsRootDirectoryHandle).mockResolvedValueOnce({
      id: 'skillsDirectory',
      handle,
      name: 'skills-root',
      updatedAt: 1,
    })
    useStore.setState({ showToast: vi.fn() })

    await useStore.getState().refreshLocalSkills()

    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
    expect(useStore.getState().skills.local).toEqual([])
    expect(useStore.getState().skills.scanning).toBe(false)
    expect(useStore.getState().showToast).toHaveBeenCalledWith(expect.stringContaining('权限'), 'error')
  })

  it('clearSkillsRootDirectory：清空本地 skill 状态并删除持久化句柄', async () => {
    useStore.setState({
      skills: { ...useStore.getState().skills, local: [skillSummary({ id: 'local-x', source: 'local' })], localRootName: 'skills-root' },
    })

    await useStore.getState().clearSkillsRootDirectory()

    expect(clearSkillsRootDirectoryHandle).toHaveBeenCalled()
    expect(useStore.getState().skills.local).toEqual([])
    expect(useStore.getState().skills.localRootName).toBeNull()
  })
})

describe('编辑链路画幅三层防御（T2）', () => {
  beforeEach(async () => {
    __resetTasksClearedForTests()
    await clearTasks()
    await clearImages()
    // db mock 的 storeImage 生成新 id；草稿图按 draft id 预注册，供 ensureImageCached 读取
    await putImage({ id: 'image-a', dataUrl: imageA.dataUrl, source: 'upload', createdAt: 1 })
    vi.mocked(callImageApi).mockReset().mockImplementation(async () => ({
      images: [],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    }))
    vi.mocked(preprocessInputImagesForTarget).mockClear()
    useStore.setState({
      settings: localAutoSaveSettings(false),
      prompt: '',
      params: { ...DEFAULT_PARAMS },
      inputImages: [],
      maskDraft: null,
      tasks: [],
      showToast: vi.fn(),
    })
  })

  it('编辑任务 crop 策略：发送预处理后的输入图并记录 inputPreprocess 与原图', async () => {
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,done-1024x1536'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    vi.mocked(preprocessInputImagesForTarget).mockResolvedValueOnce({
      images: [{ dataUrl: 'data:image/png;base64,pre-1024x1536', width: 1024, height: 1536 }],
      policy: 'crop',
    })
    useStore.setState({
      prompt: '编辑提示词',
      params: { ...DEFAULT_PARAMS, size: '1024x1536', input_ratio_policy: 'crop' },
      inputImages: [imageA],
    })

    await submitTask()
    await waitForAssertion(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(vi.mocked(preprocessInputImagesForTarget)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(preprocessInputImagesForTarget).mock.calls[0]?.[2]).toBe('crop')
    expect(vi.mocked(callImageApi).mock.calls[0]?.[0]?.inputImageDataUrls).toEqual(['data:image/png;base64,pre-1024x1536'])

    const record = useStore.getState().tasks[0]
    expect(record.inputPreprocess).toMatchObject({ policy: 'crop', originalCount: 1 })
    expect(record.originalInputImageIds).toEqual(['image-a'])
    expect(record.inputImageIds).not.toContain('image-a')
  })

  it('auto 策略未触发处理时：原图直发，任务记录 policy=none 且不保留副本', async () => {
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,done-941x1672'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    vi.mocked(preprocessInputImagesForTarget).mockResolvedValueOnce({
      images: [{ dataUrl: imageA.dataUrl, width: 941, height: 1672 }],
      policy: 'none',
    })
    useStore.setState({
      prompt: '比例已匹配',
      params: { ...DEFAULT_PARAMS, size: '2160x3840' },
      inputImages: [imageA],
    })

    await submitTask()
    await waitForAssertion(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(vi.mocked(callImageApi).mock.calls[0]?.[0]?.inputImageDataUrls).toEqual([imageA.dataUrl])
    const record = useStore.getState().tasks[0]
    expect(record.inputPreprocess).toMatchObject({ policy: 'none', originalCount: 1 })
    expect(record.originalInputImageIds).toBeUndefined()
    expect(record.inputImageIds).toEqual(['image-a'])
  })

  it('outpaint 策略：扩边指令拼在请求提示词开头，任务 prompt 保持原文', async () => {
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,done-1536x1536'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    vi.mocked(preprocessInputImagesForTarget).mockResolvedValueOnce({
      images: [{ dataUrl: 'data:image/png;base64,pre-outpaint', width: 1536, height: 1536 }],
      policy: 'outpaint',
      promptHint: 'mock-outpaint-hint',
    })
    useStore.setState({
      prompt: '扩边提示词',
      params: { ...DEFAULT_PARAMS, size: '1024x1536', input_ratio_policy: 'outpaint' },
      inputImages: [imageA],
    })

    await submitTask()
    await waitForAssertion(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const sent = vi.mocked(callImageApi).mock.calls[0]?.[0]
    expect(sent?.prompt.startsWith('mock-outpaint-hint\n')).toBe(true)
    expect(useStore.getState().tasks[0].prompt).toBe('扩边提示词')
  })

  it('无输入图任务零影响：不调用预处理、不记录 inputPreprocess', async () => {
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,done-1024x1536'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '纯文生图',
      params: { ...DEFAULT_PARAMS, size: '1024x1536' },
    })

    await submitTask()
    await waitForAssertion(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(vi.mocked(preprocessInputImagesForTarget)).not.toHaveBeenCalled()
    const record = useStore.getState().tasks[0]
    expect(record.inputPreprocess).toBeUndefined()
    expect(record.originalInputImageIds).toBeUndefined()
  })

  it('带遮罩的编辑任务跳过输入图预处理', async () => {
    useStore.setState({
      prompt: '遮罩编辑',
      params: { ...DEFAULT_PARAMS, size: '1024x1536', input_ratio_policy: 'crop' },
      inputImages: [imageA],
      maskDraft: {
        targetImageId: imageA.id,
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await submitTask({ allowFullMask: true })
    await waitForAssertion(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(vi.mocked(preprocessInputImagesForTarget)).not.toHaveBeenCalled()
    expect(useStore.getState().tasks[0].inputPreprocess).toBeUndefined()
  })

  it('非 exact_size 任务返回比例偏差 >5% 时本地校正并标记 ratioCorrected', async () => {
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,raw-2000x1000'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '校正测试',
      params: { ...DEFAULT_PARAMS, size: '1024x1536' },
    })

    await submitTask()
    await waitForAssertion(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const record = useStore.getState().tasks[0]
    expect(record.ratioCorrected).toBe(true)
    const outputId = record.outputImages[0]
    expect(await getImage(outputId)).toMatchObject({ dataUrl: 'data:image/png;base64,resized-1024x1536' })
    // provider 原图按 exactSizeOriginalImages 同款机制保留，可下载
    const originalId = record.exactSizeOriginalImages?.[0]
    expect(originalId).toBeTruthy()
    expect(await getImage(originalId!)).toMatchObject({ dataUrl: 'data:image/png;base64,raw-2000x1000' })
  })

  it('返回比例偏差 ≤5% 时不触发校正', async () => {
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,ok-1022x1536'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '比例微偏',
      params: { ...DEFAULT_PARAMS, size: '1024x1536' },
    })

    await submitTask()
    await waitForAssertion(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const record = useStore.getState().tasks[0]
    expect(record.ratioCorrected).toBeUndefined()
    expect(await getImage(record.outputImages[0])).toMatchObject({ dataUrl: 'data:image/png;base64,ok-1022x1536' })
  })

  it('设置关闭「比例自动校正」时不触发校正', async () => {
    useStore.setState({
      settings: { ...localAutoSaveSettings(false), ratioAutoCorrect: false },
      prompt: '关闭校正',
      params: { ...DEFAULT_PARAMS, size: '1024x1536' },
    })
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,raw-2000x1000'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })

    await submitTask()
    await waitForAssertion(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const record = useStore.getState().tasks[0]
    expect(record.ratioCorrected).toBeUndefined()
    expect(await getImage(record.outputImages[0])).toMatchObject({ dataUrl: 'data:image/png;base64,raw-2000x1000' })
  })
})
