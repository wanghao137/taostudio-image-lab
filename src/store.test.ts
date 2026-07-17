import { beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, normalizeSettings } from './lib/apiProfiles'
import type { AgentConversation, AppSettings, ExportData, StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
vi.mock('./lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  const agentConversations = new Map<string, AgentConversation>()
  let localAutoSaveDirectoryHandle: {
    id: 'directory'
    handle: FileSystemDirectoryHandle
    name?: string
    updatedAt: number
  } | undefined
  let imageSeq = 0

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: vi.fn(async (task: TaskRecord) => {
      tasks.set(task.id, task)
      return task.id
    }),
    deleteTask: async (id: string) => {
      tasks.delete(id)
    },
    clearTasks: async () => {
      tasks.clear()
    },
    getAllAgentConversations: async () => [...agentConversations.values()],
    putAgentConversation: async (conversation: AgentConversation) => {
      agentConversations.set(conversation.id, conversation)
      return conversation.id
    },
    deleteAgentConversation: async (id: string) => {
      agentConversations.delete(id)
    },
    clearAgentConversations: async () => {
      agentConversations.clear()
    },
    replaceAgentConversations: async (conversations: AgentConversation[]) => {
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
    getImage: async (id: string) => images.get(id),
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
    deleteImage: async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    },
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
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
  }
})
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
vi.mock('./lib/transparentImage', () => ({
  GREEN_KEY_COLOR: '#00FF00',
  MAGENTA_KEY_COLOR: '#FF00FF',
  createTransparentOutputMeta: vi.fn((prompt: string) => ({
    transparentOutput: true,
    effectivePrompt: `transparent:${prompt}`,
  })),
  getTransparentRequestParams: vi.fn((params: typeof DEFAULT_PARAMS) => ({
    ...params,
    output_format: 'png',
    output_compression: null,
    transparent_output: true,
  })),
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
    const sourceWidth = sourceMatch ? Number(sourceMatch[1]) : 1024
    const sourceHeight = sourceMatch ? Number(sourceMatch[2]) : 1024
    if (sourceWidth === target.width && sourceHeight === target.height) {
      return { dataUrl, width: sourceWidth, height: sourceHeight, sourceWidth, sourceHeight, resized: false }
    }
    return {
      dataUrl: `data:image/png;base64,resized-${target.width}x${target.height}`,
      width: target.width,
      height: target.height,
      sourceWidth,
      sourceHeight,
      resized: true,
      drawPlan: {
        mode: fitMode,
        sourceWidth,
        sourceHeight,
        targetWidth: target.width,
        targetHeight: target.height,
        scale: 1,
        drawX: 0,
        drawY: 0,
        drawWidth: target.width,
        drawHeight: target.height,
        aspectMismatch: sourceWidth / sourceHeight !== target.width / target.height,
      },
    }
  }),
}))
vi.mock('./lib/agentApi', () => ({
  callAgentConversationTitleApi: vi.fn(async () => '标题'),
  callAgentResponsesApi: vi.fn(() => new Promise(() => {})),
  callBatchImageSingle: vi.fn(async (opts: { batchItemId: string; prompt: string }) => ({
    batchItemId: opts.batchItemId,
    image: { dataUrl: 'data:image/png;base64,batch-output', revisedPrompt: opts.prompt },
    error: null,
  })),
  parseBatchImageCallArguments: vi.fn((args: string) => {
    try {
      const parsed = JSON.parse(args) as { images?: Array<{ id?: string; prompt?: string }> }
      return parsed.images?.map((item, index) => ({
        id: item.id || `image_${index + 1}`,
        prompt: item.prompt || '',
      })) ?? null
    } catch {
      return null
    }
  }),
}))
import { clearAgentConversations, clearImages, clearLocalAutoSaveDirectoryHandle, clearTasks, getAllAgentConversations, getAllTasks, getImage, getLocalAutoSaveDirectoryHandle, putAgentConversation, putImage, putLocalAutoSaveDirectoryHandle, putTask as putDbTask } from './lib/db'
import { callImageApi } from './lib/api'
import { callAgentResponsesApi, callBatchImageSingle } from './lib/agentApi'
import { resizeImageDataUrlToExactSize } from './lib/exactImageSize'
import { formatExportFileTime } from './lib/exportFileName'
import { getFalQueuedImageResult } from './lib/falAiImageApi'
import { LocalAutoSavePermissionError, writeLocalAutoSaveArchive } from './lib/localAutoSaveWriter'
import { removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { authorizeLocalAutoSaveDirectory, cleanStaleAgentInputDrafts, clearData, clearFailedTasks, deleteAgentRoundFromConversation, deleteFavoriteCollection, editOutputs, getActiveAgentRounds, getAgentConversationTaskIds, getAgentRoundTaskIds, getErrorToastMessage, getLocalAutoSaveRetryableTaskCount, getPersistedState, getTaskApiProfile, importData, initStore, markInterruptedOpenAIRunningTasks, migratePersistedState, regenerateAgentAssistantMessage, remapAgentRoundMentionsForPathChange, removeTask, retryPendingLocalAutoSaves, reuseConfig, runLocalAutoSaveForTask, selectLocalAutoSaveDirectory, stopAgentResponse, submitAgentMessage, submitTask, taskMatchesFilterStatus, taskMatchesSearchQuery, useStore } from './store'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

describe('error toast messages', () => {
  it('drops long error detail after the failure title', () => {
    expect(getErrorToastMessage('Agent 请求失败：接口拒绝了很长的提示词内容')).toBe('Agent 请求失败')
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

function importFile(data: ExportData): File {
  const zipped = zipSync({ 'manifest.json': strToU8(JSON.stringify(data)) })
  const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength)
  return { arrayBuffer: async () => buffer } as File
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
    }), { importConfig: false, importTasks: true })

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
      agentConversations: [],
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
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
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

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.showToast).toHaveBeenCalledWith('任务已提交', 'success')
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
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

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
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))

    const [task] = useStore.getState().tasks
    expect(task.actualParams?.size).toBe('1024x1024')
    expect(task.actualParamsByImage?.[task.outputImages[0]].size).toBe('1024x1024')
    await clearTasks()
    await clearImages()
  })

  it('resizes exact-size outputs locally and preserves the source image', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(resizeImageDataUrlToExactSize).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,actual-1254x1254'],
      actualParams: { output_format: 'png', quality: 'high', size: '1254x1254' },
      actualParamsList: [{ output_format: 'png', quality: 'high', size: '1254x1254' }],
      revisedPrompts: [],
    })
    useStore.setState({
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

    expect(vi.mocked(callImageApi).mock.calls[0]?.[0].prompt).toContain('Target frame: vertical 9:16 composition')
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
      sourceWidth: 1254,
      sourceHeight: 1254,
      targetWidth: 2160,
      targetHeight: 3840,
      aspectMismatch: true,
    })
    expect(task.actualParams).toMatchObject({ size: '2160x3840', output_format: 'png', quality: 'high', n: 1 })
    expect(task.actualParamsByImage?.[task.outputImages[0]]).toMatchObject({ size: '2160x3840', output_format: 'png', quality: 'high' })
    const outputImage = await getImage(task.outputImages[0])
    const sourceImage = await getImage(task.exactSizeOriginalImages![0])
    expect(outputImage?.dataUrl).toBe('data:image/png;base64,resized-2160x3840')
    expect(sourceImage?.dataUrl).toBe('data:image/png;base64,actual-1254x1254')
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
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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
        profiles: [falProfile],
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
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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

