# 图片反推提示词（Image-to-Prompt）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在生图工作台中新增「反推提示词」：任意图片一键反推出结构化解构 + 三候选中文提示词 + 英文镜像，可编辑、复制、一键填入生成输入框并沉淀为提示词历史。

**Architecture:** 纯客户端增量功能。新增 `src/lib/promptReverse.ts`（指令常量 + Responses API 视觉调用 + 四级 JSON 解析 + 图片预处理决策）与 lazy 模态 `PromptReverseModal`，通过 store 的 `promptReverseSource` 状态驱动（完全镜像现有 `stickerSplitSource` 模式）；入口挂在 DetailModal 工具条与全局右键菜单。模型解析复用 Agent 文本配置（零新设置项），代理链路自动继承。

**Tech Stack:** React 18 + TypeScript + zustand + Tailwind；测试 vitest（node 环境，`vi.spyOn(globalThis, 'fetch')` 风格）。

**Spec:** `docs/superpowers/specs/2026-08-29-image-to-prompt-design.md`（v3）。指令模板原文在 spec §5.4，本计划 Task 4 内嵌同一份文本，两处必须一致。

## Global Constraints

- UI 文案一律中文（AGENTS.md）。
- 不硬编码任何 API host/网关/厂商到产品逻辑（AGENTS.md provider 中立）。
- 不提交真实密钥；测试只用假 key（如 `test-key`）。
- lint 基线零错误；既有 unused-variable 警告可保留，但新增代码不得产生新警告。
- 本地 commit 需用户已批准本计划为授权（按任务粒度提交）；**push / deploy 一律禁止**，除非用户另行明确要求。
- 指令模板 `PROMPT_REVERSE_INSTRUCTIONS` 修改后必须跑 spec §5.9 QC（`node .omx/reverse-lab/step7_template_v3.mjs`，需本地 chatgpt2api :3001 可用；不可用时在 PR/交付说明中标注未回归）。
- 每个任务完成时跑 `npm test`（全量）确认无回归。

---

### Task 1: `parsePromptReverseResult` 四级解析器

**Files:**
- Create: `src/lib/promptReverse.ts`
- Create: `src/lib/promptReverse.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces: `PromptReverseResult` / `PromptReverseCandidate` 类型与 `parsePromptReverseResult(text: string): PromptReverseResult | null`（后续 Task 4/6 依赖；解析失败返回 `null` 由调用方决定兜底文案，解析出部分时返回带兜底 prompt 的对象——见用例 6/7）。

- [ ] **Step 1: 写失败测试**

创建 `src/lib/promptReverse.test.ts`：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/promptReverse.test.ts`
Expected: FAIL — `Cannot find module './promptReverse'`（或等价解析错误）。

- [ ] **Step 3: 最小实现**

创建 `src/lib/promptReverse.ts`：

```ts
import type { ApiProfile, AppSettings } from '../types'

// ---------------------------------------------------------------------------
// 图片反推提示词（Image-to-Prompt）
// 设计文档：docs/superpowers/specs/2026-08-29-image-to-prompt-design.md
// ---------------------------------------------------------------------------

export type PromptReverseImageType = 'portrait' | 'illustration' | 'poster' | 'product' | 'general'

export interface PromptReverseCandidate {
  label: string
  text: string
}

export interface PromptReverseResult {
  imageType: PromptReverseImageType
  breakdown: Array<{ dimension: string; text: string }>
  prompts: PromptReverseCandidate[]
  promptEn?: string
}

const IMAGE_TYPES: PromptReverseImageType[] = ['portrait', 'illustration', 'poster', 'product', 'general']

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1')
}

function coerceResult(value: unknown, rawText: string): PromptReverseResult | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const imageType = IMAGE_TYPES.includes(record.imageType as PromptReverseImageType)
    ? (record.imageType as PromptReverseImageType)
    : 'general'
  const breakdown = Array.isArray(record.breakdown)
    ? record.breakdown
        .filter((item): item is { dimension: string; text: string } => {
          if (typeof item !== 'object' || item === null) return false
          const entry = item as Record<string, unknown>
          return typeof entry.dimension === 'string' && typeof entry.text === 'string'
        })
        .map((item) => ({ dimension: item.dimension, text: item.text }))
    : []
  const prompts = Array.isArray(record.prompts)
    ? record.prompts
        .filter((item): item is { label: string; text: string } => {
          if (typeof item !== 'object' || item === null) return false
          const entry = item as Record<string, unknown>
          return typeof entry.label === 'string' && typeof entry.text === 'string' && entry.text.trim() !== ''
        })
        .map((item) => ({ label: item.label, text: item.text }))
    : []
  const promptEn = typeof record.promptEn === 'string' && record.promptEn.trim() !== '' ? record.promptEn : undefined
  if (prompts.length === 0) {
    return { imageType, breakdown, prompts: [{ label: '反推结果', text: rawText.trim() }] }
  }
  return { imageType, breakdown, prompts, promptEn }
}

/**
 * 四级解析链（设计文档 §5.5，实证 6/6 通过；尾随逗号为 VLM 实测真实缺陷）：
 * 直接 parse → 去尾逗号 → 剥围栏（含去尾逗号）→ 截取 {..}（含去尾逗号）。
 * 全部失败返回 null；解析出对象但缺 prompts 时兜底整段文本为单候选。
 */
export function parsePromptReverseResult(text: string): PromptReverseResult | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const attempts: Array<() => unknown> = [
    () => JSON.parse(trimmed),
    () => JSON.parse(stripTrailingCommas(trimmed)),
    () => {
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (!fenced) throw new Error('no fence')
      return JSON.parse(stripTrailingCommas(fenced[1]))
    },
    () => {
      const first = trimmed.indexOf('{')
      const last = trimmed.lastIndexOf('}')
      if (first < 0 || last <= first) throw new Error('no braces')
      return JSON.parse(stripTrailingCommas(trimmed.slice(first, last + 1)))
    },
  ]
  for (const attempt of attempts) {
    try {
      const parsed = attempt()
      const coerced = coerceResult(parsed, trimmed)
      if (coerced) return coerced
    } catch {
      // 尝试下一级
    }
  }
  return null
}
```

