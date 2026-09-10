# 场景框架 P1a 实施计划（Scene Framework）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「场景」提升为一等配置单元：每场景独立记忆生图 profile 引用、本地保存目录句柄、文本模型引用与默认参数；顶层导航改为场景 Tab；画廊按场景过滤。

**Architecture:** 全部走「引用不复制」——`AppSettings.scenes` 只存 profileId，解析时场景显式引用优先、否则回落既有全局链（`getActiveApiProfile` / `getTextApiProfileResolution`，语义不变）；目录句柄复用 IndexedDB `localAutoSave` store 的既有模式，新增 `sceneDirectory:<sceneId>` key；落盘链改为 场景目录 → 全局目录 → 不落盘。P1a 不动 Agent（那是 P1b），Skill 工坊视图随 P2 上线（P1a 导航只上 3 个场景 Tab + 引擎）。

**Tech Stack:** React 19 + TS + Zustand(persist) + Vitest + Tailwind（自研组件，无 UI 库）。

**设计文档：** `docs/scene-and-skill-upgrade-plan-2026-09-10.md`（§6.1 数据模型、§6.3 解析链/保存链、§6.5 UI）

## Global Constraints

- UI 文案一律中文（AGENTS.md）。
- 不得在产品逻辑硬编码任何 API host/网关/临时 URL（AGENTS.md provider 中立红线）。
- 不配置任何场景时，行为必须与现状完全一致（general = 旧画廊）。
- 归一化只校验不固化：非法引用回 null/'general'，不迁移用户数据，不写死推导值（沿用 textApiProfileId 模式，apiProfiles.ts:814-818）。
- 给被 mock 的模块（如 `src/lib/db.ts`）加导出时，必须同步测试工厂（历史坑：native-transparent 修复时踩过）。
- lint 基线零错误；提交信息用中文 conventional commits。
- **commit/push 仅在用户明确同意后执行**（AGENTS.md：不主动 commit）。
- 单测命令：`npx vitest run <文件路径>`；全量：`npm test`。

---

### Task 1: 场景类型、归一化与解析函数

**Files:**
- Modify: `src/types.ts`（AppSettings 区，~126-161；TaskRecord 区，~377）
- Modify: `src/lib/apiProfiles.ts`（normalizeSettings 771-853；文件尾部公共函数区）
- Test: `src/lib/apiProfiles.test.ts`

**Interfaces（后续任务依赖）:**
- Produces: `SceneId`、`SceneSettings`、`AppSettings.scenes: Record<SceneId, SceneSettings>`、`AppSettings.activeScene: SceneId`、`TaskRecord.sceneId?: SceneId`、`SceneSettings.saveDirectoryName?: string | null`
- Produces: `getSceneImageApiProfile(settings): ApiProfile`、`getSceneTextApiProfileResolution(settings): TextApiResolution`

- [ ] **Step 1: 写失败测试**（追加到 `src/lib/apiProfiles.test.ts`，沿用该文件既有 import）