describe('interrupted OpenAI running tasks', () => {
  it('marks legacy and OpenAI running tasks as interrupted', () => {
    const now = 10_000
    const legacyRunning = task({ id: 'legacy-running', status: 'running', createdAt: 1_000, finishedAt: null, elapsed: null })
    const openAIRunning = task({ id: 'openai-running', apiProvider: 'openai', status: 'running', createdAt: 2_000, finishedAt: null, elapsed: null })
    const falRunning = task({ id: 'fal-running', apiProvider: 'fal', status: 'running', createdAt: 3_000, finishedAt: null, elapsed: null })
    const customAsyncRunning = task({ id: 'custom-running', apiProvider: 'custom-provider', customTaskId: 'task-1', status: 'running', createdAt: 4_000, finishedAt: null, elapsed: null })
    const doneTask = task({ id: 'done-task', apiProvider: 'openai', status: 'done' })

    const result = markInterruptedOpenAIRunningTasks([legacyRunning, openAIRunning, falRunning, customAsyncRunning, doneTask], now)

    expect(result.interruptedTasks.map((item) => item.id)).toEqual(['legacy-running', 'openai-running'])
    expect(result.tasks.find((item) => item.id === 'legacy-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 9_000,
    })
    expect(result.tasks.find((item) => item.id === 'openai-running')).toMatchObject({
      status: 'error',
      error: expect.stringContaining('请求中断'),
      finishedAt: now,
      elapsed: 8_000,
    })
    expect(result.tasks.find((item) => item.id === 'fal-running')).toEqual(falRunning)
    expect(result.tasks.find((item) => item.id === 'custom-running')).toEqual(customAsyncRunning)
    expect(result.tasks.find((item) => item.id === 'done-task')).toEqual(doneTask)
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
      agentConversations: [],
      agentInputDrafts: {},
      tasks: [],
      showToast: vi.fn(),
    })

    await initStore()

    expect(useStore.getState().inputImages).toEqual([
      { id: imageA.id, dataUrl: imageA.dataUrl, width: 1536, height: 1024 },
    ])
  })

  it('omits input when restart input restore is disabled', () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false } })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted).not.toHaveProperty('inputImages')
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })
})

describe('agent conversation persistence', () => {
  beforeEach(async () => {
    await clearAgentConversations()
  })

  it('omits agent conversations from localStorage state', () => {
    const conversation = agentConversation({
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一张图',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        responseOutput: [
          { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
          { type: 'image_generation_call', id: 'image-call-a', result: 'large-base64-a' },
          { type: 'image_generation_call', id: 'image-call-b', result: { b64_json: 'large-base64-b', base64: 'large-base64-c', image: 'large-base64-d', data: 'large-base64-e' } },
        ],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一张图', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '已生成图片。', roundId: 'round-a', outputTaskIds: ['task-a'], createdAt: 2 },
      ],
    })
    useStore.setState({ agentConversations: [conversation] })

    const persisted = getPersistedState(useStore.getState())
    const serializedPersisted = JSON.stringify(persisted)

    expect('agentConversations' in persisted).toBe(false)
    expect(serializedPersisted).not.toContain('image_generation_call')
    expect(serializedPersisted).not.toContain('large-base64')
    expect(JSON.stringify(useStore.getState().agentConversations)).toContain('large-base64-a')
  })

  it('loads agent conversations from IndexedDB and migrates legacy localStorage conversations', async () => {
    const storedConversation = agentConversation({ id: 'stored-conversation', createdAt: 1, updatedAt: 1 })
    const legacyConversation = agentConversation({ id: 'legacy-conversation', createdAt: 2, updatedAt: 2 })
    useStore.setState({ agentConversations: [legacyConversation], activeAgentConversationId: legacyConversation.id })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await putAgentConversation(storedConversation)

    await initStore()

    const state = useStore.getState()
    const stored = await getAllAgentConversations()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['stored-conversation', 'legacy-conversation'])
    expect(state.activeAgentConversationId).toBe('legacy-conversation')
    expect(stored.map((conversation) => conversation.id)).toEqual(['stored-conversation', 'legacy-conversation'])
  })

  it('strips generated image payloads from legacy task raw payloads during startup migration', async () => {
    await putDbTask(task({
      id: 'legacy-task',
      outputImages: ['image-live'],
      rawResponsePayload: JSON.stringify({
        output: [{ type: 'image_generation_call', id: 'image-call-a', result: 'legacy-task-base64' }],
      }),
    }))

    await initStore()

    const storedTasks = await getAllTasks()
    const serializedStoredTasks = JSON.stringify(storedTasks)
    expect(serializedStoredTasks).toContain('image_generation_call')
    expect(serializedStoredTasks).not.toContain('legacy-task-base64')
  })

  it('keeps agent conversations created while initStore is loading', async () => {
    const legacyConversation = agentConversation({ id: 'legacy-conversation', createdAt: 1, updatedAt: 1 })
    const earlyConversation = agentConversation({ id: 'early-conversation', createdAt: 2, updatedAt: 2 })
    useStore.setState({ agentConversations: [legacyConversation], activeAgentConversationId: legacyConversation.id })

    const initPromise = initStore()
    useStore.setState({ agentConversations: [legacyConversation, earlyConversation], activeAgentConversationId: earlyConversation.id })
    await initPromise

    const state = useStore.getState()
    const stored = await getAllAgentConversations()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['legacy-conversation', 'early-conversation'])
    expect(state.activeAgentConversationId).toBe('early-conversation')
    expect(stored.map((conversation) => conversation.id)).toEqual(['legacy-conversation', 'early-conversation'])
  })

  it('restores active conversation and draft when localStorage no longer stores conversations', async () => {
    const storedConversation = agentConversation({ id: 'stored-conversation', createdAt: 1, updatedAt: 1 })
    useStore.setState({
      appMode: 'agent',
      agentConversations: [],
      activeAgentConversationId: storedConversation.id,
      agentInputDrafts: {
        [storedConversation.id]: {
          prompt: '未发送草稿',
          inputImages: [],
          maskDraft: null,
          maskEditorImageId: null,
          updatedAt: Date.now(),
        },
      },
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
    })
    await putAgentConversation(storedConversation)

    await initStore()

    const state = useStore.getState()
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['stored-conversation'])
    expect(state.activeAgentConversationId).toBe('stored-conversation')
    expect(state.agentInputDrafts['stored-conversation']?.prompt).toBe('未发送草稿')
    expect(state.prompt).toBe('未发送草稿')
  })

  it('strips generated image payloads when migrating old persisted state', () => {
    const migrated = migratePersistedState({
      settings: { ...DEFAULT_SETTINGS },
      agentConversations: [agentConversation({
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          prompt: '画一张图',
          inputImageIds: [],
          outputTaskIds: ['task-a'],
          responseOutput: [
            { type: 'image_generation_call', id: 'image-call-a', result: 'legacy-base64-a' },
            { type: 'image_generation_call', id: 'image-call-b', result: { b64_json: 'legacy-base64-b', base64: 'legacy-base64-c' } },
          ],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
      })],
    })

    const serializedMigrated = JSON.stringify(migrated)
    expect(serializedMigrated).not.toContain('legacy-base64')
    expect(serializedMigrated).toContain('image_generation_call')
  })
})

