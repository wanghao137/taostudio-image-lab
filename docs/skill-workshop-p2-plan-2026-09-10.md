# Skill 工坊 P2 实施计划（Skill Workshop）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上线第 4 个场景「Skill 工坊」：SKILL.md 开放标准的 skill 列表（内置 + 本地目录导入）→ 锚点输入 → 文本模型单轮扩写 → 可编辑提示词条目 → 逐条生成落盘，全链走已上线的场景配置（生图 profile / 文本 profile / 保存目录）。

**Architecture:** 单轮扩写泛化自反推提示词的调用链（`promptReverse.ts` 的 POST /responses 模式），无对话状态；skill 内容 = SKILL.md frontmatter(name/description) + 正文（instructions）；多条提示词按分节/编号/段落解析为条目，每条独立提交走既有 `submitTask` 链（自动获得 sceneId 快照、场景 profile 解析、落盘链）；本地导入复用目录句柄模式（IndexedDB `localAutoSave` store 新 key `skillsDirectory`）。

**Tech Stack:** React 19 + TS + Zustand(persist) + Vitest + Tailwind（自研组件）。

**设计文档：** `docs/scene-and-skill-upgrade-plan-2026-09-10.md` §6.4（已批准，含「不做清单」红线：不做 skill 商店、不做自动触发、不做多轮编排、不执行 skill 内脚本）。

## Global Constraints

- 单轮扩写，无对话状态；skill 正文原样作为 instructions 主体，不重写社区 skill 内容。
- 不硬编码任何 API host/网关；UI 文案中文。
- 文本模型解析走 `getSceneTextApiProfileResolution`（场景覆盖 > 全局链，P1 已上线）；无可用 profile 时引导文案（模式同反推）。
- 生成走既有 `submitTask` 链（`getSceneImageApiProfile` 场景解析 + sceneId 快照 + 落盘链），不另起生图路径。
- 给被 mock 模块（src/lib/db.ts）加导出必须同步测试工厂。
- zustand useStore 选择器只返回稳定引用（原始值或既有 store 引用），派生用 useMemo——P1 的 TaskGrid 崩溃教训。
- lint 零错误；commit 中文 conventional；**commit 不 push**（推送由控制器统一执行）。
- 单测命令：`npx vitest run <文件>`；全量 `npm test`。

---

### Task 1: skill 解析与扩写条目解析（纯函数层）

**Files:**
- Create: `src/lib/skillWorkshop/skillMarkdown.ts`
- Create: `src/lib/skillWorkshop/expansion.ts`
- Test: `src/lib/skillWorkshop/skillMarkdown.test.ts`、`src/lib/skillWorkshop/expansion.test.ts`

**Interfaces（后续任务依赖）:**
- Produces: `parseSkillMarkdown(text: string, fallbackName: string): { name: string; description: string; body: string } | null`（无正文返回 null；无 frontmatter 时 name=fallbackName、description=''、body=全文）
- Produces: `parseExpansionEntries(raw: string): Array<{ id: string; text: string }>`（id 形如 `entry-1`，至少 1 条）
- Produces: `buildExpansionInstructions(skillBody: string): string`

- [ ] **Step 1: 写失败测试**

`skillMarkdown.test.ts`：
```ts
describe('parseSkillMarkdown', () => {
  it('标准 frontmatter：取 name/description，body 为 --- 之后全文', () => {
    const md = '---\nname: vibeshot-candid-photography\ndescription: 生成生活感人像提示词。\n---\n\n# 标题\n\n正文内容'
    const r = parseSkillMarkdown(md, 'fallback')!
    expect(r.name).toBe('vibeshot-candid-photography')
    expect(r.description).toBe('生成生活感人像提示词。')
    expect(r.body).toContain('# 标题')
    expect(r.body).toContain('正文内容')
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
```

`expansion.test.ts`：
```ts
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
```

- [ ] **Step 2: 跑测试确认失败**。Run: `npx vitest run src/lib/skillWorkshop/`。Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/lib/skillWorkshop/skillMarkdown.ts`：
```ts
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
```

`src/lib/skillWorkshop/expansion.ts`：
```ts
const MIN_ENTRY_LENGTH = 6

function stripCodeFence(text: string): string {
  const t = text.trim()
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  return (m ? m[1] : t).trim()
}

