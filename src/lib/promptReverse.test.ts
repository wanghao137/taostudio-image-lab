import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { callPromptReverseApi, parsePromptReverseResult, PROMPT_REVERSE_INSTRUCTIONS, resolveReverseImageTarget } from './promptReverse'

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

  it('候选 label 重复时自动加序号后缀，两个候选均可独立访问', () => {
    const text = JSON.stringify({
      imageType: 'general',
      breakdown: [],
      prompts: [
        { label: '忠实复刻', text: '第一条提示词' },
        { label: '忠实复刻', text: '第二条提示词' },
      ],
    })
    const result = parsePromptReverseResult(text)
    expect(result?.prompts).toHaveLength(2)
    expect(result?.prompts[0].label).toBe('忠实复刻')
    expect(result?.prompts[1].label).toBe('忠实复刻 2')
    expect(result?.prompts[1].text).toBe('第二条提示词')
  })

  it('breakdown 空文本条目剔除、重复维度去重（保留首条）', () => {
    const text = JSON.stringify({
      imageType: 'general',
      breakdown: [
        { dimension: '主体', text: '一只橘猫' },
        { dimension: '主体', text: '重复维度应被丢弃' },
        { dimension: '光线', text: '   ' },
        { dimension: '色彩', text: '暖色调' },
      ],
      prompts: [{ label: '忠实复刻', text: '一只橘猫' }],
    })
    const result = parsePromptReverseResult(text)
    expect(result?.breakdown).toEqual([
      { dimension: '主体', text: '一只橘猫' },
      { dimension: '色彩', text: '暖色调' },
    ])
  })

  it('兜底单候选时保留 promptEn（英文镜像不丢失）', () => {
    const result = parsePromptReverseResult('{"imageType":"poster","promptEn":"EN mirror"}')
    expect(result?.promptEn).toBe('EN mirror')
    expect(result?.prompts).toHaveLength(1)
    expect(result?.prompts[0].label).toBe('反推结果')
  })

  it('围栏 + 尾随逗号组合分支可解析', () => {
    const fenced = '```json\n{"imageType":"general","breakdown":[{"dimension":"主体","text":"猫"},],"prompts":[{"label":"忠实复刻","text":"一只猫"}],}\n```'
    const result = parsePromptReverseResult(fenced)
    expect(result?.imageType).toBe('general')
    expect(result?.prompts[0].text).toBe('一只猫')
  })

  it('杂文包裹 + 尾随逗号组合分支可解析', () => {
    const text = '反推结果如下：\n{"imageType":"general","breakdown":[{"dimension":"主体","text":"猫"},],"prompts":[{"label":"忠实复刻","text":"一只猫"}],}\n以上供参考。'
    const result = parsePromptReverseResult(text)
    expect(result?.imageType).toBe('general')
    expect(result?.prompts[0].text).toBe('一只猫')
  })
})

describe('resolveReverseImageTarget', () => {
  it('最长边不超过 1536 时不缩放', () => {
    expect(resolveReverseImageTarget(1024, 768)).toBeNull()
    expect(resolveReverseImageTarget(1536, 1024)).toBeNull()
    expect(resolveReverseImageTarget(1536, 1536)).toBeNull()
  })

  it('小图返回 null，不放大', () => {
    expect(resolveReverseImageTarget(512, 512)).toBeNull()
    expect(resolveReverseImageTarget(800, 200)).toBeNull()
  })

  it('非法尺寸返回 null', () => {
    expect(resolveReverseImageTarget(0, 100)).toBeNull()
    expect(resolveReverseImageTarget(-1, 2000)).toBeNull()
    expect(resolveReverseImageTarget(2000, 0)).toBeNull()
  })

  it('超限图缩到保持宽高比的目标：最长边 1536，短边按比例', () => {
    expect(resolveReverseImageTarget(2400, 3200)).toEqual({ width: 1152, height: 1536 })
    expect(resolveReverseImageTarget(1536, 2048)).toEqual({ width: 1152, height: 1536 })
    expect(resolveReverseImageTarget(4096, 4096)).toEqual({ width: 1536, height: 1536 })
  })

  it('横版超限图同样保持宽高比（1536 × 短边）', () => {
    expect(resolveReverseImageTarget(3200, 2400)).toEqual({ width: 1536, height: 1152 })
    expect(resolveReverseImageTarget(4096, 2160)).toEqual({ width: 1536, height: 810 })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('callPromptReverseApi', () => {
  const okPayload = {
    output: [{ type: 'message', content: [{ type: 'output_text', text: '{"imageType":"general"}' }] }],
  }

  it('构造 responses 请求：instructions + input_image 内联 + reasoning 透传', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(okPayload), { status: 200 }))
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', model: 'gpt-5-6', reasoningEffort: 'low' })

    const text = await callPromptReverseApi({
      settings: DEFAULT_SETTINGS,
      profile,
      imageDataUrl: 'data:image/png;base64,AAAA',
    })

    expect(text).toBe('{"imageType":"general"}')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/responses')
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.instructions).toBe(PROMPT_REVERSE_INSTRUCTIONS)
    expect(body.model).toBe('gpt-5-6')
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect(body.input[0].content[0].type).toBe('input_text')
    expect(body.input[0].content[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,AAAA' })
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('未配置 reasoningEffort 时不发送 reasoning 字段', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(okPayload), { status: 200 }))
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses' })

    await callPromptReverseApi({ settings: DEFAULT_SETTINGS, profile, imageDataUrl: 'data:image/png;base64,AAAA' })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.reasoning).toBeUndefined()
  })

  it('HTTP 错误时抛出接口错误信息', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: '上游不可用' } }), { status: 502 }))
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses' })

    await expect(callPromptReverseApi({ settings: DEFAULT_SETTINGS, profile, imageDataUrl: 'data:image/png;base64,AAAA' }))
      .rejects.toThrow('上游不可用')
  })

  it('超时时抛出中文超时提示（含配置的超时秒数）', async () => {
    // 模拟真实 fetch 语义：signal abort 时以 AbortError 拒绝。
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    )
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', timeout: 0.2 })

    await expect(callPromptReverseApi({ settings: DEFAULT_SETTINGS, profile, imageDataUrl: 'data:image/png;base64,AAAA' }))
      .rejects.toThrow(/反推请求超时（0\.2 秒）/)
  })
})