describe('fal task recovery', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    vi.mocked(getFalQueuedImageResult).mockClear()
    vi.mocked(callAgentResponsesApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
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
      agentConversations: [],
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
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

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

  it('continues an Agent round after all fal image tasks recover', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'agent-text-profile', apiKey: 'text-key', apiMode: 'responses' })
    const imageProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: imageProfile.id,
      apiProfileName: imageProfile.name,
      apiModel: imageProfile.model,
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        responseOutput: [{ type: 'function_call', name: 'generate_image', call_id: 'tool-a', arguments: JSON.stringify({ id: 'cat', prompt: '画一只猫' }) }],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    vi.mocked(getFalQueuedImageResult).mockResolvedValue({
      images: ['data:image/png;base64,agent-recovered'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: [],
    })
    vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
      text: '已完成。',
      images: [],
      outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '已完成。' }] }],
      responseId: 'response-done',
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [textProfile, imageProfile],
        activeProfileId: textProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: conversation.id,
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    for (let i = 0; i < 20 && useStore.getState().agentConversations[0]?.rounds[0]?.status !== 'done'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const recoveredTask = useStore.getState().tasks.find((item) => item.id === agentTask.id)
    expect(recoveredTask).toMatchObject({ status: 'done', falRecoverable: false })
    expect(callAgentResponsesApi).toHaveBeenCalledTimes(1)
    const agentInputJson = JSON.stringify(vi.mocked(callAgentResponsesApi).mock.calls[0][0].input)
    expect(agentInputJson).toContain('function_call_output')
    expect(agentInputJson).toContain('\\"status\\":\\"done\\"')
    const round = useStore.getState().agentConversations[0].rounds[0]
    expect(round).toMatchObject({ status: 'done', error: null, responseId: 'response-done' })
    expect(round.responseOutput).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'tool-a' }),
    ]))
  })

  it('records recovered Agent tool failures without continuing the Agent round', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'agent-text-profile', apiKey: 'text-key', apiMode: 'responses' })
    const imageProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: imageProfile.id,
      apiProfileName: imageProfile.name,
      apiModel: imageProfile.model,
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        responseOutput: [{ type: 'function_call', name: 'generate_image', call_id: 'tool-a', arguments: JSON.stringify({ id: 'cat', prompt: '画一只猫' }) }],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    vi.mocked(getFalQueuedImageResult).mockRejectedValueOnce(new Error('quota exceeded'))
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [textProfile, imageProfile],
        activeProfileId: textProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: 'conversation-a',
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    for (let i = 0; i < 20 && useStore.getState().tasks.find((item) => item.id === agentTask.id)?.falRecoverable !== false; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(callAgentResponsesApi).not.toHaveBeenCalled()
    const failedTask = useStore.getState().tasks.find((item) => item.id === agentTask.id)
    expect(failedTask).toMatchObject({ status: 'error', error: 'quota exceeded', falRecoverable: false })
    const round = useStore.getState().agentConversations[0].rounds[0]
    expect(round).toMatchObject({ status: 'error', error: 'quota exceeded' })
    const toolOutput = round.responseOutput?.find((item) => item.type === 'function_call_output')
    expect(toolOutput).toMatchObject({ call_id: 'tool-a' })
    expect(toolOutput?.output).toContain('"status":"error"')
    expect(toolOutput?.output).toContain('quota exceeded')
  })

  it('does not call Agent again when recovered tasks already reached the tool limit', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'agent-text-profile', apiKey: 'text-key', apiMode: 'responses' })
    const imageProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: imageProfile.id,
      apiProfileName: imageProfile.name,
      apiModel: imageProfile.model,
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'limit-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        responseOutput: [{ type: 'function_call', name: 'generate_image', call_id: 'tool-a', arguments: JSON.stringify({ id: 'cat', prompt: '画一只猫' }) }],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    vi.mocked(getFalQueuedImageResult).mockResolvedValueOnce({
      images: ['data:image/png;base64,agent-recovered-limit'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [textProfile, imageProfile],
        activeProfileId: textProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
        agentMaxToolRounds: 1,
      }),
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: conversation.id,
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    for (let i = 0; i < 20 && useStore.getState().agentConversations[0]?.rounds[0]?.status !== 'done'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(callAgentResponsesApi).not.toHaveBeenCalled()
    const round = useStore.getState().agentConversations[0].rounds[0]
    expect(round).toMatchObject({ status: 'done', error: null })
    expect(useStore.getState().agentConversations[0].messages.find((message) => message.id === 'assistant-a')?.content).toContain('已达到最大工具调用次数（1）')
  })

  it('does not continue a stopped Agent round when a recoverable fal task later completes', async () => {
    const textProfile = createDefaultOpenAIProfile({ id: 'agent-text-profile', apiKey: 'text-key', apiMode: 'responses' })
    const imageProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: imageProfile.id,
      apiProfileName: imageProfile.name,
      apiModel: imageProfile.model,
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        responseOutput: [{ type: 'function_call', name: 'generate_image', call_id: 'tool-a', arguments: JSON.stringify({ id: 'cat', prompt: '画一只猫' }) }],
        status: 'error',
        error: '已停止生成。',
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '已停止生成。', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    vi.mocked(getFalQueuedImageResult).mockResolvedValueOnce({
      images: ['data:image/png;base64,agent-recovered-after-stop'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [textProfile, imageProfile],
        activeProfileId: textProfile.id,
        agentApiConfigMode: 'hybrid',
        agentTextProfileId: textProfile.id,
        agentImageProfileId: imageProfile.id,
      }),
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: 'conversation-a',
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    for (let i = 0; i < 20 && useStore.getState().tasks.find((item) => item.id === agentTask.id)?.falRecoverable !== false; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(callAgentResponsesApi).not.toHaveBeenCalled()
    expect(useStore.getState().tasks.find((item) => item.id === agentTask.id)).toMatchObject({ status: 'done', falRecoverable: false })
    expect(useStore.getState().agentConversations[0].rounds[0]).toMatchObject({ status: 'error', error: '已停止生成。' })
  })

  it('does not overwrite a stopped Agent task when an in-flight fal recovery completes', async () => {
    const agentTask = task({
      id: 'agent-fal-task',
      prompt: '画一只猫',
      apiProvider: 'fal',
      apiProfileId: 'fal-profile',
      apiProfileName: 'fal',
      apiModel: 'fal-model',
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
      finishedAt: Date.now(),
      elapsed: 10,
    })
    let resolveRecovery: (value: Awaited<ReturnType<typeof getFalQueuedImageResult>>) => void = () => {}
    vi.mocked(getFalQueuedImageResult).mockImplementationOnce(() => new Promise((resolve) => { resolveRecovery = resolve }))
    const conversation = agentConversation({
      id: 'conversation-a',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '画一只猫',
        inputImageIds: [],
        outputTaskIds: [agentTask.id],
        status: 'running',
        error: null,
        createdAt: 1,
        finishedAt: null,
      }],
      messages: [
        { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
        { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
      ],
    })
    useStore.setState({
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: 'conversation-a',
      showToast: vi.fn(),
    })
    await putDbTask(agentTask)
    await putAgentConversation(conversation)

    await initStore()
    for (let i = 0; i < 20 && vi.mocked(getFalQueuedImageResult).mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    useStore.setState((state) => ({
      agentConversations: state.agentConversations.map((item) => item.id === 'conversation-a'
        ? { ...item, rounds: item.rounds.map((round) => round.id === 'round-a' ? { ...round, status: 'running', error: null } : round) }
        : item),
    }))
    stopAgentResponse('conversation-a')
    resolveRecovery({
      images: ['data:image/png;base64,should-not-write'],
      actualParams: {},
      actualParamsList: [{}],
      revisedPrompts: [],
    })
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(useStore.getState().tasks[0]).toMatchObject({
      status: 'error',
      error: '已停止生成。',
      falRecoverable: false,
      outputImages: [],
    })
  })

  it('clears recoverable Agent image tasks when stopping the Agent round', () => {
    const agentTask = task({
      id: 'agent-fal-task',
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      sourceMode: 'agent',
      agentConversationId: 'conversation-a',
      agentRoundId: 'round-a',
      agentMessageId: 'assistant-a',
      agentToolCallId: 'tool-a',
    })
    useStore.setState({
      tasks: [agentTask],
      activeAgentConversationId: 'conversation-a',
      agentConversations: [agentConversation({
        id: 'conversation-a',
        activeRoundId: 'round-a',
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          assistantMessageId: 'assistant-a',
          prompt: '画一只猫',
          inputImageIds: [],
          outputTaskIds: [agentTask.id],
          status: 'running',
          error: null,
          createdAt: 1,
          finishedAt: null,
        }],
        messages: [
          { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', createdAt: 1 },
          { id: 'assistant-a', role: 'assistant', content: '', roundId: 'round-a', outputTaskIds: [agentTask.id], createdAt: 2 },
        ],
      })],
      showToast: vi.fn(),
    })

    stopAgentResponse('conversation-a')

    expect(useStore.getState().tasks[0]).toMatchObject({
      status: 'error',
      error: '已停止生成。',
      falRecoverable: false,
    })
    expect(useStore.getState().agentConversations[0].rounds[0]).toMatchObject({
      status: 'error',
      error: '已停止生成。',
    })
  })
})

