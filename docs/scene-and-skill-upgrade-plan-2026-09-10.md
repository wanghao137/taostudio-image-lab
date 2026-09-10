# 生图工作台「场景化 + Skill 工坊」升级方案

- 日期：2026-09-10
- 状态：**P1a+P1b+P2 已上线**（P1：f778887；P2 Skill 工坊：feat/skill-workshop-p2 分支 9 提交含对抗终审修复与真实链路冒烟）。P3 打磨归拢待开工（跟进清单见 .superpowers/sdd/progress.md）
- 范围：`src/` 前端工作台 + 本地落盘链路；不涉及引擎（本地批量引擎）与代理后端的行为变更

---

## 0. 结论摘要（TL;DR）

把「板块」从使用习惯提升为产品的一等公民——**场景（Scene）**。顶层导航由「画廊 / 智能体 / 引擎」改为「**人像写真 / 通用创作 / 表情与头像 / Skill 工坊 / 引擎**」。每个场景独立记忆三样东西：**生图模型（引用现有 ApiProfile）、本地保存目录（独立目录句柄）、文本模型（skill 提示词扩写用，沿用 textApiProfileId 自动链作为回退）**，外加尺寸/比例/风格默认值。

Skill 工坊采用 **SKILL.md 开放标准**（Anthropic / ChatGPT / Codex 通用），运行形态是**单轮**：用户填锚点输入 → 文本模型按 skill 正文扩写提示词 → 可编辑预览 → 生图落盘。不做对话、不做编排、不做商店。

**智能体（Agent）功能整体移除**：其有价值的部分（文本模型调用）由 skill 工坊和既有的文本能力路由承接，多轮工具循环经确认零使用。移除需同步修改 `upstream-upgrade.config.json`，否则下次上游升级会把文件带回。

分四期落地：P1a 场景框架 → P1b Agent 手术 → P2 Skill 工坊 → P3 打磨归拢。每期过全量验证门。

---

## 1. 需求与设计原则

用户需求（2026-09-10 原话归纳）：

1. 生图工作分四大板块：人像写真 / 其他（广告、风景、旅行、产品等）/ 表情包·头像·动态 / 基于 skill 的生图（案例：两条 X 长文）。
2. 每个板块独立配置：生图模型、图片本地存储；skill 类板块还需配置文本模型（基于 skill 生成提示词）。
3. 研究智能体功能是否可移除（从未使用过）或并入 skill。

设计原则（约束，优先级从高到低）：

- **简洁**：功能与界面都做减法；新增概念的唯一入口是「场景」。
- **引用不复制**：场景配置引用现有 ApiProfile / 目录句柄，不复制值，避免两处真相。
- **Provider 中立**：不在产品逻辑写死任何网关/host（AGENTS.md 红线）。
- **上游可升级**：所有偏离上游的改动都要在 `upstream-upgrade.config.json` 与升级文档中留痕。
- **每期可验证可回滚**：不搞一次性大爆炸重构。

---

## 2. 第一性原理分析

**本质工作流**：选场景 → 输入简短意图 →（必要时文本模型扩写提示词）→ 生图模型出图 → 自动落到该场景对应的本地目录 → 浏览复用。

当前架构与这个工作流有两个核心矛盾：

**矛盾一：工作是分场景的，配置是全局的。**
四类板块对「模型通道 / 尺寸比例 / 风格 / 保存目录」的要求互相冲突（人像要 3:4 高质量档、表情要 1:1 768 透明、4K 交付另算）。现状只有一套全局 activeProfile，切换板块 = 手工改全局配置，互相覆盖。历史上「表情生图永久切到 sub2api responses 模式」就是没有场景级配置导致的全局 hack——本次升级把它正规化为场景配置后，全局默认恢复自由。

**矛盾二：提示词工程知识（skill）长在产品外面。**
社区已经把高质量提示词工程打包成 SKILL.md（见 §4 调研），而工作台没有承接位置。Agent 本可以承接，但它的形态是「自由对话 + 工具调用循环」，对单人内部工具过重，实际零使用。

**三个推论**：

1. 场景是配置的正确粒度 → 引入 SceneSettings，引用 profile 与目录句柄。
2. skill 的最小充分形态是**单轮文本扩写**（锚点输入 → 提示词），不是对话智能体 → Skill 工坊 = skill 列表 + 一次文本调用 + 生图。
3. Agent 与 skill 工坊在能力上重叠（都是文本模型编排），零使用的一方应让位 → 移除 Agent，其可复用的纯函数下沉到共享层。

