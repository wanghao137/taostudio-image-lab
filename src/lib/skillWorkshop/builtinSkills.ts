// ---------------------------------------------------------------------------
// 内置 skill 加载（Skill Workshop P2 Task 4）
// 内置 skill 随产品部署在 public/skills/<id>/SKILL.md，运行期 fetch 读取；
// 解析复用 skillMarkdown 的轻量 frontmatter 解析器，单条失败返回 null 由
// 调用方静默跳过（单个 skill 缺失不阻塞工坊可用性）。
// ---------------------------------------------------------------------------

import { parseSkillMarkdown, type ParsedSkillMarkdown } from './skillMarkdown'

export const BUILTIN_SKILL_IDS = [
  'vibeshot-candid-photography',
  'voyeur-style-photographer',
  'character-candid-photography',
  'summer-boyfriend-pov',
  'shan-ze-school',
  'rare-style-explorer',
] as const

export async function loadBuiltinSkill(id: string): Promise<ParsedSkillMarkdown | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}skills/${id}/SKILL.md`, { cache: 'no-store' })
    if (!res.ok) return null
    return parseSkillMarkdown(await res.text(), id)
  } catch {
    return null
  }
}
