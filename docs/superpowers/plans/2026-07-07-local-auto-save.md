# Local Auto Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build desktop Chrome/Edge local auto-save for successful gallery-mode 4K generations, writing each eligible generation group to a user-selected local folder.

**Architecture:** Add a focused local auto-save subsystem with pure eligibility/format helpers, an IndexedDB-backed directory handle store, a File System Access writer, store integration after gallery task completion, and a compact Data-tab UI. The generation pipeline remains authoritative for task success; local archive status is a separate recoverable state.

**Tech Stack:** Vite, React, TypeScript, Zustand, IndexedDB, File System Access API, Vitest, existing `dataUrlToBytes`, `formatExportFileTime`, `sanitizeFileNamePart`, and `getExactImageSizeTarget` helpers.

## Global Constraints

- First version supports desktop Chrome/Edge only.
- No mobile support in the first version.
- No Agent mode auto-save in the first version.
- No cloud storage, R2, S3, sync, or account-level persistence.
- No automatic export of failed, partial, or non-4K tasks.
- Only gallery tasks with `status === 'done'` and confirmed 4K output are eligible.
- 4K requires both exact-size intent and actual stored output dimensions.
- Local auto-save failure must never change task generation status.
- Do not write API keys, bearer tokens, cookies, or request headers to local archive files.
- Do not commit unless the user explicitly asks; each task ends with tests plus a review checkpoint.

---

## File Structure

- Create `src/lib/localAutoSave.ts`: pure helpers for support detection, status decisions, 4K eligibility, safe folder names, prompt text, metadata, and data URL conversion.
- Create `src/lib/localAutoSave.test.ts`: pure helper regression tests.
- Create `src/lib/localAutoSaveWriter.ts`: File System Access writer that checks permissions and writes folders/files.
- Create `src/lib/localAutoSaveWriter.test.ts`: fake directory/file handle tests.
- Modify `src/types.ts`: add local auto-save settings and task status types.
- Modify `src/lib/apiProfiles.ts`: normalize and default `settings.localAutoSave`.
- Modify `src/lib/apiProfiles.test.ts`: settings normalization coverage.
- Modify `src/store.ts`: expose actions, persist task auto-save status, schedule auto-save after eligible gallery completion, and retry pending tasks.
- Modify `src/store.test.ts`: store integration coverage for saved, skipped, failed, and permission-blocked paths.
- Modify `src/components/SettingsModal.tsx`: Data-tab UI for enabling, selecting folder, showing status, and retrying.

---

### Task 1: Types, Settings, And Pure Local Auto-Save Helpers

**Files:**
- Create: `src/lib/localAutoSave.ts`
- Create: `src/lib/localAutoSave.test.ts`
- Modify: `src/types.ts`
- Modify: `src/lib/apiProfiles.ts`
- Modify: `src/lib/apiProfiles.test.ts`

**Interfaces:**
- Produces: `DEFAULT_LOCAL_AUTO_SAVE_SETTINGS`, `normalizeLocalAutoSaveSettings(value)`, `isLocalAutoSaveSupported()`, `getLocalAutoSaveEligibility(task, images)`, `buildLocalAutoSaveFolderName(task, size, usedNames)`, `buildPromptText(task, size)`, `buildMetadata(task, images)`.
- Consumes: existing `TaskRecord`, `StoredImage`, `TaskParams`, `getExactImageSizeTarget`, `formatExportFileTime`, `sanitizeFileNamePart`, and `dataUrlToBytes`.

- [ ] **Step 1: Add failing settings normalization tests**

Add these tests to `src/lib/apiProfiles.test.ts` in a new `describe('local auto-save settings')` block:

```ts
import { DEFAULT_LOCAL_AUTO_SAVE_SETTINGS, normalizeSettings } from './apiProfiles'

describe('local auto-save settings', () => {
  it('defaults local auto-save to disabled with no selected folder metadata', () => {
    const settings = normalizeSettings({})

    expect(settings.localAutoSave).toEqual(DEFAULT_LOCAL_AUTO_SAVE_SETTINGS)
  })

  it('normalizes persisted local auto-save metadata without storing handles in settings', () => {
    const settings = normalizeSettings({
      localAutoSave: {
        enabled: true,
        directoryName: 'D:\\\\TaoStudio Archive',
        lastSavedAt: 1783440000000,
        lastSavedFolderName: '2026-07-07_21-35-12_2160x3840_城市夜晚人像',
        handle: { unsafe: true },
      },
    })

    expect(settings.localAutoSave).toEqual({
      enabled: true,
      directoryName: 'D:\\\\TaoStudio Archive',
      lastSavedAt: 1783440000000,
      lastSavedFolderName: '2026-07-07_21-35-12_2160x3840_城市夜晚人像',
    })
    expect('handle' in settings.localAutoSave).toBe(false)
  })
})
```

- [ ] **Step 2: Run the new settings test and verify it fails**

Run:

```bash
npm test -- src/lib/apiProfiles.test.ts
```

Expected: FAIL because `DEFAULT_LOCAL_AUTO_SAVE_SETTINGS` and `settings.localAutoSave` do not exist yet.

- [ ] **Step 3: Add the public types**

Modify `src/types.ts` by adding these types before `export interface AppSettings`:

```ts
export type LocalAutoSaveStatus =
  | 'not_applicable'
  | 'pending'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'needs_permission'

export interface LocalAutoSaveSettings {
  enabled: boolean
  directoryName: string | null
  lastSavedAt: number | null
  lastSavedFolderName: string | null
}

export interface LocalAutoSaveTaskState {
  status: LocalAutoSaveStatus
  folderName?: string
  savedAt?: number
  files?: string[]
  error?: string
}
```

Add this field to `AppSettings`:

```ts
  localAutoSave: LocalAutoSaveSettings
```

Add this field to `TaskRecord` near the task status/timing fields:

```ts
  /** Local filesystem archive status; independent from generation status. */
  localAutoSave?: LocalAutoSaveTaskState
```

- [ ] **Step 4: Add settings defaults and normalization**

Modify `src/lib/apiProfiles.ts`:

```ts
import type {
  AgentApiConfigMode,
  ApiMode,
  ApiProfile,
  ApiProvider,
  AppSettings,
  CustomProviderDefinition,
  LocalAutoSaveSettings,
  ReferenceImageEditAction,
  ZipDownloadRoute,
} from '../types'
```

Add near other defaults:

```ts
export const DEFAULT_LOCAL_AUTO_SAVE_SETTINGS: LocalAutoSaveSettings = {
  enabled: false,
  directoryName: null,
  lastSavedAt: null,
  lastSavedFolderName: null,
}

export function normalizeLocalAutoSaveSettings(value: unknown): LocalAutoSaveSettings {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    enabled: record.enabled === true,
    directoryName: typeof record.directoryName === 'string' && record.directoryName.trim()
      ? record.directoryName
      : null,
    lastSavedAt: typeof record.lastSavedAt === 'number' && Number.isFinite(record.lastSavedAt)
      ? record.lastSavedAt
      : null,
    lastSavedFolderName: typeof record.lastSavedFolderName === 'string' && record.lastSavedFolderName.trim()
      ? record.lastSavedFolderName
      : null,
  }
}
```

Add to `normalizeSettings()` return object:

```ts
    localAutoSave: normalizeLocalAutoSaveSettings(record.localAutoSave),
```

Add to `DEFAULT_SETTINGS` input object:

```ts
  localAutoSave: DEFAULT_LOCAL_AUTO_SAVE_SETTINGS,
```

- [ ] **Step 5: Run the settings test and verify it passes**

Run:

```bash
npm test -- src/lib/apiProfiles.test.ts
```

Expected: PASS for the new `local auto-save settings` tests.

- [ ] **Step 6: Write failing pure helper tests**

Create `src/lib/localAutoSave.test.ts`:

```ts
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
  it('detects support only when showDirectoryPicker exists', () => {
    expect(isLocalAutoSaveSupported({ showDirectoryPicker: () => null })).toBe(true)
    expect(isLocalAutoSaveSupported({})).toBe(false)
  })

  it('requires exact-size 4K intent and actual 4K dimensions', () => {
    expect(getLocalAutoSaveEligibility(task(), [image()])).toEqual({ eligible: true })
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

  it('excludes Agent tasks from the first version', () => {
    expect(getLocalAutoSaveEligibility(task({ sourceMode: 'agent' }), [image()])).toEqual({
      eligible: false,
      status: 'not_applicable',
      reason: 'agent_task',
    })
  })

  it('formats safe folder names with duplicate suffixes', () => {
    const folder = buildLocalAutoSaveFolderName(task(), { width: 2160, height: 3840 }, new Set())
    expect(folder).toBe('2026-07-07_13-35-12_2160x3840_城市夜晚人像-cinematic')

    const duplicate = buildLocalAutoSaveFolderName(task(), { width: 2160, height: 3840 }, new Set([folder]))
    expect(duplicate).toBe('2026-07-07_13-35-12_2160x3840_城市夜晚人像-cinematic-2')
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

  it('accepts both portrait and landscape 4K sizes', () => {
    expect(isConfirmed4kSize({ width: 2160, height: 3840 })).toBe(true)
    expect(isConfirmed4kSize({ width: 3840, height: 2160 })).toBe(true)
    expect(isConfirmed4kSize({ width: 2048, height: 4096 })).toBe(false)
  })
})
```

- [ ] **Step 7: Run the pure helper test and verify it fails**

Run:

```bash
npm test -- src/lib/localAutoSave.test.ts
```

Expected: FAIL because `src/lib/localAutoSave.ts` does not exist.

- [ ] **Step 8: Implement pure helpers**

Create `src/lib/localAutoSave.ts`:

