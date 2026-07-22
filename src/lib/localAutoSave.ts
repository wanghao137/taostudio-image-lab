import type { LocalAutoSaveStatus, StoredImage, TaskRecord } from '../types'
import { dataUrlToBytes } from './dataUrl'
import { formatExportFileTime, sanitizeFileNamePart } from './exportFileName'
import { getExactImageSizeTarget } from './exactImageSize'
import { calculateImageSize, COMMON_IMAGE_RATIOS } from './size'

export type LocalAutoSaveIneligibilityReason =
  | 'agent_task'
  | 'not_done'
  | 'no_outputs'
  | 'missing_image'
  | 'partial_failure'
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

function getNavigatorRecord(target: unknown): Record<string, unknown> | null {
  if (target && typeof target === 'object' && 'navigator' in target) {
    const candidate = (target as { navigator?: unknown }).navigator
    return candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null
  }

  return typeof navigator === 'undefined' ? null : navigator as unknown as Record<string, unknown>
}

function getUserAgentDataMobile(navigatorRecord: Record<string, unknown> | null) {
  const userAgentData = navigatorRecord?.userAgentData
  return userAgentData && typeof userAgentData === 'object'
    ? (userAgentData as { mobile?: unknown }).mobile === true
    : false
}

function getUserAgentDataBrands(navigatorRecord: Record<string, unknown> | null) {
  const userAgentData = navigatorRecord?.userAgentData
  if (!userAgentData || typeof userAgentData !== 'object') return null

  const brands = (userAgentData as { brands?: unknown }).brands
  if (!Array.isArray(brands)) return null

  const brandNames = brands
    .map((entry) => entry && typeof entry === 'object' ? (entry as { brand?: unknown }).brand : null)
    .filter((brand): brand is string => typeof brand === 'string')
  return brandNames.length ? brandNames : null
}

function getUserAgent(navigatorRecord: Record<string, unknown> | null) {
  return typeof navigatorRecord?.userAgent === 'string' ? navigatorRecord.userAgent : ''
}

function isMobileUserAgent(userAgent: string, navigatorRecord: Record<string, unknown> | null) {
  const maxTouchPoints = navigatorRecord?.maxTouchPoints
  const isIpadDesktopMode = typeof maxTouchPoints === 'number' &&
    maxTouchPoints > 1 &&
    /\bMacintosh\b/i.test(userAgent) &&
    /\bAppleWebKit\b/i.test(userAgent)

  return getUserAgentDataMobile(navigatorRecord) ||
    isIpadDesktopMode ||
    /\b(Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|Silk|Kindle)\b/i.test(userAgent)
}

function isDesktopChromeOrEdge(userAgent: string, navigatorRecord: Record<string, unknown> | null) {
  const brands = getUserAgentDataBrands(navigatorRecord)
  if (brands) return brands.includes('Google Chrome') || brands.includes('Microsoft Edge')

  const isOtherChromiumShell = /\b(?:OPR|Opera|SamsungBrowser|YaBrowser|Vivaldi)\//.test(userAgent)
  if (isOtherChromiumShell) return false
  if (/\bEdg\//.test(userAgent)) return true
  return /\bChrome\//.test(userAgent) && !/\bChromium\//.test(userAgent)
}

export function isLocalAutoSaveSupported(target: unknown = typeof window === 'undefined' ? {} : window) {
  if (typeof (target as { showDirectoryPicker?: unknown }).showDirectoryPicker !== 'function') return false

  const navigatorRecord = getNavigatorRecord(target)
  const userAgent = getUserAgent(navigatorRecord)
  if (isMobileUserAgent(userAgent, navigatorRecord)) return false
  return isDesktopChromeOrEdge(userAgent, navigatorRecord)
}

export function isConfirmed4kSize(size: { width?: number; height?: number } | null | undefined): size is LocalAutoSaveSize {
  if (!size) return false
  const { width, height } = size
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return false
  }

  const dimensions = `${width}x${height}`
  return COMMON_IMAGE_RATIOS.some(({ value }) => calculateImageSize('4K', value) === dimensions)
}

export function getLocalAutoSaveIntentSize(task: Pick<TaskRecord, 'params'>): LocalAutoSaveSize | null {
  const target = getExactImageSizeTarget(task.params)
  return isConfirmed4kSize(target) ? target : null
}

function isAgentTask(task: Pick<TaskRecord, 'sourceMode' | 'agentConversationId' | 'agentRoundId'>) {
  return task.sourceMode === 'agent' || Boolean(task.agentConversationId || task.agentRoundId)
}

export function getLocalAutoSaveEligibility(task: TaskRecord, images: StoredImage[]): LocalAutoSaveEligibility {
  if (isAgentTask(task)) return { eligible: false, status: 'not_applicable', reason: 'agent_task' }
  if (task.status !== 'done') return { eligible: false, status: 'not_applicable', reason: 'not_done' }
  if (!task.outputImages.length) return { eligible: false, status: 'not_applicable', reason: 'no_outputs' }
  if (task.outputErrors?.length) return { eligible: false, status: 'not_applicable', reason: 'partial_failure' }
  if (!getLocalAutoSaveIntentSize(task)) return { eligible: false, status: 'not_applicable', reason: 'not_4k_intent' }
  if (images.length !== task.outputImages.length) return { eligible: false, status: 'failed', reason: 'missing_image' }
  if (!images.every((img, index) => img.id === task.outputImages[index])) return { eligible: false, status: 'failed', reason: 'missing_image' }
  if (!images.every((img) => isConfirmed4kSize(img))) return { eligible: false, status: 'not_applicable', reason: 'not_4k_actual' }
  return { eligible: true }
}

function getPromptPrefix(prompt: string) {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  const chars = Array.from(normalized).slice(0, 20).join('')
  return sanitizeFileNamePart(chars)
    .replace(/\s*-\s*/g, '-')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '') || 'untitled'
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