```ts
describe('场景配置归一化与解析', () => {
  it('旧 settings 无 scenes 时补全四个场景默认值，activeScene 默认 general', () => {
    const s = normalizeSettings({ profiles: [createDefaultOpenAIProfile()] })
    expect(Object.keys(s.scenes).sort()).toEqual(['general', 'portrait', 'skill', 'sticker'])
    expect(s.scenes.general).toEqual({ imageProfileId: null, textProfileId: null, saveDirectoryName: null, defaults: {} })
    expect(s.activeScene).toBe('general')
  })

  it('非法 profile 引用回退 null，合法引用保留（文本引用须为 Responses 型）', () => {
    const text = { ...createDefaultOpenAIProfile(), id: 'text-1', apiMode: 'responses' as const }
    const s = normalizeSettings({
      profiles: [createDefaultOpenAIProfile(), text],
      scenes: { portrait: { imageProfileId: 'missing-id', textProfileId: text.id, saveDirectoryName: 'F:\\人像' } },
    })
    expect(s.scenes.portrait.imageProfileId).toBeNull()
    expect(s.scenes.portrait.textProfileId).toBe('text-1')
    expect(s.scenes.portrait.saveDirectoryName).toBe('F:\\人像')
  })

  it('activeScene 非法值回退 general', () => {
    expect(normalizeSettings({ activeScene: 'nope' }).activeScene).toBe('general')
  })

  it('getSceneImageApiProfile：场景显式引用优先，且不套用顶层镜像字段', () => {
    const a = { ...createDefaultOpenAIProfile(), id: 'a', name: 'A', model: 'model-a' }
    const b = { ...createDefaultOpenAIProfile(), id: 'b', name: 'B', model: 'model-b' }
    const s = normalizeSettings({
      profiles: [a, b], activeProfileId: 'a', activeScene: 'sticker',
      scenes: { sticker: { imageProfileId: 'b' } },
    })
    expect(getSceneImageApiProfile(s).id).toBe('b')
    expect(getSceneImageApiProfile(s).model).toBe('model-b')
  })

  it('getSceneImageApiProfile：无场景引用时回落全局激活 profile', () => {
    const s = normalizeSettings({})
    expect(getSceneImageApiProfile(s).id).toBe(s.activeProfileId)
  })

  it('getSceneTextApiProfileResolution：场景文本引用优先，无引用走全局链', () => {
    const text = { ...createDefaultOpenAIProfile(), id: 'text-1', apiMode: 'responses' as const }
    const s = normalizeSettings({
      profiles: [createDefaultOpenAIProfile(), text],
      scenes: { skill: { textProfileId: 'text-1' } },
    })
    expect(getSceneTextApiProfileResolution(s).profile?.id).toBe('text-1')
    expect(getSceneTextApiProfileResolution({ ...s, activeScene: 'general' }).resolvedBy).not.toBe('explicit')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/apiProfiles.test.ts`
Expected: FAIL（`s.scenes` 为 undefined / 函数未导出）

- [ ] **Step 3: 实现**

`src/types.ts`（AppSettings 定义之前插入；`AppSettings` 内 `textApiProfileId` 之后加两行；TaskRecord 的 `sourceMode` 行后加一行）：

```ts
export type SceneId = 'portrait' | 'general' | 'sticker' | 'skill'
export const SCENE_ID_VALUES = ['portrait', 'general', 'sticker', 'skill'] as const

export interface SceneDefaults {
  /** COMMON_IMAGE_RATIOS 的比例 key（如 '3:4'、'1:1'）；缺省不覆盖 */
  ratio?: string
  /** 与 src/lib/size.ts 的 SizeTier 对齐 */
  tier?: '1K' | '2K' | '4K'
  transparentBackground?: boolean
}

export interface SceneSettings {
  /** 场景生图配置引用：null = 跟随全局 activeProfileId */
  imageProfileId: string | null
  /** 场景文本模型引用：null = 走全局 textApiProfileId 自动链 */
  textProfileId: string | null
  /** 场景独立保存目录名（句柄存 IndexedDB sceneDirectory:<id>）；null = 跟随全局目录 */
  saveDirectoryName?: string | null
  defaults: SceneDefaults
}
```

AppSettings 增量（`activeProfileId: string` 之后）：

```ts
  scenes: Record<SceneId, SceneSettings>
  activeScene: SceneId
```

TaskRecord 增量（`sourceMode?: AppMode` 注释行后）：

```ts
  /** 提交时所属场景；旧任务无此字段视为 general */
  sceneId?: SceneId
```

`src/lib/apiProfiles.ts`：

1. import 区补 `SceneDefaults, SceneId, SceneSettings, SCENE_ID_VALUES`（从 `../types`，与现有 import 合并）。
2. `normalizeSettings`（771）内，`textApiProfileId` 推导块（816-818）之后插入：

