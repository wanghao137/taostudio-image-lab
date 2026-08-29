// ---------------------------------------------------------------------------
// 图片反推提示词（Image-to-Prompt）
// 设计文档：docs/superpowers/specs/2026-08-29-image-to-prompt-design.md
// ---------------------------------------------------------------------------

export type PromptReverseImageType = 'portrait' | 'illustration' | 'poster' | 'product' | 'general'

export interface PromptReverseCandidate {
  label: string
  text: string
}

export interface PromptReverseResult {
  imageType: PromptReverseImageType
  breakdown: Array<{ dimension: string; text: string }>
  prompts: PromptReverseCandidate[]
  promptEn?: string
}

const IMAGE_TYPES: PromptReverseImageType[] = ['portrait', 'illustration', 'poster', 'product', 'general']

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1')
}

function coerceResult(value: unknown, rawText: string): PromptReverseResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const imageType = IMAGE_TYPES.includes(record.imageType as PromptReverseImageType)
    ? (record.imageType as PromptReverseImageType)
    : 'general'
  const breakdown = Array.isArray(record.breakdown)
    ? record.breakdown
        .filter((item): item is { dimension: string; text: string } => {
          if (typeof item !== 'object' || item === null) return false
          const entry = item as Record<string, unknown>
          return typeof entry.dimension === 'string' && typeof entry.text === 'string'
        })
        .map((item) => ({ dimension: item.dimension, text: item.text }))
    : []
  const prompts = Array.isArray(record.prompts)
    ? record.prompts
        .filter((item): item is { label: string; text: string } => {
          if (typeof item !== 'object' || item === null) return false
          const entry = item as Record<string, unknown>
          return typeof entry.label === 'string' && typeof entry.text === 'string' && entry.text.trim() !== ''
        })
        .map((item) => ({ label: item.label, text: item.text }))
    : []
  const promptEn = typeof record.promptEn === 'string' && record.promptEn.trim() !== '' ? record.promptEn : undefined
  if (prompts.length === 0) {
    return { imageType, breakdown, prompts: [{ label: '反推结果', text: rawText.trim() }] }
  }
  return { imageType, breakdown, prompts, promptEn }
}

/**
 * 四级解析链（设计文档 §5.5，实证 6/6 通过；尾随逗号为 VLM 实测真实缺陷）：
 * 直接 parse → 去尾逗号 → 剥围栏（含去尾逗号）→ 截取 {..}（含去尾逗号）。
 * 全部失败返回 null；解析出对象但缺 prompts 时兜底整段文本为单候选。
 */
export function parsePromptReverseResult(text: string): PromptReverseResult | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const attempts: Array<() => unknown> = [
    () => JSON.parse(trimmed),
    () => JSON.parse(stripTrailingCommas(trimmed)),
    () => {
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (!fenced) throw new Error('no fence')
      return JSON.parse(stripTrailingCommas(fenced[1]))
    },
    () => {
      const first = trimmed.indexOf('{')
      const last = trimmed.lastIndexOf('}')
      if (first < 0 || last <= first) throw new Error('no braces')
      return JSON.parse(stripTrailingCommas(trimmed.slice(first, last + 1)))
    },
  ]
  for (const attempt of attempts) {
    try {
      const parsed = attempt()
      const coerced = coerceResult(parsed, trimmed)
      if (coerced) return coerced
    } catch {
      // 尝试下一级
    }
  }
  return null
}

export const PROMPT_REVERSE_MAX_EDGE = 1536

/**
 * 预缩放决策：最长边 ≤1536 返回 null（不缩放不放大）；否则返回 1536×1536
 * contain 盒（resizeImageHighQuality 以 contain 保持宽高比）。设计文档 §5.1：
 * VLM 无需 4K（实测 1024px 已逐字读出排版文字）。
 */
export function resolveReverseImageTarget(width: number, height: number): { width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null
  if (Math.max(width, height) <= PROMPT_REVERSE_MAX_EDGE) return null
  return { width: PROMPT_REVERSE_MAX_EDGE, height: PROMPT_REVERSE_MAX_EDGE }
}
