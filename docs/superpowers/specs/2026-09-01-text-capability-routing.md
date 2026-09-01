# 文本能力路由（Text Capability Routing）设计

日期：2026-09-01
状态：已实现并通过对抗式审查（同日），随修复记录见 §5
前置：2026-08-29 反推提示词设计（docs/superpowers/specs/2026-08-29-image-to-prompt-design.md）

## 1. 问题陈述

用户实际场景：生图用 chatgpt2api（OpenAI 兼容 · images 模式），文本/视觉理解用另一个 OpenAI 兼容配置（responses 模式，如 sub2api gpt-5-6）。激活 chatgpt2api 生图时，反推提示词、Agent 会话标题等文本类功能全部不可用——提示「暂无可用的反推模型配置」，必须手动把激活配置切到文本型 profile，用完再切回来。类似场景（标题、Agent、未来的视觉 QC 等）会不断出现。

## 2. 现状代码事实（2026-09-01 逐一核实）

- 多 profile 体系已存在：`settings.profiles[]`（SettingsModal 列表/拖拽/复制/切换），`activeProfileId` 单一激活。
- 生图路径：`getActiveApiProfile`（apiProfiles.ts:914）→ api.ts dispatch，生成/编辑/4K 全部走激活 profile。**这是 activeProfileId 的本职。**
- 文本能力判定：`isAgentTextApiProfile`（apiProfiles.ts:204）= `provider === 'openai' && apiMode === 'responses'`。provider 'openai' 是「OpenAI 兼容」类型（baseUrl 可指向任意网关），判定覆盖面足够，且是结构化判定（provider 中立）。
- 文本能力现状解析 `getAgentTextApiProfile`（apiProfiles.ts:798）：
  - `agentApiConfigMode === 'off'`（默认）→ **无条件返回 activeProfile**（不管支不支持文本）；
  - native/hybrid → `agentTextProfileId`。
- 反推 `getPromptReverseApiProfile`（apiProfiles.ts:804）：agent 模式 on → agentTextProfileId；off → 仅当激活 profile 本身是文本型才可用，否则 null。
- `agentTextProfileId` 的归一化（apiProfiles.ts:756-759）：显式有效 > active 是文本型 > 第一个文本型 profile，**推导结果被固化进字段**。
- 文本消费方：Agent 会话主循环（store 三处）、Agent 配置校验 `getAgentProfileValidationError`、Agent 会话标题生成（profile 经参数注入，源头同解析链）、反推。
- UI：文本 profile 选择器只存在于 AgentSettingsTab（`agentApiConfigMode !== 'off'` 时显示），API 主配置区没有「文本服务」概念。

## 3. 第一性原理分析

### 3.1 问题本质：一个状态变量承载了两个正交决策

`activeProfileId` 同时驱动两个语义正交的路由决策：

- **维度 A · 生图路由**：图片生成请求发到哪。由成本/质量/配额决定，用户按任务高频切换。
- **维度 B · 文本能力路由**：文本/视觉理解请求发到哪。由「哪个 provider 支持文本」决定，一旦确定近乎静态。

B 被隐式绑定到 A（off 模式下文本=激活项）。当 B 的正确答案 ≠ A 的当前值（生图走 chatgpt2api、文本走 sub2api），用户被迫通过切换 A 来间接驱动 B——代价是 A 被污染（生图也被切走）。这不是 UI 缺陷，是**路由域模型错误：按「配置项」路由，而正确模型是按「能力」路由**。

### 3.2 正确模型：能力路由（capability-based routing）

系统只有两类能力需求：`image-generation` 与 `text(responses)`。每个 profile 的能力由既有结构化字段隐式声明（provider+apiMode），无需新增声明机制。每个能力各需一个路由决策：

- image → 沿用 `activeProfileId`（现状语义保留，生图工作流零变化）；
- text → 独立路由决策 + 一个「自动跟随」默认策略兜住单配置的常见情形。

### 3.3 方案否决记录