```ts
  // 场景配置：只校验显式引用有效性（生图任意 profile / 文本须 Responses 型），
  // 缺失或非法一律回默认；不固化推导值，不迁移用户数据。
  const sceneProfileIds = new Set(profiles.map((p) => p.id))
  const textCapableIds = new Set(profiles.filter(isAgentTextApiProfile).map((p) => p.id))
  const normalizeSceneSettings = (raw: unknown): SceneSettings => {
    const rec = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const defaults = rec.defaults && typeof rec.defaults === 'object' ? rec.defaults as Record<string, unknown> : {}
    return {
      imageProfileId: typeof rec.imageProfileId === 'string' && sceneProfileIds.has(rec.imageProfileId) ? rec.imageProfileId : null,
      textProfileId: typeof rec.textProfileId === 'string' && textCapableIds.has(rec.textProfileId) ? rec.textProfileId : null,
      saveDirectoryName: typeof rec.saveDirectoryName === 'string' && rec.saveDirectoryName ? rec.saveDirectoryName : null,
      defaults: {
        ratio: typeof defaults.ratio === 'string' ? defaults.ratio : undefined,
        tier: defaults.tier === '1K' || defaults.tier === '2K' || defaults.tier === '4K' ? defaults.tier : undefined,
        transparentBackground: defaults.transparentBackground === true ? true : undefined,
      },
    }
  }
  const rawScenes = record.scenes && typeof record.scenes === 'object' ? record.scenes as Record<string, unknown> : {}
  const scenes = Object.fromEntries(
    SCENE_ID_VALUES.map((id) => [id, normalizeSceneSettings(rawScenes[id])]),
  ) as Record<SceneId, SceneSettings>
  const activeScene = (SCENE_ID_VALUES as readonly string[]).includes(record.activeScene as string)
    ? record.activeScene as SceneId
    : 'general'
```

3. `normalizeSettings` 的 return 对象（820-852）在 `activeProfileId,` 后加 `scenes, activeScene,`。
4. `DEFAULT_SETTINGS`（1391）**无需改动**：它经由 `normalizeSettings` 构造，scenes 自动补全。
5. 文件公共函数区（`getTextApiProfile` 之后）加两个解析函数：

```ts
/**
 * 场景生图解析：场景显式引用优先，干净返回该 profile 本体（不套 getActiveApiProfile
 * 的旧版顶层镜像字段覆盖——顶层 baseUrl/apiKey/model 只描述全局激活配置，对场景引用
 * 无意义）；无引用或引用失效时回落全局激活链。
 */
export function getSceneImageApiProfile(settings: Partial<AppSettings> | unknown): ApiProfile {
  const normalized = normalizeSettings(settings)
  const sceneProfileId = normalized.scenes[normalized.activeScene].imageProfileId
  if (sceneProfileId) {
    const profile = normalized.profiles.find((p) => p.id === sceneProfileId)
    if (profile) return profile
  }
  return getActiveApiProfile(normalized)
}

/** 场景文本解析：场景显式引用优先，否则走全局 textApiProfileId 自动链（语义不变）。 */
export function getSceneTextApiProfileResolution(settings: Partial<AppSettings> | unknown): TextApiResolution {
  const normalized = normalizeSettings(settings)
  const sceneTextProfileId = normalized.scenes[normalized.activeScene].textProfileId
  if (sceneTextProfileId) {
    const profile = normalized.profiles.find((p) => p.id === sceneTextProfileId)
    if (profile) return { profile, resolvedBy: 'explicit', reason: null }
  }
  return getTextApiProfileResolution(normalized)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/apiProfiles.test.ts`
Expected: PASS（含既有用例无回归）

- [ ] **Step 5: 提交（需用户同意）**

```bash
git add src/types.ts src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts
git commit -m "feat(scenes): 场景配置类型、归一化与生图/文本解析链"
```