---

## 3. 现状盘点（代码证据摘要）

技术栈：React 19 + TS + Vite + Zustand(persist) + Tailwind，自研组件，无路由（`appMode` 状态切换）。视图为 `gallery / agent / engine` 三模式（`src/types.ts:6`，`src/App.tsx:255-327` 分发）。

| 领域 | 现状 | 关键位置 |
|---|---|---|
| 生成分发 | `callImageApi` → `getActiveApiProfile(settings)` → openai 兼容 / fal 两路 | `src/lib/api.ts:9-14`、`src/lib/apiProfiles.ts:1000-1021` |
| Profile 体系 | `ApiProfile[]` + `activeProfileId`；每 provider 记忆 apiKey（providerDrafts）；Images/Responses 双模式各自记忆模型 | `src/types.ts:72-101`、`apiProfiles.ts:500-639,81-92` |
| 文本路由 | `textApiProfileId` 自动解析链：显式指定 > 跟随生图 > 唯一可用；归一化只校验不固化 | `apiProfiles.ts:883-894,814-818` |
| 本地落盘 | 双目录句柄独立授权：画廊 `directory`、引擎交付 `engineDeliveryDirectory`（IndexedDB `localAutoSave` store）+ 权限恢复 effect | `src/lib/db.ts:11-12,362-398`、`src/store.ts:4340-4497` |
| Agent | `agentApi.ts`(926 行) + 7 个专属 lib + `AgentWorkspace.tsx`(1053 行) + store ~30 字段/action + IndexedDB `agentConversations`；**来自上游基线，不在 preservePaths** | 详见 §7 手术清单 |
| 表情资产 | 36 种风格预设、动作帧（5 模板 2×2 关键姿势）、贴纸切图工作台、尺寸预设 | `src/lib/stickerSplit/actionFrames.ts`、`stylePresets.ts`、`StickerSplitModal.tsx` |
| 反推提示词 | 自研「文本模型单轮调用」完整参考实现（POST /responses + instructions + 超时 + 代理链 + 稳健解析） | `src/lib/promptReverse.ts:134-210` |
| 设置 UI | 单模态 5 Tab（api/general/agent/data/about），2159 行 | `src/components/SettingsModal.tsx` |

对本次升级最重要的三个事实：

1. **textApiProfileId 解析链已经存在**——skill 的文本模型配置可以完全踩在这条已上线的链上，只加一层场景覆盖。
2. **目录句柄 + 权限恢复机制已经存在**——场景目录只是多几把 key，机制照抄。
3. **promptReverse.ts 就是「文本模型单轮调用」的样板**——skill 扩写就是它的泛化（instructions 换成 skill 正文）。且它依赖 agentApi 的 3 个纯函数（`createHeaders/extractText/normalizeResponsePayload`），这 3 个函数必须先下沉共享层再删 agentApi。

---

## 4. 外部案例与生态结论

两条 X 均为长文（数据与全文经 fxtwitter API 取回，实锤）：

- **@VoxcatAI**（2026-09-09，129 万浏览）：《我做了个色狼角色摄影师 Skill》——完整的角色扮演式提示词设计师：输入 `{角色}` + 修饰词，按「偷拍机位库 + 动作库 + 焦段语言 + 输出模板」扩写出一组提示词（n=10 时机位各异）。
- **@MANISH1027512**（2026-09-03，46 万浏览）：《从此以后，你也可以是 AI 摄影师》——五要素框架 `[表情]+[服装]+[场景]+[瞬间状态]+[摄影技法]`，核心思想「**骨架 + 变量池**的有边界随机」（只锁锚点，其余维度给厚枚举池），并按 Agent Skills 开放标准开源到 GitHub（vibeshotclub/vsc-skills）。

生态结论：

1. SKILL.md 是**跨厂商开放标准**（Anthropic 规格 6 字段 frontmatter；ChatGPT/Codex 已兼容同格式），社区生图 skill 仓库已经存在（vsc-skills 649 stars，5 个生图 skill）。
2. 传统生图产品（Krea/Recraft/即梦/Gemini）的「配方」仍是风格预设/参考图/自定义指令形态，**没有产品内置 SKILL.md 体系**——采用开放标准 = 直接兼容社区存量内容，零生态成本。
3. 案例验证的可复用模式正是：**锚点输入 → 文本模型按 skill 扩写（骨架+变量池）→ 生图模型出图**。与 §2 推论 2 一致。