```ts
import type { LocalAutoSaveStatus, StoredImage, TaskRecord } from '../types'
import { dataUrlToBytes } from './dataUrl'
import { formatExportFileTime, sanitizeFileNamePart } from './exportFileName'
import { getExactImageSizeTarget } from './exactImageSize'

export type LocalAutoSaveIneligibilityReason =
  | 'agent_task'
  | 'not_done'
  | 'no_outputs'
  | 'missing_image'
  | 'not_4k_intent'
  | 'not_4k_actual'

export type LocalAutoSaveEligibility =
  | { eligible: true }
  | { eligible: false; status: Extract<LocalAutoSaveStatus, 'not_applicable' | 'failed'>; reason: LocalAutoSaveIneligibilityReason }

export interface LocalAutoSaveSize {
  width: number
  height: number
}

export interface LocalAutoSaveMetadataImage {
  image: StoredImage
  fileName: string
}

export interface LocalAutoSaveMetadata {
  version: 1
  taskId: string
  createdAt: string
  finishedAt: string | null
  prompt: string
  params: TaskRecord['params']
  actualSize: LocalAutoSaveSize
  api: {
    provider: string | null
    profileName: string | null
    model: string | null
  }
  images: Array<{
    file: string
    width: number
    height: number
  }>
}

export function isLocalAutoSaveSupported(target: { showDirectoryPicker?: unknown } = globalThis.window ?? {}) {
  return typeof (target as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
}

export function isConfirmed4kSize(size: { width?: number; height?: number } | null | undefined): size is LocalAutoSaveSize {
  if (!size?.width || !size.height) return false
  const longEdge = Math.max(size.width, size.height)
  const shortEdge = Math.min(size.width, size.height)
  return longEdge === 3840 && shortEdge >= 2160
}

export function getLocalAutoSaveIntentSize(task: Pick<TaskRecord, 'params'>): LocalAutoSaveSize | null {
  const target = getExactImageSizeTarget(task.params)
  return isConfirmed4kSize(target) ? target : null
}

export function getLocalAutoSaveEligibility(task: TaskRecord, images: StoredImage[]): LocalAutoSaveEligibility {
  if (task.sourceMode === 'agent') return { eligible: false, status: 'not_applicable', reason: 'agent_task' }
  if (task.status !== 'done') return { eligible: false, status: 'not_applicable', reason: 'not_done' }
  if (!task.outputImages.length) return { eligible: false, status: 'not_applicable', reason: 'no_outputs' }
  if (!getLocalAutoSaveIntentSize(task)) return { eligible: false, status: 'not_applicable', reason: 'not_4k_intent' }
  if (images.length !== task.outputImages.length) return { eligible: false, status: 'failed', reason: 'missing_image' }
  if (!images.every((img) => isConfirmed4kSize(img))) return { eligible: false, status: 'not_applicable', reason: 'not_4k_actual' }
  return { eligible: true }
}

function getPromptPrefix(prompt: string) {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  const chars = Array.from(normalized).slice(0, 20).join('')
  return sanitizeFileNamePart(chars).replace(/^-+|-+$/g, '') || 'untitled'
}

export function buildLocalAutoSaveFolderName(task: TaskRecord, size: LocalAutoSaveSize, usedNames: Set<string>) {
  const base = `${formatExportFileTime(new Date(task.createdAt))}_${size.width}x${size.height}_${getPromptPrefix(task.prompt)}`
  let candidate = base
  let suffix = 2
  while (usedNames.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function buildLocalAutoSavePromptText(task: TaskRecord, size: LocalAutoSaveSize) {
  const lines = [
    '提示词：',
    task.prompt,
    '',
    `尺寸：${size.width}x${size.height}`,
    `模型：${task.apiModel ?? '未知'}`,
    `质量：${task.params.quality}`,
    `格式：${task.params.output_format.toUpperCase()}`,
    `生成时间：${new Date(task.finishedAt ?? task.createdAt).toLocaleString('zh-CN', { hour12: false })}`,
    `任务ID：${task.id}`,
  ]
  return `${lines.join('\n')}\n`
}

export function buildLocalAutoSaveMetadata(task: TaskRecord, images: LocalAutoSaveMetadataImage[]): LocalAutoSaveMetadata {
  const firstImage = images[0]?.image
  const actualSize = {
    width: firstImage?.width ?? 0,
    height: firstImage?.height ?? 0,
  }
  return {
    version: 1,
    taskId: task.id,
    createdAt: new Date(task.createdAt).toISOString(),
    finishedAt: task.finishedAt ? new Date(task.finishedAt).toISOString() : null,
    prompt: task.prompt,
    params: task.params,
    actualSize,
    api: {
      provider: task.apiProvider ?? null,
      profileName: task.apiProfileName ?? null,
      model: task.apiModel ?? null,
    },
    images: images.map(({ image, fileName }) => ({
      file: fileName,
      width: image.width ?? 0,
      height: image.height ?? 0,
    })),
  }
}

export function getLocalAutoSaveImageFileName(index: number, image: StoredImage) {
  const { ext } = dataUrlToBytes(image.dataUrl)
  return `image-${index + 1}.${ext === 'jpeg' ? 'jpg' : ext}`
}

export function getLocalAutoSaveImageBytes(image: StoredImage) {
  return dataUrlToBytes(image.dataUrl).bytes
}
```

- [ ] **Step 9: Run Task 1 tests**

Run:

```bash
npm test -- src/lib/apiProfiles.test.ts src/lib/localAutoSave.test.ts
```

Expected: PASS.

- [ ] **Step 10: Task 1 review checkpoint**

Run:

```bash
npm run lint
npm run build
git diff --check
git status --short
```

Expected: lint and build pass; `git diff --check` has no output; changed files are only Task 1 files.

---

### Task 2: Directory Handle Persistence And File Writer

**Files:**
- Create: `src/lib/localAutoSaveWriter.ts`
- Create: `src/lib/localAutoSaveWriter.test.ts`
- Modify: `src/lib/db.ts`

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: `getLocalAutoSaveDirectoryHandle()`, `putLocalAutoSaveDirectoryHandle(handle)`, `clearLocalAutoSaveDirectoryHandle()`, `writeLocalAutoSaveArchive(params)`.

- [ ] **Step 1: Add failing writer tests with fake handles**

