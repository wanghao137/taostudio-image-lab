export const MIN_ENTRY_LENGTH = 6

/** 期望条数合法范围（持久化值与 UI 输入统一在此收口） */
export const SKILL_ENTRY_COUNT_MIN = 1
export const SKILL_ENTRY_COUNT_MAX = 10
export const SKILL_ENTRY_COUNT_DEFAULT = 5

export function clampSkillEntryCount(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : SKILL_ENTRY_COUNT_DEFAULT
  return Math.min(SKILL_ENTRY_COUNT_MAX, Math.max(SKILL_ENTRY_COUNT_MIN, n))
}

function stripCodeFence(text: string): string {
  const t = text.trim()
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  return (m ? m[1] : t).trim()
}

/** skill 正文里可能混入字面 `</skill>` 行（skill 文档自带示例或 prompt 注入），
 *  包裹前进整行剔除，防止标签被提前闭合导致契约指令逃逸出 <skill> 包裹。 */
function stripClosingSkillTagLines(skillBody: string): string {
  return skillBody
    .split('\n')
    .filter((line) => !line.includes('</skill>'))
    .join('\n')
}

function cleanParts(parts: string[]): string[] {
  return parts.map((p) => p.trim()).filter((p) => p.length >= MIN_ENTRY_LENGTH)
}

/** 扩写输出 → 提示词条目。优先 markdown 分节，其次编号行，再次空行分段，兜底整段单条。
 *  一旦识别到某种分节结构（标题/编号），就按该结构出条目；噪声条目（过短）被丢弃后
 *  允许少于 2 条，避免降级到空行分段时把标题行/编号行本身混进条目文本。 */
export function parseExpansionEntries(raw: string): Array<{ id: string; text: string }> {
  const text = stripCodeFence(raw.replace(/\r\n/g, '\n').trim())
  const strategies: Array<() => string[]> = [
    () => {
      const parts = text.split(/^#{2,4}\s*[^\n]*$/m)
      return parts.length >= 2 ? cleanParts(parts) : []
    },
    () => {
      const parts = text.split(/^\s*\d{1,2}[.、)]\s*/m)
      return parts.length >= 2 ? cleanParts(parts) : []
    },
    () => cleanParts(text.split(/\n{2,}/)),
  ]
  for (const tryStrategy of strategies) {
    const parts = tryStrategy()
    if (parts.length >= 1) {
      return parts.map((p, i) => ({ id: `entry-${i + 1}`, text: p }))
    }
  }
  return [{ id: 'entry-1', text }]
}

/** 成文轮（单轮模式 / 严格模式第二轮共用）的契约指令：开头角色框定 + <skill> 标签包裹
 *  + 结尾输出契约。契约明确条数、编号样式、纯自然语言、维度差异与「别输出解释」。 */
export function buildExpansionInstructions(skillBody: string, entryCount: number): string {
  const lines = [
    '你是专业的图片生成提示词工程师。下面给出一份 SKILL 规范，你必须逐条遵守它的一切要求（风格、随机变量表、禁止事项、输出格式）。',
    '用户输入是对本次生成的锚点要求，优先级高于 skill 中的默认值，但不得违反 skill 的禁止事项。',
    '',
    '<skill>',
    stripClosingSkillTagLines(skillBody).trim(),
    '</skill>',
    '',
  ]
  // few-shot：skill 自带高质量示例时，显式要求对齐其风格与密度
  if (skillBody.includes('## 示例输出')) {
    lines.push('skill 含「## 示例输出」节：你的每条输出都必须参照示例的风格与密度。', '')
  }
  lines.push(
    '输出契约（必须满足，缺一不可）：',
    `1. 输出恰好 ${clampSkillEntryCount(entryCount)} 条提示词，每条以「### 01」「### 02」…样式编号分节；`,
    '2. 每条是一段完整自然语言提示词，可直接复制用于生图，禁止出现「场景：」「焦段：」等结构化字段标签；',
    '3. 条与条之间在场景/瞬间/景别/焦段/机位/构图/前景/光线这些维度中至少 5 个明显不同；',
    '4. 直接输出最终可用的提示词文本，不要输出解释、分析、变量说明或与提示词无关的内容。',
  )
  return lines.join('\n')
}