/** 扩写输出 → 提示词条目。优先 markdown 分节，其次编号行，再次空行分段，兜底整段单条。 */
export function parseExpansionEntries(raw: string): Array<{ id: string; text: string }> {
  const text = stripCodeFence(raw.replace(/\r\n/g, '\n').trim())
  const push = (parts: string[]) =>
    parts.map((p) => p.trim()).filter((p) => p.length >= MIN_ENTRY_LENGTH)
  let parts: string[] = []
  const byHeading = text.split(/^#{2,4}\s*[^\n]*$/m)
  if (byHeading.length >= 2 && push(byHeading).length >= 2) parts = push(byHeading)
  if (parts.length < 2) {
    const byNumber = text.split(/^\s*\d{1,2}[.、)]\s*/m)
    if (byNumber.length >= 2 && push(byNumber).length >= 2) parts = push(byNumber)
  }
  if (parts.length < 2) {
    const byBlank = text.split(/\n{2,}/)
    if (byBlank.length >= 2 && push(byBlank).length >= 2) parts = push(byBlank)
  }
  if (parts.length < 1) parts = [text]
  return parts.map((p, i) => ({ id: `entry-${i + 1}`, text: p }))
}

/** skill 正文 + 通用输出约束。skill 自带的输出规则优先，本约束只兜底「别输出解释」。 */
export function buildExpansionInstructions(skillBody: string): string {
  const suffix = '通用约束：直接输出最终可用的提示词文本，不要输出解释、分析、变量说明或与提示词无关的内容。若产出多条提示词，用「### 01」「### 02」…分节编号。'
  return `${skillBody.trim()}\n\n---\n\n${suffix}`
}
```

- [ ] **Step 4: 跑测试确认通过**。Run: `npx vitest run src/lib/skillWorkshop/`。Expected: PASS。
- [ ] **Step 5: 提交**：`git commit -m "feat(skill-workshop): SKILL.md 解析与扩写条目解析（纯函数层）"`

---

### Task 2: skillsDirectory 目录句柄（db 层）

**Files:**
- Modify: `src/lib/db.ts`（Scene save directories 区之后，~460 行附近）
- Modify: 各测试工厂中 `src/lib/db.ts` 的 mock（grep `vi.mock` 定位，P1 已同步过 3 处）

**Interfaces:**
- Produces: `getSkillsRootDirectoryHandle()`、`putSkillsRootDirectoryHandle(handle)`、`clearSkillsRootDirectoryHandle()`（StoredLocalAutoSaveDirectoryHandle 同构；key 常量 `SKILLS_ROOT_DIRECTORY_KEY = 'skillsDirectory'`）

- [ ] **Step 1: 实现**（逐字镜像 SCENE_DIRECTORY 三件套模式，单 key 无前缀）：
```ts
// ===== Skill workshop root directory =====
// 本地 skills 根目录句柄（扫描一级子目录的 SKILL.md），独立授权。

export const SKILLS_ROOT_DIRECTORY_KEY = 'skillsDirectory'

export function getSkillsRootDirectoryHandle(): Promise<StoredLocalAutoSaveDirectoryHandle | undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readonly', (s) => s.get(SKILLS_ROOT_DIRECTORY_KEY))
}

export function putSkillsRootDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<IDBValidKey> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.put({
    id: SKILLS_ROOT_DIRECTORY_KEY,
    handle,
    name: handle.name,
    updatedAt: Date.now(),
  } satisfies StoredLocalAutoSaveDirectoryHandle))
}

