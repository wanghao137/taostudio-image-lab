export interface ParsedSkillMarkdown {
  name: string
  description: string
  body: string
}

/** SKILL.md 轻量解析：单行 key:value frontmatter（开放标准 6 字段只取 name/description，
 *  其余忽略）；无 frontmatter 容错降级。不引入 YAML 依赖。 */
export function parseSkillMarkdown(text: string, fallbackName: string): ParsedSkillMarkdown | null {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return null
  if (!normalized.startsWith('---')) {
    return { name: fallbackName, description: '', body: normalized }
  }
  const endMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!endMatch) return { name: fallbackName, description: '', body: normalized }
  const [, frontmatter, body] = endMatch
  let name = ''
  let description = ''
  for (const line of frontmatter.split('\n')) {
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/)
    if (!m) continue
    if (m[1] === 'name') name = m[2].trim()
    if (m[1] === 'description') description = m[2].trim()
  }
  return { name: name || fallbackName, description, body: body.trim() || normalized }
}