- **每功能独立配置**（反推一个配置、标题一个配置…）：配置项数=功能数，爆炸；用户心智里「文本走哪」是一个问题，不应拆成 N 个。否决。
- **失败自动 fallback 到其他 profile**：隐式魔法，可能烧错 key，错误恢复语义混乱（重试该不该换路由？），不可预期。否决。
- **noProfile 态加快捷切换入口**：治标，仍需来回切换且污染生图激活态。用户已明确此体验不可接受。否决。
- **把 agentTextProfileId 直接全局化**：字段归一化会固化推导值（2 节），「跟随激活」语义会被固化结果覆盖失效；且与 agent 三态语义纠缠。需新字段。否决直接复用。

## 4. 定稿方案：全局文本路由 + Agent 覆盖保留

### 4.1 数据模型

`AppSettings` 新增 `textApiProfileId?: string | null`：

- `null`/缺省 = **自动（auto）**，是默认值；
- profile id = 显式选择。

`normalizeSettings` 只做有效性校验（指向的必须是文本型 profile，无效清 null），**绝不把推导值固化进字段**——auto 语义靠运行时解析，落库固化会让「跟随激活」失效（这是现有 agentTextProfileId 归一化的已知缺陷，新字段必须避开）。旧数据零迁移：缺省即 auto。

### 4.2 运行时解析 `getTextApiProfile(settings)`

```
1) textApiProfileId 有效            → 用它（显式意图最优先）
2) auto 且激活 profile 是文本型      → 跟随激活（单配置用户零变化；urlSettings 覆盖兼容）
3) auto 且 profiles 恰有唯一文本型   → 自动采用（目标场景零操作直接修复）
4) auto 且 0 个文本型               → null（文案：没有可用文本配置）
5) auto 且 ≥2 个文本型且激活非文本型 → null + 歧义提示（要求显式选择，不静默猜）
```

返回 `{ profile, resolvedBy: 'explicit' | 'active' | 'sole' | null }`，供设置摘要与错误文案展示「当前文本服务：sub2api · gpt-5-6（自动）」。

### 4.3 消费方切换（最小改动面）

- **反推** `getPromptReverseApiProfile`：改为 agent 模式 on 时 agentTextProfileId 覆盖（agent 用户零变化），否则走 `getTextApiProfile`。
- **Agent 会话标题**：off 模式下从「activeProfile」改为 `getTextApiProfile`——目标场景下标题从不可用变为自动可用，纯改善；native/hybrid 不变。
- **Agent 会话主循环 / getAgentProfileValidationError / AgentSettingsTab 三态**：全部不动。
- **生图全部路径**：不动。

### 4.4 UI

- SettingsModal → API 配置 tab，激活配置旁新增「文本模型服务」Select：
  - 选项 = 「自动（跟随生图或唯一可用配置）」+ 全部文本型 profile（`${name} · ${model}`，构造复用 SettingsModal 现有 agentTextProfiles 过滤）；
  - 旁注实时显示解析结果与来源（自动/显式）；
  - 0 个文本型 profile 时显示引导文案（新建 OpenAI 兼容 · Responses 模式配置）。
- 反推 noProfile 态文案重写：「生图配置（{name}）不支持文本请求。请在 设置 → API 配置 → 文本模型服务 选择一个 Responses 模式配置。」保留「打开设置」按钮（setShowSettings 定位到 api tab）。

### 4.5 兼容矩阵（逐格推演）

| 用户形态 | 行为变化 |
|---|---|
| 单 profile（openai+responses） | 无（auto 链 2，与现状一致） |
| 单 profile（chatgpt2api 等纯生图） | 文本功能依旧不可用，但文案说清原因 |
| **目标场景：chatgpt2api 激活 + 存在唯一文本型 profile** | **零操作修复（auto 链 3）** |
| 多个文本型 profile | 需一次显式选择（歧义显式化，仅一次） |
| agentApiConfigMode native/hybrid | 无（agentTextProfileId 覆盖优先） |
| urlSettings ?apiUrl/&apiMode=responses 覆盖 | 兼容（patch 激活 profile，auto 链 2 跟随） |
| 旧持久化数据 | 零迁移（缺省 auto） |
| 预置配置合并（presetConfig） | textApiProfileId 不参与预置合并，自然保留 |