Create `src/lib/localAutoSaveWriter.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { writeLocalAutoSaveArchive, type WritableDirectoryHandle } from './localAutoSaveWriter'

class FakeWritable {
  chunks: unknown[] = []
  async write(chunk: unknown) {
    this.chunks.push(chunk)
  }
  async close() {
    return undefined
  }
}

class FakeFileHandle {
  writable = new FakeWritable()
  async createWritable() {
    return this.writable
  }
}

class FakeDirectoryHandle {
  name = 'Archive'
  permission: PermissionState = 'granted'
  directories = new Map<string, FakeDirectoryHandle>()
  files = new Map<string, FakeFileHandle>()

  async queryPermission() {
    return this.permission
  }

  async requestPermission() {
    return this.permission
  }

  async getDirectoryHandle(name: string) {
    const next = new FakeDirectoryHandle()
    next.name = name
    this.directories.set(name, next)
    return next
  }

  async getFileHandle(name: string) {
    const file = new FakeFileHandle()
    this.files.set(name, file)
    return file
  }
}

describe('local auto-save writer', () => {
  it('writes all files into a generated folder', async () => {
    const root = new FakeDirectoryHandle()

    const result = await writeLocalAutoSaveArchive({
      rootHandle: root as unknown as WritableDirectoryHandle,
      folderName: '2026-07-07_13-35-12_2160x3840_城市夜晚人像',
      files: [
        { name: 'image-1.png', data: new Uint8Array([1, 2, 3]), type: 'image/png' },
        { name: 'prompt.txt', data: '提示词：城市夜晚人像\\n', type: 'text/plain;charset=utf-8' },
        { name: 'metadata.json', data: '{\"version\":1}\\n', type: 'application/json;charset=utf-8' },
      ],
    })

    const folder = root.directories.get('2026-07-07_13-35-12_2160x3840_城市夜晚人像')
    expect(result).toEqual({
      folderName: '2026-07-07_13-35-12_2160x3840_城市夜晚人像',
      files: ['image-1.png', 'prompt.txt', 'metadata.json'],
    })
    expect(folder?.files.has('image-1.png')).toBe(true)
    expect(folder?.files.has('prompt.txt')).toBe(true)
    expect(folder?.files.has('metadata.json')).toBe(true)
  })

  it('returns needs_permission when readwrite permission is denied', async () => {
    const root = new FakeDirectoryHandle()
    root.permission = 'denied'

    await expect(writeLocalAutoSaveArchive({
      rootHandle: root as unknown as WritableDirectoryHandle,
      folderName: 'folder',
      files: [{ name: 'prompt.txt', data: 'prompt', type: 'text/plain;charset=utf-8' }],
    })).rejects.toMatchObject({ name: 'LocalAutoSavePermissionError' })
  })

  it('wraps write failures with a user-facing message', async () => {
    const root = new FakeDirectoryHandle()
    vi.spyOn(root, 'getDirectoryHandle').mockRejectedValueOnce(new Error('disk full'))

    await expect(writeLocalAutoSaveArchive({
      rootHandle: root as unknown as WritableDirectoryHandle,
      folderName: 'folder',
      files: [{ name: 'prompt.txt', data: 'prompt', type: 'text/plain;charset=utf-8' }],
    })).rejects.toThrow('本地自动保存失败：disk full')
  })
})
```

- [ ] **Step 2: Run writer tests and verify they fail**

Run:

```bash
npm test -- src/lib/localAutoSaveWriter.test.ts
```

Expected: FAIL because `localAutoSaveWriter.ts` does not exist.

- [ ] **Step 3: Implement the File System Access writer**

Create `src/lib/localAutoSaveWriter.ts`:

```ts
export type WritablePermissionState = PermissionState

export interface WritableFileHandle {
  createWritable: () => Promise<WritableStreamDefaultWriter | FileSystemWritableFileStream>
}

export interface WritableDirectoryHandle {
  name?: string
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<WritablePermissionState>
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<WritablePermissionState>
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<WritableDirectoryHandle>
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<WritableFileHandle>
}

export interface LocalAutoSaveWriteFile {
  name: string
  data: Uint8Array | string
  type: string
}

export interface LocalAutoSaveWriteParams {
  rootHandle: WritableDirectoryHandle
  folderName: string
  files: LocalAutoSaveWriteFile[]
}

export class LocalAutoSavePermissionError extends Error {
  constructor() {
    super('需要重新授权保存位置')
    this.name = 'LocalAutoSavePermissionError'
  }
}

async function ensureReadWritePermission(handle: WritableDirectoryHandle) {
  const descriptor = { mode: 'readwrite' as const }
  const queried = await handle.queryPermission?.(descriptor)
  if (queried === 'granted') return
  const requested = await handle.requestPermission?.(descriptor)
  if (requested !== 'granted') throw new LocalAutoSavePermissionError()
}

async function writeFile(handle: WritableDirectoryHandle, file: LocalAutoSaveWriteFile) {
  const fileHandle = await handle.getFileHandle(file.name, { create: true })
  const writable = await fileHandle.createWritable()
  const payload = typeof file.data === 'string'
    ? new Blob([file.data], { type: file.type })
    : new Blob([file.data], { type: file.type })
  await writable.write(payload)
  await writable.close()
}

export async function writeLocalAutoSaveArchive(params: LocalAutoSaveWriteParams) {
  try {
    await ensureReadWritePermission(params.rootHandle)
    const folder = await params.rootHandle.getDirectoryHandle(params.folderName, { create: true })
    for (const file of params.files) {
      await writeFile(folder, file)
    }
    return {
      folderName: params.folderName,
      files: params.files.map((file) => file.name),
    }
  } catch (err) {
    if (err instanceof LocalAutoSavePermissionError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`本地自动保存失败：${message}`)
  }
}
```