对本方案的直接约束：skill 内容格式 = SKILL.md（frontmatter 取 `name/description`，正文即扩写指令）；导入方式 = 指向本地 skills 根目录扫描（社区仓库 clone 下来即可用）。

---

## 5. 候选方案权衡

| | 方案 A：场景切换器（轻量） | **方案 B：场景=持久配置单元 + Skill 工坊（推荐）** | 方案 C：分板块子应用（重） |
|---|---|---|---|
| 思路 | 「切场景」只是批量改全局 activeProfile/尺寸/目录 | 每场景持久记忆 profile 引用/目录句柄/文本模型/默认值；skill=单轮扩写 | 每板块独立路由/页面/独立配置存储，独立编排引擎 |
| 解决矛盾一 | ✗ 配置仍是全局互相覆盖 | ✓ 引用式持久配置，互不干扰 | ✓ 彻底隔离 |
| 解决矛盾二 | ✗ 无 skill 承载 | ✓ SKILL.md 单轮扩写，兼容社区生态 | ✓ 但会做成「agent 编排引擎」，复杂度违背简洁红线 |
| 工程量 | 小 | 中 | 大（重复建设 4 套工作台） |
| 上游升级友好 | 好 | 中（改动集中在解析层与导航，preservePaths 可控） | 差（结构性偏离） |
| 结论 | 否：治标 | **采纳** | 否：违背「简洁」 |

---

## 6. 详细设计（方案 B）

### 6.1 数据模型（`src/types.ts` 增量）

```ts
export type SceneId = 'portrait' | 'general' | 'sticker' | 'skill'

export interface SceneSettings {
  imageProfileId: string | null   // null = 跟随全局 activeProfileId（迁移零成本）
  textProfileId: string | null    // null = 走既有 textApiProfileId 自动链
  defaults: {
    ratio?: string                // COMMON_IMAGE_RATIOS key（src/lib/size.ts）
    tier?: SizeTier               // '1K' | '2K' | '4K'
    transparentBackground?: boolean
    stylePresetId?: string        // 表情场景用 STICKER_STYLE_PRESETS
  }
}

// AppSettings 增量（其余字段不动）：
scenes: Record<SceneId, SceneSettings>   // 归一化时补全缺失场景（DEFAULT_SETTINGS 显式给出）
activeScene: SceneId                      // 默认 'general'
```

要点：

- **引用不复制**：场景只存 profileId。profile 的增删改仍在全局设置里完成；被删 profile 的场景引用在归一化时回落 null（校验不固化，沿用 textApiProfileId 的既有模式）。
- TaskRecord 增量：`sceneId?: SceneId`（存量任务 undefined 视为「通用/全部」）、skill 场景再加 `skillId?: string`、`skillInput?: string`（复现追溯）。

### 6.2 四个内置场景

| 场景 | 生图默认 | 保存目录 | 文本模型 | 默认值 | 备注 |
|---|---|---|---|---|---|
| 人像写真 | 跟随全局 | 独立可配（如 F:\gpt生图\人像） | 可配 | 3:4、高质量档 | P3 可挂内置「写真摄影师 skill」 |
| 通用创作 | 跟随全局（=现状全部能力：4K/编辑/蒙版/收藏） | 独立可配 | 可配（反推用） | 现状默认 | 即现有画廊工作台 |
| 表情与头像 | **指定 sub2api responses 配置**（用户侧选择，产品不写死任何 host） | 独立可配（F:\gpt生图\其他→表情） | 可配 | 1:1、1K(768)、透明 | 既有贴纸资产（切图/动作帧/36 风格预设）入口归拢到此场景；全局默认 profile 解除「表情通道」绑定 |
| Skill 工坊 | 跟随全局或指定 | 独立可配 | **场景级必配**（UI 引导，无可用文本 profile 时明确提示） | 跟随 skill 输出 | §6.4 |

### 6.3 解析链与保存链

**生图 profile 解析**（`apiProfiles.ts` 新增，唯一入口）：

