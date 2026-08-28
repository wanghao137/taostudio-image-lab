// AI 动作帧：把单张贴纸喂回现有生成通道（图生图编辑），生成同一角色的连续动作姿势帧，
// 再用工作台现成的键控透明管线清洗 → 裁剪 → 方形归一化，作为逐帧动画的帧源。
// 不引入任何新模型/服务 —— 走用户当前激活的 provider。
import { callImageApi } from '../api'
import { buildTransparentPrompt, removeKeyedBackgroundFromDataUrl } from '../transparentImage'
import { extractLargestComponent } from './engine'
import type { AppSettings, TaskParams } from '../../types'
import { loadImage } from '../canvasImage'

export interface ActionTemplate {
  id: string
  label: string
  /** 连续动作相位（第 1 帧即角色原图，phases 为后续帧） */
  phases: string[]
}

const SAME_CHARACTER = [
  '保持与输入图完全相同的角色：相同的外貌、发型、表情基线、画风、配色与线条风格；相同视角与构图、相同服装与道具、相同光照；单主体、角色居中占画面大部分',
  '整张画面里只能有这一个角色单体：禁止出现多个角色、多个姿势、分镜格、序列帧、连环画式排列或拼贴',
  '只改变指定的姿势，不改变角色本身，不加文字',
].join('。')

// 三相位动作语法（预备→顶点→回收）：回归由循环闭合（原图为第 1 帧 + ping-pong）。
// 幅度纪律（解剖 motion-sticker-pack 案例实锤：帧间主体轮廓变化仅 0.1~0.7%）：
// 只允许局部动作（表情/头部/单臂），禁止全身性大动作 —— 免费编辑通道下
// 每帧剪影全换等于整角色重画，一致性必崩。
export const ACTION_TEMPLATES: ActionTemplate[] = [
  {
    id: 'blink-smile',
    label: '眨眼笑',
    phases: [
      '顶点帧：把角色画成开心地眯起眼睛笑的姿势，眼睛弯成月牙形，嘴角明显上扬，身体其余部分完全保持不动',
      '过渡帧：把角色画成一只眼睛完全闭上、嘴角还在笑的姿势，身体其余部分完全保持不动',
      '回收帧：把角色画成眼睛睁开的姿势，眼神明亮，嘴角还带着一点笑意，身体其余部分完全保持不动',
    ],
  },
  {
    id: 'wave',
    label: '挥手',
    phases: [
      '预备帧：把角色画成抬起右手到肩侧、手肘弯曲的姿势，身体其余部分完全保持不动',
      '顶点帧：把角色画成右手小幅挥动、手掌张开的姿势，身体其余部分完全保持不动',
      '回收帧：把角色画成右手落回身侧的姿势，身体其余部分完全保持不动',
    ],
  },
  {
    id: 'nod',
    label: '点头',
    phases: [
      '预备帧：把角色画成头部微微低下的姿势，下巴略收，身体其余部分完全保持不动',
      '顶点帧：把角色画成头部低下约三十度的姿势，身体其余部分完全保持不动',
      '回收帧：把角色画成头部抬回正中的姿势，身体其余部分完全保持不动',
    ],
  },
  {
    id: 'look',
    label: '左右看',
    phases: [
      '预备帧：把角色画成头和眼睛转向左侧的姿势，身体其余部分完全保持不动',
      '顶点帧：把角色画成头和眼睛转向右侧的姿势，身体其余部分完全保持不动',
      '回收帧：把角色画成头和眼睛回到正中、目视前方的姿势，身体其余部分完全保持不动',
    ],
  },
  {
    id: 'bounce',
    label: '原地小弹',
    phases: [
      '预备帧：把角色画成微微下蹲一点点、身体略微压缩的姿势，脚不离开地面，角色轮廓与原图基本相同',
      '顶点帧：把角色画成轻轻踮起脚尖、身体舒展拉高一点点的姿势，脚尖不离地太多，角色轮廓与原图基本相同',
      '回收帧：把角色画成双脚踏实站立的姿势，回到与原图几乎一样的状态',
    ],
  },
]

export function getActionTemplate(id: string): ActionTemplate | undefined {
  return ACTION_TEMPLATES.find((t) => t.id === id)
}

/**
 * 生成一帧动作：编辑 → 键控去底 → alpha 紧裁 → 方形画布居中 → dataURL。
 * 免费网关上游偶发连接抖动，自动重试；失败即抛错，由调用方决定中断或跳过。
 */
