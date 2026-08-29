import { describe, expect, it } from 'vitest'
import { parsePromptReverseResult } from './promptReverse'

const VALID_JSON = JSON.stringify({
  imageType: 'poster',
  breakdown: [{ dimension: '主体与身份特征', text: '一位年轻女性' }],
  prompts: [
    { label: '忠实复刻', text: '竖版时尚海报：年轻女性站在花园中' },
    { label: '风格强化', text: '高级自然系时装摄影海报' },
    { label: '精简速写', text: '花园人像海报' },
  ],
  promptEn: 'A vertical fashion poster of a young woman in a garden',
})

describe('parsePromptReverseResult', () => {
  it('直接解析纯 JSON', () => {
    const result = parsePromptReverseResult(VALID_JSON)
    expect(result?.imageType).toBe('poster')
    expect(result?.breakdown).toHaveLength(1)
    expect(result?.prompts).toHaveLength(3)
    expect(result?.promptEn).toContain('fashion poster')
  })

  it('容忍尾随逗号（VLM 实测缺陷）', () => {
    const text = '{"imageType":"general","breakdown":[{"dimension":"主体","text":"猫"},],"prompts":[{"label":"忠实复刻","text":"一只猫",},],}'
    const result = parsePromptReverseResult(text)
    expect(result?.imageType).toBe('general')
    expect(result?.prompts[0].text).toBe('一只猫')
  })

  it('剥离 markdown 代码围栏', () => {
    const result = parsePromptReverseResult('```json\n' + VALID_JSON + '\n```')
    expect(result?.imageType).toBe('poster')
  })

  it('从前后杂文中截取 JSON 主体', () => {
    const result = parsePromptReverseResult('反推结果如下：\n' + VALID_JSON + '\n以上供参考。')
    expect(result?.imageType).toBe('poster')
  })

  it('非法输入返回 null', () => {
    expect(parsePromptReverseResult('完全不是 JSON 的一段话')).toBeNull()
    expect(parsePromptReverseResult('')).toBeNull()
  })

  it('JSON 有效但 prompts 缺失时兜底为整段文本单候选', () => {
    const result = parsePromptReverseResult('{"imageType":"general","breakdown":[]}')
    expect(result?.prompts).toHaveLength(1)
    expect(result?.prompts[0].label).toBe('反推结果')
    expect(result?.prompts[0].text).toContain('imageType')
  })

  it('promptEn 缺失时字段为 undefined（UI 隐藏英文区）', () => {
    const result = parsePromptReverseResult('{"imageType":"general","breakdown":[],"prompts":[{"label":"忠实复刻","text":"一只猫"}]}')
    expect(result?.promptEn).toBeUndefined()
  })
})