describe('agent conversation creation', () => {
  beforeEach(() => {
    useStore.setState({
      agentConversations: [],
      activeAgentConversationId: null,
      agentSidebarCollapsed: false,
      agentEditingRoundId: null,
    })
  })

  it('refreshes the latest empty conversation instead of creating another one', () => {
    const olderEmpty = agentConversation({ id: 'older-empty', createdAt: 1_000, updatedAt: 1_000 })
    const latestEmpty = agentConversation({ id: 'latest-empty', createdAt: 2_000, updatedAt: 2_000 })
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000)
    useStore.setState({
      agentConversations: [olderEmpty, latestEmpty],
      activeAgentConversationId: olderEmpty.id,
      agentSidebarCollapsed: false,
      agentEditingRoundId: 'editing-round',
    })

    const id = useStore.getState().createAgentConversation()

    const state = useStore.getState()
    expect(id).toBe(latestEmpty.id)
    expect(state.activeAgentConversationId).toBe(latestEmpty.id)
    expect(state.agentConversations).toHaveLength(2)
    expect(state.agentConversations.find((item) => item.id === latestEmpty.id)).toMatchObject({
      createdAt: 3_000,
      updatedAt: 3_000,
    })
    expect(state.agentConversations.find((item) => item.id === olderEmpty.id)).toEqual(olderEmpty)
    expect(state.agentSidebarCollapsed).toBe(true)
    expect(state.agentEditingRoundId).toBeNull()
    now.mockRestore()
  })

  it('creates a new conversation when the latest conversation has messages', () => {
    const olderEmpty = agentConversation({ id: 'older-empty', createdAt: 1_000, updatedAt: 1_000 })
    const latestUsed = agentConversation({
      id: 'latest-used',
      activeRoundId: 'round-a',
      createdAt: 2_000,
      updatedAt: 2_000,
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'prompt',
        inputImageIds: [],
        outputTaskIds: [],
        status: 'done',
        error: null,
        createdAt: 2_000,
        finishedAt: 2_000,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'prompt', roundId: 'round-a', createdAt: 2_000 }],
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(3_000)
    useStore.setState({ agentConversations: [olderEmpty, latestUsed], activeAgentConversationId: latestUsed.id })

    const id = useStore.getState().createAgentConversation()

    const state = useStore.getState()
    expect(id).not.toBe(olderEmpty.id)
    expect(id).not.toBe(latestUsed.id)
    expect(state.agentConversations).toHaveLength(3)
    expect(state.agentConversations[state.agentConversations.length - 1]).toMatchObject({ id, createdAt: 3_000, updatedAt: 3_000, messages: [], rounds: [] })
    expect(state.activeAgentConversationId).toBe(id)
    now.mockRestore()
  })
})

describe('agent round deletion', () => {
  it('renumbers later rounds and remaps image mentions after deleting a middle round', () => {
    const conversation = agentConversation({
      activeRoundId: 'round-3',
      rounds: [
        {
          id: 'round-1',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-1',
          assistantMessageId: 'assistant-1',
          prompt: '第一轮',
          inputImageIds: [],
          outputTaskIds: ['task-1'],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        },
        {
          id: 'round-2',
          index: 2,
          parentRoundId: 'round-1',
          userMessageId: 'user-2',
          assistantMessageId: 'assistant-2',
          prompt: '第二轮',
          inputImageIds: [],
          outputTaskIds: ['task-2'],
          status: 'done',
          error: null,
          createdAt: 3,
          finishedAt: 4,
        },
        {
          id: 'round-3',
          index: 3,
          parentRoundId: 'round-2',
          userMessageId: 'user-3',
          assistantMessageId: 'assistant-3',
          prompt: '第三轮',
          inputImageIds: [],
          outputTaskIds: ['task-3'],
          status: 'done',
          error: null,
          createdAt: 5,
          finishedAt: 6,
        },
      ],
      messages: [
        { id: 'user-1', role: 'user', content: '第一轮', roundId: 'round-1', createdAt: 1 },
        { id: 'assistant-1', role: 'assistant', content: '完成', roundId: 'round-1', createdAt: 2 },
        { id: 'user-2', role: 'user', content: '第二轮', roundId: 'round-2', createdAt: 3 },
        { id: 'assistant-2', role: 'assistant', content: '完成', roundId: 'round-2', createdAt: 4 },
        { id: 'user-3', role: 'user', content: '参考 @第1轮图1、@第2轮图1、@第3轮图1', roundId: 'round-3', createdAt: 5 },
        { id: 'assistant-3', role: 'assistant', content: '完成', roundId: 'round-3', createdAt: 6 },
      ],
    })

    const deleted = deleteAgentRoundFromConversation(conversation, 'round-2', 10)

    expect(deleted.rounds.map((round) => ({ id: round.id, index: round.index, parentRoundId: round.parentRoundId }))).toEqual([
      { id: 'round-1', index: 1, parentRoundId: null },
      { id: 'round-3', index: 2, parentRoundId: 'round-1' },
    ])
    expect(deleted.messages.map((message) => message.id)).toEqual(['user-1', 'assistant-1', 'user-3', 'assistant-3'])
    expect(deleted.messages.find((message) => message.id === 'user-3')?.content).toBe('参考 @第1轮图1、@已删除轮次图1、@第2轮图1')
    expect(deleted.activeRoundId).toBe('round-3')
    expect(deleted.updatedAt).toBe(10)
  })

  it('can remap draft mentions using the old and new active paths after deletion', () => {
    const conversation = agentConversation({
      activeRoundId: 'round-3',
      rounds: [
        {
          id: 'round-1',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-1',
          prompt: '第一轮',
          inputImageIds: [],
          outputTaskIds: ['task-1'],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        },
        {
          id: 'round-2',
          index: 2,
          parentRoundId: 'round-1',
          userMessageId: 'user-2',
          prompt: '第二轮',
          inputImageIds: [],
          outputTaskIds: ['task-2'],
          status: 'done',
          error: null,
          createdAt: 3,
          finishedAt: 4,
        },
        {
          id: 'round-3',
          index: 3,
          parentRoundId: 'round-2',
          userMessageId: 'user-3',
          prompt: '第三轮',
          inputImageIds: [],
          outputTaskIds: ['task-3'],
          status: 'done',
          error: null,
          createdAt: 5,
          finishedAt: 6,
        },
      ],
      messages: [],
    })
    const oldPath = getActiveAgentRounds(conversation)
    const deleted = deleteAgentRoundFromConversation(conversation, 'round-2', 10)
    const newPath = getActiveAgentRounds(deleted)

    expect(remapAgentRoundMentionsForPathChange('继续参考 @第1轮图1、@第2轮图1、@第3轮图1', oldPath, newPath))
      .toBe('继续参考 @第1轮图1、@已删除轮次图1、@第2轮图1')
  })

  it('collects agent round and conversation tasks even when some failed tasks are not in outputTaskIds', () => {
    const conversation = agentConversation({
      id: 'conversation-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'user-a',
        assistantMessageId: 'assistant-a',
        prompt: '第一轮',
        inputImageIds: [],
        outputTaskIds: ['task-success'],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [],
    })
    const tasks = [
      task({ id: 'task-success', agentConversationId: 'conversation-a', agentRoundId: 'round-a', status: 'done', outputImages: ['image-a'] }),
      task({ id: 'task-failed', agentConversationId: 'conversation-a', agentRoundId: 'round-a', status: 'error', error: '失败' }),
      task({ id: 'task-unrelated', agentConversationId: 'other', agentRoundId: 'other-round', status: 'error', error: '失败' }),
    ]

    expect(getAgentRoundTaskIds(conversation.rounds[0], tasks)).toEqual(['task-success', 'task-failed'])
    expect(getAgentConversationTaskIds(conversation, tasks)).toEqual(['task-success', 'task-failed'])
  })
})