### 4.6 实现锚点

- `src/types.ts`：AppSettings + `textApiProfileId?: string | null`。
- `src/lib/apiProfiles.ts`：normalizeSettings 校验段；新增 `getTextApiProfile`；改 `getPromptReverseApiProfile`。
- `src/store.ts`：标题生成 profile 来源切 `getTextApiProfile`（off 分支）。
- `src/components/SettingsModal.tsx`：API tab 新增文本模型服务 Select + 解析摘要。
- `src/components/PromptReverseModal.tsx`：noProfile 文案。
- 测试：`src/lib/apiProfiles.test.ts` 补解析链 5 分支 + normalize 幂等（auto 不被固化）+ 显式选择校验。

### 4.7 为什么这是最优

1. **正交归位**：生图路由与文本路由各自独立，切换互不污染——根因层面修复，而非加切换捷径。
2. **零迁移 + 零操作覆盖目标场景**：auto 策略让「生图 chatgpt2api + 唯一文本配置」用户升级后即用，无需任何配置动作。
3. **歧义显式化**：多候选不静默猜，一次选择永久生效；解析来源（自动/显式）全程可见。
4. **可扩展**：未来任何文本/视觉类功能（视觉 QC、批量审查、提示词改写…）统一走 `getTextApiProfile`，不再每功能一个配置项。
5. **Agent 零扰动**：三态语义与覆盖关系原样保留。
6. **provider 中立**：能力判定仍是结构性 provider+apiMode，无任何 host/vendor 硬编码。

## 5. 实现与对抗式审查记录（2026-09-01）

### 5.1 实现时的两处事实修正

- **标题生成不改**（§4.3 修正）：标题的 profile 经参数注入，源头是 `getAgentTextApiProfile`，且在 agent 配置校验门之后——off 且激活配置非文本型时根本不可达，改它无收益有风险。反推是唯一真正的 off 模式文本消费方。
- **agent 回落路径与旧行为等价**（审查攻击面 7 核实）：normalizeSettings 对 agentTextProfileId 有回填（存在任一文本型 profile 时必被回填），因此 getPromptReverseApiProfile 的 agent 分支几乎必命中；落到 getTextApiProfile 仅发生在"不存在任何文本型 profile"时，此时新旧行为都返回 null。agent 用户不存在"配置失效时静默换用别的 profile"的风险。

### 5.2 对抗式审查修复

- I-1（Important）·Agent 模式摘要失真：SettingsModal 的「文本模型服务」摘要原不考虑 agentApiConfigMode，agent native/hybrid 下会误报实际路由。已修：检测到 Agent 独立配置开启且存在有效 Agent 文本配置时，摘要改述「反推与智能体优先使用 Agent 文本配置 X，此处选择在关闭后生效」。
- M-1（Minor）·预置只读部署未锁定：新 Select 补 `disabled={defaultConfigOnly}`，与相邻「当前配置/服务商类型」锁定控件对齐。
- N-2（Nit）·补测试：新增「agent 文本配置优先于全局 textApiProfileId 显式选择」用例锁定覆盖顺序。
- N-1 死防御（显式分支的 if(explicit)）保留：normalize 契约变更时的防线，无害。

### 5.3 验证

- 单元：apiProfiles.test 90/90（新增 8 条：解析链 5 分支、幂等不固化、无效显式清空、agent 覆盖优先）；全量 964/964、build 通过、lint 0 errors（58 warnings 与基线一致）。
- 浏览器实测 7/7（.omx/reverse-lab/verify-text-routing.mjs，localStorage 预置双配置）：目标场景（生图 images 激活+唯一文本配置）反推真实自动路由 sub2api 出 done 结果；设置摘要「自动采用唯一可用文本配置」；生图激活不受影响；显式选择摘要「手动指定」；多文本歧义被拦截且文案引导去「文本模型服务」。