---

### Task 2: 提交链路接入场景

**Files:**
- Modify: `src/lib/api.ts:9-14`
- Modify: `src/store.ts`（画廊提交函数内，TaskRecord 构造 ~2142-2164）
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `getSceneImageApiProfile`。
- Produces: 画廊任务 `TaskRecord.sceneId` 恒为提交时 `settings.activeScene`；所有经 `callImageApi` 的生图请求按场景解析 profile。

- [ ] **Step 1: 写失败测试**（追加到 `src/store.test.ts`，先 grep 本文件既有的画廊提交用例，沿用其 mock/调用模式）

```ts
it('提交的任务记录提交时的场景 sceneId', async () => {
  // 沿用本文件既有画廊提交用例的前置（mock api、seed settings）
  useStore.setState({ settings: { ...useStore.getState().settings, activeScene: 'sticker' } })
  await useStore.getState().submitPrompt('场景测试')
  const task = useStore.getState().tasks[0]
  expect(task.sceneId).toBe('sticker')
})
```

（若既有用例的提交入口函数名不是 `submitPrompt`，以实际为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/store.test.ts`
Expected: FAIL（`task.sceneId` 为 undefined）

- [ ] **Step 3: 实现**

`src/lib/api.ts`：把 `getActiveApiProfile` 的 import 与调用（9-14 行）换成 `getSceneImageApiProfile`，其余不动：

```ts
const profile = getSceneImageApiProfile(opts.settings)
```

`src/store.ts` TaskRecord 构造块（2142-2164）`createdAt: Date.now(),` 之前加一行（`settings` 在该函数作用域内可用，见 2171 行用法）：

```ts
    sceneId: settings.activeScene,
```

然后 grep 全仓 `getActiveApiProfile(` 的非测试调用点（预期：`src/store.ts` 若画廊提交/重试另有直取 activeProfile 处、`agentApi` 相关、`SettingsModal` 展示用）：**只改画廊生图请求路径**（提交与重试取 profile 处一并换成 `getSceneImageApiProfile`）；Agent 路径（`getAgentImageApiProfile`）与设置 UI 展示不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交（需用户同意）**

```bash
git add src/lib/api.ts src/store.ts src/store.test.ts
git commit -m "feat(scenes): 生图请求走场景 profile 解析，任务记录 sceneId"
```

---

### Task 3: 场景目录句柄（db 层）

**Files:**
- Modify: `src/lib/db.ts`（Local auto-save 区，360-398 之后）
- Modify: 各测试工厂中 `src/lib/db.ts` 的 mock（grep `vi.mock('../lib/db'` 或 `vi.mock('./lib/db'` 定位）

**Interfaces:**
- Produces: `SCENE_DIRECTORY_KEY_PREFIX = 'sceneDirectory:'`、`getSceneDirectoryHandle(sceneId)`、`putSceneDirectoryHandle(sceneId, handle)`、`clearSceneDirectoryHandle(sceneId)`、`listSceneDirectoryHandles()`（返回 `StoredLocalAutoSaveDirectoryHandle[]`）

- [ ] **Step 1: 实现**（纯镜像 362-398 的既有三件套模式，无独立单测——IndexedDB 环境不可直测，行为由 Task 4 的 store 测试经 mock 覆盖）

```ts
// ===== Scene save directories =====
// 每场景一把独立句柄（key: sceneDirectory:<sceneId>），与全局 directory、
// 引擎交付目录三者各自授权、互不覆盖。

export const SCENE_DIRECTORY_KEY_PREFIX = 'sceneDirectory:'

function sceneDirectoryKey(sceneId: string) {
  return `${SCENE_DIRECTORY_KEY_PREFIX}${sceneId}`
}

export function getSceneDirectoryHandle(sceneId: string): Promise<StoredLocalAutoSaveDirectoryHandle | undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readonly', (s) => s.get(sceneDirectoryKey(sceneId)))
}

export function putSceneDirectoryHandle(sceneId: string, handle: FileSystemDirectoryHandle): Promise<IDBValidKey> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.put({
    id: sceneDirectoryKey(sceneId),
    handle,
    name: handle.name,
    updatedAt: Date.now(),
  } satisfies StoredLocalAutoSaveDirectoryHandle))
}