```
resolveSceneImageProfile(settings):
  scenes[activeScene].imageProfileId 命中 → 该 profile
  否则 → getActiveApiProfile(settings)   // 原全局链不动
```

实现要求：审计 `getActiveApiProfile` 全部调用方，任务提交入口统一改为场景解析；TaskRecord 继续快照实际使用的 profile（沿用现有任务级快照机制），保证重试/重跑不随场景漂移。

**文本 profile 解析**：

```
resolveSceneTextProfile(settings):
  scenes[activeScene].textProfileId 命中 → 该 profile
  否则 → getTextApiProfileResolution(settings)  // 既有自动链，语义不变
```

`isAgentTextApiProfile`（`apiProfiles.ts:244`）随 Agent 移除改名 `isTextCapableApiProfile`（纯改名，行为不变，反推链路无感）。

**保存目录链**（`localAutoSave` object store 新增 per-scene key `sceneDirectory:<sceneId>`，读写清函数与权限恢复 effect 照抄 `db.ts:362-398` / `store.ts:4340-4497` 模式）：

```
落盘目标 = 场景目录句柄（授权有效） → 全局 directory（授权有效） → 不落盘（仅 IndexedDB）
```

- 场景设置面板显示「本场景：独立目录 xxx / 跟随全局」，落盘失败 toast 引导重新授权（复用现有一次性权限请求器模式）。
- 引擎交付目录（`engineDeliveryDirectory`）**不动**，属引擎批量链路。

### 6.4 Skill 工坊（核心新功能）

**Skill 定义**：SKILL.md 开放标准。frontmatter 取 `name`（缺省用目录名）、`description`（列表展示用）；正文 = 扩写指令。浏览器内轻量解析（单行 `key: value`，容错：无 frontmatter 的 md 也可导入）。**不执行** skill 内 scripts（浏览器沙箱 + 简洁原则）。

**两个来源**：

1. 内置：`public/skills/<id>/SKILL.md` 随构建分发。首发 2 个社区 skill 已安装（2026-09-10，用户指定）：
   - `vibeshot-candid-photography`：来自 vsc-skills 仓库（commit `cf6cf9f`）原样内置，「骨架+变量池」生活感人像方法论（约 50 场景/27 服装风格/23 机位的厚枚举池）；
   - `voyeur-style-photographer`：@VoxcatAI 的 X 文章整理为 SKILL.md，偷拍感/窥视机位角色摄影体系（六类偷拍机位库 +「被发现」模式 + n=10 多机位批量；作者原文自带安全边界——成年角色、虚构摆拍、仅公开场所——原样保留并加粗）。
   两个来源均未声明开源 license，溯源与使用限制已写入 `public/skills/SOURCE.md`（仅限内部使用、不对外再分发、原样不改动）。自研 skill（人像写真、贴纸表）留待 P3 按需补充。
2. 本地导入：选择本地 skills 根目录（目录句柄持久化到 IndexedDB 新 key `skillsDirectory`，权限恢复复用既有机制），扫描一级子目录的 SKILL.md，缓存清单；与内置分组展示。

**运行流程（单轮，无对话状态）**：

```
选 skill → 填锚点输入（如角色名/主题）
→ [扩写提示词]：文本模型单轮调用
   （system/instructions = skill 正文 + 通用输出约束，user = 锚点输入）
   实现泛化自 promptReverse.ts:154-210：profile 解析、超时、AbortSignal、代理链、稳健文本提取全复用
→ 扩写结果可编辑预览（textarea，可手动改写后再生成）
→ [生成图片]：走本场景生图 profile；n>1 以循环提交实现（与画廊任务模型一致）
→ 任务进画廊（sceneId='skill'，记 skillId + 原始输入）
```

**不做清单（YAGNI 红线）**：skill 商店 / 在线市场、description 常驻+模型自动触发、多轮对话编排、skill 内脚本执行、跨 skill 组合流水线。

### 6.5 UI 信息架构

**桌面 Header**（陶土橙设计语言不变，5 项 tab + 现有右侧功能区）：

```
[TaoStudio] 人像写真 | 通用创作 | 表情与头像 | Skill 工坊 | 引擎     [主题|帮助|设置]
```

