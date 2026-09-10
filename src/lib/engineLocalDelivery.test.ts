// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineDeliveryRecord, StoredLocalAutoSaveDirectoryHandle } from './db'
import type { ImageJobV1 } from './imageTaskApi'

vi.mock('./db', () => {
  let localAutoSaveDirectoryHandle: StoredLocalAutoSaveDirectoryHandle | undefined
  let engineDeliveryDirectoryHandle: StoredLocalAutoSaveDirectoryHandle | undefined
  const deliveryRecords = new Map<string, EngineDeliveryRecord>()
  const sceneDirectoryHandles = new Map<string, StoredLocalAutoSaveDirectoryHandle>()
  return {
    getLocalAutoSaveDirectoryHandle: async () => localAutoSaveDirectoryHandle,
    putLocalAutoSaveDirectoryHandle: vi.fn(async (handle: FileSystemDirectoryHandle) => {
      localAutoSaveDirectoryHandle = { id: 'directory', handle, name: handle.name, updatedAt: Date.now() }
      return 'directory'
    }),
    clearLocalAutoSaveDirectoryHandle: async () => {
      localAutoSaveDirectoryHandle = undefined
    },
    getEngineDeliveryDirectoryHandle: async () => engineDeliveryDirectoryHandle,
    putEngineDeliveryDirectoryHandle: async (handle: FileSystemDirectoryHandle) => {
      engineDeliveryDirectoryHandle = { id: 'engineDeliveryDirectory', handle, name: handle.name, updatedAt: Date.now() }
      return 'engineDeliveryDirectory'
    },
    clearEngineDeliveryDirectoryHandle: async () => {
      engineDeliveryDirectoryHandle = undefined
    },
    SCENE_DIRECTORY_KEY_PREFIX: 'sceneDirectory:',
    getSceneDirectoryHandle: vi.fn(async (sceneId: string) => sceneDirectoryHandles.get(sceneId)),
    putSceneDirectoryHandle: vi.fn(async (sceneId: string, handle: FileSystemDirectoryHandle) => {
      const record: StoredLocalAutoSaveDirectoryHandle = {
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
    getEngineDeliveryRecord: async (kind: EngineDeliveryRecord['kind'], entityId: string) =>
      deliveryRecords.get(`${kind}:${entityId}`),
    putEngineDeliveryRecord: async (record: EngineDeliveryRecord) => {
      deliveryRecords.set(record.id, record)
      return record.id
    },
    deleteEngineDeliveryRecord: async (kind: EngineDeliveryRecord['kind'], entityId: string) => {
      deliveryRecords.delete(`${kind}:${entityId}`)
    },
    __resetDirectories: () => {
      localAutoSaveDirectoryHandle = undefined
      engineDeliveryDirectoryHandle = undefined
      deliveryRecords.clear()
      sceneDirectoryHandles.clear()
    },
  }
})

vi.mock('./localAutoSaveWriter', () => ({
  LocalAutoSavePermissionError: class LocalAutoSavePermissionError extends Error {
    constructor() {
      super('需要重新授权保存位置')
      this.name = 'LocalAutoSavePermissionError'
    }
  },
  writeLocalDeliveryFiles: vi.fn(async (params: { folderName: string; files: Array<{ name: string }> }) => ({
    folderName: params.folderName,
    files: params.files.map((file) => file.name),
  })),
}))

vi.mock('./imageTaskApi', () => ({
  getImageAssetBlob: async (_config: unknown, assetId: string) =>
    new Blob([`bytes-of-${assetId}`], { type: 'image/png' }),
  getImageAssetManifest: async (_config: unknown, assetId: string) => ({ assetId }),
  getImageBatchSummary: async () => {
    throw new Error('not used in these tests')
  },
  listAllImageBatchItems: async () => {
    throw new Error('not used in these tests')
  },
}))

import * as dbModule from './db'
import { writeLocalDeliveryFiles } from './localAutoSaveWriter'
import { chooseEngineLocalDeliveryDirectory, saveEngineJobLocally } from './engineLocalDelivery'
import type { ImageTaskApiConfig } from './imageTaskApi'

const db = dbModule as unknown as {
  __resetDirectories: () => void
  putLocalAutoSaveDirectoryHandle: ReturnType<typeof vi.fn>
}
const writeLocalDeliveryFilesMock = writeLocalDeliveryFiles as unknown as ReturnType<typeof vi.fn>

function fakeDirectoryHandle(name: string) {
  return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle
}

function succeededJob(id: string): ImageJobV1 {
  return {
    id,
    contractVersion: '1',
    request: {
      contractVersion: '1',
      idempotencyKey: `delivery-test-${id}`,
      input: { prompt: 'Delivery separation test' },
      composition: { ratio: '1:1' },
      generation: { provider: 'configured', model: 'gpt-image-2', apiMode: 'images' },
      output: {
        ratioMode: 'inherit',
        format: 'png',
        quality: 'high',
        dimensions: '2880x2880',
        enhancement: 'lanczos3',
        contentClass: 'photo',
      },
    },
    state: 'succeeded',
    attempts: 1,
    routeIndex: 0,
    routeAttempts: 1,
    maxAttempts: 3,
    actualRoute: { provider: 'configured', model: 'gpt-image-2', apiMode: 'images' },
    cancelRequested: false,
    sourceAssetId: null,
    finalAssetId: `asset-${id}`,
    events: [],
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:01:00.000Z',
  } satisfies ImageJobV1
}

const config = {} as ImageTaskApiConfig

beforeEach(() => {
  vi.clearAllMocks()
  db.__resetDirectories()
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(window.navigator, 'userAgentData', {
    configurable: true,
    value: { mobile: false, brands: [{ brand: 'Google Chrome', version: '126' }] },
  })
})

afterEach(() => {
  Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: undefined })
  Object.defineProperty(window.navigator, 'userAgentData', { configurable: true, value: undefined })
})

describe('engine local delivery directory is independent from the gallery auto-save directory', () => {
  it('choosing the delivery directory persists the engine handle without touching the gallery handle', async () => {
    await dbModule.putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('4K'))
    const picker = vi.fn().mockResolvedValue(fakeDirectoryHandle('批量'))
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: picker })

    const directory = await chooseEngineLocalDeliveryDirectory()

    expect(directory.name).toBe('批量')
    expect(await dbModule.getEngineDeliveryDirectoryHandle()).toMatchObject({ name: '批量' })
    expect(await dbModule.getLocalAutoSaveDirectoryHandle()).toMatchObject({ name: '4K' })
    expect(db.putLocalAutoSaveDirectoryHandle).toHaveBeenCalledTimes(1)
  })

  it('does not fall back to the gallery handle when the engine handle is unset', async () => {
    await dbModule.putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('4K'))

    const { record } = await saveEngineJobLocally(config, succeededJob('no-fallback'))

    expect(record.status).toBe('pending')
    expect(record.error).toBe('尚未选择本地交付目录')
    expect(writeLocalDeliveryFilesMock).not.toHaveBeenCalled()
  })

  it('writes deliveries through the engine handle, not the gallery handle', async () => {
    await dbModule.putEngineDeliveryDirectoryHandle(fakeDirectoryHandle('批量'))
    await dbModule.putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('4K'))

    const { record } = await saveEngineJobLocally(config, succeededJob('via-engine'))

    expect(record.status).toBe('saved')
    expect(writeLocalDeliveryFilesMock).toHaveBeenCalledTimes(1)
    const rootHandle = writeLocalDeliveryFilesMock.mock.calls[0][0].rootHandle as { name?: string }
    expect(rootHandle.name).toBe('批量')
  })

  it('clearing the gallery directory does not remove the engine delivery directory', async () => {
    await dbModule.putEngineDeliveryDirectoryHandle(fakeDirectoryHandle('批量'))
    await dbModule.putLocalAutoSaveDirectoryHandle(fakeDirectoryHandle('4K'))

    await dbModule.clearLocalAutoSaveDirectoryHandle()

    expect(await dbModule.getLocalAutoSaveDirectoryHandle()).toBeUndefined()
    expect(await dbModule.getEngineDeliveryDirectoryHandle()).toMatchObject({ name: '批量' })

    await dbModule.clearEngineDeliveryDirectoryHandle()
    expect(await dbModule.getEngineDeliveryDirectoryHandle()).toBeUndefined()
  })
})