describe('data import', () => {
  beforeEach(async () => {
    useStore.setState({
      tasks: [],
      agentConversations: [],
      activeAgentConversationId: null,
      showToast: vi.fn(),
    })
    await clearAgentConversations()
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

  it('skips empty agent conversations when importing task data', async () => {
    const usedConversation = agentConversation({
      id: 'used-conversation',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'prompt',
        inputImageIds: [],
        outputTaskIds: [],
        status: 'done',
        error: null,
        createdAt: 1,
        finishedAt: 2,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'prompt', roundId: 'round-a', createdAt: 1 }],
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [],
      agentConversations: [
        agentConversation({ id: 'empty-conversation' }),
        usedConversation,
      ],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['used-conversation'])
    expect(state.activeAgentConversationId).toBe('used-conversation')
  })

  it('merges imported agent conversations without replacing local conversations', async () => {
    const localConversation = agentConversation({
      id: 'local-conversation',
      title: '本地对话',
      createdAt: 1,
      updatedAt: 1,
    })
    const importedConversation = agentConversation({
      id: 'imported-conversation',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'imported prompt',
        inputImageIds: [],
        outputTaskIds: [],
        status: 'done',
        error: null,
        createdAt: 2,
        finishedAt: 3,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'imported prompt', roundId: 'round-a', createdAt: 2 }],
    })
    useStore.setState({
      agentConversations: [localConversation],
      activeAgentConversationId: localConversation.id,
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [],
      agentConversations: [importedConversation],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.agentConversations.map((conversation) => conversation.id)).toEqual(['local-conversation', 'imported-conversation'])
    expect(state.activeAgentConversationId).toBe('local-conversation')
  })

  it('stores imported legacy agent conversations in IndexedDB without localStorage or image payloads', async () => {
    const importedConversation = agentConversation({
      id: 'legacy-imported-conversation',
      activeRoundId: 'round-a',
      rounds: [{
        id: 'round-a',
        index: 1,
        parentRoundId: null,
        userMessageId: 'message-a',
        prompt: 'imported prompt',
        inputImageIds: [],
        outputTaskIds: ['task-a'],
        responseOutput: [
          { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
          { type: 'image_generation_call', id: 'image-call-a', result: { base64: 'imported-legacy-base64' } },
        ],
        status: 'done',
        error: null,
        createdAt: 2,
        finishedAt: 3,
      }],
      messages: [{ id: 'message-a', role: 'user', content: 'imported prompt', roundId: 'round-a', createdAt: 2 }],
    })

    const imported = await importData(importFile({
      version: 2,
      exportedAt: new Date(0).toISOString(),
      tasks: [],
      agentConversations: [importedConversation],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const indexedConversations = await getAllAgentConversations()
    const persisted = getPersistedState(useStore.getState())
    const serializedIndexedConversations = JSON.stringify(indexedConversations)
    const serializedPersisted = JSON.stringify(persisted)

    expect(imported).toBe(true)
    expect(indexedConversations.map((conversation) => conversation.id)).toEqual(['legacy-imported-conversation'])
    expect(serializedIndexedConversations).toContain('image_generation_call')
    expect(serializedIndexedConversations).not.toContain('imported-legacy-base64')
    expect('agentConversations' in persisted).toBe(false)
    expect(serializedPersisted).not.toContain('image_generation_call')
    expect(serializedPersisted).not.toContain('imported-legacy-base64')
  })

})

describe('agent draft lifecycle', () => {
  const responsesProfile = createDefaultOpenAIProfile({ id: 'openai-responses', apiKey: 'openai-key', apiMode: 'responses' })
  const draftState = {
    prompt: `参考 ${getSelectedImageMentionLabel(0)} 生成`,
    inputImages: [imageA],
    maskDraft: {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    },
    maskEditorImageId: imageA.id,
    agentEditingRoundId: 'round-a',
  }

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
      }),
      appMode: 'agent',
      agentConversations: [
        agentConversation({ id: 'conversation-a' }),
        agentConversation({ id: 'conversation-b' }),
      ],
      activeAgentConversationId: 'conversation-a',
      galleryInputDraft: null,
      agentInputDrafts: {},
      agentSidebarCollapsed: false,
      agentAssetPanelCollapsed: false,
      ...draftState,
    })
  })

  it('clears visible input but keeps the agent draft when returning to gallery mode', () => {
    useStore.getState().setAppMode('gallery')

    const state = useStore.getState()
    expect(state.appMode).toBe('gallery')
    expect(state.prompt).toBe('')
    expect(state.inputImages).toEqual([])
    expect(state.maskDraft).toBeNull()
    expect(state.maskEditorImageId).toBeNull()
    expect(state.agentEditingRoundId).toBeNull()
    expect(state.agentInputDrafts['conversation-a']).toMatchObject({
      prompt: draftState.prompt,
      inputImages: draftState.inputImages,
      maskDraft: draftState.maskDraft,
      maskEditorImageId: imageA.id,
    })
  })

  it('restores the agent draft when switching back from gallery mode', () => {
    useStore.getState().setAppMode('gallery')
    useStore.getState().setAppMode('agent')

    const state = useStore.getState()
    expect(state.appMode).toBe('agent')
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.inputImages).toEqual(draftState.inputImages)
    expect(state.maskDraft).toEqual(draftState.maskDraft)
    expect(state.maskEditorImageId).toBe(imageA.id)
    expect(state.agentEditingRoundId).toBeNull()
  })

  it('keeps the gallery draft when switching into agent mode and back', () => {
    const galleryPrompt = `画廊 ${getSelectedImageMentionLabel(0)} 草稿`
    useStore.setState({
      appMode: 'gallery',
      prompt: galleryPrompt,
      inputImages: [imageB],
      maskDraft: null,
      maskEditorImageId: null,
      galleryInputDraft: null,
      agentInputDrafts: {
        'conversation-a': {
          prompt: draftState.prompt,
          inputImages: draftState.inputImages,
          maskDraft: draftState.maskDraft,
          maskEditorImageId: imageA.id,
        },
      },
    })

    useStore.getState().setAppMode('agent')

    let state = useStore.getState()
    expect(state.appMode).toBe('agent')
    expect(state.galleryInputDraft).toMatchObject({ prompt: galleryPrompt, inputImages: [imageB] })
    expect(state.prompt).toBe(draftState.prompt)

    useStore.getState().setAppMode('gallery')

    state = useStore.getState()
    expect(state.appMode).toBe('gallery')
    expect(state.prompt).toBe(galleryPrompt)
    expect(state.inputImages).toEqual([imageB])
  })

  it('persists the gallery draft while agent mode is active', () => {
    const galleryPrompt = 'gallery draft'
    useStore.setState({
      appMode: 'agent',
      galleryInputDraft: {
        prompt: galleryPrompt,
        inputImages: [imageB],
        maskDraft: null,
        maskEditorImageId: null,
      },
    })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe(galleryPrompt)
    expect(persisted.inputImages).toEqual([{ id: imageB.id, dataUrl: '' }])
  })

  it('clears stale mentions in the visible input when switching conversations', () => {
    useStore.getState().setActiveAgentConversationId('conversation-b')

    const state = useStore.getState()
    expect(state.activeAgentConversationId).toBe('conversation-b')
    expect(state.prompt).toBe('')
    expect(state.inputImages).toEqual([])
    expect(state.maskDraft).toBeNull()
    expect(state.maskEditorImageId).toBeNull()
    expect(state.agentEditingRoundId).toBeNull()
    expect(state.agentInputDrafts['conversation-a']?.prompt).toBe(draftState.prompt)
  })

  it('restores the previous conversation draft when switching back', () => {
    useStore.getState().setActiveAgentConversationId('conversation-b')
    useStore.getState().setActiveAgentConversationId('conversation-a')

    const state = useStore.getState()
    expect(state.activeAgentConversationId).toBe('conversation-a')
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.inputImages).toEqual(draftState.inputImages)
    expect(state.maskDraft).toEqual(draftState.maskDraft)
    expect(state.maskEditorImageId).toBe(imageA.id)
    expect(state.agentEditingRoundId).toBeNull()
  })

  it('keeps the current draft when selecting the already active conversation', () => {
    useStore.getState().setActiveAgentConversationId('conversation-a')

    const state = useStore.getState()
    expect(state.prompt).toBe(draftState.prompt)
    expect(state.inputImages).toEqual(draftState.inputImages)
    expect(state.maskDraft).toEqual(draftState.maskDraft)
    expect(state.maskEditorImageId).toBe(imageA.id)
  })

  it('persists agent drafts separately from the gallery input draft', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted).not.toHaveProperty('prompt')
    expect(persisted.agentInputDrafts['conversation-a']).toMatchObject({
      prompt: draftState.prompt,
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      maskDraft: draftState.maskDraft,
      maskEditorImageId: imageA.id,
    })
    expect(persisted.agentInputDrafts['conversation-a']?.updatedAt).toEqual(expect.any(Number))
  })

  it('removes stale agent drafts except the last active conversation', () => {
    const now = 10 * 24 * 60 * 60 * 1000
    const staleUpdatedAt = now - 3 * 24 * 60 * 60 * 1000 - 1
    const recentUpdatedAt = now - 3 * 24 * 60 * 60 * 1000
    const activeDraft = { prompt: 'active', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: staleUpdatedAt }
    const staleDraft = { prompt: 'stale', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: staleUpdatedAt }
    const recentDraft = { prompt: 'recent', inputImages: [], maskDraft: null, maskEditorImageId: null, updatedAt: recentUpdatedAt }

    const cleaned = cleanStaleAgentInputDrafts({
      'conversation-a': activeDraft,
      'conversation-b': staleDraft,
      'conversation-c': recentDraft,
    }, 'conversation-a', now)

    expect(cleaned).toEqual({
      'conversation-a': activeDraft,
      'conversation-c': recentDraft,
    })
  })

})