- 场景 tab 即画廊过滤器：默认显示该场景任务，画廊顶部「全部」开关一键切换（旧任务无 sceneId 归入通用）。
- 每场景头部一个「场景设置」齿轮 → 抽屉面板（生图模型 / 保存目录 / 文本模型 / 默认尺寸与风格）。**不放全局 SettingsModal**——全局设置只留 provider profiles 管理、代理、数据、关于（agent Tab 随移除删除，剩 4 Tab）。
- Skill 工坊视图：左 skill 列表（内置/本地分组，仅显示 name+description）+ 右侧「输入 → 扩写结果（可编辑）→ 生成」单屏流。生成后跳画廊 skill 视图查看。

**移动端**：底栏 4 场景 tab + FAB 创作抽屉保留；引擎收进「更多」菜单（MobileShell 现有 more 结构）。375px 宽度验收（verify:ui）。

**删掉的界面**：智能体 Tab、Agent 会话抽屉/历史/资产面板、agent 设置 Tab——导航认知负担从「3 个模式（其中 1 个从未用）」变为「4 个场景 + 1 个工具」。
- **无限画布按钮位置**（已定）：从当前 Tab 旁常驻 chip 移到右侧工具区（与主题/帮助/设置一组）的外链图标按钮；移动端收进「更多」菜单。理由：主导航只承载「4 场景 + 引擎」五个内部高频入口，无限画布是独立应用外链，属工具动作，与主题/帮助同级。

### 6.6 表情与头像场景的资产归拢

- 切图工作台 / 动作帧 / 右键菜单入口保持现状（全局可达），表情场景内额外露出：风格预设快捷选择（STICKER_STYLE_PRESETS 摘要 chip）、1:1+768+透明默认值。
- 动态头像：AI 动作帧为当前可用路径（已上线）；整板真 I2V 通道仍是已研究的未来项，本期不碰。
- 场景默认 profile 由用户在场景设置里指定（sub2api responses 配置），全局默认恢复自由——去掉历史 hack。

---

## 7. Agent 移除手术清单（P1b 执行依据）

**结论：整体移除。** 理由：① 零使用（用户确认）；② 有价值能力已被承接（文本编排→skill 工坊+文本路由；生图→场景工作台）；③ 926+1053 行组件 + store ~30 字段/action + 7 个测试文件的维护成本与 UI 负担纯粹是负债。

| 类别 | 处置 | 说明 |
|---|---|---|
| `AgentWorkspace.tsx`、`HistoryModal.tsx`、`settings/AgentSettingsTab.tsx` | 删除 | SettingsModal 删 agent Tab |
| `agentApi.ts` | **先拆后删**：`createHeaders/extractText/normalizeResponsePayload` 下沉到 `imageApiShared.ts`（promptReverse 已依赖） | 其余全删 |
| `agentAssistantBlocks / agentConversationState / agentImageReferences / agentInputBuilder / agentResponseState / agentWebSearch`（.ts + .test.ts） | 删除 | agentResponseState 的 scrub/merge 仅 agent 用 |
| store.ts：agent 状态 ~30 字段/action、`submitAgentMessage`、`executeAgentRound`、标题生成、持久化循环、initStore 合并 | 删除 | 5800 行文件的照片级手术，小步提交 |
| IndexedDB `agentConversations` store | **建表保留**；initStore 一次性迁移：静默清空存量会话（用户零使用，预期为空）并释放其引用图（`isImageReferencedByState` 对应分支随删除收敛） | 防老库升级报错 |
| `ExportData.agentConversations`（备份格式） | 导入侧保留解析并忽略该字段 | 老备份向前兼容 |
| `appMode: 'agent'`、Header/InputBar/TaskCard/DetailModal/HelpModal/MobileShell/MobileComposeSheet/ZipDownloadRouteModal 的 agent 分支 | 删分支 | `agent-round-all` ZIP 路由一并删 |
| `isAgentTextApiProfile` → `isTextCapableApiProfile` | 纯改名保留 | 全局文本路由在用 |
| **`upstream-upgrade.config.json` + `scripts/upgrade-upstream-v2.mjs`** | **必须同步**：删除路径入清单（preservePaths/删除策略） | 否则下次 `upgrade:upstream` 全部复活；这是本方案最大工程风险点 |
| 测试 | 同步删改 7 个 agent 测试 + store/persistedState/inputDraftState/exportZip/apiProfiles 关联用例 | 保持零错误基线 |

---

## 8. 分期实施计划