/** 严格模式第一轮（变量抽取）指令：只抽变量不写正文，输出紧凑 JSON 数组，键名不硬校验。 */
export function buildExtractionInstructions(skillBody: string): string {
  return [
    '你是专业的图片生成提示词工程师。下面给出一份 SKILL 规范，本步骤只做变量抽取：你必须遵守 skill 的随机变量表与禁止事项，但不要输出提示词正文。',
    '',
    '<skill>',
    stripClosingSkillTagLines(skillBody).trim(),
    '</skill>',
    '',
    '抽取契约（必须满足）：',
    '1. 只输出一个 JSON 数组，不要输出任何解释、分析或 JSON 之外的内容；',
    '2. 数组中每个元素是一个 JSON 对象，代表一条提示词的变量抽取结果；',
    '3. 对象的键取自 skill 的变量维度（如场景/瞬间/景别/焦段/机位/构图/前景/光线，以 skill 实际变量表为准），值从对应变量池中抽取；',
    '4. 各对象之间同一维度的取值尽量互不相同（条间去重）；',
    '5. 用户锚点中指定的要求必须体现在每个对象中。',
  ].join('\n')
}

/** 严格模式第一轮的用户输入：锚点 + 条数 + JSON 形状示例（键名仅供参考）。 */
export function buildExtractionUserInput(userInput: string, entryCount: number): string {
  return [
    `锚点要求：${userInput}`,
    '',
    `请抽取 ${clampSkillEntryCount(entryCount)} 条提示词的变量，输出 JSON 数组。JSON 形状示例（键名仅供参考，以 skill 实际变量维度为准）：`,
    '[{"scene":"…","moment":"…","framing":"…","focal":"…","camera":"…","composition":"…","foreground":"…","light":"…"}]',
  ].join('\n')
}

/** 严格模式第二轮的用户输入：锚点 + 抽取 JSON + 逐条成文要求（契约仍在 instructions 中）。 */
export function buildComposeUserInput(userInput: string, extractionJson: string, entryCount: number): string {
  return [
    `锚点要求：${userInput}`,
    '',
    '变量抽取结果（JSON，第 1 个对象对应第 1 条，依此类推）：',
    extractionJson,
    '',
    `请把上述变量抽取结果逐条写成 ${clampSkillEntryCount(entryCount)} 段完整自然语言提示词：把抽取到的变量自然融合进画面描述，不要罗列字段，不要输出 JSON。`,
  ].join('\n')
}

/** 严格模式抽取轮输出 → JSON 对象数组。容错：剥代码围栏、截取首个「[」到最后一个「]」；
 *  键名不做硬校验，只要求是非空对象数组；解析失败返回 null（调用方回落单轮）。 */
export function parseExtractionJson(raw: string): Array<Record<string, unknown>> | null {
  const text = stripCodeFence(raw.replace(/\r\n/g, '\n').trim())
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) return null
    const items = parsed.filter((item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
    )
    return items.length ? items : null
  } catch {
    return null
  }
}

/** 抽取结果的紧凑序列化（回传给成文轮，同时便于测试断言与日志） */
export function serializeExtractionJson(items: Array<Record<string, unknown>>): string {
  return JSON.stringify(items)
}

/** 结构化字段标签（行首检测）：标签词后紧跟冒号才命中，允许列表符号/编号前缀。
 *  「构图原则：」这类小节标题因冒号不紧跟标签词而天然不命中；无冒号的整行标题也不命中，
 *  过短的标题残条由长度规则兜底。 */
const FIELD_LABEL_PATTERN = /^\s*(?:[-*•]\s*)?(?:\d{1,2}[.、)]\s*)?(?:场景|服装|焦段|机位|构图|光线|瞬间|景别|前景|色彩)\s*[:：]/

/** 解析后校验：返回不合格原因列表（空数组 = 合格）。
 *  ① 条数 ≥ min(expectedCount, 2)（expectedCount=1 时就是 1）；② 行首不含结构化字段标签；
 *  ③ 每条长度 ≥ MIN_ENTRY_LENGTH。 */
export function validateExpansionEntries(entries: Array<{ text: string }>, expectedCount: number): string[] {
  const reasons: string[] = []
  const minCount = Math.min(clampSkillEntryCount(expectedCount), 2)
  if (entries.length < minCount) {
    reasons.push(`条数不足：期望至少 ${minCount} 条，实际 ${entries.length} 条`)
  }
  entries.forEach((entry, index) => {
    const hasFieldLabel = entry.text.split('\n').some((line) => FIELD_LABEL_PATTERN.test(line))
    if (hasFieldLabel) {
      reasons.push(`第 ${index + 1} 条含结构化字段标签（如「场景：」），必须是自然语言段落`)
    }
    if (entry.text.trim().length < MIN_ENTRY_LENGTH) {
      reasons.push(`第 ${index + 1} 条内容过短`)
    }
  })
  return reasons
}

/** 校验不合格后的自动重试指令：在原契约末尾附上具体问题，要求修正。 */
export function buildRetryInstructions(baseInstructions: string, reasons: string[]): string {
  return `${baseInstructions}\n\n上次输出的问题：${reasons.join('；')}，必须修正。`
}