export async function generateActionFrame(
  settings: AppSettings,
  params: TaskParams,
  stickerDataUrl: string,
  phasePrompt: string,
): Promise<string> {
  const prompt = buildTransparentPrompt(`${phasePrompt}。${SAME_CHARACTER}`)
  const editParams: TaskParams = { ...params, n: 1, transparent_output: true }

  let lastError: unknown = new Error('生成通道未返回图片')
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 8000 * attempt))
    try {
      const result = await callImageApi({ settings, prompt, params: editParams, inputImageDataUrls: [stickerDataUrl] })
      const image = result.images?.[0]
      if (!image) throw new Error('生成通道未返回图片')
      const cleaned = await removeKeyedBackgroundFromDataUrl(image)
      return normalizeToSquareDataUrl(cleaned)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 动作帧统一归一化边长：所有帧(含原图帧)主体最长边一致，消除帧间尺度泵动。 */
export const ACTION_FRAME_SIDE = 768

function drawSquareNormalized(cropSource: HTMLCanvasElement, cropX: number, cropY: number, cropW: number, cropH: number, side: number): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = side
  out.height = side
  const octx = out.getContext('2d')
  if (!octx) throw new Error('无法创建画布上下文')
  octx.imageSmoothingQuality = 'high'
  octx.drawImage(cropSource, cropX, cropY, cropW, cropH, (side - cropW) / 2, (side - cropH) / 2, cropW, cropH)
  return out
}

/** 任意画布 → 最大连通域守卫 → alpha 紧裁 → 固定边长方形居中。 */
export function normalizeCanvasToActionFrame(source: HTMLCanvasElement): HTMLCanvasElement {
  const w = source.width
  const h = source.height
  const sctx = source.getContext('2d', { willReadFrequently: true })
  if (!sctx) throw new Error('无法创建画布上下文')

  let cropSource = source
  let cropX = 0
  let cropY = 0
  let cropW = w
  let cropH = h
  try {
    const pixels = sctx.getImageData(0, 0, w, h)
    const largest = extractLargestComponent({ width: w, height: h, data: pixels.data })
    if (largest && (largest.width < w * 0.95 || largest.height < h * 0.95)) {
      const guarded = document.createElement('canvas')
      guarded.width = largest.width
      guarded.height = largest.height
      guarded.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(largest.data), largest.width, largest.height), 0, 0)
      cropSource = guarded
      cropW = largest.width
      cropH = largest.height
    }
  } catch {
    // 守卫失败退回整图
  }

  const gctx = cropSource.getContext('2d', { willReadFrequently: true })
  if (gctx) {
    const data = gctx.getImageData(0, 0, cropW, cropH).data
    let minX = cropW
    let minY = cropH
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        if (data[(y * cropW + x) * 4 + 3] > 12) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX >= 0) {
      cropX = minX
      cropY = minY
      cropW = maxX - minX + 1
      cropH = maxY - minY + 1
    }
  }

  // 缩放到统一边长：主体最长边 → ACTION_FRAME_SIDE
  const long = Math.max(cropW, cropH)
  const scaled = document.createElement('canvas')
  scaled.width = Math.max(1, Math.round((cropW / long) * ACTION_FRAME_SIDE))
  scaled.height = Math.max(1, Math.round((cropH / long) * ACTION_FRAME_SIDE))
  const sctx2 = scaled.getContext('2d')
  if (!sctx2) throw new Error('无法创建画布上下文')
  sctx2.imageSmoothingQuality = 'high'
  sctx2.drawImage(cropSource, cropX, cropY, cropW, cropH, 0, 0, scaled.width, scaled.height)
  return drawSquareNormalized(scaled, 0, 0, scaled.width, scaled.height, ACTION_FRAME_SIDE)
}

/**
 * 帧归一化：最大连通域守卫 → alpha 紧裁 → 统一边长方形居中 → dataURL。
 */
export async function normalizeToSquareDataUrl(dataUrl: string): Promise<string> {
  const image = await loadImage(dataUrl)
  const source = document.createElement('canvas')
  source.width = image.naturalWidth
  source.height = image.naturalHeight
  source.getContext('2d')?.drawImage(image, 0, 0)
  return normalizeCanvasToActionFrame(source).toDataURL('image/png')
}

/** dataURL → canvas（合成管线的帧源）。 */
export async function dataUrlToCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d')?.drawImage(image, 0, 0)
  return canvas
}