| 期 | 内容 | 验收标准（完成定义） |
|---|---|---|
| **P1a 场景框架** | SceneSettings 数据模型与两条解析链、四场景骨架与 Header/移动端导航、画廊场景过滤、per-scene 保存目录链 | 四场景各自出图、各自落各自目录；不配任何场景时行为与现状完全一致（general=旧画廊）；`npm test/build/lint` 全绿 + `verify:ui` 双宽度 |
| **P1b Agent 手术** | §7 清单全项（含 upstream-upgrade.config.json 与升级文档留痕） | 全部测试绿；本地跑一次 `upgrade:upstream` 演练确认 agent 文件不复活；clearData/export/import 用例通过 |
| **P2 Skill 工坊** | SKILL.md 解析、内置 2 个社区 skill（已安装到 public/skills/）、本地目录导入、扩写→编辑→生成全链、TaskRecord 溯源字段 | 内置 skill 在工坊直接可选可用并出图；vsc-skills 仓库 clone 后本地导入可运行其中任一 skill；无文本 profile 时有清晰引导；验证门全绿 |
| **P3 打磨归拢** | 表情场景风格露出、人像内置写真 skill、画廊「全部」开关细节、移动端打磨 | 验证门全绿 + 用户实机走查 |

粗估工作量（会话级，非承诺）：P1a 2-3 天 / P1b 1-2 天 / P2 2 天 / P3 1 天。

每期共同验证门（AGENTS.md）：`npm test`、`npm run build`、`npm run lint`（零错误基线）、`npm run verify:ui`；涉及 provider 行为期加跑冒烟脚本。

---

## 9. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| 1 | 上游升级复活 agent 文件 / 大冲突 | 同步改 `upstream-upgrade.config.json`；P1b 验收含升级演练；从此有意不再跟随上游 agent 演进（产品方向决策，记入升级文档） |
| 2 | store.ts 手术回归（持久化/clearData/孤儿图回收） | 小步提交 + 全量测试重点覆盖这三条链；先拆共享函数再删主体 |
| 3 | 场景 profile 解析遗漏调用点（重试/重跑/临时 profile 路径） | 统一入口函数 + 调用点审计清单入 P1a 任务；任务级 profile 快照不破坏 |
| 4 | 旧 settings 无 scenes 字段 | DEFAULT_SETTINGS 显式给出四场景默认（吸取 v0.7.11 升级「DEFAULT_SETTINGS 必须显式 profiles」的坑）；归一化补全不迁移用户数据 |
| 5 | 目录权限是 Chromium 专属能力 | 现状已如此，非新增风险；无权限时回落「仅 IndexedDB」并在 UI 说明 |
| 6 | SKILL.md 解析容错 / 社区 skill 质量参差 | 无 frontmatter 降级为文件名导入；扩写结果必经可编辑预览，用户始终有最终控制权 |
| 7 | 社区 skill 无开源 license | 已核实两个来源均无 license 声明：仅限内部使用、不对外再分发，溯源写入 `public/skills/SOURCE.md`（已落地） |
| 8 | 老备份导入含 agentConversations | 导入侧解析后忽略，不报错 |

---

## 10. 决策记录（2026-09-10 已全部拍板）

1. **引擎入口**：保留顶层 Tab（与四场景并列）。✅
2. **画廊过滤默认行为**：进场景默认看该场景任务 + 一键「全部」切换。✅
3. **内置 starter skill**：安装两条案例 skill（`vibeshot-candid-photography` + `voyeur-style-photographer`），已完成，见 §6.4 与 `public/skills/SOURCE.md`。✅
4. **无限画布按钮**：桌面移到右侧工具区外链图标按钮，移动端收进「更多」（见 §6.5）。✅

---

## 附：调研来源

- 推文全文：`api.fxtwitter.com/VoxcatAI/status/2097511865857507750`、`api.fxtwitter.com/MANISH1027512/status/2095347397509652954`
- SKILL.md 规范：`code.claude.com/docs/en/skills`；ChatGPT/Codex 兼容：`learn.chatgpt.com/zh-Hans/docs/build-skills`
- 社区 skill 仓库：`github.com/vibeshotclub/vsc-skills`（5 个生图 skill）
- 代码现状：Explore agent 盘点报告（2026-09-10，行号均对应当前 main 分支）