export function clearSceneDirectoryHandle(sceneId: string): Promise<undefined> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readwrite', (s) => s.delete(sceneDirectoryKey(sceneId)))
}

export function listSceneDirectoryHandles(): Promise<StoredLocalAutoSaveDirectoryHandle[]> {
  return dbTransaction(STORE_LOCAL_AUTO_SAVE, 'readonly', (s) =>
    s.getAll(IDBKeyRange.bound(SCENE_DIRECTORY_KEY_PREFIX, `${SCENE_DIRECTORY_KEY_PREFIX}\uffff`)))
}
```

- [ ] **Step 2: 同步测试工厂**：给所有 `src/lib/db.ts` 的 mock 加上以上五个导出的桩（`getSceneDirectoryHandle: vi.fn().mockResolvedValue(undefined)` 等）。

- [ ] **Step 3: 跑全量测试确认无 mock 缺口**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: 提交（需用户同意）**

```bash
git add src/lib/db.ts
git commit -m "feat(scenes): IndexedDB 场景目录句柄读写（sceneDirectory:<id>）"
```

---

### Task 4: store 场景 actions、保存链与画廊过滤

**Files:**
- Modify: `src/store.ts`（actions 接口 ~488 附近、实现区、落盘链 ~4531、权限恢复 ~4438-4465、TaskGrid 数据源）
- Modify: `src/components/TaskGrid.tsx`（过滤）
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: Task 1 `SceneSettings/SceneDefaults`、Task 3 db 函数；`calculateImageSize(tier, ratio)`（`src/lib/size.ts:224`）。
- Produces: `setActiveScene(scene)`、`setSceneImageProfileId(scene, id|null)`、`setSceneTextProfileId(scene, id|null)`、`setSceneDefaults(scene, partial)`、`selectSceneSaveDirectory(scene)`、`clearSceneSaveDirectory(scene)`、`gallerySceneFilter: 'all' | SceneId` + `setGallerySceneFilter`。

- [ ] **Step 1: 写失败测试**

```ts
describe('场景 actions 与保存链', () => {
  it('setActiveScene 切换场景并应用默认参数、重置画廊过滤', () => {
    useStore.setState({ settings: normalizeSettings({
      scenes: { sticker: { defaults: { ratio: '1:1', tier: '1K', transparentBackground: true } } },
    }) })
    useStore.getState().setActiveScene('sticker')
    expect(useStore.getState().settings.activeScene).toBe('sticker')
    expect(useStore.getState().gallerySceneFilter).toBe('sticker')
    expect(useStore.getState().params.transparent_output).toBe(true)
    expect(useStore.getState().params.size).toBe(calculateImageSize('1K', '1:1'))
  })

  it('resolveTaskSaveDirectoryHandle：场景句柄已授权时优先，否则回落全局', async () => {
    // mock getSceneDirectoryHandle 返回已授权句柄 → 断言 writeLocalAutoSaveArchive 收到该句柄
    // mock 场景句柄缺失 → 断言收到全局句柄（跟随既有 4K 落盘用例的 mock 模式）
  })
})
```

（第二个用例跟随 `store.test.ts` 既有 localAutoSave 用例的 mock 结构补全断言，此处以注释给出等价断言目标。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/store.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

store 接口与实现（与 `selectLocalAutoSaveDirectory` 同区放置）：

```ts
setActiveScene: (scene) => {
  const state = get()
  if (state.settings.activeScene === scene) return
  set({ settings: { ...state.settings, activeScene: scene }, gallerySceneFilter: scene })
  applySceneDefaults(scene)
},
setSceneImageProfileId: (scene, profileId) => {
  const state = get()
  set({ settings: { ...state.settings, scenes: { ...state.settings.scenes, [scene]: { ...state.settings.scenes[scene], imageProfileId: profileId } } } })
},
setSceneTextProfileId: (scene, profileId) => {
  const state = get()
  set({ settings: { ...state.settings, scenes: { ...state.settings.scenes, [scene]: { ...state.settings.scenes[scene], textProfileId: profileId } } } })
},
setSceneDefaults: (scene, defaults) => {
  const state = get()
  set({ settings: { ...state.settings, scenes: { ...state.settings.scenes, [scene]: { ...state.settings.scenes[scene], defaults: { ...state.settings.scenes[scene].defaults, ...defaults } } } } })
},
```

`applySceneDefaults`（模块级函数，`setParams` 的 patch 只覆盖场景显式给出的维度）：

```ts
function applySceneDefaults(sceneId: SceneId) {
  const { settings, params } = useStore.getState()
  const defaults = settings.scenes[sceneId].defaults
  const patch: Partial<TaskParams> = {}
  if (defaults.ratio || defaults.tier) {
    patch.size = calculateImageSize(defaults.tier ?? '1K', defaults.ratio ?? '1:1')
  }
  if (defaults.transparentBackground === true && params.output_format === 'png') patch.transparent_output = true
  if (defaults.transparentBackground === false) patch.transparent_output = false
  if (Object.keys(patch).length) useStore.getState().setParams(patch)
}
```

`selectSceneSaveDirectory` / `clearSceneSaveDirectory`：镜像 `selectLocalAutoSaveDirectory`（4340-4365）——`showDirectoryPicker({ mode: 'readwrite' })` → `putSceneDirectoryHandle(sceneId, handle)` → `setSceneSettings` 写 `saveDirectoryName: handle.name`；清除版调用 `clearSceneDirectoryHandle` + `saveDirectoryName: null`。

保存链接入（4531 行处替换 + 新增解析函数；权限校验逻辑从 `getSelectedLocalAutoSaveDirectoryHandle`（4474-4497）中提取复用，提取时保持原函数行为不变）：

```ts
async function resolveTaskSaveDirectoryHandle(task: TaskRecord): Promise<StoredLocalAutoSaveDirectoryHandle | null> {
  const sceneId = task.sceneId
  if (sceneId) {
    const stored = await getSceneDirectoryHandle(sceneId)
    // 复用从 getSelectedLocalAutoSaveDirectoryHandle 提取的「名称一致性 + readwrite 权限」校验；
    // 通过则返回 stored，名称不符则 clearSceneDirectoryHandle 后继续回落。
    const authorized = stored ? await authorizeStoredDirectoryHandle(stored) : null
    if (authorized) return authorized
  }
  return getSelectedLocalAutoSaveDirectoryHandle()
}
```

落盘调用点（~4531）：

```ts
const directoryHandle = await resolveTaskSaveDirectoryHandle(task)
```

权限恢复：`restoreLocalAutoSavePermissionOnUserActivation`（4438-4465）在处理全局句柄之外，追加 `await listSceneDirectoryHandles()` 逐把走同一恢复路径（只恢复授权，不弹选择器）。

画廊过滤：store 增加 `gallerySceneFilter: 'all' | SceneId`（初始 `general`，不持久化——跟随 activeScene 派生即可）+ `setGallerySceneFilter`；`setActiveScene` 时重置为该场景（上方实现已含）。`TaskGrid.tsx` 的 tasks 数据源选择器包一层：

```ts
const tasks = useStore((s) => s.gallerySceneFilter === 'all'
  ? s.tasks
  : s.tasks.filter((t) => (t.sceneId ?? 'general') === s.gallerySceneFilter))