- [ ] **Step 4: Add directory handle persistence to IndexedDB**

Modify `src/lib/db.ts`:

```ts
const DB_VERSION = 4
const STORE_LOCAL_AUTO_SAVE = 'localAutoSave'
const LOCAL_AUTO_SAVE_DIRECTORY_KEY = 'directory'

export interface StoredLocalAutoSaveDirectoryHandle {
  id: typeof LOCAL_AUTO_SAVE_DIRECTORY_KEY
  handle: FileSystemDirectoryHandle
  name?: string
  updatedAt: number
}
```

Inside `openDB().onupgradeneeded`, add:

```ts
      if (!db.objectStoreNames.contains(STORE_LOCAL_AUTO_SAVE)) {
        db.createObjectStore(STORE_LOCAL_AUTO_SAVE, { keyPath: 'id' })
      }
```

Add exports near the image store helpers:

```ts
export function getLocalAutoSaveDirectoryHandle(): Promise<StoredLocalAutoSaveDirectoryHandle | undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readonly', (s) => s.get(LOCAL_AUTO_SAVE_DIRECTORY_KEY))
}

export function putLocalAutoSaveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<IDBValidKey> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.put({
    id: LOCAL_AUTO_SAVE_DIRECTORY_KEY,
    handle,
    name: handle.name,
    updatedAt: Date.now(),
  } satisfies StoredLocalAutoSaveDirectoryHandle))
}

export function clearLocalAutoSaveDirectoryHandle(): Promise<undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.delete(LOCAL_AUTO_SAVE_DIRECTORY_KEY))
}
```

- [ ] **Step 5: Run writer tests**

Run:

```bash
npm test -- src/lib/localAutoSaveWriter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Task 2 review checkpoint**

Run:

```bash
npm run lint
npm run build
git diff --check
git status --short
```

Expected: lint and build pass; changed files are only Task 2 files plus `src/lib/db.ts`.

---

### Task 3: Store Integration, Auto-Save Scheduling, And Retry

**Files:**
- Modify: `src/store.ts`
- Modify: `src/store.test.ts`
- Modify: `src/lib/localAutoSave.ts` if a test exposes a missing pure helper.

**Interfaces:**
- Consumes: Task 1 helpers and Task 2 persistence/writer functions.
- Produces store exports: `selectLocalAutoSaveDirectory()`, `retryPendingLocalAutoSaves()`, `runLocalAutoSaveForTask(taskId)`, `getLocalAutoSaveRetryableTaskCount(tasks)`.

- [ ] **Step 1: Add failing store integration tests**

In `src/store.test.ts`, extend the existing `vi.mock('./lib/db', ...)` return object with stubs for the new db exports:

```ts
    getLocalAutoSaveDirectoryHandle: async () => undefined,
    putLocalAutoSaveDirectoryHandle: async () => 'directory',
    clearLocalAutoSaveDirectoryHandle: async () => undefined,
```

Add a new mock for the writer near other mocks:

```ts
vi.mock('./lib/localAutoSaveWriter', () => ({
  LocalAutoSavePermissionError: class LocalAutoSavePermissionError extends Error {
    constructor() {
      super('需要重新授权保存位置')
      this.name = 'LocalAutoSavePermissionError'
    }
  },
  writeLocalAutoSaveArchive: vi.fn(async () => ({
    folderName: '2026-07-07_13-35-12_2160x3840_城市夜晚人像',
    files: ['image-1.png', 'prompt.txt', 'metadata.json'],
  })),
}))
```

Update the later `./store` import in this test file to include the new export:

```ts
import {
  clearData,
  clearFailedTasks,
  createInputImageFromFile,
  editOutputs,
  getActiveAgentRounds,
  importData,
  initStore,
  retryTask,
  runLocalAutoSaveForTask,
  submitAgentMessage,
  submitTask,
  useStore,
} from './store'
```

Add tests:

```ts
import { writeLocalAutoSaveArchive, LocalAutoSavePermissionError } from './lib/localAutoSaveWriter'