export function clearSkillsRootDirectoryHandle(): Promise<undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.delete(SKILLS_ROOT_DIRECTORY_KEY))
}
```
- [ ] **Step 2: 同步全部 db mock**（三函数桩：get → undefined，put/clear → undefined）。
- [ ] **Step 3: `npm test` 全绿；lint。**
- [ ] **Step 4: 提交**：`git commit -m "feat(skill-workshop): IndexedDB skills 根目录句柄读写"`

---

### Task 3: skill 扩写 API（callSkillExpansionApi）

**Files:**
- Create: `src/lib/skillWorkshop/skillExpansionApi.ts`
- Test: `src/lib/skillWorkshop/skillExpansionApi.test.ts`

**Interfaces:**
- Consumes: `imageApiShared` 的 `createHeaders/extractText/normalizeResponsePayload`（P1b 已下沉）；`promptReverse.ts` 的调用骨架（本任务镜像，不改动它）。
- Produces: `callSkillExpansionApi(opts: { settings: AppSettings; profile: ApiProfile; skillBody: string; userInput: string; signal?: AbortSignal }): Promise<string>`（返回原始输出文本，条目解析由调用方做）

- [ ] **Step 1: 写失败测试**（跟随 `src/lib/promptReverse.test.ts` 的 fetch mock 模式；用例：成功返回文本 / 非 2xx 抛错带状态 / 超时抛中文提示 / 外部 abort 传递）：
```ts
describe('callSkillExpansionApi', () => {
  it('POST /responses，instructions=skill 正文+约束，input 只有 input_text', async () => {
    // mock fetch 捕获 (url, init)，返回 Responses 形状 { output_text } 或 output 数组（两种都测）
    // 断言 body.instructions 含 skillBody 关键句与「不要输出解释」；body.input[0].content[0].type === 'input_text' 且 text === userInput
  })
  it('HTTP 错误抛出 getApiErrorMessage 文案')
  it('超时抛「Skill 扩写请求超时（N 秒）…」')
  it('reasoningEffort 存在时带 body.reasoning')
})
```
（骨架断言按 promptReverse.test.ts 现有用例改写，测试代码以真实 mock 模式落地。）
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（镜像 `callPromptReverseApi`（promptReverse.ts:153-209）：`readClientDevProxyConfig/shouldUseApiProxy/buildApiUrl/getApiErrorMessage` 同款 import；差异点：content 只有一条 `input_text`（文本=用户锚点输入）、instructions=buildExpansionInstructions(skillBody)、错误文案「Skill 扩写」）→ **Step 4: 通过** → **Step 5: 提交**：`git commit -m "feat(skill-workshop): 文本模型单轮扩写 API（镜像反推调用链）"`

---

### Task 4: store 状态、内置 skill 加载与生成链

**Files:**
- Modify: `src/store.ts`（状态接口区、实现区、submitTask ~1603/TaskRecord 构造 ~1700）
- Modify: `src/types.ts`（TaskRecord 增量）
- Create: `src/lib/skillWorkshop/builtinSkills.ts`
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: Task 1-3 全部产物；`getSceneTextApiProfileResolution`（P1）；db 句柄函数（Task 2）。
- Produces（store）：`skills: SkillWorkshopState`、`activeSkillId: string | null`、`skillExpansion: SkillExpansionState`、actions：`loadBuiltinSkills` / `importSkillsRootDirectory` / `refreshLocalSkills` / `clearSkillsRootDirectory` / `setActiveSkill` / `setSkillInputDraft` / `runSkillExpansion` / `updateSkillEntry(id, patch)` / `removeSkillEntry(id)` / `generateFromSkillEntries`。
- Produces（TaskRecord）：`skillId?: string`、`skillInput?: string`；`submitTask` options 增 `skillMeta?: { skillId: string; skillInput: string }`。

类型（types.ts 或 store 内定义，保持与文件既有风格一致）：
```ts
export interface SkillSummary {
  /** 展示名（frontmatter name，无则目录名） */
  name: string
  description: string
  /** 来源目录名（内置=public/skills 目录名，本地=一级子目录名），作稳定 id */
  id: string
  source: 'builtin' | 'local'
  body: string
}
```

`builtinSkills.ts`：
```ts
import { parseSkillMarkdown, type ParsedSkillMarkdown } from './skillMarkdown'

export const BUILTIN_SKILL_IDS = ['vibeshot-candid-photography', 'voyeur-style-photographer'] as const

export async function loadBuiltinSkill(id: string): Promise<ParsedSkillMarkdown | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}skills/${id}/SKILL.md`, { cache: 'no-store' })
    if (!res.ok) return null
    return parseSkillMarkdown(await res.text(), id)
  } catch {
    return null
  }
}
```

