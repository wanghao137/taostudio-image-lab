import { describe, expect, it } from 'vitest'
import { parseSkillMarkdown } from './skillMarkdown'

describe('parseSkillMarkdown', () => {
  it('标准 frontmatter：取 name/description，body 为 --- 之后全文', () => {
    const md = '---\nname: vibeshot-candid-photography\ndescription: 生成生活感人像提示词。\n---\n\n# 标题\n\n正文内容'
    const r = parseSkillMarkdown(md, 'fallback')!
    expect(r.name).toBe('vibeshot-candid-photography')
    expect(r.description).toBe('生成生活感人像提示词。')
    expect(r.body).toContain('# 标题')
    expect(r.body).toContain('正文内容')
  })
  it('frontmatter 含 title：解析出 title 中文标题', () => {
    const md = '---\nname: vibeshot-candid-photography\ntitle: 生活感随手抓拍写真\ndescription: 描述。\n---\n\n正文'
    const r = parseSkillMarkdown(md, 'fallback')!
    expect(r.title).toBe('生活感随手抓拍写真')
    expect(r.name).toBe('vibeshot-candid-photography')
    expect(r.body).toContain('正文')
  })
  it('frontmatter 无 title：title 为 undefined（展示层回落 name）', () => {
    const md = '---\nname: my-skill\ndescription: 描述。\n---\n正文'
    const r = parseSkillMarkdown(md, 'fallback')!
    expect(r.name).toBe('my-skill')
    expect(r.title).toBeUndefined()
  })
  it('title 为空串：视为未设置（undefined），回落 name', () => {
    const md = '---\nname: my-skill\ntitle: \ndescription: 描述。\n---\n正文'
    const r = parseSkillMarkdown(md, 'fallback')!
    expect(r.title).toBeUndefined()
    expect(r.name).toBe('my-skill')
  })
  it('无 frontmatter：name=fallback，body=全文', () => {
    const r = parseSkillMarkdown('就是一段提示词体系', 'my-skill')!
    expect(r.name).toBe('my-skill')
    expect(r.description).toBe('')
    expect(r.body).toBe('就是一段提示词体系')
  })
  it('frontmatter 只认文件头部（--- 不在首行则视为正文）', () => {
    const r = parseSkillMarkdown('正文\n---\nname: x', 'fb')!
    expect(r.name).toBe('fb')
    expect(r.body).toContain('---')
  })
  it('空文本返回 null', () => {
    expect(parseSkillMarkdown('   \n  ', 'x')).toBeNull()
  })
})
