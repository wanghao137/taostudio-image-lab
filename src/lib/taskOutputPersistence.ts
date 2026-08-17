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
import type { ExactSizeTransformRecord } from '../types'

export async function storeGeneratedOutputImage(
  dataUrl: string,
  params: TaskParams,
  storedImageIds: string[],
) {
  let outputDataUrl = dataUrl
  let exactSizeOriginalImageId = ''
  let exactSizeTransform: ExactSizeTransformRecord | undefined
  let persistFailed = false
  const targetSize = getExactImageSizeTarget(params)

  if (targetSize) {
    const resized = await resizeImageDataUrlToExactSize(outputDataUrl, targetSize, params.output_format, 'cover')
    if (resized.resized) {
      const sourceDataUrl = resized.sourceDataUrl ?? outputDataUrl
      try {
        const original = await storeImageWithSize(sourceDataUrl, 'generated')
        storedImageIds.push(original.id)
        cacheImage(original.id, sourceDataUrl)
        exactSizeOriginalImageId = original.id
      } catch (err) {
        // 配额不足：原图留在内存缓存；任务继续，稍后统一提示导出。
        if (err instanceof StorageQuotaError) {
          pinQuotaImage(err.imageId, sourceDataUrl)
          exactSizeOriginalImageId = err.imageId
          persistFailed = true
        } else {
          throw err
        }
      }
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
  }

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

  return {
    id: stored.id,
    dataUrl: outputDataUrl,
    size: stored,
    exactSizeOriginalImageId,
    exactSizeTransform,
    persistFailed,
  }
}

export async function storeTaskOutputImages(
  task: TaskRecord,
  images: string[],
  cleanupOrphans?: (ids: string[]) => Promise<void>,
) {
  const outputIds: string[] = []
  const outputDataUrls: string[] = []
  const outputImageSizes: Array<{ width?: number; height?: number }> = []
  const transparentOriginalImageIds: string[] = []
  const exactSizeOriginalImageIds: string[] = []
  const exactSizeTransforms: Record<string, ExactSizeTransformRecord> = {}
  const storedImageIds: string[] = []
  let persistFailedCount = 0
  const trackExactSizeOriginalImages = Boolean(getExactImageSizeTarget(task.params))

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
          outputDataUrl = await removeKeyedBackgroundFromDataUrl(dataUrl)
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

      const stored = await storeGeneratedOutputImage(outputDataUrl, task.params, storedImageIds)
      if (stored.persistFailed) persistFailedCount += 1
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
      persistFailedCount,
    }
  } catch (err) {
    if (cleanupOrphans) await cleanupOrphans(storedImageIds)
    throw err
  }
}