describe('agent context for removed outputs', () => {
  beforeEach(() => {
    const profile = createDefaultOpenAIProfile({
      id: 'responses-profile',
      apiKey: 'test-key',
      apiMode: 'responses',
      model: DEFAULT_RESPONSES_MODEL,
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        model: DEFAULT_RESPONSES_MODEL,
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      prompt: '继续',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      appMode: 'agent',
      tasks: [task({
        id: 'task-live',
        outputImages: ['image-live'],
        sourceMode: 'agent',
        agentRoundId: 'round-a',
        agentToolCallId: 'live-call',
      })],
      agentConversations: [agentConversation({
        id: 'conversation-a',
        activeRoundId: 'round-a',
        rounds: [{
          id: 'round-a',
          index: 1,
          parentRoundId: null,
          userMessageId: 'user-a',
          assistantMessageId: 'assistant-a',
          prompt: '画两张图',
          inputImageIds: [],
          outputTaskIds: ['task-deleted', 'task-live'],
          responseOutput: [
            { type: 'message', content: [{ type: 'output_text', text: '已生成两张图。' }] },
            { type: 'image_generation_call', id: 'deleted-call', result: 'deleted-base64' },
            { type: 'image_generation_call', id: 'live-call', result: 'live-base64' },
          ],
          status: 'done',
          error: null,
          createdAt: 1,
          finishedAt: 2,
        }],
        messages: [
          { id: 'user-a', role: 'user', content: '画两张图', roundId: 'round-a', createdAt: 1 },
          { id: 'assistant-a', role: 'assistant', content: '已生成两张图。', roundId: 'round-a', outputTaskIds: ['task-deleted', 'task-live'], createdAt: 2 },
        ],
      })],
      activeAgentConversationId: 'conversation-a',
      agentEditingRoundId: null,
      showToast: vi.fn(),
    })
    vi.mocked(callAgentResponsesApi).mockClear()
    vi.mocked(callAgentResponsesApi).mockResolvedValue({
      text: 'ok',
      images: [],
      outputItems: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      responseId: 'response-b',
    })
  })

  it('does not send removed image_generation results back to the model', async () => {
    await putImage({ id: 'image-live', dataUrl: 'data:image/png;base64,live-base64' })
    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).not.toContain('deleted-base64')
    expect(serializedInput).toContain('live-base64')
    expect(serializedInput).not.toContain('deleted-call')
    expect(serializedInput).not.toContain('live-call')
    expect(serializedInput).not.toContain('image_generation_call')
    expect(serializedInput).toContain('removed_ref')
    expect(serializedInput).toContain('round-1-image-1')
    expect(serializedInput).toContain('round-1-image-2')
    expect(serializedInput).toContain('input_image')
  })

  it('restores stripped image_generation results from task payloads when building context', async () => {
    await putImage({ id: 'image-live', dataUrl: 'data:image/png;base64,live-base64' })
    const rawResponsePayload = JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '已生成两张图。' }] },
        { type: 'image_generation_call', id: 'deleted-call', result: 'deleted-base64' },
        { type: 'image_generation_call', id: 'live-call', result: 'live-base64' },
      ],
    }, null, 2)
    useStore.setState((state) => ({
      tasks: [task({
        id: 'task-live',
        outputImages: ['image-live'],
        rawResponsePayload,
        sourceMode: 'agent',
        agentRoundId: 'round-a',
        agentToolCallId: 'live-call',
      })],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              responseOutput: [
                { type: 'message', content: [{ type: 'output_text', text: '已生成两张图。' }] },
                { type: 'image_generation_call', id: 'deleted-call' },
                { type: 'image_generation_call', id: 'live-call' },
              ],
            }
          : round,
        ),
      })),
    }))

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).toContain('live-base64')
    expect(serializedInput).toContain('input_image')
    expect(serializedInput).not.toContain('deleted-base64')
    expect(serializedInput).not.toContain('live-call')
    expect(serializedInput).not.toContain('image_generation_call')
  })

  it('hydrates stripped task payload image results from stored images when building context', async () => {
    await putImage({ id: 'image-hydrate', dataUrl: 'data:image/png;base64,hydrated-live-base64' })
    const rawResponsePayload = JSON.stringify({
      output: [{ type: 'image_generation_call' }],
    }, null, 2)
    useStore.setState((state) => ({
      tasks: [task({
        id: 'task-live',
        outputImages: ['image-hydrate'],
        rawResponsePayload,
        sourceMode: 'agent',
        agentRoundId: 'round-a',
      })],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              outputTaskIds: ['task-live'],
              responseOutput: [{ type: 'image_generation_call' }],
            }
          : round,
        ),
      })),
    }))

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).toContain('hydrated-live-base64')
  })

  it('restores stripped image results even when legacy tasks lack tool call ids', async () => {
    await putImage({ id: 'image-legacy', dataUrl: 'data:image/png;base64,legacy-live-base64' })
    const rawResponsePayload = JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
        { type: 'image_generation_call', result: { base64: 'legacy-live-base64' } },
      ],
    }, null, 2)
    useStore.setState((state) => ({
      tasks: [task({
        id: 'legacy-task-live',
        outputImages: ['image-legacy'],
        rawResponsePayload,
        sourceMode: 'agent',
        agentRoundId: 'round-a',
        agentToolCallId: undefined,
      })],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              outputTaskIds: ['legacy-task-live'],
              responseOutput: [
                { type: 'message', content: [{ type: 'output_text', text: '已生成图片。' }] },
                { type: 'image_generation_call' },
              ],
            }
          : round,
        ),
      })),
    }))

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).toContain('legacy-live-base64')
    expect(serializedInput).toContain('input_image')
    expect(serializedInput).not.toContain('image_generation_call')
    expect(serializedInput.match(/已生成图片。/g)).toHaveLength(1)
  })

  it('restores all stripped batch image results after restart', async () => {
    await putImage({ id: 'image-batch-1', dataUrl: 'data:image/png;base64,batch-base64-1' })
    await putImage({ id: 'image-batch-2', dataUrl: 'data:image/png;base64,batch-base64-2' })
    const batchOnePayload = JSON.stringify({
      output: [{ type: 'image_generation_call', id: 'batch-call-1', result: 'batch-base64-1' }],
    }, null, 2)
    const batchTwoPayload = JSON.stringify({
      output: [{ type: 'image_generation_call', id: 'batch-call-2', result: 'batch-base64-2' }],
    }, null, 2)
    useStore.setState((state) => ({
      tasks: [
        task({
          id: 'task-batch-1',
          outputImages: ['image-batch-1'],
          rawResponsePayload: batchOnePayload,
          sourceMode: 'agent',
          agentRoundId: 'round-a',
          agentToolCallId: 'batch-call-1',
          agentBatchCallId: 'batch-fc-1',
        }),
        task({
          id: 'task-batch-2',
          outputImages: ['image-batch-2'],
          rawResponsePayload: batchTwoPayload,
          sourceMode: 'agent',
          agentRoundId: 'round-a',
          agentToolCallId: 'batch-call-2',
          agentBatchCallId: 'batch-fc-1',
        }),
      ],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              outputTaskIds: ['task-batch-1', 'task-batch-2'],
              responseOutput: [
                { type: 'function_call', name: 'generate_image_batch', call_id: 'batch-fc-1', arguments: '{}' },
                { type: 'function_call_output', call_id: 'batch-fc-1', output: '{"images":[{"id":"1","status":"done"},{"id":"2","status":"done"}]}' },
                { type: 'image_generation_call' },
                { type: 'image_generation_call' },
              ],
            }
          : round,
        ),
      })),
    }))

    await submitAgentMessage()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const input = vi.mocked(callAgentResponsesApi).mock.calls[0][0].input
    const serializedInput = JSON.stringify(input)
    expect(serializedInput).toContain('batch-base64-1')
    expect(serializedInput).toContain('batch-base64-2')
    expect(serializedInput).toContain('input_image')
    expect(serializedInput).not.toContain('batch-call-1')
    expect(serializedInput).not.toContain('batch-call-2')
    expect(serializedInput).not.toContain('image_generation_call')
  })

  it('scrubs stored agent response payloads when deleting an output task', async () => {
    const rawResponsePayload = JSON.stringify({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '已生成两张图。' }] },
        { type: 'image_generation_call', id: 'deleted-call', result: 'deleted-base64' },
        { type: 'image_generation_call', id: 'live-call', result: 'live-base64' },
      ],
    }, null, 2)
    const deletedTask = task({
      id: 'task-deleted',
      outputImages: ['image-deleted'],
      rawResponsePayload,
      sourceMode: 'agent',
      agentRoundId: 'round-a',
      agentToolCallId: 'deleted-call',
    })
    const liveTask = task({
      id: 'task-live',
      outputImages: ['image-live'],
      rawResponsePayload,
      sourceMode: 'agent',
      agentRoundId: 'round-a',
      agentToolCallId: 'live-call',
    })
    useStore.setState((state) => ({
      tasks: [deletedTask, liveTask],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? { ...round, outputTaskIds: ['task-deleted', 'task-live'], responseOutput: JSON.parse(rawResponsePayload).output }
          : round,
        ),
      })),
    }))

    await removeTask(deletedTask)

    const state = useStore.getState()
    const serializedConversations = JSON.stringify(state.agentConversations)
    const remainingTaskPayload = state.tasks.find((item) => item.id === 'task-live')?.rawResponsePayload ?? ''
    expect(serializedConversations).not.toContain('deleted-base64')
    expect(remainingTaskPayload).not.toContain('deleted-base64')
    expect(serializedConversations).toContain('live-base64')
    expect(remainingTaskPayload).toContain('live-base64')
  })

  it('does not corrupt batch task payloads when deleting one of the batch tasks', async () => {
    const batchDeletedPayload = JSON.stringify({
      output: [{ type: 'image_generation_call', id: 'batch-deleted-call', result: 'batch-deleted-base64' }],
    }, null, 2)
    const batchLivePayload = JSON.stringify({
      output: [{ type: 'image_generation_call', id: 'batch-live-call', result: 'batch-live-base64' }],
    }, null, 2)
    const batchDeletedTask = task({
      id: 'batch-task-deleted',
      outputImages: ['batch-img-deleted'],
      rawResponsePayload: batchDeletedPayload,
      sourceMode: 'agent',
      agentRoundId: 'round-a',
      agentToolCallId: 'batch-deleted-call',
      agentBatchCallId: 'batch-fc-1',
    })
    const batchLiveTask = task({
      id: 'batch-task-live',
      outputImages: ['batch-img-live'],
      rawResponsePayload: batchLivePayload,
      sourceMode: 'agent',
      agentRoundId: 'round-a',
      agentToolCallId: 'batch-live-call',
      agentBatchCallId: 'batch-fc-1',
    })
    useStore.setState((state) => ({
      tasks: [batchDeletedTask, batchLiveTask],
      agentConversations: state.agentConversations.map((conversation) => ({
        ...conversation,
        rounds: conversation.rounds.map((round) => round.id === 'round-a'
          ? {
              ...round,
              outputTaskIds: ['batch-task-deleted', 'batch-task-live'],
              responseOutput: [
                { type: 'function_call', name: 'generate_image_batch', call_id: 'batch-fc-1', arguments: '{}' },
                { type: 'function_call_output', call_id: 'batch-fc-1', output: '{"images":[{"id":"1","status":"done"},{"id":"2","status":"done"}]}' },
              ],
            }
          : round,
        ),
      })),
    }))

    await removeTask(batchDeletedTask)

    const state = useStore.getState()
    const liveTaskPayload = state.tasks.find((item) => item.id === 'batch-task-live')?.rawResponsePayload ?? ''
    expect(liveTaskPayload).toContain('batch-live-base64')
    expect(liveTaskPayload).not.toContain('batch-deleted-base64')
    const serializedConversations = JSON.stringify(state.agentConversations)
    expect(serializedConversations).toContain('function_call_output')
    expect(serializedConversations).not.toContain('batch-deleted-base64')
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

describe('agent built-in image tool failure', () => {
  const responsesProfile = createDefaultOpenAIProfile({
    id: 'responses-profile',
    apiKey: 'test-key',
    apiMode: 'responses',
    model: DEFAULT_RESPONSES_MODEL,
    streamImages: true,
  })

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    await clearAgentConversations()
    vi.mocked(callAgentResponsesApi).mockClear()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        model: DEFAULT_RESPONSES_MODEL,
        streamImages: true,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
      }),
      prompt: '画一张图',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      appMode: 'agent',
      tasks: [],
      streamPreviews: {},
      streamPreviewSlots: {},
      agentConversations: [agentConversation({
        id: 'conversation-a',
        activeRoundId: null,
        rounds: [],
        messages: [],
      })],
      activeAgentConversationId: 'conversation-a',
      agentEditingRoundId: null,
      showToast: vi.fn(),
    })
  })

  it('marks a started built-in image task as error when the stream fails', async () => {
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts) => {
      await opts.onImageToolStarted?.({ toolCallId: 'ig-fail' })
      await opts.onImagePartialImage?.({
        toolCallId: 'ig-fail',
        image: 'data:image/png;base64,cGFydGlhbA==',
        partialImageIndex: 0,
      })
      throw new Error('image_generation failed')
    })

    await submitAgentMessage()
    for (let i = 0; i < 10 && useStore.getState().tasks[0]?.status !== 'error'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const state = useStore.getState()
    const failedTask = state.tasks[0]
    expect(failedTask).toMatchObject({
      status: 'error',
      error: 'image_generation failed',
      agentToolCallId: 'ig-fail',
      sourceMode: 'agent',
    })
    expect(state.streamPreviews[failedTask.id]).toBeUndefined()
    expect(state.streamPreviewSlots[failedTask.id]).toBeUndefined()

    const round = state.agentConversations[0].rounds[0]
    expect(round).toMatchObject({
      status: 'error',
      error: 'image_generation failed',
      outputTaskIds: [failedTask.id],
    })
  })

  it('marks a failed built-in image task as error while the Agent stream continues', async () => {
    vi.mocked(callAgentResponsesApi).mockImplementationOnce(async (opts) => {
      await opts.onImageToolStarted?.({ toolCallId: 'ig-fail' })
      await opts.onImagePartialImage?.({
        toolCallId: 'ig-fail',
        image: 'data:image/png;base64,cGFydGlhbA==',
        partialImageIndex: 0,
      })
      await opts.onImageToolFailed?.({ toolCallId: 'ig-fail', error: 'safety rejected' })
      opts.onTextDelta?.('图片失败，但回复继续。')
      return {
        text: '图片失败，但回复继续。',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '图片失败，但回复继续。' }] }],
        responseId: 'response-continued',
      }
    })

    await submitAgentMessage()
    for (let i = 0; i < 10 && useStore.getState().agentConversations[0].rounds[0]?.status !== 'done'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const state = useStore.getState()
    const failedTask = state.tasks[0]
    expect(failedTask).toMatchObject({
      status: 'error',
      error: 'safety rejected',
      agentToolCallId: 'ig-fail',
      sourceMode: 'agent',
    })
    expect(state.streamPreviews[failedTask.id]).toBeUndefined()
    expect(state.streamPreviewSlots[failedTask.id]).toBeUndefined()

    const round = state.agentConversations[0].rounds[0]
    expect(round).toMatchObject({
      status: 'done',
      error: null,
      outputTaskIds: [failedTask.id],
    })
    expect(state.agentConversations[0].messages.find((message) => message.role === 'assistant')).toMatchObject({
      content: '图片失败，但回复继续。',
      outputTaskIds: [failedTask.id],
    })
  })
})

