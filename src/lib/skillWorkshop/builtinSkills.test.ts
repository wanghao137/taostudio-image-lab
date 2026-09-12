import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILL_IDS } from './builtinSkills'
import { parseSkillMarkdown } from './skillMarkdown'

// 安装诚实性回归：BUILTIN_SKILL_IDS 中的每个 id 必须在 public/skills/<id>/SKILL.md
// 存在随产品部署的真实文件，且 frontmatter（name/title/description）与正文完整可解析。
// 防止未来“只改清单不装文件”“frontmatter 被破坏”导致工坊内置技能静默缺失或展示异常。
describe('BUILTIN_SKILL_IDS 安装诚实性', () => {
  it('清单 id 无重复', () => {
    expect(new Set(BUILTIN_SKILL_IDS).size).toBe(BUILTIN_SKILL_IDS.length)
  })

  it.each([...BUILTIN_SKILL_IDS])('%s：真实 public 文件解析成功且 frontmatter 完整', (id) => {
    const raw = readFileSync(join(process.cwd(), 'public', 'skills', id, 'SKILL.md'), 'utf8')
    const parsed = parseSkillMarkdown(raw, id)
    expect(parsed).not.toBeNull()
    // frontmatter 的 name 必须与目录 id 一致（防止复制文件忘改 name）
    expect(parsed?.name).toBe(id)
    // 中文展示标题非空，且不是回落到 name
    expect(parsed?.title).toBeTruthy()
    expect(parsed?.title).not.toBe(id)
    // 描述非空
    expect(parsed?.description.trim().length).toBeGreaterThan(0)
    // 正文完整（扩写与展示依赖正文，不能是只有 frontmatter 的空壳）
    expect(parsed!.body.length).toBeGreaterThan(1000)
  })
})
