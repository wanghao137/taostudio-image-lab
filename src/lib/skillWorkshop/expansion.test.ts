import { describe, expect, it } from 'vitest'
import { buildExpansionInstructions, parseExpansionEntries } from './expansion'

describe('parseExpansionEntries', () => {
  it('markdown 分节（### 01 形式，vsc 格式）逐节成条目', () => {
    const raw = '### 01\n一位韩系人像在荷塘边…\n\n### 02\n渡轮甲板上的低机位…'
    const entries = parseExpansionEntries(raw)
    expect(entries).toHaveLength(2)
    expect(entries[0].text).toContain('荷塘')
    expect(entries[0].id).toBe('entry-1')
  })
  it('编号行（1. / 01、）分段成条目', () => {
    const raw = '1. 第一条提示词内容足够长\n2. 第二条提示词内容足够长'
    expect(parseExpansionEntries(raw)).toHaveLength(2)
  })
  it('无编号多段落按空行分段成条目', () => {
    const raw = '第一条成段提示词，语义完整。\n\n第二条成段提示词，语义完整。'
    expect(parseExpansionEntries(raw)).toHaveLength(2)
  })
  it('整段代码围栏剥壳；单段输出成单条目', () => {
    const raw = '```text\n一条完整提示词。\n```'
    const entries = parseExpansionEntries(raw)
    expect(entries).toHaveLength(1)
    expect(entries[0].text).not.toContain('```')
  })
  it('噪声条目（过短）被丢弃，除非它是唯一内容', () => {
    expect(parseExpansionEntries('### 01\n好\n\n### 02\n完整的第二条提示词内容')).toHaveLength(1)
    expect(parseExpansionEntries('短')).toHaveLength(1)
  })
})

describe('buildExpansionInstructions', () => {
  it('skill 正文原样保留，尾部追加通用输出约束', () => {
    const s = buildExpansionInstructions('# 角色设定\n变量池…')
    expect(s).toContain('# 角色设定')
    expect(s).toContain('变量池')
    expect(s.endsWith('### 02')).toBe(false)
    expect(s).toContain('不要输出解释')
  })
})
