import type { TaskRecord, TaskParams } from '../types'
import {
  storeImageWithSize,
  getImage,
  putImage,
  putImageThumbnail,
  StorageQuotaError,
} from './db'
import { cacheImage, cacheThumbnail, pinQuotaImage, deleteImageCacheEntry } from './imageCache'
import { getExactImageSizeTarget, resizeImageDataUrlToExactSize } from './exactImageSize'
import { removeKeyedBackgroundFromDataUrl } from './transparentImage'
import { getInputRatioDeviation } from './inputPreprocess'
import { parseImageSize } from './size'
import type { ExactSizeTransformRecord } from '../types'

/** 第二层兜底：非 exact_size 任务返回图比例与请求比例的相对偏差阈值 */
export const RATIO_CORRECTION_DEVIATION_THRESHOLD = 0.05

export interface StoreOutputImageOptions {
  /** 输出比例自动校正开关（AppSettings.ratioAutoCorrect），默认关闭（未传=关闭） */
  ratioAutoCorrect?: boolean
}

export async function storeGeneratedOutputImage(
  dataUrl: string,
  params: TaskParams,
  storedImageIds: string[],
  options: StoreOutputImageOptions = {},
) {
  let outputDataUrl = dataUrl
  let exactSizeOriginalImageId = ''
  let exactSizeTransform: ExactSizeTransformRecord | undefined
  let ratioCorrected = false
  let persistFailed = false
  const targetSize = getExactImageSizeTarget(params)
  // exact_size 走既有无条件重采样管线；非 exact_size 且请求了具体尺寸时，
  // 仅当返回比例偏差 >5% 才做本地 cover 校正（比例已匹配的返回不动）。
  const ratioCorrectionTarget = !targetSize && options.ratioAutoCorrect && params.size !== 'auto'
    ? parseImageSize(params.size)
    : null

  // 先落盘原始输出：既拿到真实像素尺寸用于比例判定，也天然保留 provider 原图
  // （exactSizeOriginalImages 同款语义，详情页可下载原生底图）。
  let stored
  try {
    stored = await storeImageWithSize(outputDataUrl, 'generated')
  } catch (err) {
    if (err instanceof StorageQuotaError) {
      // 关键兜底：图已经生成并计费，配额不足不能把图丢掉。
      // 留在内存缓存（LRU 可能被挤掉，是尽力而为）+ 任务标记未持久化，引导用户立刻导出。
      pinQuotaImage(err.imageId, outputDataUrl)
      stored = { id: err.imageId, width: err.width, height: err.height }
      persistFailed = true
    } else {
      throw err
    }
  }
  storedImageIds.push(stored.id)
  cacheImage(stored.id, outputDataUrl)

  if (targetSize) {
    // exact_size：无条件重采样到目标像素（cover 裁切内建）
    const resized = await resizeImageDataUrlToExactSize(outputDataUrl, targetSize, params.output_format, 'cover')
    if (resized.resized) {
      exactSizeOriginalImageId = stored.id
      outputDataUrl = resized.dataUrl
      if (resized.drawPlan) {
        exactSizeTransform = {
          mode: resized.drawPlan.mode,
          sourceWidth: resized.drawPlan.sourceWidth,
          sourceHeight: resized.drawPlan.sourceHeight,
          rawSourceWidth: resized.rawSourceWidth,
          rawSourceHeight: resized.rawSourceHeight,
          sourceNormalized: resized.sourceNormalized,
          targetWidth: resized.drawPlan.targetWidth,
          targetHeight: resized.drawPlan.targetHeight,
          scale: resized.drawPlan.scale,
          drawX: resized.drawPlan.drawX,
          drawY: resized.drawPlan.drawY,
          drawWidth: resized.drawPlan.drawWidth,
          drawHeight: resized.drawPlan.drawHeight,
          aspectMismatch: resized.drawPlan.aspectMismatch,
        }
      }
    }
  } else if (
    ratioCorrectionTarget && typeof stored.width === 'number' && typeof stored.height === 'number' &&
    getInputRatioDeviation({ width: stored.width, height: stored.height }, ratioCorrectionTarget) > RATIO_CORRECTION_DEVIATION_THRESHOLD
  ) {
    // 比例校正（第二层兜底）：cover 裁切到请求比例（复用 exact_size 管线），
    // 只记录 ratioCorrected 标记、不写 exactSizeTransform，避免与详情页
    // exact_size 后处理警告语义混淆。
    const resized = await resizeImageDataUrlToExactSize(outputDataUrl, ratioCorrectionTarget, params.output_format, 'cover')
    if (resized.resized) {
      exactSizeOriginalImageId = stored.id
      outputDataUrl = resized.dataUrl
      ratioCorrected = true
    }
  }

  // 已裁切/重采样时输出图与原图不同，需要再次落盘；未处理时复用首次落盘结果
  let storedOutput = stored
  if (outputDataUrl !== dataUrl) {
    try {
      storedOutput = await storeImageWithSize(outputDataUrl, 'generated')
    } catch (err) {
      if (err instanceof StorageQuotaError) {
        pinQuotaImage(err.imageId, outputDataUrl)
        storedOutput = { id: err.imageId, width: err.width, height: err.height }
        persistFailed = true
      } else {
        throw err
      }
    }
    storedImageIds.push(storedOutput.id)
    cacheImage(storedOutput.id, outputDataUrl)
  }

  return {
    id: storedOutput.id,
    dataUrl: outputDataUrl,
    size: storedOutput,
    exactSizeOriginalImageId,
    exactSizeTransform,
    ratioCorrected,
    persistFailed,
  }
}

