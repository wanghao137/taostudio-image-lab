# 底部参数台遮挡重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将桌面端底部参数台从"常驻全展开"重构为"精简常驻栏 + 内联向上展开"，并修复画廊避让间隙不匹配的根因，彻底消除对生成图片的遮挡。

**Architecture:** 三处改动：(1) `App.tsx` 的画廊 `<main>` 把硬编码 `pb-48` 换成消费 CSS 变量 `--input-bar-clearance`（该变量已由 `InputBar` 的 `ResizeObserver` 实时发布）；(2) `InputBar.tsx` 把 7 列参数行与 4K 策略卡从常驻区移入一个可折叠的展开区，新增「参数」切换钮与 localStorage 记忆；(3) 收紧提示词增长上限与缩略图尺寸，降低常驻栏高度。

**Tech Stack:** React + TypeScript + Tailwind CSS + Zustand + vitest + @testing-library/react。复用现有 `.collapse-section` CSS 动画（`src/index.css:373-388`）。

## Global Constraints

- 复用现有 `.collapse-section` CSS 类（`src/index.css:373-388`），不引入新动画依赖。
- 复用现有 `--input-bar-clearance` CSS 变量（`InputBar.tsx:750-780` 已发布），不新建避让机制。
- 移动端（`< 640px`，`useIsMobile`）不动，本次改动只影响桌面分支（`>= 640px`，即 Tailwind `sm:` 及以上）。
- `src/store.ts` 状态结构不动，`src/hooks/useImageComposer.ts` 共享逻辑不动。
- UI 文案保持中文。
- 提示词增长上限精确改为 `8rem`（128px）。
- 缩略图精确从 `52px` 改为 `40px`。
- 按 `AGENTS.md`：lint 基线为零错误；不要提交、推送、部署，除非用户明确要求。
- Commit 信息使用 `feat:` / `fix:` / `refactor:` 前缀，匹配现有 git log 风格。

---

## File Structure

| 文件 | 改动类型 | 责任 |
| --- | --- | --- |
| `src/App.tsx` | 修改 `:225` | 画廊 `<main>` 的 `pb-48` 改为消费 `--input-bar-clearance` |
| `src/components/InputBar.tsx` | 修改多处 | 常驻栏重组、展开/收起状态、参数移入展开区、提示词上限、缩略图尺寸 |
| `src/components/__tests__/InputBar.occlusion.test.tsx` | 新建 | 展开状态持久化与避让变量的单元测试 |

`src/index.css`、`src/hooks/useImageComposer.ts`、`src/store.ts` 不改。

---

### Task 1: 修复画廊避让间隙（根因修复）

**Files:**
- Modify: `src/App.tsx:225`

**Interfaces:**
- Consumes: CSS 变量 `--input-bar-clearance`（由 `InputBar.tsx:750-780` 的 `updateInputBarClearance` 通过 `document.documentElement.style.setProperty` 发布，单位 px）
- Produces: 画廊 `<main>` 底部留白始终等于输入栏真实高度 + 1.5rem

这是最小、可独立验证的一步：把硬编码的 `pb-48`（192px）替换为消费 CSS 变量的动态值。变量由 `InputBar` 的 `ResizeObserver` 实时维护，收起/展开/提示词增长时自动更新。`AgentWorkspace.tsx:941` 已验证同一消费模式。

- [ ] **Step 1: 修改 `App.tsx` 的 `<main>` className**

将 `src/App.tsx:225` 的：

```jsx
<main data-home-main data-drag-select-surface className="pb-48">
```

改为：

```jsx
<main data-home-main data-drag-select-surface className="pb-[calc(var(--input-bar-clearance,12rem)+1.5rem)]">
```