store 关键实现要点（实现者按文件既有风格落地）：
- `loadBuiltinSkills`：并行 loadBuiltinSkill 全部 id，失败项静默跳过；结果存 `skills.builtin`。
- `importSkillsRootDirectory`：`showDirectoryPicker({ mode: 'readwrite' })`（不支持时 toast 同 selectLocalAutoSaveDirectory 文案）→ put 句柄 → 扫描（见下）→ set `skills.local` + `skills.localRootName`。
- 扫描函数（store 内或 skillWorkshop lib，可测优先放 lib）：遍历根目录一级条目，对目录 `dir.getFileEntry('SKILL.md')` 形式读取（`for await (const [name, entry] of root.entries())`，`entry.kind === 'directory'` 时 `entry.getFileHandle('SKILL.md')` → `getFile()` → `.text()` → parseSkillMarkdown(text, name)），无 SKILL.md 的子目录跳过；权限拒绝返回错误信息（工坊 UI 提示重新授权/重选）。
- `runSkillExpansion`：`getSceneTextApiProfileResolution(settings)` → profile 为 null 时 set error（文案含「未找到可用的文本模型配置（需 Responses 类型），可在设置→API 中添加」）→ 否则调 `callSkillExpansionApi`（skillBody=当前 activeSkill.body，userInput=skillInputDraft）→ `parseExpansionEntries` → 全 enabled → set entries（status 回 idle）。running 态可 abort（AbortController 存模块级，镜像反推若有同等机制则复用其模式，无则最简实现）。
- `generateFromSkillEntries`：校验 enabled 条目 ≥1 与生图 profile 有效（复用 validateApiProfile + getSceneImageApiProfile）；循环：`useStore.getState().setPrompt(entry.text)` → `await submitTask({ skillMeta: { skillId: activeSkillId, skillInput: skillInputDraft } })`；完成后 toast「已提交 N 个生成任务」。
- `submitTask` 增量：options 加 `skillMeta`，TaskRecord 构造处（P1 已打 `sceneId: settings.activeScene` 的同一构造块）追加：
```ts
    ...(options.skillMeta ? { skillId: options.skillMeta.skillId, skillInput: options.skillMeta.skillInput } : {}),
```
- types.ts TaskRecord 在 `sceneId?: SceneId` 后加 `skillId?: string` 与 `skillInput?: string`（注释：Skill 工坊溯源）。

- [ ] **Step 1: 失败测试**（store.test.ts 新 describe，沿用既有 mock 模式）：loadBuiltinSkills（mock fetch 两个 SKILL.md）；runSkillExpansion 无文本 profile → error 文案；有 profile → mock callSkillExpansionApi 返回多节文本 → entries 解析正确；generateFromSkillEntries 循环提交 N 个任务且每个 task.skillId/skillInput/sceneId==='skill'（mock submitTask 依赖的真实链路或 spy submitTask——按本文件既有 submitTask 用例模式选择）。
- [ ] **Step 2: 失败** → **Step 3: 实现** → **Step 4: `npx vitest run src/store.test.ts` + `npm test` 全绿** → **Step 5: 提交**：`git commit -m "feat(skill-workshop): store 状态机、内置 skill 加载与逐条目生成链"`

---

### Task 5: SkillWorkshop 组件、场景 Tab 与 App 分发

**Files:**
- Create: `src/components/SkillWorkshop.tsx`（+ 可选拆分 `src/components/skill/` 子组件）
- Modify: `src/App.tsx`（双端分发 ~284-343、InputBar 条件 ~340、MobileShell onOpenCompose ~285）
- Modify: `src/components/Header.tsx`（SCENE_TABS + skill 项，删 P2 占位注释；App.tsx:48-52 与 SceneSettingsDrawer.tsx:27-31 的 SKILL_SCENE_LABEL 占位注释一并清理——SCENE_TABS 命中后 fallback 仅防御）
- Modify: `src/components/MobileShell.tsx`（skill 场景隐藏 compose FAB：由 App 传 `composeDisabled` prop 或等价最小方案）
- Test: `src/components/__tests__/SkillWorkshop.test.tsx`