describe('local auto-save store integration', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    vi.mocked(writeLocalAutoSaveArchive).mockClear()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        localAutoSave: {
          enabled: true,
          directoryName: 'Archive',
          lastSavedAt: null,
          lastSavedFolderName: null,
        },
      }),
      tasks: [],
      showToast: vi.fn(),
    })
  })

  it('auto-saves eligible gallery 4K tasks without changing generation status', async () => {
    await putImage({ id: 'image-a', dataUrl: 'data:image/png;base64,AAAA', width: 2160, height: 3840, source: 'generated' })
    const galleryTask = task({
      id: 'task-gallery-4k',
      prompt: '城市夜晚人像',
      params: { ...DEFAULT_PARAMS, size: '2160x3840', exact_size: true, quality: 'high', output_format: 'png' },
      outputImages: ['image-a'],
      status: 'done',
      createdAt: Date.UTC(2026, 6, 7, 13, 35, 12),
      finishedAt: Date.UTC(2026, 6, 7, 13, 36, 12),
    })
    useStore.getState().setTasks([galleryTask])

    await runLocalAutoSaveForTask('task-gallery-4k')

    const saved = useStore.getState().tasks[0]
    expect(saved.status).toBe('done')
    expect(saved.localAutoSave).toMatchObject({
      status: 'saved',
      folderName: '2026-07-07_13-35-12_2160x3840_城市夜晚人像',
      files: ['image-1.png', 'prompt.txt', 'metadata.json'],
    })
    expect(writeLocalAutoSaveArchive).toHaveBeenCalledTimes(1)
  })

  it('marks Agent tasks as not_applicable', async () => {
    useStore.getState().setTasks([task({
      id: 'agent-task',
      sourceMode: 'agent',
      outputImages: ['image-a'],
      params: { ...DEFAULT_PARAMS, size: '2160x3840', exact_size: true },
    })])

    await runLocalAutoSaveForTask('agent-task')

    expect(useStore.getState().tasks[0].localAutoSave).toEqual({
      status: 'not_applicable',
      error: 'agent_task',
    })
    expect(writeLocalAutoSaveArchive).not.toHaveBeenCalled()
  })

  it('marks missing stored images as failed', async () => {
    useStore.getState().setTasks([task({
      id: 'missing-image-task',
      outputImages: ['missing-image'],
      params: { ...DEFAULT_PARAMS, size: '2160x3840', exact_size: true },
    })])

    await runLocalAutoSaveForTask('missing-image-task')

    expect(useStore.getState().tasks[0].localAutoSave).toEqual({
      status: 'failed',
      error: '图片数据已不存在',
    })
  })

  it('marks permission errors as needs_permission', async () => {
    vi.mocked(writeLocalAutoSaveArchive).mockRejectedValueOnce(new LocalAutoSavePermissionError())
    await putImage({ id: 'image-a', dataUrl: 'data:image/png;base64,AAAA', width: 2160, height: 3840, source: 'generated' })
    useStore.getState().setTasks([task({
      id: 'permission-task',
      outputImages: ['image-a'],
      params: { ...DEFAULT_PARAMS, size: '2160x3840', exact_size: true },
    })])

    await runLocalAutoSaveForTask('permission-task')

    expect(useStore.getState().tasks[0].localAutoSave).toEqual({
      status: 'needs_permission',
      error: '需要重新授权保存位置',
    })
  })
})
```

- [ ] **Step 2: Run the store tests and verify they fail**

Run:

```bash
npm test -- src/store.test.ts
```

Expected: FAIL because `runLocalAutoSaveForTask` and retry helpers do not exist.

- [ ] **Step 3: Import local auto-save dependencies in `src/store.ts`**

Add imports:

```ts
  getLocalAutoSaveDirectoryHandle,
  putLocalAutoSaveDirectoryHandle,
} from './lib/db'
import {
  buildLocalAutoSaveFolderName,
  buildLocalAutoSaveMetadata,
  buildLocalAutoSavePromptText,
  getLocalAutoSaveEligibility,
  getLocalAutoSaveImageBytes,
  getLocalAutoSaveImageFileName,
  getLocalAutoSaveIntentSize,
} from './lib/localAutoSave'
import { LocalAutoSavePermissionError, writeLocalAutoSaveArchive } from './lib/localAutoSaveWriter'
```

- [ ] **Step 4: Add store action types**

Add to `AppState`:

```ts
  localAutoSaveRunningTaskIds: Record<string, true>
  selectLocalAutoSaveDirectory: () => Promise<void>
  retryPendingLocalAutoSaves: () => Promise<void>
```

Add defaults inside the store initializer:

```ts
      localAutoSaveRunningTaskIds: {},
      selectLocalAutoSaveDirectory: async () => {
        if (typeof window === 'undefined' || typeof window.showDirectoryPicker !== 'function') {
          get().showToast('本地自动保存仅支持桌面 Chrome/Edge', 'error')
          return
        }
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
        await putLocalAutoSaveDirectoryHandle(handle)
        get().setSettings({
          localAutoSave: {
            ...get().settings.localAutoSave,
            directoryName: handle.name,
          },
        })
        get().showToast('本地自动保存位置已设置', 'success')
      },
      retryPendingLocalAutoSaves: async () => {
        const retryable = get().tasks.filter((task) =>
          task.localAutoSave?.status === 'pending' ||
          task.localAutoSave?.status === 'failed' ||
          task.localAutoSave?.status === 'needs_permission'
        )
        for (const task of retryable) {
          await runLocalAutoSaveForTask(task.id)
        }
      },
```

- [ ] **Step 5: Implement status update helpers**

Add near `updateTaskInStore`:

```ts
function updateTaskLocalAutoSave(taskId: string, localAutoSave: TaskRecord['localAutoSave']) {
  updateTaskInStore(taskId, { localAutoSave })
}