`12rem`（192px）作为 `--input-bar-clearance` 未发布时的 fallback，与原 `pb-48` 等值，保证降级行为一致。`+1.5rem` 是输入栏与视口底部的视觉间距（`sm:bottom-5` 约等于 1.25rem，取 1.5rem 留足余量），与 `AgentWorkspace.tsx:941` 的消费方式完全一致。

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 构建成功，无 TypeScript 报错。

- [ ] **Step 3: 浏览器实地验证（桌面 1280px）**

Run: `npm run dev`

在浏览器中打开桌面宽度（1280px），确认：
1. 底部输入栏可见。
2. 画廊最后一行图卡的元数据和操作按钮完整可见，不被输入栏遮挡。
3. 上传一张参考图、输入多行提示词使输入栏变高后，画廊底部留白自动增大，仍无遮挡。

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "fix: gallery main consumes --input-bar-clearance to avoid InputBar occlusion"
```

---

### Task 2: 新增展开/收起状态与 localStorage 记忆

**Files:**
- Modify: `src/components/InputBar.tsx:720-748`（state 声明区）
- Create: `src/components/__tests__/InputBar.occlusion.test.tsx`

**Interfaces:**
- Consumes: 无（新增 state）
- Produces: `paramsExpanded: boolean` state（`true`=展开，`false`=收起），通过 localStorage key `inputBar.paramsExpanded` 持久化；挂载时读取恢复，默认 `false`（收起）。

- [ ] **Step 1: 写失败测试 —— localStorage 记忆逻辑**

Create `src/components/__tests__/InputBar.occlusion.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'inputBar.paramsExpanded'

// 抽取纯函数逻辑进行单元测试，避免渲染整个 InputBar（2667 行，依赖大量 store/portal）
function readParamsExpanded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeParamsExpanded(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // ignore quota / private mode
  }
}

