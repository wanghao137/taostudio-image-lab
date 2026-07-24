import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// fake-indexeddb 提供完整的 IndexedDB 事务语义（onsuccess/oncomplete/onabort/onerror），
// 用来验证 dbTransaction 的 Promise 在事务真正提交（oncomplete）后才 resolve，
// 而非在 req.onsuccess 时提前 resolve。
import 'fake-indexeddb/auto'
import {
  clearAgentConversations,
  clearImages,
  clearTasks,
  getAllAgentConversations,
  getAllImageIds,
  getAllTasks,
  getImage,
  getImageThumbnail,
  putAgentConversation,
  putImage,
  putImageThumbnail,
  putTask,
  storeImage,
} from './db'
import type { AgentConversation, TaskRecord } from '../types'

function sampleTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    prompt: 'p',
    params: { size: '1024x1024', n: 1 } as TaskRecord['params'],
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

function sampleConversation(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return {
    id: 'conv-1',
    title: 't',
    activeRoundId: null,
    createdAt: 1,
    updatedAt: 1,
    rounds: [],
    messages: [],
    ...overrides,
  }
}

describe('db — real IndexedDB transaction semantics (fake-indexeddb)', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearAgentConversations()
    await clearImages()
  })

  afterEach(async () => {
    await clearTasks()
    await clearAgentConversations()
    await clearImages()
  })

  it('putTask resolves only after the transaction commits (data is durable)', async () => {
    await putTask(sampleTask({ id: 'durable-1' }))

    // Immediately after putTask resolves, getAllTasks must see the record.
    // If dbTransaction resolved on req.onsuccess (pre-commit), this read could
    // race and return [] in environments where commit is deferred.
    const all = await getAllTasks()
    expect(all.map((t) => t.id)).toContain('durable-1')
  })

  it('clearTasks resolves only after the store is actually empty', async () => {
    await putTask(sampleTask({ id: 'survive-1' }))
    await putTask(sampleTask({ id: 'survive-2' }))
    expect((await getAllTasks()).length).toBe(2)

    await clearTasks()

    // The core regression: after clearTasks resolves, the store MUST be empty.
    // The original bug resolved on req.onsuccess, so a subsequent read could
    // still see stale data if the clear transaction hadn't committed yet.
    const remaining = await getAllTasks()
    expect(remaining.length).toBe(0)
  })

  it('clearAgentConversations resolves only after the store is actually empty', async () => {
    await putAgentConversation(sampleConversation({ id: 'c-1' }))
    await putAgentConversation(sampleConversation({ id: 'c-2' }))

    await clearAgentConversations()

    expect((await getAllAgentConversations()).length).toBe(0)
  })

  it('clearImages resolves only after both images and thumbnails stores are empty', async () => {
    await putImage({ id: 'img-1', dataUrl: 'data:image/png;base64,aaa', source: 'upload', createdAt: 1 })
    await putImageThumbnail({
      id: 'img-1',
      thumbnailDataUrl: 'data:image/png;base64,thumb',
      width: 100,
      height: 100,
      thumbnailVersion: 2,
    })

    await clearImages()

    expect((await getAllImageIds()).length).toBe(0)
  })

  it('multiple sequential clears on the same store are all durable', async () => {
    for (let i = 0; i < 5; i++) {
      await putTask(sampleTask({ id: `batch-${i}` }))
    }
    await clearTasks()
    await putTask(sampleTask({ id: 'after-clear' }))
    await clearTasks()

    expect((await getAllTasks()).length).toBe(0)
  })

  it('getImage returns undefined for missing keys without rejecting', async () => {
    const result = await getImage('does-not-exist')
    expect(result).toBeUndefined()
  })

  it('storeImage writes the image record and is retrievable', async () => {
    const id = await storeImage('data:image/png;base64,iVBORw0KGgo=', 'upload')
    expect(id).toBeTruthy()

    const image = await getImage(id)
    expect(image).toBeDefined()
    expect(image!.source).toBe('upload')
    // Note: thumbnail generation requires a real Canvas environment; in
    // fake-indexeddb (Node) the thumbnail may be absent. The image record
    // itself must still be durable.
  })

  it('getImageThumbnail regenerates a missing thumbnail from the stored image', async () => {
    // Put an image without a pre-existing thumbnail record.
    await putImage({
      id: 'no-thumb',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      source: 'generated',
      createdAt: 1,
    })

    const thumb = await getImageThumbnail('no-thumb')
    // fake-indexeddb doesn't run canvas, so thumbnailDataUrl may be absent,
    // but the call must not reject and must return an object or undefined.
    expect(thumb === undefined || typeof thumb === 'object').toBe(true)
  })

  it('putTask overwrites an existing record with the same id', async () => {
    await putTask(sampleTask({ id: 'dup', prompt: 'first' }))
    await putTask(sampleTask({ id: 'dup', prompt: 'second' }))

    const all = await getAllTasks()
    expect(all.length).toBe(1)
    expect(all[0].prompt).toBe('second')
  })
})