describe('agent batch reference resolution', () => {
  const responsesProfile = createDefaultOpenAIProfile({
    id: 'responses-profile',
    apiKey: 'test-key',
    apiMode: 'responses',
    model: DEFAULT_RESPONSES_MODEL,
  })

  beforeEach(async () => {
    await clearImages()
    await putImage(imageA)
    await putImage(imageB)
    vi.mocked(callAgentResponsesApi).mockClear()
    vi.mocked(callBatchImageSingle).mockClear()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        apiMode: 'responses',
        model: DEFAULT_RESPONSES_MODEL,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
      }),
      prompt: '继续生成',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      appMode: 'agent',
      tasks: [
        task({ id: 'task-branch-a', outputImages: [imageA.id], sourceMode: 'agent', agentRoundId: 'round-2-a' }),
        task({ id: 'task-branch-b', outputImages: [imageB.id], sourceMode: 'agent', agentRoundId: 'round-2-b' }),
      ],
      agentConversations: [agentConversation({
        id: 'conversation-a',
        activeRoundId: 'round-2-b',
        rounds: [
          {
            id: 'round-1',
            index: 1,
            parentRoundId: null,
            userMessageId: 'user-1',
            assistantMessageId: 'assistant-1',
            prompt: '画基础图',
            inputImageIds: [],
            outputTaskIds: [],
            status: 'done',
            error: null,
            createdAt: 1,
            finishedAt: 2,
          },
          {
            id: 'round-2-a',
            index: 2,
            parentRoundId: 'round-1',
            userMessageId: 'user-2-a',
            assistantMessageId: 'assistant-2-a',
            prompt: '分支 A',
            inputImageIds: [],
            outputTaskIds: ['task-branch-a'],
            status: 'done',
            error: null,
            createdAt: 3,
            finishedAt: 4,
          },
          {
            id: 'round-2-b',
            index: 2,
            parentRoundId: 'round-1',
            userMessageId: 'user-2-b',
            assistantMessageId: 'assistant-2-b',
            prompt: '分支 B',
            inputImageIds: [],
            outputTaskIds: ['task-branch-b'],
            status: 'done',
            error: null,
            createdAt: 5,
            finishedAt: 6,
          },
        ],
        messages: [
          { id: 'user-1', role: 'user', content: '画基础图', roundId: 'round-1', createdAt: 1 },
          { id: 'assistant-1', role: 'assistant', content: '完成', roundId: 'round-1', createdAt: 2 },
          { id: 'user-2-a', role: 'user', content: '分支 A', roundId: 'round-2-a', createdAt: 3 },
          { id: 'assistant-2-a', role: 'assistant', content: '完成', roundId: 'round-2-a', outputTaskIds: ['task-branch-a'], createdAt: 4 },
          { id: 'user-2-b', role: 'user', content: '分支 B', roundId: 'round-2-b', createdAt: 5 },
          { id: 'assistant-2-b', role: 'assistant', content: '完成', roundId: 'round-2-b', outputTaskIds: ['task-branch-b'], createdAt: 6 },
        ],
      })],
      activeAgentConversationId: 'conversation-a',
      agentEditingRoundId: null,
      showToast: vi.fn(),
    })
  })

  it('resolves batch references from the active branch path only', async () => {
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'generate_image_batch',
          call_id: 'batch-call',
          arguments: JSON.stringify({
            images: [{
              id: 'next-image',
              prompt: '参考 <ref id="round-2-image-1" /> 生成',
            }],
          }),
        }],
        responseId: 'response-1',
      })
      .mockResolvedValueOnce({
        text: '完成',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
        responseId: 'response-2',
      })

    await submitAgentMessage()

    for (let i = 0; i < 5 && vi.mocked(callBatchImageSingle).mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(callBatchImageSingle).toHaveBeenCalled()
    const batchArgs = vi.mocked(callBatchImageSingle).mock.calls[0][0]
    expect(batchArgs.referenceImageDataUrls).toEqual([imageB.dataUrl])
    expect(batchArgs.referenceImageDataUrls).not.toContain(imageA.dataUrl)
    expect(batchArgs.referenceIds).toEqual(['round-2-image-1'])
  })

  it('resolves batch references to current round input images', async () => {
    useStore.setState({ inputImages: [imageA] })
    vi.mocked(callAgentResponsesApi)
      .mockResolvedValueOnce({
        text: '',
        images: [],
        outputItems: [{
          type: 'function_call',
          name: 'generate_image_batch',
          call_id: 'batch-call',
          arguments: JSON.stringify({
            images: [{
              id: 'variant-image',
              prompt: '参考 <ref id="round-3-reference-1" /> 生成变体',
            }],
          }),
        }],
        responseId: 'response-1',
      })
      .mockResolvedValueOnce({
        text: '完成',
        images: [],
        outputItems: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }],
        responseId: 'response-2',
      })

    await submitAgentMessage()

    for (let i = 0; i < 5 && vi.mocked(callBatchImageSingle).mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(callBatchImageSingle).toHaveBeenCalled()
    const batchArgs = vi.mocked(callBatchImageSingle).mock.calls[0][0]
    expect(batchArgs.referenceImageDataUrls).toEqual([imageA.dataUrl])
    expect(batchArgs.referenceIds).toEqual(['round-3-reference-1'])
  })
})