注意：`ApiProfile` / `AppSettings` 导入本任务暂未使用（Task 4 会用），先不导入以免 lint 未使用告警——把 import 行去掉，Task 4 再加。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/promptReverse.test.ts`
Expected: PASS（7 个用例全绿）。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npm test
git add src/lib/promptReverse.ts src/lib/promptReverse.test.ts
git commit -m "feat: add prompt reverse JSON parser with four-level fallback chain"
```

---

### Task 2: `resolveReverseImageTarget` 预缩放决策

**Files:**
- Modify: `src/lib/promptReverse.ts`
- Modify: `src/lib/promptReverse.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `resolveReverseImageTarget(width: number, height: number): { width: number; height: number } | null`（Task 6 模态依赖）。返回 `null` 表示无需缩放（最长边 ≤1536）。
- 偏差说明：设计文档写「JPEG q85」，但实现复用现有 `resizeImageHighQuality`（lanczos Worker，保持原格式）以遵守「优先既有代码路径」；≤1536px 的 PNG 体积可接受（实测输入 208KB）。若实测超 4MB 再补 JPEG 转换。

- [ ] **Step 1: 写失败测试**

在 `src/lib/promptReverse.test.ts` 追加：

```ts
import { resolveReverseImageTarget } from './promptReverse'

