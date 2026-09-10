# 智能体移除 P1b 实施计划（Agent Removal Surgery）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 整体移除零使用的智能体（Agent）功能：UI、store 状态与执行链、专属 lib 与测试；保留三条生命线——反推提示词依赖的共享函数、全局文本路由、IndexedDB 建表与老备份导入兼容；并同步上游升级配置防止文件复活。

**Architecture:** 先下沉共享函数（改动最小、可独立验证）→ 再删 UI 层 → 再做 store 大手术 → 最后删 lib 与测试、改升级配置。每步全量测试保持绿色，小步提交可回滚。前置条件：P1a 已落地（导航已是场景 Tab）。

**Tech Stack:** 同主仓（React 19 + TS + Zustand + Vitest）。

**设计文档：** `docs/scene-and-skill-upgrade-plan-2026-09-10.md` §7 手术清单（含完整文件/符号/行号盘点，本计划直接引用其表格）。

## Global Constraints

- 反推提示词（`promptReverse.ts`）与全局文本路由（`textApiProfileId`）行为必须零变化。
- 老用户数据不炸库：IndexedDB `agentConversations` object store 建表保留；老备份 ZIP 导入含 `agentConversations` 字段时静默忽略不报错。
- `TaskRecord` 上 9 个 `agent*` 字段与 `sourceMode: 'agent'` **保留类型定义不删**（旧记录/旧备份仍会带这些字段，读取路径要能容错），只是新代码不再写入。
- 上游升级配置必须与删除同步改，否则下次 `npm run upgrade:upstream` 全部复活（本计划最大风险点）。
- commit/push 仅在用户明确同意后执行；lint 零错误基线。

---

### Task 1: 共享函数下沉 imageApiShared.ts

**Files:**
- Modify: `src/lib/agentApi.ts:104-109,343,417`（函数体原样迁出）
- Create/Modify: `src/lib/imageApiShared.ts`（若已存在则追加）
- Modify: `src/lib/promptReverse.ts:6`（import 改指 imageApiShared）
- Test: 既有 `src/lib/promptReverse.test.ts`（应无改动即通过）

**Interfaces:**
- Produces: `imageApiShared.ts` 导出 `createHeaders`、`extractText`、`normalizeResponsePayload`（签名与实现从 agentApi 原样搬移，不改一行逻辑）。

- [ ] **Step 1:** 把三个函数从 `agentApi.ts` 剪切到 `imageApiShared.ts`（连同其局部依赖的类型/import）。
- [ ] **Step 2:** `agentApi.ts` 内部改为从 `./imageApiShared` import 使用（该文件本阶段仍存在，P1b Task 4 才删）。
- [ ] **Step 3:** `promptReverse.ts` 的 import 从 `./agentApi` 改为 `./imageApiShared`。
- [ ] **Step 4:** Run `npm test`。Expected: 全绿（反推用例不改动即通过）。
- [ ] **Step 5:** 提交（需用户同意）：`git commit -m "refactor(agent): 共享请求头/文本提取函数下沉 imageApiShared"`

---

### Task 2: UI 层移除

**Files（删除）:**
- `src/components/AgentWorkspace.tsx`（1053 行）
- `src/components/HistoryModal.tsx`
- `src/components/settings/AgentSettingsTab.tsx`

**Files（修改，删 agent 分支）:**
- `src/App.tsx`：lazy 引用（23-43）、`appMode === 'agent'` 渲染分支（255-327）
- `src/components/Header.tsx`：agent 专属区（229-255 历史任务/新对话按钮）、agent Tab 分支（289-295 区域，P1a 后已无 Tab 但残留逻辑）、`agentMobileHeaderVisible`（410-434）
- `src/components/InputBar.tsx`（51 处 agent 引用：agent 模式输入/草稿/@ 引用分支）
- `src/components/MobileShell.tsx`、`MobileComposeSheet.tsx`、`TaskCard.tsx`、`DetailModal.tsx`、`HelpModal.tsx`、`ZipDownloadRouteModal.tsx`（各文件 agent 分支与 `agent-round-all` 路由项）
- `src/components/SettingsModal.tsx`：agent Tab（SettingsTab 联合类型、Tab 列表、渲染分支；214 行类型处）
- `src/types.ts:6`：`AppMode = 'gallery' | 'engine'`；`types.ts:15` `ZIP_DOWNLOAD_ROUTE_VALUES` 移除 `'agent-round-all'`（**注意**：normalize 兼容旧值——读到旧路由值时丢弃，不报错）