**布局（设计 §6.4/§6.5，桌面与移动自适应单列/双列）**：
```
┌────────────────────────────────────────────────────┐
│ Skill 工坊                       [场景设置⚙]        │
├──────────────┬─────────────────────────────────────┤
│ 内置 (2)      │  {activeSkill.name}                 │
│  · skill A    │  {activeSkill.description}          │
│  · skill B    │  锚点输入：[textarea]（角色名/主题） │
│ 本地 (n)      │  [✨ 扩写提示词]（running/错误态）    │
│  · skill C    │  扩写结果（可编辑，checkbox 逐条）：  │
│ [导入目录]     │   [✓][textarea…][删] × N            │
│ [重新扫描]     │  [生成 N 张图片]（enabled 数）       │
│              │  最近生成：[缩略条 sceneId='skill' 最新12，点击开详情] │
└──────────────┴─────────────────────────────────────┘
```
- 左列 skill 项：name + description 单行截断；active 高亮（陶土橙系）。空态：内置加载失败 →「内置 skill 加载失败，点击重试」；无本地 → 引导导入。
- 无文本 profile：扩写按钮位置显示引导文案 + 「打开设置」按钮（`setShowSettings(true)`，模式同反推 noProfile）。
- 「生成 N 张」：disabled 当 enabled=0；点击调 `generateFromSkillEntries`；生成中不阻塞工坊（任务后台跑）。
- 最近生成条：`useStore((s) => s.tasks)` 稳定订阅 + `useMemo` 过滤 `t.sceneId === 'skill'` 取前 12（**禁止在 useStore 选择器里过滤——P1 崩溃教训**）；缩略用任务首图（`task.outputImages[0]` 经既有图片取用 hook/组件模式，跟随 TaskCard 的图片加载方式最小实现）；点击 `setDetailTaskId(task.id)`。
- App 分发：`appMode === 'gallery' && activeScene === 'skill'` 时双端主区渲染 `<SkillWorkshop onOpenSceneSettings={...} />`（lazy + Suspense + ErrorBoundary sectionLabel="Skill 工坊"），替代画廊块（GalleryWorkspaceHeader/SearchBar/TaskGrid 不渲染）；`{appMode !== 'engine' && <InputBar />}` 改为 `{appMode === 'gallery' && activeScene !== 'skill' && <InputBar />}`；移动端 compose FAB 在 skill 场景隐藏（App 传 prop 控制）。
- Header SCENE_TABS：
```ts
const SCENE_TABS: Array<{ id: SceneId; label: string }> = [
  { id: 'portrait', label: '人像写真' },
  { id: 'general', label: '通用创作' },
  { id: 'sticker', label: '表情与头像' },
  { id: 'skill', label: 'Skill 工坊' },
]
```
- 组件测试（jsdom + testing-library 基建，跟随 SceneSettingsDrawer.test.tsx 模式）：渲染工坊（mock store state：两个内置 skill + expansion entries）→ 断言列表/条目/按钮；一个交互（勾掉一条 entry → 生成按钮计数变化）。

- [ ] **Step 1: 组件测试先行**（渲染断言 RED）→ **Step 2: 实现组件与分发** → **Step 3: `npm test` 全绿 + `npm run build` + `npm run lint`** → **Step 4: 提交**：`git commit -m "feat(skill-workshop): 工坊视图、第 4 场景 Tab 与 App 双端分发"`

---

### Task 6: verify:scenes 浏览器门更新

**Files:**
- Modify: `scripts/verify-scenes.mjs`

- [ ] **Step 1:** 桌面 Tab 检查清单加入 `'Skill 工坊'`（`for (const label of [...])`）；移动端 body 检查同步加。
- [ ] **Step 2:** 新增工坊检查点（desktop 段，gear 检查前）：点 Skill 工坊 Tab → 等待 lazy 视图 → body 含「Skill 工坊」标题与「扩写提示词」按钮与内置 skill 名（`vibeshot-candid-photography`）；工坊内场景设置齿轮存在（aria-label 场景设置）且打开抽屉四分区含「文本模型」。
- [ ] **Step 3:** 本地 `npm run dev`（端口 5175）起服后 `npm run verify:scenes -- http://127.0.0.1:5175/` 全绿；`npm run verify:ui` 不回归。
- [ ] **Step 4: 提交**：`git commit -m "test(skill-workshop): verify:scenes 增加 Skill 工坊检查点"`

---

### Task 7: P2 回归门

- [ ] `npm test` 全绿；`npm run build`；`npm run lint` 零错误
- [ ] `npm run verify:ui -- http://127.0.0.1:5175/` 与 `npm run verify:scenes -- http://127.0.0.1:5175/` 全绿
- [ ] 手工冒烟（dev + 浏览器）：工坊选内置 skill → 输入锚点 → 配好文本 profile 真实扩写一次 → 条目生成 → 任务出现在「最近生成」与画廊 skill 过滤视图 → 落盘到 skill 场景目录（若已配）
- [ ] 收尾提交（如有）：`git commit -m "feat(skill-workshop): P2 Skill 工坊完成"`

---

## 后续（不在本计划内）

对抗式终审（A 攻击面 + B 回归验收双路）→ 修复循环 → 合入 main → push 触发部署 → 生产 verify。P1 台账的跟进清单（F3/F4/F5/F7/F8 等）继续顺延，不在 P2 范围。
