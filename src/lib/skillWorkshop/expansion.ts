const MIN_ENTRY_LENGTH = 6

function stripCodeFence(text: string): string {
  const t = text.trim()
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  return (m ? m[1] : t).trim()
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

/** skill 正文 + 通用输出约束。skill 自带的输出规则优先，本约束只兜底「别输出解释」。 */
export function buildExpansionInstructions(skillBody: string): string {
  const suffix = '通用约束：直接输出最终可用的提示词文本，不要输出解释、分析、变量说明或与提示词无关的内容。若产出多条提示词，用「### 01」「### 02」…分节编号。'
  return `${skillBody.trim()}\n\n---\n\n${suffix}`
}