export function getLocalAutoSaveRetryableTaskCount(tasks: TaskRecord[]) {
  return tasks.filter((task) =>
    task.localAutoSave?.status === 'pending' ||
    task.localAutoSave?.status === 'failed' ||
    task.localAutoSave?.status === 'needs_permission'
  ).length
}
```

- [ ] **Step 6: Implement `runLocalAutoSaveForTask`**

Add after `updateTaskInStore`:

```ts
export async function runLocalAutoSaveForTask(taskId: string) {
  const state = useStore.getState()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) return
  if (!state.settings.localAutoSave.enabled) return
  if (state.localAutoSaveRunningTaskIds[taskId]) return
  if (task.localAutoSave?.status === 'saved') return

  useStore.setState((current) => ({
    localAutoSaveRunningTaskIds: { ...current.localAutoSaveRunningTaskIds, [taskId]: true },
  }))

  try {
    const storedImages = []
    for (const imageId of task.outputImages) {
      const image = await getImage(imageId)
      if (image) storedImages.push(image)
    }

    const eligibility = getLocalAutoSaveEligibility(task, storedImages)
    if (!eligibility.eligible) {
      updateTaskLocalAutoSave(taskId, {
        status: eligibility.status,
        error: eligibility.reason === 'missing_image' ? '图片数据已不存在' : eligibility.reason,
      })
      return
    }

    const directory = await getLocalAutoSaveDirectoryHandle()
    if (!directory?.handle) {
      updateTaskLocalAutoSave(taskId, { status: 'pending', error: '未选择保存位置' })
      return
    }

    const intentSize = getLocalAutoSaveIntentSize(task)
    const actualSize = {
      width: storedImages[0].width ?? intentSize?.width ?? 0,
      height: storedImages[0].height ?? intentSize?.height ?? 0,
    }
    const usedNames = new Set(useStore.getState().tasks.map((item) => item.localAutoSave?.folderName).filter((value): value is string => Boolean(value)))
    const folderName = buildLocalAutoSaveFolderName(task, actualSize, usedNames)
    const imageFiles = storedImages.map((image, index) => ({
      image,
      fileName: getLocalAutoSaveImageFileName(index, image),
    }))
    const metadata = buildLocalAutoSaveMetadata(task, imageFiles)

    updateTaskLocalAutoSave(taskId, { status: 'saving' })
    const result = await writeLocalAutoSaveArchive({
      rootHandle: directory.handle,
      folderName,
      files: [
        ...imageFiles.map(({ image, fileName }) => ({
          name: fileName,
          data: getLocalAutoSaveImageBytes(image),
          type: image.dataUrl.match(/^data:([^;]+)/)?.[1] ?? 'image/png',
        })),
        { name: 'prompt.txt', data: buildLocalAutoSavePromptText(task, actualSize), type: 'text/plain;charset=utf-8' },
        { name: 'metadata.json', data: `${JSON.stringify(metadata, null, 2)}\n`, type: 'application/json;charset=utf-8' },
      ],
    })

    updateTaskLocalAutoSave(taskId, {
      status: 'saved',
      folderName: result.folderName,
      files: result.files,
      savedAt: Date.now(),
    })
    useStore.getState().setSettings({
      localAutoSave: {
        ...useStore.getState().settings.localAutoSave,
        lastSavedAt: Date.now(),
        lastSavedFolderName: result.folderName,
      },
    })
  } catch (err) {
    updateTaskLocalAutoSave(taskId, {
      status: err instanceof LocalAutoSavePermissionError ? 'needs_permission' : 'failed',
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    useStore.setState((current) => {
      const next = { ...current.localAutoSaveRunningTaskIds }
      delete next[taskId]
      return { localAutoSaveRunningTaskIds: next }
    })
  }
}
```

- [ ] **Step 7: Trigger auto-save after gallery task success**

In `executeTask`, immediately after the successful `updateTaskInStore(taskId, { ... status: 'done' ... })` block, add:

```ts
    if (useStore.getState().settings.localAutoSave.enabled) {
      void runLocalAutoSaveForTask(taskId)
    }
```

Do not add this to Agent-specific task creation paths in this first version.

- [ ] **Step 8: Run store tests**

Run:

```bash
npm test -- src/store.test.ts
```

Expected: PASS.

- [ ] **Step 9: Task 3 review checkpoint**

Run:

```bash
npm test -- src/store.test.ts src/lib/localAutoSave.test.ts src/lib/localAutoSaveWriter.test.ts
npm run lint
npm run build
git diff --check
git status --short
```

Expected: all tests pass; lint and build pass; `git diff --check` has no output.

---

### Task 4: Settings Data Tab UI

**Files:**
- Modify: `src/components/SettingsModal.tsx`
- Modify or create test only if the project already has nearby SettingsModal tests during implementation.

**Interfaces:**
- Consumes store actions `selectLocalAutoSaveDirectory`, `retryPendingLocalAutoSaves`, `getLocalAutoSaveRetryableTaskCount`, and `settings.localAutoSave`.
- Produces user controls in the Data tab.

- [ ] **Step 1: Add selectors and support detection**

Modify the import from `../store`:

```ts
import { useStore, exportData, importData, clearData, getLocalAutoSaveRetryableTaskCount, type SettingsTab } from '../store'
```

Inside `SettingsModal`, add selectors:

```ts
  const tasks = useStore((s) => s.tasks)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const selectLocalAutoSaveDirectory = useStore((s) => s.selectLocalAutoSaveDirectory)
  const retryPendingLocalAutoSaves = useStore((s) => s.retryPendingLocalAutoSaves)
  const localAutoSaveSupported = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
  const pendingLocalAutoSaveCount = getLocalAutoSaveRetryableTaskCount(tasks)
```

- [ ] **Step 2: Add the Data-tab UI section**

In `activeTab === 'data'`, insert this block before `导出数据`:

```tsx
                <div className="rounded-2xl border border-gray-100 bg-white p-4 dark:border-white/[0.06] dark:bg-white/[0.02] space-y-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-bold text-gray-800 dark:text-gray-100">本地自动保存</h4>
                      <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                        仅自动保存画廊模式下成功生成的 4K 图片。
                      </p>
                    </div>
                    <Checkbox
                      checked={settings.localAutoSave.enabled}
                      onChange={(enabled) => setSettings({
                        localAutoSave: {
                          ...settings.localAutoSave,
                          enabled,
                        },
                      })}
                      label={settings.localAutoSave.enabled ? '开启' : '关闭'}
                      disabled={!localAutoSaveSupported}
                    />
                  </div>

                  {!localAutoSaveSupported ? (
                    <div className="rounded-xl border border-yellow-200/70 bg-yellow-50 px-3 py-2 text-xs leading-relaxed text-yellow-700 dark:border-yellow-500/20 dark:bg-yellow-500/10 dark:text-yellow-200">
                      本地自动保存仅支持桌面 Chrome/Edge。移动端暂不支持本地自动保存，可继续使用手动下载。
                    </div>
                  ) : (
                    <>
                      <div className="rounded-xl bg-gray-50/80 p-3 text-xs leading-relaxed text-gray-600 dark:bg-white/[0.04] dark:text-gray-300">
                        <div>保存位置：{settings.localAutoSave.directoryName ?? '未选择'}</div>
                        <div>状态：{settings.localAutoSave.directoryName ? '已选择，写入前会确认权限' : '未选择'}</div>
                        {settings.localAutoSave.lastSavedFolderName ? (
                          <div>最近保存：{settings.localAutoSave.lastSavedFolderName}</div>
                        ) : null}
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={() => { void selectLocalAutoSaveDirectory() }}
                          className="rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm font-medium text-gray-700 transition-all hover:bg-gray-200 hover:text-gray-900 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1] dark:hover:text-white"
                        >
                          选择文件夹
                        </button>
                        <button
                          type="button"
                          onClick={() => { void retryPendingLocalAutoSaves() }}
                          disabled={pendingLocalAutoSaveCount === 0}
                          className="rounded-xl bg-blue-50 px-4 py-2.5 text-sm font-medium text-blue-600 transition-all hover:bg-blue-100 disabled:opacity-50 disabled:hover:bg-blue-50 dark:bg-blue-500/10 dark:text-blue-300 dark:hover:bg-blue-500/20 dark:disabled:hover:bg-blue-500/10"
                        >
                          立即补保存（{pendingLocalAutoSaveCount}）
                        </button>
                      </div>
                    </>
                  )}
                </div>
```

- [ ] **Step 3: Keep copy Chinese and scope-specific**

Verify visible copy includes:

```text
本地自动保存
仅自动保存画廊模式下成功生成的 4K 图片。
本地自动保存仅支持桌面 Chrome/Edge。
移动端暂不支持本地自动保存，可继续使用手动下载。
选择文件夹
立即补保存
```

- [ ] **Step 4: Run UI-related checks**

Run:

```bash
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 5: Task 4 review checkpoint**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; changed file includes `src/components/SettingsModal.tsx`.

---

### Task 5: Browser Verification And Final Regression

**Files:**
- No source changes unless verification exposes a bug.

**Interfaces:**
- Consumes the completed implementation.
- Produces verified behavior evidence.

- [ ] **Step 1: Run full automated gates**

Run:

```bash
npm test
npm run build
npm run lint
```

Expected: all pass. Existing lint warning baseline may remain only if already present before this feature.

- [ ] **Step 2: Start the local app**

Run:

```bash
npm run start:local
```

Expected: Vite serves the app on `http://127.0.0.1:9527/`.

- [ ] **Step 3: Verify unsupported/mobile messaging manually**

In desktop Chrome or Edge:

1. Open settings.
2. Open Data tab.
3. Confirm the local auto-save section appears.
4. Confirm the section says it supports desktop Chrome/Edge and mobile is unsupported.

Expected: section is visible, copy is Chinese, and no mobile promise is made.

- [ ] **Step 4: Verify directory selection**

In desktop Chrome or Edge:

1. Enable `本地自动保存`.
2. Click `选择文件夹`.
3. Choose a temporary archive folder such as `D:\taostudio-local-auto-save-test`.

Expected: the settings section shows the selected folder name and no console error is produced.

- [ ] **Step 5: Verify archive writing with an existing eligible task if available**

If the browser already has a completed gallery task with `2160x3840` or `3840x2160` output:

1. Open settings.
2. Click `立即补保存`.
3. Inspect the selected folder.

Expected: one folder named like `YYYY-MM-DD_HH-mm-ss_2160x3840_提示词前缀` exists and contains `image-1.png`, `prompt.txt`, and `metadata.json`.

- [ ] **Step 6: Verify new generation writing when credentials are available**

Only run this when local credentials are already configured:

1. In gallery mode, generate a 4K exact-size image.
2. Wait for task success.
3. Inspect the selected archive folder.

Expected: the archive folder appears automatically after generation completion. The gallery task remains `done`.

- [ ] **Step 7: Verify failure isolation**

Temporarily revoke folder permission from the browser site settings or choose a folder and deny the permission prompt when requested.

Expected: the task remains `done`; local auto-save status becomes `needs_permission` or `failed`; settings shows a nonzero retry count.

- [ ] **Step 8: Final review checkpoint**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; changed files match the implementation scope. Do not commit unless the user explicitly asks.