- [ ] **Step 1:** 删除三个组件文件；逐文件清除上述分支（以 `grep -n "agent\|Agent" <file>` 逐个确认清零，`agent` 大小写变体都查）。
- [ ] **Step 2:** Run `npm test` + `npx tsc --noEmit`（或 `npm run build`）。Expected: 类型错误清零、测试绿（store 层尚未删，相关测试仍在）。
- [ ] **Step 3:** 浏览器冒烟：画廊/引擎两模式正常切换与生图，无 agent 残留入口。
- [ ] **Step 4:** 提交（需用户同意）：`git commit -m "feat(agent)!: 移除智能体 UI 层（AppMode 收窄为 gallery|engine）"`

---

### Task 3: store 状态与执行链手术

**Files:**
- Modify: `src/store.ts`

**删除清单（对照设计文档 §7 附录 A，行号为盘点时快照，以符号名为准）:**
- 状态字段（439-463）：`agentConversations`、`activeAgentConversationId`、`agentInputDrafts`、`agentSidebarCollapsed`、`agentAssetTab`、`agentAssetPanelCollapsed`、`agentMobileHeaderVisible`、`agentEditingRoundId`、`agentEditingConversationId`、`agentGeneratingTitleIds` + 对应 13 个 action（含接口声明 ~439-488 区域）
- 模块级（119-123）：round AbortController 表、恢复续跑集合、持久化就绪/迁移标志
- 函数：`submitAgentMessage`（2658）、`executeAgentRound`（2920-4000）、会话标题生成调用链（2350 起）、`getActiveAgentConversation`（2181）
- 持久化循环（1235-1300 按条 diff 写 `agentConversations`）与 `initStore` 合并段（1780-1835、1807/1819/1977/2019/4944 各 agent 分支）
- `clearData`（5113-5222）agent 段（abort 轮次、`dbClearAgentConversations`、清 state——**注意保留对一次性迁移的调用**，见 Step 2）
- `exportData`（5505+）导出侧 `agentConversations` 字段移除；`importData`（5616+）保留解析但忽略该字段（老备份兼容）
- `exportZip.ts` 12 处 agent 引用（`getPersistableAgentConversations` 等）
- `isImageReferencedByState`（558-573）：移除 agentInputDrafts/agentConversations 引用检查（保留其他引用源）
- settings 字段：`agentScrollToBottomAfterSubmit`、`agentMaxToolRounds`、`agentWebSearch`、`agentMathFormattingPrompt`、`agentApiConfigMode`、`agentTextProfileId`、`agentImageProfileId`（types.ts AppSettings 149-155 + normalizeSettings 842-848 + DEFAULT_SETTINGS 1415-1421 + `getAgentTextApiProfile/getAgentImageApiProfile` 855-904 一并删；`getPromptReverseApiProfile` 861-868 去掉 agent 分支，仅保留 `getTextApiProfile` 回退）

**保留清单：**
- `textApiProfileId` 与 `getTextApiProfileResolution`（883-894）原样
- db.ts 的 `agentConversations` 建表与读写函数（下个任务用于一次性清理）

- [ ] **Step 1:** 按清单删改；`grep -n "agent" src/store.ts` 清零人工复核（TaskRecord 的 agent* 字段类型、`sourceMode === 'agent'` 的旧数据容错判断除外——这些是读路径兼容，保留）。
- [ ] **Step 2: 一次性存量清理迁移**：`initStore` 内（原合并段位置）加：
```ts
// Agent 功能已移除（2026-09 设计决策）：一次性清空存量会话并释放其引用图；
// 用户确认从未使用，预期为空。建表保留防老库升级报错。
try {
  await dbClearAgentConversations()
} catch { /* 老库无表等情况静默 */ }
```
（`dbClearAgentConversations` 已存在于 db.ts:239-358 区段；确认其幂等。）
- [ ] **Step 3:** `src/lib/persistedState.ts`：`stripPersistedAgentConversations`（151-257）链路改为「丢弃 legacy agent 数据」语义（保留函数但简化为剥离子段，不再迁移到 IndexedDB）。
- [ ] **Step 4:** 删除/改写关联测试：`store.test.ts`、`persistedState.test.ts`、`inputDraftState.test.ts`、`exportZip.test.ts`、`apiProfiles.test.ts` 中 agent 用例（删）与非 agent 用例（改断言）。
- [ ] **Step 5:** Run `npm test`。Expected: 全绿。
- [ ] **Step 6:** 提交（需用户同意）：`git commit -m "feat(agent)!: 移除 store 智能体状态/执行链，存量会话一次性清理"`

