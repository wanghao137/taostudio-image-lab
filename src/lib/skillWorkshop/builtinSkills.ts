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

/** 内置 skill 的示例锚点（每个 3 条，贴合各自主题；工坊「试试」chips 与输入框 placeholder 用）。
 *  本地导入 skill 无示例回落：工坊侧不展示 chips。 */
export const BUILTIN_SKILL_EXAMPLE_ANCHORS: Record<string, readonly string[]> = {
  'vibeshot-candid-photography': ['盛夏荷塘边穿白裙的女生', '深夜便利店门口的随拍', '老城区巷口的午后'],
  'voyeur-style-photographer': ['22岁成年大美女', '赛博朋克风的成年女战士', '京都小巷穿和服的成年女性'],
  'character-candid-photography': ['原神甘雨（成年形象）', '哈利波特里的赫敏（成年）', '街角偶遇的动漫角色 COS'],
  'summer-boyfriend-pov': ['海边泳池双人玩水', '水上乐园的夏日午后', '马尔代夫度假的伴侣视角'],
  'shan-ze-school': ['山海经毕方鸟', '九尾狐', '月宫玉兔捣药'],
  'rare-style-explorer': ['一杯手冲咖啡的产品图', '机甲少女手办', '城市夜景海报'],
}

export async function loadBuiltinSkill(id: string): Promise<ParsedSkillMarkdown | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}skills/${id}/SKILL.md`, { cache: 'no-store' })
    if (!res.ok) return null
    return parseSkillMarkdown(await res.text(), id)
  } catch {
    return null
  }
}