```

（以 TaskGrid 实际取数选择器为准包过滤；`SearchBar` 搜索/筛选逻辑不动，作用于过滤后的列表。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交（需用户同意）**

```bash
git add src/store.ts src/components/TaskGrid.tsx src/store.test.ts
git commit -m "feat(scenes): 场景 actions、场景目录落盘链与画廊场景过滤"
```

---

### Task 5: 顶层导航（场景 Tab + 引擎 + 画布按钮右移）与移动端

**Files:**
- Modify: `src/components/Header.tsx`（281-315 tab 区、316+ 右侧工具区）
- Modify: `src/components/MobileShell.tsx`（grep `setAppMode` 定位底部 tab 区）

**Interfaces:**
- Consumes: `setActiveScene`、`settings.activeScene`。

- [ ] **Step 1: Header 桌面导航改造**。281-315 的 tab 组替换为（样式类沿用现值）：

```tsx
const SCENE_TABS: Array<{ id: SceneId; label: string }> = [
  { id: 'portrait', label: '人像写真' },
  { id: 'general', label: '通用创作' },
  { id: 'sticker', label: '表情与头像' },
  // P2 上线 Skill 工坊视图后追加：{ id: 'skill', label: 'Skill 工坊' }
]
```

```tsx
<div className="hidden sm:flex items-center gap-1 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-gray-100/70 dark:bg-white/[0.04] p-1 mr-4">
  {SCENE_TABS.map(({ id, label }) => (
    <button
      key={id}
      type="button"
      onClick={() => { setAppMode('gallery'); setActiveScene(id); }}
      className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${appMode === 'gallery' && activeScene === id ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
    >
      {label}
    </button>
  ))}
  <button type="button" onClick={() => setAppMode('engine')} className={/* 引擎按钮沿用现有样式 */''}>
    引擎
  </button>
</div>
```

（保持现有 `sm:` 断点：P1a 共 4 个 Tab，画布外链移走后 tab 组总宽与现状持平；P2 增加 Skill 工坊 Tab 时再实测评估是否需要收窄文案或断点。）

- [ ] **Step 2: 画布按钮右移**。从 tab 组删除 303-314 的 `<a>`，移入右侧工具组（316 的 div 内、主题按钮之前）：

```tsx
{CANVAS_WORKSPACE_URL !== '' && (
  <a
    href={CANVAS_WORKSPACE_URL} target="_blank" rel="noopener noreferrer"
    title="无限画布（独立应用，新标签页打开）" aria-label="无限画布"
    className="flex items-center rounded-lg p-2 text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-white/[0.08] dark:hover:text-stone-100"
  >
    <LayoutGrid className="h-5 w-5" aria-hidden />
  </a>
)}
```

（`LayoutGrid` 加入 lucide-react import。）

- [ ] **Step 3: 移动端**。`MobileShell.tsx` 的底部 tab 区改为 3 个场景 chip + 引擎（沿用现有 tab 项样式与激活态逻辑，点击行为同桌面：`setAppMode('gallery'); setActiveScene(id)`）；「无限画布」入口放进移动端「更多」菜单（若现无此入口，加同款 `LayoutGrid` 外链项）。窄屏场景 chip 允许横向滚动（`overflow-x-auto`）。

- [ ] **Step 4: 浏览器双宽度验证**。本地 `npm run dev` 后检查：桌面 ≥1024px 五 Tab 正常、切换场景画廊过滤与默认参数生效、画布按钮在右侧工具区新标签打开；移动 375px 场景 chips 可横滚、引擎可达。

Run: `npm run dev`（人工检查）
Expected: 上述行为全部成立；无控制台报错。

- [ ] **Step 5: 提交（需用户同意）**

```bash
git add src/components/Header.tsx src/components/MobileShell.tsx
git commit -m "feat(scenes): 顶层导航改为场景 Tab，无限画布入口右移"
```

---

### Task 6: 场景设置抽屉

**Files:**
- Create: `src/components/SceneSettingsDrawer.tsx`
- Modify: `src/components/Header.tsx` 或画廊头部（加齿轮入口，仅 `appMode === 'gallery'` 时显示）

**Interfaces:**
- Consumes: Task 4 全部 actions；`settings.profiles`、`isAgentTextApiProfile`、`getSceneTextApiProfileResolution`（无可用文本 profile 时显示引导文案）。
- Produces: 无（叶子组件）。

- [ ] **Step 1: 实现组件**（沿用 `ConfirmDialog`/`Select.tsx` 的玻璃拟态风格与自研 Select；标题用当前场景中文名；四组配置：生图模型 / 保存目录 / 文本模型 / 默认参数）：

```tsx
export function SceneSettingsDrawer({ scene, onClose }: { scene: SceneId; onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const sceneSettings = settings.scenes[scene]
  // 生图模型：Select 选项 = 「跟随全局（当前：{activeProfile.name}）」 + 全部 profiles
  //   值绑定 sceneSettings.imageProfileId ?? ''，onChange → setSceneImageProfileId(scene, value || null)
  // 保存目录：显示 saveDirectoryName ?? '跟随全局目录'；
  //   按钮「选择独立目录」→ selectSceneSaveDirectory(scene)、「清除」→ clearSceneSaveDirectory(scene)
  //   本地保存总开关 settings.localAutoSave.enabled 为关时提示「已停用本地自动保存」
  // 文本模型：Select 选项 = 「跟随全局文本路由」 + isAgentTextApiProfile 的 profiles；
  //   getSceneTextApiProfileResolution(settings).profile 为 null 时显示
  //   「未找到可用的文本模型配置（需 Responses 类型），可在设置→API 中添加」
  // 默认参数：比例（COMMON_IMAGE_RATIOS）+ 档位（1K/2K/4K）+ 透明背景 Checkbox → setSceneDefaults
  return (/* 上述四组的抽屉布局 */)
}
```

（骨架如上；布局与文案落地时对照 `SettingsModal` 的分区样式，保持中文。）

- [ ] **Step 2: 入口接线**。画廊头部加齿轮 `Settings2` 图标按钮 → 本地 state 打开抽屉渲染 `<SceneSettingsDrawer scene={activeScene} ... />`。

- [ ] **Step 3: 浏览器验证**：给表情场景指定独立 profile/目录后提交任务 → 图落场景目录；清空所有场景配置 → 行为与现状一致。

Run: `npm run dev`（人工检查）

- [ ] **Step 4: 提交（需用户同意）**

```bash
git add src/components/SceneSettingsDrawer.tsx src/components/Header.tsx
git commit -m "feat(scenes): 场景设置抽屉（生图/目录/文本/默认参数）"
```

---

### Task 7: P1a 回归门

- [ ] `npm test` 全绿
- [ ] `npm run build` 通过
- [ ] `npm run lint` 零错误（unused 警告基线内）
- [ ] `npm run verify:ui -- http://localhost:5173/`（本地 dev；生产验证待部署后补跑 `https://image.taostudioai.com/`）
- [ ] 手工冒烟：四路径各提交一次生成（不配场景 → 与旧行为一致；表情场景配独立 profile+目录 → 落对地方）
- [ ] 提交（需用户同意）：`git commit -m "feat(scenes): P1a 场景框架完成"`（如有收尾改动）

---

## 后续计划（另行出计划文档，不在本计划内）

- **P1b 智能体移除手术**：见 `docs/agent-removal-p1b-plan-2026-09-10.md`。
- **P2 Skill 工坊**：在 P1a 场景骨架上建 SKILL.md 解析、工坊视图与扩写→生成链（内置 skill 已就位：`public/skills/`）。开工时基于已落地的 P1a 代码出详细计划。
- **P3 打磨归拢**：表情场景风格露出、人像内置 skill、移动端细节。同上，届时出计划。
