import { zipSync } from 'fflate'
import {
  getImageAssetBlob,
  getImageAssetManifest,
  getImageBatchSummary,
  listAllImageBatchItems,
  type ImageBatchItemV1,
  type ImageBatchSummaryV1,
  type ImageBatchV1,
  type ImageJobV1,
  type ImageTaskApiConfig,
} from './imageTaskApi'
import { getLocalAutoSaveDirectoryHandle, putEngineDeliveryRecord, getEngineDeliveryRecord, type EngineDeliveryRecord } from './db'
import { isLocalAutoSaveSupported } from './localAutoSave'
import {
  LocalAutoSavePermissionError,
  writeLocalDeliveryFiles,
  type WritableDirectoryHandle,
  type LocalAutoSaveWriteFile,
} from './localAutoSaveWriter'
import { sanitizeFileNamePart } from './exportFileName'

export type EngineDeliveryStatus = EngineDeliveryRecord['status']

export interface EngineDeliveryProgress {
  savedCount: number
  totalCount: number
  status: EngineDeliveryStatus
  error?: string | null
}

export interface EngineDeliveryDirectory {
  handle: WritableDirectoryHandle
  name: string
}

export interface EngineDeliveryResult {
  record: EngineDeliveryRecord
  skipped?: boolean
}

function shortTitle(prompt: string | undefined, fallback: string) {
  const value = (prompt || fallback).replace(/\s+/g, ' ').trim()
  return sanitizeFileNamePart(value.split(/[。！？.!?\n]/)[0] || value).slice(0, 48) || fallback
}

function jobFolderName(job: ImageJobV1) {
  return `jobs/${sanitizeFileNamePart(job.id)}_${shortTitle(job.request.input.prompt, 'image')}`
}

function batchFolderName(batch: Pick<ImageBatchV1, 'id' | 'name'> | ImageBatchSummaryV1) {
  return `batches/${sanitizeFileNamePart(batch.id)}_${shortTitle(batch.name || undefined, 'batch')}`
}

function itemFolderName(item: ImageBatchItemV1, total: number) {
  const digits = Math.max(3, String(total).length)
  const number = String(item.position || item.outputIndex || 0).padStart(digits, '0')
  return `${number}_${sanitizeFileNamePart(item.itemKey)}_${shortTitle(item.job.request.input.prompt, 'image')}`
}

function jsonFile(name: string, value: unknown): LocalAutoSaveWriteFile {
  return {
    name,
    data: `${JSON.stringify(value, null, 2)}\n`,
    type: 'application/json;charset=utf-8',
  }
}