describe('InputBar paramsExpanded localStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns false when no stored value (default collapsed)', () => {
    expect(readParamsExpanded()).toBe(false)
  })

  it('returns true when stored value is true', () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    expect(readParamsExpanded()).toBe(true)
  })

  it('returns false when stored value is not "true"', () => {
    localStorage.setItem(STORAGE_KEY, 'false')
    expect(readParamsExpanded()).toBe(false)
    localStorage.setItem(STORAGE_KEY, 'anything')
    expect(readParamsExpanded()).toBe(false)
  })

  it('writeParamsExpanded persists the value', () => {
    writeParamsExpanded(true)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true')
    writeParamsExpanded(false)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false')
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/components/__tests__/InputBar.occlusion.test.tsx`
Expected: FAIL — `readParamsExpanded` / `writeParamsExpanded` not defined（它们目前只在测试文件里声明，未在 InputBar 中实现为可导出逻辑）。

> 说明：我们采用"纯函数 + 同文件导出"的方式实现记忆逻辑，而非把 localStorage 读写塞进组件副作用，这样它可被单元测试覆盖。测试文件里临时声明的函数会在 Step 3 被替换为从 `InputBar.tsx` 导入的真实实现。

- [ ] **Step 3: 在 `InputBar.tsx` 实现记忆逻辑并导出**

在 `src/components/InputBar.tsx` 文件顶部、所有 import 之后、组件定义之前，加入：

```tsx
/** localStorage key for persisting the params panel expand/collapse state. */
export const PARAMS_EXPANDED_KEY = 'inputBar.paramsExpanded'

/** Read persisted params-expanded preference. Defaults to false (collapsed). */
export function readParamsExpanded(): boolean {
  try {
    return localStorage.getItem(PARAMS_EXPANDED_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist params-expanded preference. Silently ignores quota/private-mode errors. */
export function writeParamsExpanded(value: boolean): void {
  try {
    localStorage.setItem(PARAMS_EXPANDED_KEY, String(value))
  } catch {
    // ignore
  }
}
```

然后在组件 state 声明区（`InputBar.tsx:725` 的 `const [mobileCollapsed, setMobileCollapsed] = useState(false)` 之后）加入：

```tsx
const [paramsExpanded, setParamsExpanded] = useState(() => readParamsExpanded())

const toggleParamsExpanded = useCallback(() => {
  setParamsExpanded((prev) => {
    const next = !prev
    writeParamsExpanded(next)
    return next
  })
}, [])
```

需要确保 `useCallback` 已在文件 import 列表中（当前已有使用，如 `InputBar.tsx:750`，无需新增 import）。

- [ ] **Step 4: 更新测试导入真实实现**

把 `src/components/__tests__/InputBar.occlusion.test.tsx` 中本地声明的 `STORAGE_KEY`、`readParamsExpanded`、`writeParamsExpanded` 删除，替换为从 InputBar 导入：

```tsx
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PARAMS_EXPANDED_KEY, readParamsExpanded, writeParamsExpanded } from '../InputBar'

describe('InputBar paramsExpanded localStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns false when no stored value (default collapsed)', () => {
    expect(readParamsExpanded()).toBe(false)
  })

  it('returns true when stored value is true', () => {
    localStorage.setItem(PARAMS_EXPANDED_KEY, 'true')
    expect(readParamsExpanded()).toBe(true)
  })

  it('returns false when stored value is not "true"', () => {
    localStorage.setItem(PARAMS_EXPANDED_KEY, 'false')
    expect(readParamsExpanded()).toBe(false)
    localStorage.setItem(PARAMS_EXPANDED_KEY, 'anything')
    expect(readParamsExpanded()).toBe(false)
  })

  it('writeParamsExpanded persists the value', () => {
    writeParamsExpanded(true)
    expect(localStorage.getItem(PARAMS_EXPANDED_KEY)).toBe('true')
    writeParamsExpanded(false)
    expect(localStorage.getItem(PARAMS_EXPANDED_KEY)).toBe('false')
  })
})
```

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run src/components/__tests__/InputBar.occlusion.test.tsx`
Expected: PASS — 4 个测试全部通过。

- [ ] **Step 6: Commit**

```bash
git add src/components/InputBar.tsx src/components/__tests__/InputBar.occlusion.test.tsx
git commit -m "feat: add paramsExpanded state with localStorage persistence"
```

---

### Task 3: 重排卡片布局 —— 展开区 + 常驻栏分隔

**Files:**
- Modify: `src/components/InputBar.tsx:2470-2528`（参数+按钮区域）

**Interfaces:**
- Consumes: `paramsExpanded`、`toggleParamsExpanded`（来自 Task 2），`.collapse-section` / `.collapsed` CSS 类（`src/index.css:373-388`），`SlidersHorizontal` 图标（已在 `InputBar.tsx:3` 导入）
- Produces: 卡片内部分为两层 —— 上层是可折叠的展开参数区（4K 策略卡 + 7 列参数行），下层是常驻操作行（「参数」钮 + 上传 + 生成）。

这一步把当前 `InputBar.tsx:2471-2528` 的 `{renderGenerationStrategy()}` + 桌面参数行 + 按钮组，重组为"展开区包裹策略卡和参数行，常驻区只留按钮 + 新增参数切换钮"。

- [ ] **Step 1: 重写 `参数 + 按钮` 区域（`InputBar.tsx:2470-2528`）**

将当前的：

```jsx
          {/* 参数 + 按钮 */}
          <div className="mt-3">
            {renderGenerationStrategy()}
            {/* 桌面端布局 */}
            <div className="hidden sm:flex items-end justify-between gap-3">
              {renderParams('grid-cols-7')}

              <div className="flex gap-2 flex-shrink-0 mb-0.5">
```

以及它对应的闭合标签（到 `</div>` 结束桌面布局 div，即 `InputBar.tsx:2528`），整体替换为下面的结构。**注意：仅替换到桌面布局 div 的闭合（`:2528`），保留之后的移动端布局（`:2530` 起 `sm:hidden`）不动。**

```jsx
          {/* 可折叠展开区：4K 策略卡 + 桌面 7 列参数行 */}
          <div className={`mt-3 collapse-section${paramsExpanded ? '' : ' collapsed'}`}>
            <div className="collapse-inner">
              {renderGenerationStrategy()}
              {/* 桌面端参数行 */}
              <div className="hidden sm:block">
                {renderParams('grid-cols-7')}
              </div>
            </div>
          </div>

          {/* 常驻操作行：参数切换钮 + （原桌面布局的）上传与生成按钮 */}
          <div className="mt-3 hidden sm:flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={toggleParamsExpanded}
              className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all duration-200 shadow-sm ${
                paramsExpanded
                  ? 'border-blue-300 bg-blue-50 text-blue-600 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300'
                  : 'border-gray-200/60 bg-white/50 text-gray-500 hover:bg-white hover:text-gray-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200'
              }`}
              aria-expanded={paramsExpanded}
              aria-label={paramsExpanded ? '收起参数' : '展开参数'}
              title={paramsExpanded ? '收起参数' : '展开参数'}
            >
              <SlidersHorizontal className={`h-4 w-4 transition-transform duration-200 ${paramsExpanded ? 'rotate-90' : ''}`} />
              <span>参数</span>
            </button>

            <div className="flex gap-2 flex-shrink-0">
              <div
                className="relative"
                onMouseEnter={() => setAttachHover(true)}
                onMouseLeave={() => setAttachHover(false)}
              >
                <ButtonTooltip visible={attachHover} text={uploadImageTooltipText} />
                <button
                  onClick={() => !atImageLimit && fileInputRef.current?.click()}
                  className={`p-2.5 rounded-xl transition-all shadow-sm ${
                    atImageLimit
                      ? 'bg-gray-200 dark:bg-white/[0.04] text-gray-300 dark:text-gray-500 cursor-not-allowed'
                      : 'bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 hover:shadow'
                  }`}
                  aria-label={uploadImageTooltipText}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                </button>
              </div>
              <div
                className="relative"
                onMouseEnter={() => setSubmitHover(true)}
                onMouseLeave={() => setSubmitHover(false)}
              >
                <ButtonTooltip visible={(activeAgentIsRunning || !hasSubmitApiConfig) && submitHover} text={submitTooltipText} />
                <button
                  onClick={() => activeAgentIsRunning ? stopActiveAgentResponse() : hasSubmitApiConfig ? submitCurrentMode() : setShowSettings(true)}
                  disabled={activeAgentIsRunning ? false : hasSubmitApiConfig ? !canSubmit : false}
                  className={`p-2.5 rounded-xl transition-all shadow-sm hover:shadow ${
                    activeAgentIsRunning
                      ? 'bg-red-500 text-white hover:bg-red-600'
                      : !hasSubmitApiConfig
                      ? 'bg-gray-300 dark:bg-white/[0.06] text-white cursor-pointer'
                      : 'bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed'
                  }`}
                  aria-label={submitButtonAriaLabel}
                >
                  {activeAgentIsRunning ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="7" y="7" width="10" height="10" rx="1.5" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          </div>
```

关键变化说明：
1. `renderGenerationStrategy()` 与 `renderParams('grid-cols-7')` 被包进 `.collapse-section` 展开区，由 `paramsExpanded` 控制显隐。
2. 原桌面布局的"参数行 + 按钮组水平排列"被拆开：参数行进展开区，按钮组（上传+生成）移到常驻操作行，并新增「参数」切换钮在最左。
3. 上传/生成按钮的 JSX 完全保留原样（含 tooltip、disabled 逻辑、agent 运行态），只是换了外层容器。
4. 移动端布局（`:2530` 起）不动。

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 构建成功。若报 `SlidersHorizontal` 未定义，确认 `InputBar.tsx:3` 的 import 包含它（当前已有：`import { ImageUp, Maximize2, SlidersHorizontal } from 'lucide-react'`）。

- [ ] **Step 3: 浏览器实地验证（桌面 1280px）**

Run: `npm run dev`

确认：
1. 默认状态下，底部只有提示词框 + 「参数」钮 + 上传 + 生成，7 列参数行与 4K 策略卡不可见（折叠）。
2. 点击「参数」钮，参数行与策略卡在上方平滑展开，钮变蓝且图标旋转 90°。
3. 再次点击，参数区平滑收起。
4. 刷新页面，展开状态按上次选择恢复。
5. 展开时画廊自动让出空间（Task 1 的避让变量生效），无遮挡。
6. 上传、生成按钮功能正常。

- [ ] **Step 4: lint 验证**

Run: `npm run lint`
Expected: 零错误。（现有 unused-variable warnings 可保留。）

- [ ] **Step 5: Commit**

```bash
git add src/components/InputBar.tsx
git commit -m "feat: split InputBar into collapsible params section and persistent action row"
```

---

### Task 4: 常驻栏加尺寸快接胶囊 + 收紧高度

**Files:**
- Modify: `src/components/InputBar.tsx:1265-1302`（`adjustTextareaHeight`）、`1760`（缩略图 grid）、常驻操作行（Task 3 新增）

**Interfaces:**
- Consumes: `showSizePicker`/`setShowSizePicker`（`InputBar.tsx:726`）、`params.size`（store）、`SizePickerModal`（已挂载在 `InputBar.tsx:1788` 附近）
- Produces: 常驻栏左侧新增尺寸胶囊（显示当前尺寸，点击弹 SizePickerModal）；提示词增长上限 `8rem`；缩略图 `40px`。

- [ ] **Step 1: 收紧提示词增长上限**

修改 `src/components/InputBar.tsx:1273-1274` 的 `adjustTextareaHeight`。

将：

```tsx
    // 最大高度限制在页面 40% 减固定开销，不小于 80px
    const maxH = Math.max(window.innerHeight * 0.4 - fixedOverhead, 80)
```

改为：

```tsx
    // 常驻栏高度上限 8rem（128px，约 3 行），不小于 42px（单行最小）
    const maxH = Math.max(128 - fixedOverhead, 42)
```

说明：原逻辑按视口 40% 动态计算，导致大屏上提示词框可增长到极高。改为固定 `128px` 上限（扣除 `fixedOverhead` 后），使常驻栏高度可预测。`fixedOverhead` 仍包含图片区高度 + 140px，保证有参考图时也留足空间。

- [ ] **Step 2: 缩小参考图缩略图（52px → 40px）**

`52px` 在 `InputBar.tsx` 中有 **6 处引用**，全部需同步改为 `40px`，保持视觉一致。逐处修改：

1. `InputBar.tsx:1533` —— 拖拽预览容器内联样式：
   - `width:52px;height:52px;border-radius:12px;` → `width:40px;height:40px;border-radius:8px;`

2. `InputBar.tsx:1536` —— 拖拽预览图片内联样式：
   - `width:52px;height:52px;object-fit:cover;` → `width:40px;height:40px;object-fit:cover;`

3. `InputBar.tsx:1623` —— `renderImageThumb` 单图容器（普通态）：
   - `h-[52px] w-[52px]` → `h-[40px] w-[40px]`

4. `InputBar.tsx:1669` —— `renderImageThumb` 单图容器（另一态）：
   - `w-[52px] h-[52px] rounded-xl` → `w-[40px] h-[40px] rounded-lg`

5. `InputBar.tsx:1747` —— 「清空全部」按钮容器：
   - `w-[52px] h-[52px] rounded-xl` → `w-[40px] h-[40px] rounded-lg`

6. `InputBar.tsx:1760` —— 缩略图 grid 容器：
   - `grid-cols-[repeat(auto-fill,52px)] justify-between gap-x-2 gap-y-3 mb-3` → `grid-cols-[repeat(auto-fill,40px)] justify-between gap-x-2 gap-y-2 mb-2`

7. `InputBar.tsx:1766` —— touch 拖拽预览浮层：
   - `h-[52px] w-[52px] ... rounded-xl` → `h-[40px] w-[40px] ... rounded-lg`

实现后运行 `grep -n "52" src/components/InputBar.tsx` 确认无残留 `52px` 引用（其他无关的 `52` 如行号、无关常量除外，逐一确认是尺寸引用才改）。

- [ ] **Step 3: 常驻操作行加尺寸胶囊**

在 Task 3 新增的常驻操作行中，在「参数」钮之前加入尺寸胶囊。定位到 Task 3 新增的：

```jsx
          <div className="mt-3 hidden sm:flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={toggleParamsExpanded}
```

把 `justify-end` 改为 `justify-between`，并在「参数」钮前插入尺寸胶囊 + 包裹钮组：

```jsx
          <div className="mt-3 hidden sm:flex items-center justify-between gap-2">
            {/* 尺寸快接胶囊（高频） */}
            <button
              type="button"
              onClick={() => { dismissAllTooltips(); setShowSizePicker(true) }}
              className="rounded-xl border border-gray-200/60 bg-white/50 px-3 py-2 font-mono text-xs text-left shadow-sm transition-all duration-200 hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
              title="选择尺寸"
            >
              {params.size}
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleParamsExpanded}
                className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all duration-200 shadow-sm ${
                  paramsExpanded
                    ? 'border-blue-300 bg-blue-50 text-blue-600 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300'
                    : 'border-gray-200/60 bg-white/50 text-gray-500 hover:bg-white hover:text-gray-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200'
                }`}
                aria-expanded={paramsExpanded}
                aria-label={paramsExpanded ? '收起参数' : '展开参数'}
                title={paramsExpanded ? '收起参数' : '展开参数'}
              >
                <SlidersHorizontal className={`h-4 w-4 transition-transform duration-200 ${paramsExpanded ? 'rotate-90' : ''}`} />
                <span>参数</span>
              </button>

              <div className="flex gap-2 flex-shrink-0">
                <div
                  className="relative"
                  onMouseEnter={() => setAttachHover(true)}
                  onMouseLeave={() => setAttachHover(false)}
                >
                  <ButtonTooltip visible={attachHover} text={uploadImageTooltipText} />
                  <button
                    onClick={() => !atImageLimit && fileInputRef.current?.click()}
                    className={`p-2.5 rounded-xl transition-all shadow-sm ${
                      atImageLimit
                        ? 'bg-gray-200 dark:bg-white/[0.04] text-gray-300 dark:text-gray-500 cursor-not-allowed'
                        : 'bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 hover:shadow'
                    }`}
                    aria-label={uploadImageTooltipText}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  </button>
                </div>
                <div
                  className="relative"
                  onMouseEnter={() => setSubmitHover(true)}
                  onMouseLeave={() => setSubmitHover(false)}
                >
                  <ButtonTooltip visible={(activeAgentIsRunning || !hasSubmitApiConfig) && submitHover} text={submitTooltipText} />
                  <button
                    onClick={() => activeAgentIsRunning ? stopActiveAgentResponse() : hasSubmitApiConfig ? submitCurrentMode() : setShowSettings(true)}
                    disabled={activeAgentIsRunning ? false : hasSubmitApiConfig ? !canSubmit : false}
                    className={`p-2.5 rounded-xl transition-all shadow-sm hover:shadow ${
                      activeAgentIsRunning
                        ? 'bg-red-500 text-white hover:bg-red-600'
                        : !hasSubmitApiConfig
                        ? 'bg-gray-300 dark:bg-white/[0.06] text-white cursor-pointer'
                        : 'bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed'
                    }`}
                    aria-label={submitButtonAriaLabel}
                  >
                    {activeAgentIsRunning ? (
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="7" y="7" width="10" height="10" rx="1.5" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
```

> `params` 已在组件内从 store 解构（确认：搜索 `const params = useStore` 或 `params` 在 `InputBar` 中的使用，`renderParams` 内部已引用 `params`，说明变量可用）。`dismissAllTooltips` 已在组件内定义（`renderParams` 的尺寸按钮已调用它）。

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 5: 浏览器实地验证（桌面 1280px）**

Run: `npm run dev`

确认：
1. 默认（收起）状态：常驻栏显示尺寸胶囊（如 `1024x1024`），点击它弹出 SizePickerModal，选择尺寸后胶囊文字更新。
2. 提示词输入多行后，增长到约 3 行（128px 上限）停止，不再无限增高。
3. 上传参考图，缩略图为 40×40，比之前更紧凑。
4. 整体常驻栏高度明显低于改动前。

- [ ] **Step 6: lint 验证**

Run: `npm run lint`
Expected: 零错误。

- [ ] **Step 7: Commit**

```bash
git add src/components/InputBar.tsx
git commit -m "feat: add size quick-chip to persistent bar, tighten prompt height and thumb size"
```

---

### Task 5: 全量验证与回归

**Files:**
- 无新改动，仅运行验证门禁。

- [ ] **Step 1: 运行测试套件**

Run: `npm test`
Expected: 全部通过，包括新增的 `InputBar.occlusion.test.tsx`。

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 成功。

- [ ] **Step 3: lint**

Run: `npm run lint`
Expected: 零错误。

- [ ] **Step 4: 桌面 1280px 完整回归**

Run: `npm run dev`

按以下清单逐项确认：
1. 默认收起：画廊图卡元数据/操作完整可见，无遮挡。常驻栏 = 尺寸胶囊 + 「参数」钮 + 上传 + 生成。
2. 点击「参数」：策略卡 + 7 列参数行展开，画廊让出空间无遮挡。
3. 调参（尺寸/质量/格式/数量/4K）：全部可达且生效。
4. 上传参考图 + 长提示词：输入栏增高时画廊底部留白同步增大，无遮挡。
5. 刷新页面：展开状态恢复。
6. 提交生成：功能正常（有 API 配置时）。
7. 尺寸胶囊：显示当前尺寸，点击弹窗选择，与展开区尺寸按钮联动同一 store 字段。

- [ ] **Step 5: 移动 390px 回归**

切换到移动端宽度（390px）。确认：
1. 仍走 `MobileShell` + `MobileComposeSheet`（FAB 抽屉），不受本次改动影响。
2. 桌面常驻栏（`hidden sm:flex`）在移动端不显示。

- [ ] **Step 6: 如全部通过，向用户报告完成**

无需 commit（除非用户要求）。报告：
- 改动的文件清单。
- 验证门禁结果（test/build/lint）。
- 浏览器回归结论。
- 指出 spec 文档位置 `docs/superpowers/specs/2026-07-14-inputbar-occlusion-redesign-design.md`。

---

## Self-Review 记录

（实现者在完成计划后回填此项，确认 spec 覆盖、无占位符、类型一致。）

- Spec 覆盖检查：
  - [x] 常驻栏精简（尺寸胶囊 + 提示词 + 上传 + 生成）→ Task 3 + 4
  - [x] 展开区（策略卡 + 7 列参数）→ Task 3
  - [x] 画廊避让变量消费 → Task 1
  - [x] localStorage 记忆 → Task 2
  - [x] 提示词上限 8rem → Task 4 Step 1
  - [x] 缩略图 40px → Task 4 Step 2
  - [x] 移动端不动 → Task 5 Step 5 验证
- 占位符扫描：无 TBD/TODO。
- 类型一致：`paramsExpanded: boolean`、`toggleParamsExpanded: () => void`、`readParamsExpanded/writeParamsExpanded` 在所有任务中命名一致。
