// 贴纸风格预设：移植自 motion-sticker-pack 的 style-presets（MIT），
// 用于生成入口 —— 一键组装「风格 + 九宫格拼图 + 透明底」的完整提示词。

export interface StickerStylePreset {
  id: string
  label: string
  /** 风格描述（英文提示词片段，与上游预设一致） */
  stylePrompt: string
}

export const STICKER_STYLE_PRESETS: StickerStylePreset[] = [
  { id: '3d', label: '3D卡通', stylePrompt: 'polished 3D cartoon rendering with expressive facial animation, smooth materials, soft studio lighting, subtle ambient occlusion, and a clean sticker finish' },
  { id: 'chibi', label: 'Q版', stylePrompt: 'an expressive chibi style with an oversized head, compact body, clear facial reactions, rounded cute shapes, and consistent simplified details' },
  { id: 'hand-drawn', label: '手绘', stylePrompt: 'warm hand-drawn illustration with clean expressive linework, softly textured color, visible brush character, and friendly sticker-like shapes' },
  { id: 'manga', label: '漫画', stylePrompt: 'dynamic manga-inspired illustration with expressive eyes, confident ink contours, selective cel shading, energetic gesture language, and clear sticker silhouettes' },
  { id: 'cute', label: '可爱', stylePrompt: 'a warm cute character style with soft rounded shapes, appealing expressions, gentle color accents, charming gesture language, and polished sticker readability' },
  { id: 'pixel-art', label: '像素', stylePrompt: 'carefully designed pixel art with a consistent limited palette, readable silhouettes, deliberate pixel clusters, expressive animation-ready poses, and crisp edges' },
  { id: 'retro', label: '复古', stylePrompt: 'a retro-inspired illustration treatment with period-evocative color separation, tactile print texture, bold simplified shapes, and nostalgic sticker finishing' },
  { id: 'realistic', label: '写实', stylePrompt: 'highly faithful semi-realistic rendering preserving facial structure, body proportions, clothing materials, lighting cues, and recognizable identity' },
]

export function getStickerStyle(id: string): StickerStylePreset | undefined {
  return STICKER_STYLE_PRESETS.find((s) => s.id === id)
}

/**
 * 组装九宫格贴纸拼图生成提示词：
 * 风格 + 3×3 同角色多表情 + 每格完整独立 + 宽透明间隔 + 无文字。
 */
export function buildStickerSheetPrompt(styleId: string, subject?: string): string {
  const style = getStickerStyle(styleId)
  if (!style) throw new Error(`未知的贴纸风格：${styleId}`)
  const subjectLine = subject?.trim() ? `角色：${subject.trim()}。` : ''
  return [
    `生成一张 3×3 九宫格贴纸拼图（正方形画布）。${subjectLine}`,
    `同一个角色的 9 个不同表情与反应（例如：开心、大笑、生气、惊讶、哭泣、比心、疑惑、害羞、加油），每格一个完整独立的表情，角色姿态有变化但身份、画风、配色完全一致。`,
    `画风要求：${style.stylePrompt}。`,
    '每格之间留出较宽且完全透明的间隔，角色不出格、不互相重叠；整图为透明背景 PNG，无背景元素、无文字、无水印。',
  ].join('\n')
}