function assetFile(name: string, blob: Blob): LocalAutoSaveWriteFile {
  return { name, data: blob, type: blob.type || 'image/png' }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = sanitizeFileNamePart(fileName) || 'download'
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

function downloadBytes(bytes: Uint8Array, fileName: string, type: string) {
  downloadBlob(new Blob([toArrayBuffer(bytes)], { type }), fileName)
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function getDirectory(): Promise<EngineDeliveryDirectory | null> {
  const record = await getLocalAutoSaveDirectoryHandle()
  if (!record?.handle) return null
  return { handle: record.handle as unknown as WritableDirectoryHandle, name: record.name || record.handle.name || '本地目录' }
}

export async function getEngineLocalDeliveryDirectory(): Promise<EngineDeliveryDirectory | null> {
  return getDirectory()
}

export function isEngineLocalDeliverySupported() {
  return isLocalAutoSaveSupported()
}

export async function chooseEngineLocalDeliveryDirectory(): Promise<EngineDeliveryDirectory> {
  if (!isEngineLocalDeliverySupported()) throw new Error('当前浏览器不支持自动写入本地目录，请使用下载功能')
  const picker = (window as unknown as Window & {
    showDirectoryPicker: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  }).showDirectoryPicker
  const handle = await picker({ mode: 'readwrite' })
  const { putLocalAutoSaveDirectoryHandle } = await import('./db')
  await putLocalAutoSaveDirectoryHandle(handle)
  return { handle: handle as unknown as WritableDirectoryHandle, name: handle.name || '本地目录' }
}

async function updateRecord(record: EngineDeliveryRecord, patch: Partial<EngineDeliveryRecord>) {
  const next = { ...record, ...patch, updatedAt: Date.now() }
  await putEngineDeliveryRecord(next)
  return next
}

function baseRecord(kind: EngineDeliveryRecord['kind'], entityId: string, revision: string, totalCount: number): EngineDeliveryRecord {
  return {
    id: `${kind}:${entityId}`,
    kind,
    entityId,
    revision,
    status: 'pending',
    savedCount: 0,
    savedItems: [],
    totalCount,
    error: null,
    updatedAt: Date.now(),
  }
}

async function getOrCreateRecord(kind: EngineDeliveryRecord['kind'], entityId: string, revision: string, totalCount: number) {
  const existing = await getEngineDeliveryRecord(kind, entityId)
  if (existing && existing.revision === revision && existing.totalCount === totalCount) return existing
  return baseRecord(kind, entityId, revision, totalCount)
}

async function assetMetadata(config: ImageTaskApiConfig, assetId: string | null | undefined) {
  if (!assetId) return null
  try {
    return await getImageAssetManifest(config, assetId)
  } catch {
    return { assetId }
  }
}

async function jobFiles(config: ImageTaskApiConfig, job: ImageJobV1, prefix = '') {
  if (job.state !== 'succeeded' || !job.finalAssetId) throw new Error('任务尚未生成可交付产物')
  const finalBlob = await getImageAssetBlob(config, job.finalAssetId)
  let sourceBlob: Blob | null = null
  let sourceError: string | null = null
  if (job.sourceAssetId) {
    try {
      sourceBlob = await getImageAssetBlob(config, job.sourceAssetId)
    } catch (error) {
      sourceError = errorText(error)
    }
  }
  const [sourceManifest, finalManifest] = await Promise.all([
    assetMetadata(config, job.sourceAssetId),
    assetMetadata(config, job.finalAssetId),
  ])
  const metadata = {
    version: 1,
    kind: 'engine-job',
    jobId: job.id,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    prompt: job.request.input.prompt || '',
    request: job.request,
    assets: {
      source: job.sourceAssetId ? { assetId: job.sourceAssetId, manifest: sourceManifest, error: sourceError } : null,
      final: { assetId: job.finalAssetId, manifest: finalManifest },
    },
    actualRoute: job.actualRoute,
  }
  return [
    ...(sourceBlob ? [assetFile(`${prefix}source.png`, sourceBlob)] : []),
    assetFile(`${prefix}final.png`, finalBlob),
    jsonFile(`${prefix}metadata.json`, metadata),
  ]
}

export async function saveEngineJobLocally(
  config: ImageTaskApiConfig,
  job: ImageJobV1,
  onProgress?: (progress: EngineDeliveryProgress) => void,
  force = false,
): Promise<EngineDeliveryResult> {
  const revision = `${job.sourceAssetId || ''}:${job.finalAssetId || ''}`
  let record = await getOrCreateRecord('job', job.id, revision, 1)
  if (!force && record.status === 'saved' && record.revision === revision) return { record, skipped: true }
  const directory = await getDirectory()
  if (!directory) {
    const supported = isEngineLocalDeliverySupported()
    record = await updateRecord(record, { status: supported ? 'pending' : 'unsupported', error: supported ? '尚未选择本地交付目录' : '当前浏览器不支持自动写入本地目录，请使用下载功能', folderName: jobFolderName(job), totalCount: 1 })
    onProgress?.({ savedCount: 0, totalCount: 1, status: record.status, error: record.error })
    return { record }
  }
  record = await updateRecord(record, { status: 'saving', error: null, folderName: jobFolderName(job), totalCount: 1, savedCount: 0 })
  onProgress?.({ savedCount: 0, totalCount: 1, status: 'saving' })
  try {
    const files = await jobFiles(config, job)
    const written = await writeLocalDeliveryFiles({ rootHandle: directory.handle, folderName: jobFolderName(job), files })
    record = await updateRecord(record, { status: 'saved', files: written.files, savedCount: 1, totalCount: 1, error: null })
    onProgress?.({ savedCount: 1, totalCount: 1, status: 'saved' })
    return { record }
  } catch (error) {
    const permission = error instanceof LocalAutoSavePermissionError
    record = await updateRecord(record, { status: permission ? 'needs_permission' : 'failed', error: errorText(error), savedCount: 0 })
    onProgress?.({ savedCount: 0, totalCount: 1, status: record.status, error: record.error })
    return { record }
  }
}

function batchRevision(items: ImageBatchItemV1[]) {
  return items.map((item) => `${item.itemKey}:${item.revision}:${item.job.state}:${item.job.finalAssetId || ''}`).join('|')
}

function buildBatchManifest(batch: ImageBatchV1, items: ImageBatchItemV1[], savedCount: number) {
  return {
    version: 1,
    kind: 'engine-batch',
    batchId: batch.id,
    name: batch.name || null,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    total: items.length,
    savedCount,
    items: items.map((item) => ({
      itemKey: item.itemKey,
      position: item.position,
      prompt: item.job.request.input.prompt || '',
      generationStatus: item.generationStatus,
      qaStatus: item.qaStatus,
      acceptanceStatus: item.acceptanceStatus,
      humanReviewStatus: item.humanReviewStatus,
      jobId: item.job.id,
      sourceAssetId: item.job.sourceAssetId || null,
      finalAssetId: item.job.finalAssetId || null,
      folder: itemFolderName(item, items.length),
      error: item.job.error || null,
    })),
  }
}

export async function saveEngineBatchLocally(
  config: ImageTaskApiConfig,
  batchInput: ImageBatchV1 | ImageBatchSummaryV1,
  onProgress?: (progress: EngineDeliveryProgress) => void,
  force = false,
  resetSavedItems = false,
): Promise<EngineDeliveryResult> {
  const batch = 'items' in batchInput ? batchInput : await getImageBatchSummary(config, batchInput.id)
  const items = 'items' in batchInput && batchInput.items.length >= batchInput.stats.total
    ? batchInput.items
    : await listAllImageBatchItems(config, batch.id)
  const total = items.length || batch.stats.total
  const revision = batchRevision(items)
  let record = await getOrCreateRecord('batch', batch.id, revision, total)
  if (!force && record.status === 'saved' && record.revision === revision && record.savedCount === total) return { record, skipped: true }
  const directory = await getDirectory()
  const folderName = batchFolderName(batch)
  if (!directory) {
    const supported = isEngineLocalDeliverySupported()
    record = await updateRecord(record, { status: supported ? 'pending' : 'unsupported', folderName, totalCount: total, error: supported ? '尚未选择本地交付目录' : '当前浏览器不支持自动写入本地目录，请使用下载功能' })
    onProgress?.({ savedCount: record.savedCount || 0, totalCount: total, status: record.status, error: record.error })
    return { record }
  }
  const savedItems = new Set(!resetSavedItems && record.revision === revision ? record.savedItems || [] : [])
  let savedCount = savedItems.size
  record = await updateRecord(record, { status: 'saving', folderName, totalCount: total, savedCount, savedItems: [...savedItems], error: null })
  onProgress?.({ savedCount, totalCount: total, status: 'saving' })
  const manifest = buildBatchManifest(batch as ImageBatchV1, items, savedCount)
  try {
    await writeLocalDeliveryFiles({ rootHandle: directory.handle, folderName, files: [jsonFile('batch-manifest.json', manifest)] })
  } catch (error) {
    const permission = error instanceof LocalAutoSavePermissionError
    record = await updateRecord(record, { status: permission ? 'needs_permission' : 'failed', error: errorText(error), savedCount, savedItems: [...savedItems] })
    onProgress?.({ savedCount, totalCount: total, status: record.status, error: record.error })
    return { record }
  }

  const failures: string[] = []
  let permissionFailure = false
  for (const item of items) {
    if (savedItems.has(item.itemKey)) continue
    if (item.job.state !== 'succeeded' || !item.job.finalAssetId) {
      failures.push(`${item.itemKey}: ${item.job.error?.message || '没有成功产物'}`)
      continue
    }
    try {
      const files = await jobFiles(config, item.job, `${itemFolderName(item, total)}/`)
      await writeLocalDeliveryFiles({ rootHandle: directory.handle, folderName, files })
      savedItems.add(item.itemKey)
      savedCount += 1
      record = await updateRecord(record, { savedCount, savedItems: [...savedItems], totalCount: total, status: 'saving', error: failures.length ? failures.join('; ') : null })
      onProgress?.({ savedCount, totalCount: total, status: 'saving', error: record.error })
    } catch (error) {
      failures.push(`${item.itemKey}: ${errorText(error)}`)
      if (error instanceof LocalAutoSavePermissionError) {
        permissionFailure = true
        break
      }
    }
  }
  const status: EngineDeliveryStatus = permissionFailure
    ? 'needs_permission'
    : savedCount === total
      ? 'saved'
      : savedCount > 0
        ? 'partial'
        : 'failed'
  const error = failures.length ? failures.join('; ') : null
  record = await updateRecord(record, { status, savedCount, savedItems: [...savedItems], totalCount: total, error })
  try {
    await writeLocalDeliveryFiles({
      rootHandle: directory.handle,
      folderName,
      files: [jsonFile('batch-manifest.json', buildBatchManifest(batch as ImageBatchV1, items, savedCount))],
    })
  } catch {
    // The individual assets remain delivered; the aggregate manifest is best effort.
  }
  onProgress?.({ savedCount, totalCount: total, status, error })
  return { record }
}

export async function downloadEngineJob(config: ImageTaskApiConfig, job: ImageJobV1) {
  const files = await jobFiles(config, job)
  const final = files.find((file) => file.name === 'final.png')
  if (!final || !(final.data instanceof Blob)) throw new Error('任务没有可下载产物')
  downloadBlob(final.data, `${job.id}-final.png`)
}

export async function downloadEngineBatch(config: ImageTaskApiConfig, batchInput: ImageBatchV1 | ImageBatchSummaryV1) {
  const batch = 'items' in batchInput ? batchInput : await getImageBatchSummary(config, batchInput.id)
  const items = 'items' in batchInput && batchInput.items.length >= batchInput.stats.total
    ? batchInput.items
    : await listAllImageBatchItems(config, batch.id)
  const files: Record<string, Uint8Array> = {}
  const manifest = buildBatchManifest(batch as ImageBatchV1, items, 0)
  files['batch-manifest.json'] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
  let savedCount = 0
  let zipBytes = 0
  const maxZipBytes = 512 * 1024 * 1024
  for (const item of items) {
    if (item.job.state !== 'succeeded' || !item.job.finalAssetId) continue
    const deliveryFiles = await jobFiles(config, item.job, `${itemFolderName(item, items.length)}/`)
    for (const file of deliveryFiles) {
      if (typeof file.data === 'string') files[file.name] = new TextEncoder().encode(file.data)
      else if (file.data instanceof Blob) {
        const bytes = new Uint8Array(await file.data.arrayBuffer())
        zipBytes += bytes.byteLength
        if (zipBytes > maxZipBytes) throw new Error('批次下载超过 512 MB，请先选择本地交付目录保存')
        files[file.name] = bytes
      }
      else files[file.name] = file.data
    }
    savedCount += 1
  }
  files['batch-manifest.json'] = new TextEncoder().encode(`${JSON.stringify(buildBatchManifest(batch as ImageBatchV1, items, savedCount), null, 2)}\n`)
  const bytes = zipSync(files, { level: 0 })
  downloadBytes(bytes, `${sanitizeFileNamePart(batch.name || batch.id)}-delivery.zip`, 'application/zip')
  return { savedCount, totalCount: items.length }
}
