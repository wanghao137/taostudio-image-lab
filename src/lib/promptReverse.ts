// ---------------------------------------------------------------------------
// 图片反推提示词（Image-to-Prompt）
// 设计文档：docs/superpowers/specs/2026-08-29-image-to-prompt-design.md
// ---------------------------------------------------------------------------

import { createHeaders, extractText, normalizeResponsePayload } from './agentApi'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import type { ApiProfile, AppSettings } from '../types'

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

/**
 * 指令模板 v3（设计文档 §5.4 定稿，三轮实测；修改必须跑 spec §5.9 QC 回归）。
 */
export const PROMPT_REVERSE_INSTRUCTIONS = [
  '你是一位顶级的视觉分析师与 AI 生图提示词工程师。你的输出将直接用于 OpenAI 兼容的 gpt-image 类图像生成器。',
  '',
  '任务：对输入图片做「反推提示词」——写出能最大限度重现这张图的生成提示词。',
  '',
  '工作方法（内部完成，不要输出思考过程）：',
  '1. 先判断图片类型：portrait（人像摄影）/ illustration（插画动漫）/ poster（海报版式）/ product（产品图）/ general（通用）。',
  '2. 从下面的维度菜单中，挑选对这张图最关键、最能决定生成结果像不像的 4~8 个维度：主体与身份特征 / 动作与表情 / 服装造型与道具 / 环境场景 / 构图与机位镜头 / 光线 / 色彩体系 / 材质与质感 / 画风与媒介 / 成像特征（颗粒、景深、锐度）/ 版式与文字 / 氛围情绪。',
  '3. 只描述图中可见的内容，禁止臆测不可见的细节、人名、品牌；图中有可读文字时原样引用；不确定的细节用「大约」「类似」弱化表述。',
  '4. 提示词用中文自然语言成段描述（不是标签堆砌），语义完整、空间关系清晰、包含风格与质感线索，不使用 Midjourney 参数语法。正文禁止出现「这张图片」「画面展示了」等元描述措辞，直接以画面内容开头。',
  '5. 「忠实复刻」必须完整覆盖你选中的全部维度（含成像特征，如胶片颗粒、景深、锐度）。',
  '',
  '输出要求：只输出一个 JSON 对象，不要输出任何其他文字或代码围栏，字段如下：',
  '{"imageType":"portrait|illustration|poster|product|general","breakdown":[{"dimension":"<维度名，中文>","text":"<该维度的精准描述，一句话>"}],"prompts":[{"label":"忠实复刻","text":"<完整中文提示词，重现整图所有关键维度>"},{"label":"风格强化","text":"<同体系但强化画风与质感表达的变体>"},{"label":"精简速写","text":"<保留核心识别特征的最短可用提示词>"}],"promptEn":"<忠实复刻的英文镜像版，语义等价，可直接用于英文生图API>"}',
].join('\n')

/**
 * 反推调用（镜像 callAgentConversationTitleApi 形态：无 tools、非流式、
 * input_image 内联、profile.timeout 超时、双 AbortSignal、自动继承代理链）。
 */
export async function callPromptReverseApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  imageDataUrl: string
  signal?: AbortSignal
}): Promise<string> {
  const { settings, profile, imageDataUrl, signal } = opts
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const content: Array<Record<string, string>> = [
      { type: 'input_text', text: '请对这张图片反推提示词。' },
      { type: 'input_image', image_url: imageDataUrl },
    ]
    const body: Record<string, unknown> = {
      model: profile.model || settings.model,
      instructions: PROMPT_REVERSE_INSTRUCTIONS,
      input: [{ role: 'user', content }],
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }
    const payload = normalizeResponsePayload(await response.json())
    if (!payload) throw new Error('反推接口返回格式无效')
    return extractText(payload)
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}