---

### Task 4: lib 与测试文件删除 + 改名

**Files（删除，含同名 .test.ts）:**
- `src/lib/agentApi.ts`、`agentAssistantBlocks.ts`、`agentConversationState.ts`、`agentImageReferences.ts`、`agentInputBuilder.ts`、`agentResponseState.ts`、`agentWebSearch.ts`
- `src/lib/agentApi.test.ts`、`agentAssistantBlocks.test.ts`、`agentConversationState.test.ts`、`agentImageReferences.test.ts`、`agentInputBuilder.test.ts`、`agentResponseState.test.ts`（+ agentWebSearch 若有测试）

**Files（修改）:**
- `src/lib/apiProfiles.ts:244-246`：`isAgentTextApiProfile` 改名 `isTextCapableApiProfile`（纯改名，更新全部调用点：apiProfiles 内部、`SettingsModal.tsx` 文本模型服务 Select 处、Task 6 的 SceneSettingsDrawer 若已用旧名）
- `src/lib/agentResponseState.ts` 的消费方（已在 Task 3 清零）复核

- [ ] **Step 1:** 删文件；改名；`grep -rn "agentApi\|agentResponseState\|isAgentTextApiProfile" src/` 清零。
- [ ] **Step 2:** Run `npm test` + `npm run build`。Expected: 全绿。
- [ ] **Step 3:** 提交（需用户同意）：`git commit -m "feat(agent)!: 删除智能体 lib 全家，isAgentTextApiProfile 改名 isTextCapableApiProfile"`

---

### Task 5: 上游升级配置防复活

**Files:**
- Modify: `upstream-upgrade.config.json`
- Modify: `scripts/upgrade-upstream-v2.mjs`（若删除路径策略需要代码支持）
- Modify: `docs/upstream-upgrade.md`（留痕）

- [ ] **Step 1:** 在 `upstream-upgrade.config.json` 增加删除路径清单（机制按现有 preservePaths/删除策略字段的形式扩展）：
```json
"removedPaths": [
  "src/components/AgentWorkspace.tsx",
  "src/components/HistoryModal.tsx",
  "src/components/settings/AgentSettingsTab.tsx",
  "src/lib/agentApi.ts",
  "src/lib/agentAssistantBlocks.ts",
  "src/lib/agentConversationState.ts",
  "src/lib/agentImageReferences.ts",
  "src/lib/agentInputBuilder.ts",
  "src/lib/agentResponseState.ts",
  "src/lib/agentWebSearch.ts"
]
```
（升级器 v2 若无 removedPaths 语义，则实现为：这些路径命中上游变更时**丢弃上游版本并记录 ack**，等价于永久 preserve-删除；实现方式遵循 `scripts/upgrade-upstream-v2.mjs` 既有结构。）
- [ ] **Step 2:** `docs/upstream-upgrade.md` 追加决策记录：智能体功能于 2026-09 移除，后续上游 agent 演进**有意不跟随**；升级遇到这些路径时按 removedPaths 丢弃。
- [ ] **Step 3:** 升级演练：按 `docs/upstream-upgrade.md` 流程对当前上游 ref 跑一次升级（可用 dry-run；无 dry-run 则升级后 `git status` 核验并回滚工作区），确认：agent 文件**未复活**、无意外冲突。
- [ ] **Step 4:** 提交（需用户同意）：`git commit -m "chore(upgrade): 升级器支持 removedPaths，防智能体文件复活"`

---

### Task 6: P1b 回归门

- [ ] `npm test` 全绿；`npm run build` 通过；`npm run lint` 零错误
- [ ] `npm run verify:ui -- http://localhost:5173/`：无 agent 入口；画廊/引擎/Skill（若 P2 已并入）正常
- [ ] 数据兼容冒烟：导入一份含 `agentConversations` 的老备份 ZIP → 不报错、图片正常入库；「清空数据」→ 无残留报错
- [ ] 老库升级冒烟：用带 `agentConversations` 记录的旧 IndexedDB 打开应用 → 控制台无错误、会话被清理
- [ ] 提交（需用户同意）：`git commit -m "feat(agent)!: P1b 智能体移除完成"`