describe('resolveReverseImageTarget', () => {
  it('最长边不超过 1536 时不缩放', () => {
    expect(resolveReverseImageTarget(1024, 768)).toBeNull()
    expect(resolveReverseImageTarget(1536, 2048)).toBeNull() // 最长边恰好 2048 > 1536 会缩放，见下一用例
  })

  it('小图返回 null，不放大', () => {
    expect(resolveReverseImageTarget(512, 512)).toBeNull()
    expect(resolveReverseImageTarget(800, 200)).toBeNull()
  })

  it('4K 图缩到 1536 见方的 contain 盒', () => {
    expect(resolveReverseImageTarget(2400, 3200)).toEqual({ width: 1536, height: 1536 })
    expect(resolveReverseImageTarget(4096, 4096)).toEqual({ width: 1536, height: 1536 })
  })
})
```

修正用例 1 中的笔误：`resolveReverseImageTarget(1536, 2048)` 最长边 2048 > 1536，应缩放——把该断言移到用例 3 风格：

```ts
  it('最长边不超过 1536 时不缩放', () => {
    expect(resolveReverseImageTarget(1024, 768)).toBeNull()
    expect(resolveReverseImageTarget(1536, 1024)).toBeNull()
    expect(resolveReverseImageTarget(1536, 1536)).toBeNull()
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/promptReverse.test.ts`
Expected: FAIL — `resolveReverseImageTarget` 未导出。

- [ ] **Step 3: 最小实现**

在 `src/lib/promptReverse.ts` 追加：

```ts
export const PROMPT_REVERSE_MAX_EDGE = 1536

/**
 * 预缩放决策：最长边 ≤1536 返回 null（不缩放不放大）；否则返回 1536×1536
 * contain 盒（resizeImageHighQuality 以 contain 保持宽高比）。设计文档 §5.1：
 * VLM 无需 4K（实测 1024px 已逐字读出排版文字）。
 */
export function resolveReverseImageTarget(width: number, height: number): { width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null
  if (Math.max(width, height) <= PROMPT_REVERSE_MAX_EDGE) return null
  return { width: PROMPT_REVERSE_MAX_EDGE, height: PROMPT_REVERSE_MAX_EDGE }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/promptReverse.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npm test
git add src/lib/promptReverse.ts src/lib/promptReverse.test.ts
git commit -m "feat: add reverse image downscale decision helper"
```

---

### Task 3: `getPromptReverseApiProfile` 模型解析

**Files:**
- Modify: `src/lib/apiProfiles.ts`（追加在 `getAgentTextApiProfile` 之后，约 :802）
- Modify: `src/lib/apiProfiles.test.ts`（文件末尾追加 describe）

**Interfaces:**
- Consumes: `normalizeSettings` / `isAgentTextApiProfile` / `getActiveApiProfile`（均已在 `apiProfiles.ts` 内）。
- Produces: `getPromptReverseApiProfile(settings: unknown): ApiProfile | null`（Task 6 依赖）。解析顺序：Agent 文本配置（agent 模式开启时）→ 激活 profile（若为 openai+responses）→ null。

- [ ] **Step 1: 写失败测试**

在 `src/lib/apiProfiles.test.ts` 末尾追加（文件顶部已有 `normalizeSettings`、`createDefaultOpenAIProfile` 等导入，本用例补导入 `getPromptReverseApiProfile`）：

```ts
describe('getPromptReverseApiProfile', () => {
  const responsesProfile = createDefaultOpenAIProfile({ id: 'resp-profile', apiMode: 'responses' })
  const imagesProfile = createDefaultOpenAIProfile({ id: 'img-profile', apiMode: 'images' })

  it('agent 模式开启时优先返回 Agent 文本配置', () => {
    const settings = normalizeSettings({
      profiles: [imagesProfile, responsesProfile],
      activeProfileId: 'img-profile',
      agentApiConfigMode: 'native',
      agentTextProfileId: 'resp-profile',
    })
    expect(getPromptReverseApiProfile(settings)?.id).toBe('resp-profile')
  })

  it('agent 关闭时回退激活 profile（若为 responses 类型）', () => {
    const settings = normalizeSettings({
      profiles: [imagesProfile, responsesProfile],
      activeProfileId: 'resp-profile',
      agentApiConfigMode: 'off',
    })
    expect(getPromptReverseApiProfile(settings)?.id).toBe('resp-profile')
  })

  it('agent 关闭且激活 profile 是 images 类型时返回 null（UI 引导配置）', () => {
    const settings = normalizeSettings({
      profiles: [imagesProfile, responsesProfile],
      activeProfileId: 'img-profile',
      agentApiConfigMode: 'off',
    })
    expect(getPromptReverseApiProfile(settings)).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/apiProfiles.test.ts`
Expected: FAIL — `getPromptReverseApiProfile` 未导出。

- [ ] **Step 3: 最小实现**

在 `src/lib/apiProfiles.ts` 的 `getAgentTextApiProfile` 函数后追加：

```ts
export function getPromptReverseApiProfile(settings: Partial<AppSettings> | unknown): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  if (normalized.agentApiConfigMode !== 'off') {
    const textProfile = normalized.profiles.find((profile) => profile.id === normalized.agentTextProfileId)
    if (textProfile && isAgentTextApiProfile(textProfile)) return textProfile
  }
  const active = getActiveApiProfile(normalized)
  return isAgentTextApiProfile(active) ? active : null
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/apiProfiles.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + 提交**

```bash
npm test
git add src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts
git commit -m "feat: add prompt reverse profile resolution reusing agent text profile"
```

---

### Task 4: 指令常量 + `callPromptReverseApi` 调用封装

**Files:**
- Modify: `src/lib/agentApi.ts`（`createHeaders` :103 / `extractText` :340 / `normalizeResponsePayload` :414 三个函数加 `export`，函数体不动）
- Modify: `src/lib/promptReverse.ts`
- Modify: `src/lib/promptReverse.test.ts`

**Interfaces:**
- Consumes: `buildApiUrl` / `readClientDevProxyConfig` / `shouldUseApiProxy`（`devProxy.ts` 已导出）；`getApiErrorMessage`（`imageApiShared.ts` 已导出）；`createHeaders` / `extractText` / `normalizeResponsePayload`（本任务从 `agentApi.ts` 导出）。
- Produces: `PROMPT_REVERSE_INSTRUCTIONS`（常量）与 `callPromptReverseApi(opts: { settings: AppSettings; profile: ApiProfile; imageDataUrl: string; signal?: AbortSignal }): Promise<string>`（Task 6 依赖，返回模型原始文本，解析交给 `parsePromptReverseResult`）。

- [ ] **Step 1: 导出 agentApi 内部工具**

`src/lib/agentApi.ts` 三处只加 `export` 关键字：

```ts
export function createHeaders(profile: ApiProfile): Record<string, string> {
```

```ts
export function extractText(payload: ResponsesApiResponse) {
```

```ts
export function normalizeResponsePayload(value: unknown): ResponsesApiResponse | null {
```

Run: `npx vitest run src/lib/agentApi.test.ts` — Expected: PASS（纯导出变更无行为影响；agentApi 测试为直接导入，无 vi.mock 工厂需同步）。

- [ ] **Step 2: 写失败测试**

在 `src/lib/promptReverse.test.ts` 追加（顶部补导入）：

```ts
import { afterEach, vi } from 'vitest'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { callPromptReverseApi, PROMPT_REVERSE_INSTRUCTIONS } from './promptReverse'

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
})
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run src/lib/promptReverse.test.ts`
Expected: FAIL — `callPromptReverseApi` / `PROMPT_REVERSE_INSTRUCTIONS` 未导出。

- [ ] **Step 4: 实现**

在 `src/lib/promptReverse.ts` 追加（文件顶部补导入）：

```ts
import { createHeaders, extractText, normalizeResponsePayload } from './agentApi'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import { getApiErrorMessage } from './imageApiShared'
import type { ApiProfile, AppSettings } from '../types'
```

```ts
/**
 * 指令模板 v3（设计文档 §5.4 定稿，三轮实测；修改必须跑 spec §5.9 QC 回归）。
 */
export const PROMPT_REVERSE_INSTRUCTIONS = [
  '你是一位顶级的视觉分析师与 AI 生图提示词工程师。你的输出将直接用于 OpenAI 兼容的 gpt-image 类图像生成器。',
  '',
  '任务：对输入图片做「反推提示词」——写出能最大限度重现这张图的生成提示词。',
  '',
  '工作方法（内部完成，不要输出思考过程）：',
  '1. 先判断图片类型：portrait（人像摄影）/ illustration（插画动漫）/ poster（海报版式）/ product（产品图）/ general（通用）。',
  '2. 从下面的维度菜单中，挑选对这张图最关键、最能决定生成结果像不像的 4~8 个维度：主体与身份特征 / 动作与表情 / 服装造型与道具 / 环境场景 / 构图与机位镜头 / 光线 / 色彩体系 / 材质与质感 / 画风与媒介 / 成像特征（颗粒、景深、锐度）/ 版式与文字 / 氛围情绪。',
  '3. 只描述图中可见的内容，禁止臆测不可见的细节、人名、品牌；图中有可读文字时原样引用；不确定的细节用「大约」「类似」弱化表述。',
  '4. 提示词用中文自然语言成段描述（不是标签堆砌），语义完整、空间关系清晰、包含风格与质感线索，不使用 Midjourney 参数语法。正文禁止出现「这张图片」「画面展示了」等元描述措辞，直接以画面内容开头。',
  '5. 「忠实复刻」必须完整覆盖你选中的全部维度（含成像特征，如胶片颗粒、景深、锐度）。',
  '',
  '输出要求：只输出一个 JSON 对象，不要输出任何其他文字或代码围栏，字段如下：',
  '{"imageType":"portrait|illustration|poster|product|general","breakdown":[{"dimension":"<维度名，中文>","text":"<该维度的精准描述，一句话>"}],"prompts":[{"label":"忠实复刻","text":"<完整中文提示词，重现整图所有关键维度>"},{"label":"风格强化","text":"<同体系但强化画风与质感表达的变体>"},{"label":"精简速写","text":"<保留核心识别特征的最短可用提示词>"}],"promptEn":"<忠实复刻的英文镜像版，语义等价，可直接用于英文生图API>"}',
].join('\n')

/**
 * 反推调用（镜像 callAgentConversationTitleApi 形态：无 tools、非流式、
 * input_image 内联、profile.timeout 超时、双 AbortSignal、自动继承代理链）。
 */
export async function callPromptReverseApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  imageDataUrl: string
  signal?: AbortSignal
}): Promise<string> {
  const { settings, profile, imageDataUrl, signal } = opts
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const content: Array<Record<string, string>> = [
      { type: 'input_text', text: '请对这张图片反推提示词。' },
      { type: 'input_image', image_url: imageDataUrl },
    ]
    const body: Record<string, unknown> = {
      model: profile.model || settings.model,
      instructions: PROMPT_REVERSE_INSTRUCTIONS,
      input: [{ role: 'user', content }],
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }

    const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      method: 'POST',
      headers: createHeaders(profile),
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(await getApiErrorMessage(response))
    }
    const payload = normalizeResponsePayload(await response.json())
    if (!payload) throw new Error('反推接口返回格式无效')
    return extractText(payload)
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run src/lib/promptReverse.test.ts`
Expected: PASS（含 Task 1/2 全部用例）。

- [ ] **Step 6: 指令模板回归（本机链路可用时）**

Run: `node .omx/reverse-lab/step7_template_v3.mjs`
Expected: 两样本 JSON OK、promptEn 存在、meta 短语 PASS。若本机 :3001 不可用，跳过并在提交信息注明「模板未链路回归，与 spec §5.4 逐字一致」。

- [ ] **Step 7: 全量回归 + 提交**

```bash
npm test
git add src/lib/agentApi.ts src/lib/promptReverse.ts src/lib/promptReverse.test.ts
git commit -m "feat: add prompt reverse instructions and responses API call"
```

---

### Task 5: store / App 模态接线

**Files:**
- Modify: `src/types.ts`（`StickerSplitSource` 之后，约 :264）
- Modify: `src/store.ts`（接口声明区 `stickerSplitSource` 后约 :425；实现区约 :929）
- Modify: `src/App.tsx`（lazy 声明区约 :31；ErrorBoundary key 约 :337；Suspense 渲染区约 :349）

**Interfaces:**
- Consumes: 无。
- Produces: `PromptReverseSource { imageId: string }` 类型；store 字段 `promptReverseSource: PromptReverseSource | null` 与 `setPromptReverseSource(src)`（Task 6/7 依赖）。

- [ ] **Step 1: 类型**

`src/types.ts` `StickerSplitSource` 接口后追加：

```ts
export interface PromptReverseSource {
  imageId: string
}
```

- [ ] **Step 2: store 接口与实现**

`src/store.ts` 接口区（`setStickerSplitSource` 声明后）：

```ts
  promptReverseSource: PromptReverseSource | null
  setPromptReverseSource: (src: PromptReverseSource | null) => void
```

实现区（`setStickerSplitSource` 实现后，同样带 `dismissAllTooltips`）：

```ts
      promptReverseSource: null,
      setPromptReverseSource: (promptReverseSource) => {
        if (promptReverseSource) dismissAllTooltips()
        set({ promptReverseSource })
      },
```

顶部类型导入行补 `PromptReverseSource`（与既有 `StickerSplitSource` 同一行 from './types'）。

- [ ] **Step 3: App 渲染**

`src/App.tsx` lazy 声明区（`StickerSplitModal` 行后）：

```tsx
const PromptReverseModal = lazy(() => import('./components/PromptReverseModal'))
```

store 选择器区补：

```tsx
  const promptReverseSource = useStore((s) => s.promptReverseSource)
```

ErrorBoundary `key` 表达式中 `(stickerSplitSource ? ... : null)` 段后追加：

```tsx
?? (promptReverseSource ? 'prompt-reverse' : null)
```

Suspense 内 `{stickerSplitSource ? <StickerSplitModal /> : null}` 后追加：

```tsx
          {promptReverseSource ? <PromptReverseModal /> : null}
```

- [ ] **Step 4: 验证**

Run: `npm test && npx tsc -p tsconfig.app.json --noEmit`
Expected: 测试全过；类型检查无错（`PromptReverseModal` 组件 Task 6 才创建——**本任务先创建占位会被计划禁止，因此调整执行顺序：Task 5 的 App 渲染行与类型检查放在 Task 6 完成后执行**。执行者操作：本任务只做 types.ts + store.ts 改动并跑 `npm test`；App.tsx 三处改动挪到 Task 6 Step 4 一起做）。

- [ ] **Step 5: 提交**

```bash
npm test
git add src/types.ts src/store.ts
git commit -m "feat: add promptReverseSource modal state to store"
```

---

### Task 6: `PromptReverseModal` 组件

**Files:**
- Create: `src/components/PromptReverseModal.tsx`
- Modify: `src/App.tsx`（Task 5 遗留的三处渲染改动）

**Interfaces:**
- Consumes: `useStore`（`promptReverseSource` / `setPromptReverseSource` / `settings` / `params` / `showToast` / `setPrompt` / `recordPromptHistory` / `setShowSettings`）；`ensureImageCached`（`src/lib/imageCache.ts:106`）；`resizeImageHighQuality`（`src/lib/imageResizer.ts:105`）；`getPromptReverseApiProfile`（Task 3）；`callPromptReverseApi` / `parsePromptReverseResult` / `resolveReverseImageTarget`（Task 1/2/4）。
- Produces: 默认导出组件 `PromptReverseModal()`（无 props，读 store），供 App lazy 渲染。

- [ ] **Step 1: 创建组件**

`src/components/PromptReverseModal.tsx` 完整实现：

```tsx
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { ensureImageCached } from '../lib/imageCache'
import { resizeImageHighQuality } from '../lib/imageResizer'
import { getPromptReverseApiProfile } from '../lib/apiProfiles'
import {
  callPromptReverseApi,
  parsePromptReverseResult,
  resolveReverseImageTarget,
  type PromptReverseResult,
} from '../lib/promptReverse'

type Phase = 'loading' | 'noProfile' | 'error' | 'done'

const CLOSE_ICON_PATH = 'M18 6 6 18M6 6l12 12'

function readImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('图片无法读取'))
    img.src = dataUrl
  })
}

export default function PromptReverseModal() {
  const source = useStore((s) => s.promptReverseSource)
  const setPromptReverseSource = useStore((s) => s.setPromptReverseSource)
  const showToast = useStore((s) => s.showToast)

  const [phase, setPhase] = useState<Phase>('loading')
  const [result, setResult] = useState<PromptReverseResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [previewDataUrl, setPreviewDataUrl] = useState('')
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null)
  const [activeLabel, setActiveLabel] = useState('')
  const [editedTexts, setEditedTexts] = useState<Record<string, string>>({})
  const [elapsed, setElapsed] = useState(0)
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!source?.imageId) return
    const controller = new AbortController()
    let cancelled = false
    setPhase('loading')
    setResult(null)
    setErrorMsg('')
    setEditedTexts({})
    setElapsed(0)
    setActiveLabel('')
    const timer = window.setInterval(() => setElapsed((e) => e + 1), 1000)

    void (async () => {
      try {
        const { settings } = useStore.getState()
        const profile = getPromptReverseApiProfile(settings)
        if (!profile) {
          setPhase('noProfile')
          return
        }
        const originalDataUrl = await ensureImageCached(source.imageId)
        if (!originalDataUrl) throw new Error('图片不存在或已被清理')
        if (cancelled) return
        setPreviewDataUrl(originalDataUrl)
        const size = await readImageSize(originalDataUrl)
        if (cancelled) return
        setImageSize(size)
        const target = resolveReverseImageTarget(size.width, size.height)
        const requestImage = target
          ? await resizeImageHighQuality(originalDataUrl, target.width, target.height, 'contain')
          : originalDataUrl
        if (cancelled) return
        const text = await callPromptReverseApi({ settings, profile, imageDataUrl: requestImage, signal: controller.signal })
        if (cancelled) return
        const parsed = parsePromptReverseResult(text)
        if (!parsed) throw new Error('反推返回格式无法解析，请重试')
        setResult(parsed)
        setActiveLabel(parsed.prompts[0]?.label ?? '')
        setPhase('done')
      } catch (err) {
        if (cancelled || controller.signal.aborted) return
        setErrorMsg(err instanceof Error ? err.message : String(err))
        setPhase('error')
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(timer)
    }
  }, [source?.imageId, retryTick])

  if (!source) return null

  const close = () => setPromptReverseSource(null)

  const activeCandidate = result?.prompts.find((p) => p.label === activeLabel) ?? result?.prompts[0] ?? null
  const activeText = activeCandidate ? (editedTexts[activeCandidate.label] ?? activeCandidate.text) : ''

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(`已复制${label}`, 'success')
    } catch {
      showToast('复制失败，请手动选择文本', 'error')
    }
  }

  const handleFillPrompt = () => {
    if (!activeCandidate || !activeText.trim()) return
    const { setPrompt, recordPromptHistory, params } = useStore.getState()
    setPrompt(activeText.trim())
    recordPromptHistory(activeText.trim(), params)
    showToast('已填入提示词并记入历史', 'success')
    close()
  }

  const openSettings = () => {
    useStore.getState().setShowSettings(true)
    close()
  }

  const retry = () => setRetryTick((t) => t + 1)

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 max-sm:items-end max-sm:justify-stretch max-sm:p-0"
      onClick={close}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900 max-sm:max-h-[92vh] max-sm:rounded-b-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5 dark:border-white/[0.06]">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">反推提示词</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 dark:text-gray-500">反推是对画面的推测而非精确复刻，可编辑后再生成</span>
            <button
              type="button"
              onClick={close}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-300"
              aria-label="关闭"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d={CLOSE_ICON_PATH} />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden max-sm:flex-col">
          <div className="flex w-2/5 shrink-0 items-center justify-center bg-gray-50 p-4 dark:bg-white/[0.02] max-sm:h-44 max-sm:w-full">
            {previewDataUrl ? (
              <div className="relative flex h-full items-center justify-center">
                <img src={previewDataUrl} alt="待反推图片" className="max-h-full max-w-full rounded-lg object-contain" />
                {imageSize && (
                  <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white backdrop-blur-sm">
                    {imageSize.width}×{imageSize.height}
                  </span>
                )}
              </div>
            ) : (
              <div className="h-24 w-24 animate-pulse rounded-lg bg-gray-200 dark:bg-white/[0.06]" />
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {phase === 'loading' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
                  <span>正在反推…</span>
                  <span className="tabular-nums">{elapsed}s</span>
                </div>
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-4 animate-pulse rounded bg-gray-100 dark:bg-white/[0.05]" style={{ width: `${90 - i * 12}%` }} />
                ))}
              </div>
            )}

            {phase === 'noProfile' && (
              <div className="space-y-3 py-8 text-center">
                <p className="text-sm text-gray-600 dark:text-gray-300">暂无可用的反推模型配置。</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">请在 设置 → API 配置 中启用 Agent 独立配置并选择 Responses 类型的文本模型，或将当前激活配置切换为 Responses 模式。</p>
                <button
                  type="button"
                  onClick={openSettings}
                  className="rounded-xl bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600 transition"
                >
                  打开设置
                </button>
              </div>
            )}

            {phase === 'error' && (
              <div className="space-y-3 py-8 text-center">
                <p className="text-sm text-red-500">反推失败：{errorMsg}</p>
                <div className="flex justify-center gap-2">
                  <button type="button" onClick={retry} className="rounded-xl bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600 transition">
                    重试
                  </button>
                  <button type="button" onClick={close} className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.04]">
                    关闭
                  </button>
                </div>
              </div>
            )}

            {phase === 'done' && result && (
              <div className="space-y-4">
                {result.breakdown.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-gray-400 dark:text-gray-500">画面解构</div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {result.breakdown.map((item) => (
                        <div key={item.dimension} className="rounded-xl border border-gray-100 bg-gray-50/60 px-3 py-2 dark:border-white/[0.05] dark:bg-white/[0.02]">
                          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{item.dimension}</div>
                          <div className="mt-0.5 text-[13px] leading-relaxed text-gray-700 dark:text-gray-300">{item.text}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    {result.prompts.map((candidate) => (
                      <button
                        key={candidate.label}
                        type="button"
                        onClick={() => setActiveLabel(candidate.label)}
                        className={`rounded-lg px-2.5 py-1 text-xs transition ${
                          candidate.label === activeLabel
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'
                        }`}
                      >
                        {candidate.label}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={activeText}
                    onChange={(e) => activeCandidate && setEditedTexts((prev) => ({ ...prev, [activeCandidate.label]: e.target.value }))}
                    rows={6}
                    className="w-full resize-y rounded-xl border border-gray-200 bg-white/60 px-3 py-2.5 text-sm leading-relaxed text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400 dark:text-gray-500">{activeText.length} 字 · 编辑后以编辑版为准</span>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => handleCopy(activeText, '提示词')} className="rounded-xl border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.04]">
                        复制
                      </button>
                      <button type="button" onClick={handleFillPrompt} className="rounded-xl bg-blue-500 px-3 py-1.5 text-xs text-white hover:bg-blue-600">
                        填入提示词
                      </button>
                    </div>
                  </div>
                </div>

                {result.promptEn && (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <div className="text-xs font-medium text-gray-400 dark:text-gray-500">英文镜像（可直接用于英文生图 API）</div>
                      <button type="button" onClick={() => handleCopy(result.promptEn as string, '英文提示词')} className="text-xs text-blue-500 hover:text-blue-600">
                        复制
                      </button>
                    </div>
                    <p className="max-h-28 overflow-y-auto rounded-xl border border-gray-100 bg-gray-50/60 px-3 py-2 text-[13px] leading-relaxed text-gray-600 dark:border-white/[0.05] dark:bg-white/[0.02] dark:text-gray-400">
                      {result.promptEn}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: App.tsx 三处渲染改动（Task 5 遗留）**

按 Task 5 Step 3 的三处代码（lazy 声明 / store 选择器 / key 追加 / Suspense 渲染）修改 `src/App.tsx`。

- [ ] **Step 3: 类型与构建验证**

Run: `npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: 无类型错误，构建成功。

- [ ] **Step 4: 全量回归 + 提交**

```bash
npm test
git add src/components/PromptReverseModal.tsx src/App.tsx
git commit -m "feat: add PromptReverseModal with structured breakdown, 3 candidates and EN mirror"
```

---

### Task 7: 两个入口（DetailModal 工具条 + 右键菜单）

**Files:**
- Modify: `src/components/DetailModal.tsx`（tooltip 声明区约 :81；`handleStickerSplit` 后约 :543；工具条贴纸按钮块后约 :645）
- Modify: `src/components/ImageContextMenu.tsx`（`handleStickerSplit` 后；菜单项 `拆分贴纸` 块后约 :277；`menuItemCount` 约 :222）

**Interfaces:**
- Consumes: `setPromptReverseSource`（Task 5）、`useTooltip`（`src/hooks/useTooltip`，DetailModal 已引入）。
- Produces: 无（终态入口）。

- [ ] **Step 1: DetailModal 工具条按钮**

`src/components/DetailModal.tsx`：

(a) tooltip 声明区（`const stickerSplitTooltip = useTooltip()` 后）：

```tsx
  const promptReverseTooltip = useTooltip()
```

(b) store 解构处（已有 `setStickerSplitSource` 的同一解构）补：

```tsx
    setPromptReverseSource: useStore… 
```

注意：DetailModal 从 `useStore` 解构取值——找到现有 `setStickerSplitSource,` 解构行，紧跟其后加一行：

```tsx
  setPromptReverseSource,
```

(c) `handleStickerSplit` 函数后：

```tsx
  const handlePromptReverse = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!currentOutputImageId) return
    setPromptReverseSource({ imageId: currentOutputImageId })
    setDetailTaskId(null)
  }
```

(d) 工具条 `{currentOutputImageId && splitEligible && (…拆分贴纸…)}` 块后追加（反推不设门控，只要 `currentOutputImageId` 存在）：

```tsx
              {currentOutputImageId && (
                <div className="relative group flex">
                  <button
                    type="button"
                    {...promptReverseTooltip.handlers}
                    onClick={(e) => {
                      promptReverseTooltip.handlers.onClick()
                      handlePromptReverse(e)
                    }}
                    className="flex items-center justify-center px-1.5 py-0.5 bg-black/50 text-white rounded backdrop-blur-sm hover:bg-black/70 transition focus:outline-none focus:ring-1 focus:ring-white/50"
                    aria-label="反推提示词"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="7" />
                      <path d="m21 21-4.35-4.35" />
                      <path d="M11 8v6M8 11h6" />
                    </svg>
                  </button>
                  <ViewportTooltip visible={promptReverseTooltip.visible} className="whitespace-nowrap">
                    反推提示词
                  </ViewportTooltip>
                </div>
              )}
```

- [ ] **Step 2: ImageContextMenu 菜单项**

`src/components/ImageContextMenu.tsx`：

(a) `handleStickerSplit` 后：

```tsx
  const handlePromptReverse = (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuInfo(null)
    setPromptReverseSource({ imageId: menuInfo.imageId })
  }
```

(b) store 解构处补 `setPromptReverseSource,`（与现有 `setStickerSplitSource,` 同一解构）。

(c) `menuItemCount` 公式追加一项（反推对任何带 `imageId` 的图可用，菜单本身只在此情形打开，故无条件 +1）：

```tsx
  const menuItemCount = (menuInfo.canCopyImage ? 1 : 0) + 1 + (showDownloadAll ? 1 : 0) + (menuInfo.canStickerSplit ? 1 : 0) + 1 + 1
```

(d) 「拆分贴纸」菜单项块后追加：

```tsx
      <button
        onClick={handlePromptReverse}
        className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
      >
        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.35-4.35" />
          <path d="M11 8v6M8 11h6" />
        </svg>
        反推提示词
      </button>
```

- [ ] **Step 3: 验证 + 提交**

Run: `npx tsc -p tsconfig.app.json --noEmit && npm test && npm run build`
Expected: 全部通过。

```bash
git add src/components/DetailModal.tsx src/components/ImageContextMenu.tsx
git commit -m "feat: add prompt reverse entries in detail modal toolbar and context menu"
```

---

### Task 8: 验收门（全量 + 浏览器双宽度手检）

**Files:**
- 无新增（验证任务）。

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 验收结论（写入提交信息或交付说明）。

- [ ] **Step 1: 全量门**

```bash
npm test
npm run build
npm run lint
```

Expected: 测试全过；构建成功；lint 零错误（既有 unused 警告可保留，新增代码零警告）。

- [ ] **Step 2: 本地起服务**

```bash
npm run dev
```

- [ ] **Step 3: 桌面宽度手检（≥1024px）**

1. 设置中配置一个 Responses 类型 profile（或激活它），画廊中任一生成图 → 右键 → 「反推提示词」→ 模态打开、图片预览 + 尺寸徽章正确。
2. 等待反推（骨架屏 + 计时跳动）→ 出现：画面解构卡片、三候选分段、可编辑文本框、（若有）英文镜像区。
3. 切换三候选、编辑文本 → 「复制」toast；「填入提示词」→ 输入框被填入、模态关闭、提示词历史顶部出现该条。
4. 任务详情（点图进 DetailModal）→ 工具条出现放大镜按钮 → 点击 → 同一模态。
5. 断网或填错 key 的 profile → 错误态 + 「重试」可用。
6. Agent 文本配置未配且激活 profile 是 images 类型 → 出现引导态 + 「打开设置」直达。

- [ ] **Step 4: 移动宽度手检（≤640px）**

DevTools 切 375px 宽：模态变底部抽屉样式（`max-sm:items-end`）、图片区在上（h-44）、内容区可滚动、按钮可点、无横向溢出。

- [ ] **Step 5: 真实链路 smoke（本机 chatgpt2api :3001 可用时）**

工作台 dev 里配 chatgpt2api profile（baseUrl `http://127.0.0.1:3001/v1`，模型 `gpt-5-6`，apiMode responses）反推一张真实生成图，确认 JSON 一次解析成功（对应 .omx/reverse-lab 实测的「直接 parse」级别）。

- [ ] **Step 6: 交付说明**

汇总：改动文件清单、测试结果、手检结论、（若做了）真实链路 smoke 结果；明确未做项（v1.1/v2 见设计文档 §6）。

---

## 自审记录（写计划时已完成）

1. **Spec 覆盖**：§5.1 数据流（Task 4/6）、§5.2 文件表（Tasks 1–7 逐一对应，含 agentApi 导出补丁）、§5.3（Task 3）、§5.4 模板原文（Task 4 逐字）、§5.5 契约与四级链（Task 1）、§5.6 调用形态（Task 4）、§5.7 UI（Task 6 含期望管理文案/尺寸徽章/候选编辑/promptEn）、§5.8 错误处理（Task 6 noProfile/error/兜底 + Task 2 预缩放）、§5.9 QC（Global Constraints + Task 4 Step 6）、§5.10 测试门（Task 8）。§6 明确不做项未引入。§7 三个默认值已按「记入历史/覆盖/1536」落进 Task 6 `handleFillPrompt` 与 Task 2。
2. **占位符扫描**：无 TBD/TODO；所有代码块完整；Task 5 Step 4 发现的执行顺序问题已就地写明解法（App.tsx 渲染挪 Task 6 Step 2）。
3. **类型一致性**：`PromptReverseResult`/`PromptReverseCandidate`（Task 1 定义 = Task 6 消费）；`parsePromptReverseResult`/`resolveReverseImageTarget`/`callPromptReverseApi`/`PROMPT_REVERSE_INSTRUCTIONS`（Task 1/2/4 定义 = Task 6 消费）；`getPromptReverseApiProfile`（Task 3 = Task 6）；`PromptReverseSource`/`promptReverseSource`/`setPromptReverseSource`（Task 5 = Task 6/7 消费）；store 签名与既有 `recordPromptHistory(prompt, params)`、`setPrompt(p)`、`showToast(message, type?)`、`setShowSettings(true)` 一致。