export async function storeTaskOutputImages(
  task: TaskRecord,
  images: string[],
  cleanupOrphans?: (ids: string[]) => Promise<void>,
  options: StoreOutputImageOptions = {},
) {
  const outputIds: string[] = []
  const outputDataUrls: string[] = []
  const outputImageSizes: Array<{ width?: number; height?: number }> = []
  const transparentOriginalImageIds: string[] = []
  const exactSizeOriginalImageIds: string[] = []
  const exactSizeTransforms: Record<string, ExactSizeTransformRecord> = {}
  const storedImageIds: string[] = []
  let persistFailedCount = 0
  let ratioCorrectedAny = false
  const exactSizeTarget = getExactImageSizeTarget(task.params)
  // exact_size 或比例校正可能保留 provider 原图时，输出序位上都要留原图 id 槽位
  const trackExactSizeOriginalImages = Boolean(exactSizeTarget) ||
    (Boolean(options.ratioAutoCorrect) && task.params.size !== 'auto')

  try {
    for (const dataUrl of images) {
      let outputDataUrl = dataUrl
      if (task.transparentOutput) {
        let originalId: string
        let originalSize: { width?: number; height?: number }
        try {
          const original = await storeImageWithSize(dataUrl, 'generated')
          storedImageIds.push(original.id)
          cacheImage(original.id, dataUrl)
          originalId = original.id
          originalSize = original
        } catch (err) {
          if (err instanceof StorageQuotaError) {
            pinQuotaImage(err.imageId, dataUrl)
            originalId = err.imageId
            originalSize = { width: err.width, height: err.height }
            persistFailedCount += 1
          } else {
            throw err
          }
        }

        try {
          outputDataUrl = task.params.output_format === 'webp'
            ? await removeKeyedBackgroundFromDataUrl(dataUrl, undefined, 'webp', task.params.output_compression)
            : await removeKeyedBackgroundFromDataUrl(dataUrl)
          transparentOriginalImageIds.push(originalId)
        } catch (err) {
          console.warn('透明背景后处理失败，已回退为原始输出', err)
          outputIds.push(originalId)
          outputDataUrls.push(dataUrl)
          outputImageSizes.push(originalSize)
          transparentOriginalImageIds.push('')
          continue
        }
      }

      const stored = await storeGeneratedOutputImage(outputDataUrl, task.params, storedImageIds, options)
      if (stored.persistFailed) persistFailedCount += 1
      if (stored.ratioCorrected) ratioCorrectedAny = true
      outputIds.push(stored.id)
      outputDataUrls.push(stored.dataUrl)
      outputImageSizes.push(stored.size)
      if (trackExactSizeOriginalImages) {
        exactSizeOriginalImageIds.push(stored.exactSizeOriginalImageId)
      }
      if (stored.exactSizeTransform) {
        exactSizeTransforms[stored.id] = stored.exactSizeTransform
      }
    }

    return {
      outputIds,
      outputDataUrls,
      outputImageSizes,
      transparentOriginalImageIds: transparentOriginalImageIds.length ? transparentOriginalImageIds : undefined,
      exactSizeOriginalImageIds: exactSizeOriginalImageIds.some(Boolean) ? exactSizeOriginalImageIds : undefined,
      exactSizeTransforms: Object.keys(exactSizeTransforms).length ? exactSizeTransforms : undefined,
      ratioCorrected: ratioCorrectedAny,
      persistFailedCount,
    }
  } catch (err) {
    if (cleanupOrphans) await cleanupOrphans(storedImageIds)
    throw err
  }
}
