import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from '../apiProfiles'
import { buildExpansionInstructions } from './expansion'
import { callSkillExpansionApi } from './skillExpansionApi'

const SKILL_BODY = [
  '# 角色',
  '你是 TaoStudio 的海报提示词专家，产出可直接用于生图的中文提示词。',
  '',
  '## 技能',
  '围绕用户输入的主题产出 3 条海报提示词，每条包含主体、构图、光线与色彩体系。',
].join('\n')

const USER_INPUT = '主题：中秋节的桂花拿铁海报'

/** 模拟真实 fetch 语义：收到 abort signal 时以 AbortError 拒绝。 */
function mockFetchAbortable() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    }),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('callSkillExpansionApi', () => {
  it('POST /responses：instructions=skill 正文+约束，input 只有 input_text，reasoning 透传', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '### 01\n桂花拿铁海报' }] }] }),
        { status: 200 },
      ),
    )
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', model: 'gpt-5-6', reasoningEffort: 'low' })

    const text = await callSkillExpansionApi({ settings: DEFAULT_SETTINGS, profile, skillBody: SKILL_BODY, userInput: USER_INPUT })

    expect(text).toBe('### 01\n桂花拿铁海报')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/responses')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.instructions).toBe(buildExpansionInstructions(SKILL_BODY))
    expect(body.instructions).toContain('海报提示词专家')
    expect(body.instructions).toContain('不要输出解释')
    expect(body.input).toHaveLength(1)
    expect(body.input[0].role).toBe('user')
    // 与图片反推不同：无 input_image，仅一条 input_text 且文本即用户锚点输入。
    expect(body.input[0].content).toEqual([{ type: 'input_text', text: USER_INPUT }])
    expect(body.model).toBe('gpt-5-6')
    expect(body.reasoning).toEqual({ effort: 'low' })
  })

  it('兼容顶层 output_text 返回形态（部分 OpenAI 兼容网关）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1', output_text: '### 01\n顶层文本形态' }), { status: 200 }),
    )
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses' })

    const text = await callSkillExpansionApi({ settings: DEFAULT_SETTINGS, profile, skillBody: SKILL_BODY, userInput: USER_INPUT })

    expect(text).toBe('### 01\n顶层文本形态')
  })

  it('两种形态同时存在时优先 output 数组的结构化文本', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: '来自 output 数组' }] }],
          output_text: '来自顶层字段',
        }),
        { status: 200 },
      ),
    )
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses' })

    const text = await callSkillExpansionApi({ settings: DEFAULT_SETTINGS, profile, skillBody: SKILL_BODY, userInput: USER_INPUT })

    expect(text).toBe('来自 output 数组')
  })

  it('profile.model 为空时回退 settings.model', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 }),
    )
    const profile = { ...createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses' }), model: '' }

    await callSkillExpansionApi({ settings: DEFAULT_SETTINGS, profile, skillBody: SKILL_BODY, userInput: USER_INPUT })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.model).toBe(DEFAULT_SETTINGS.model)
  })

  it('未配置 reasoningEffort 时不发送 reasoning 字段', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 }),
    )
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses' })

    await callSkillExpansionApi({ settings: DEFAULT_SETTINGS, profile, skillBody: SKILL_BODY, userInput: USER_INPUT })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String((init as RequestInit).body))
    expect(body.reasoning).toBeUndefined()
  })

  it('HTTP 错误时抛出接口错误信息', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: '上游不可用' } }), { status: 502 }),
    )
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses' })

    await expect(
      callSkillExpansionApi({ settings: DEFAULT_SETTINGS, profile, skillBody: SKILL_BODY, userInput: USER_INPUT }),
    ).rejects.toThrow('上游不可用')
  })

  it('超时时抛出中文超时提示（含配置的超时秒数）', async () => {
    mockFetchAbortable()
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', timeout: 0.2 })

    await expect(
      callSkillExpansionApi({ settings: DEFAULT_SETTINGS, profile, skillBody: SKILL_BODY, userInput: USER_INPUT }),
    ).rejects.toThrow(/Skill 扩写请求超时（0\.2 秒）/)
  })

  it('外部 abort 传递为 AbortError 而非超时文案', async () => {
    mockFetchAbortable()
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses', timeout: 30 })
    const external = new AbortController()

    const promise = callSkillExpansionApi({
      settings: DEFAULT_SETTINGS,
      profile,
      skillBody: SKILL_BODY,
      userInput: USER_INPUT,
      signal: external.signal,
    })
    setTimeout(() => external.abort(), 20)

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('两种形态都无文本时抛出可读错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ output: [] }), { status: 200 }))
    const profile = createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses' })

    await expect(
      callSkillExpansionApi({ settings: DEFAULT_SETTINGS, profile, skillBody: SKILL_BODY, userInput: USER_INPUT }),
    ).rejects.toThrow('Skill 扩写接口未返回文本内容')
  })
})