describe('agent assistant regeneration', () => {
  const responsesProfile = createDefaultOpenAIProfile({ id: 'openai-responses', apiKey: 'openai-key', apiMode: 'responses' })

  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
        alwaysShowRetryButton: false,
      }),
      params: { ...DEFAULT_PARAMS, n: 4 },
      agentEditingRoundId: 'round-a',
      agentConversations: [
        agentConversation({
          id: 'conversation-a',
          activeRoundId: 'round-a',
          rounds: [{
            id: 'round-a',
            index: 1,
            parentRoundId: null,
            userMessageId: 'user-a',
            assistantMessageId: 'assistant-a',
            prompt: '画一只猫',
            inputImageIds: [imageA.id],
            outputTaskIds: [],
            status: 'done',
            error: null,
            createdAt: 1,
            finishedAt: 2,
          }],
          messages: [
            { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', inputImageIds: [imageA.id], createdAt: 1 },
            { id: 'assistant-a', role: 'assistant', content: '已完成。', roundId: 'round-a', createdAt: 2 },
          ],
        }),
      ],
      toast: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('creates a sibling round from the assistant message regardless of retry setting', async () => {
    await regenerateAgentAssistantMessage('conversation-a', 'round-a')

    const conversation = useStore.getState().agentConversations[0]
    const newRound = conversation.rounds.find((round) => round.id !== 'round-a')
    expect(newRound).toMatchObject({
      index: 1,
      parentRoundId: null,
      prompt: '画一只猫',
      inputImageIds: [imageA.id],
      status: 'running',
      outputTaskIds: [],
    })
    expect(conversation.activeRoundId).toBe(newRound?.id)
    expect(conversation.messages).toContainEqual(expect.objectContaining({
      role: 'user',
      content: '画一只猫',
      roundId: newRound?.id,
      inputImageIds: [imageA.id],
    }))
    expect(useStore.getState().agentEditingRoundId).toBeNull()
  })

  it('overwrites the same round when regenerating an error assistant message', async () => {
    useStore.setState({
      agentConversations: [
        agentConversation({
          id: 'conversation-a',
          activeRoundId: 'round-a',
          rounds: [{
            id: 'round-a',
            index: 1,
            parentRoundId: null,
            userMessageId: 'user-a',
            assistantMessageId: 'assistant-a',
            prompt: '画一只猫',
            inputImageIds: [imageA.id],
            outputTaskIds: ['task-a'],
            status: 'error',
            error: '失败',
            createdAt: 1,
            finishedAt: 2,
          }],
          messages: [
            { id: 'user-a', role: 'user', content: '画一只猫', roundId: 'round-a', inputImageIds: [imageA.id], createdAt: 1 },
            { id: 'assistant-a', role: 'assistant', content: '请求失败：失败', roundId: 'round-a', outputTaskIds: ['task-a'], createdAt: 2 },
          ],
        }),
      ],
    })

    await regenerateAgentAssistantMessage('conversation-a', 'round-a')

    const conversation = useStore.getState().agentConversations[0]
    expect(conversation.rounds).toHaveLength(1)
    expect(conversation.activeRoundId).toBe('round-a')
    expect(conversation.rounds[0]).toMatchObject({
      id: 'round-a',
      status: 'running',
      error: null,
      outputTaskIds: [],
      finishedAt: null,
    })
    expect(conversation.messages.find((message) => message.id === 'assistant-a')).toMatchObject({
      content: '',
      outputTaskIds: [],
    })
  })
})

describe('reused task API profile', () => {
  const openaiProfile = createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'openai-key' })
  const falProfile = createDefaultFalProfile({ id: 'fal-profile', name: 'fal 配置', apiKey: 'fal-key' })

  beforeEach(() => {
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
