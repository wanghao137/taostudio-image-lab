# 底部参数台遮挡重设计

## 背景

TaoStudio Image Lab 桌面端的底部参数配置台（`InputBar`）采用 `position: fixed` 浮层常驻视口底部，在用户上传参考图或生成图片后，对画廊内容造成严重遮挡，下方一至两行图卡的元数据与操作按钮被永久挡住。

通过代码探索与实际截图确认，遮挡有三层根因：

1. **定位永不可收起**：`src/components/InputBar.tsx:2208` 使用 `fixed bottom-3 ... z-30`，桌面端没有收起/抽屉机制，始终盖在画廊之上。
2. **避让间隙不匹配**：`src/App.tsx:225` 的画廊 `<main>` 仅预留硬编码 `pb-48`（192px），但实际输入栏在有参考图、4K 策略卡、长提示词时常高达 320–420px，缺口达 130–230px。
3. **空间占用过高**：「当前生成策略 / 保持比例 4K / 改比例」卡片在 `InputBar.tsx:2012` 始终展开（约 140–180px），叠加 7 列参数行与最高增长到视口 40% 的提示词框，使栏整体过高。

讽刺的是，`InputBar.tsx:750-780` 已通过 `ResizeObserver` + `visualViewport` 实时计算真实高度并写入 CSS 变量 `--input-bar-clearance`，但画廊的 `pb-48` 从未消费它——只有 `AgentWorkspace.tsx:941` 与 `:1236` 用了。这是一个未完成的机制。

## 目标行为

| 场景 | 期望结果 |
| --- | --- |
| 桌面端首次进入（默认收起） | 底部只剩精简常驻栏（约 60–80px），画廊图卡元数据/操作完整可见 |
| 点击「参数」钮 | 常驻栏上方内联展开参数区，画廊自动上移让出空间，不产生遮挡 |
| 再次点击「参数」钮 | 参数区收起，常驻栏不变 |
| 展开状态下切换尺寸/质量等参数 | 参数一步可达，画廊仍无遮挡 |
| 收起/展开/提示词增长任意状态切换 | 画廊底部留白始终精确等于输入栏真实高度 |
| 刷新页面 | 展开状态按上次选择恢复（localStorage 记忆） |
| 参考图缩略图显示 | 紧凑小缩略图（40×40）显示在常驻栏内，无图时不占位 |
| 窗口宽度 < 640px | 仍使用 `MobileComposeSheet` 抽屉，本次改动不影响 |

## 非目标（YAGNI）

- 不改移动端 shell（`MobileShell` / `MobileComposeSheet` / `MobileMoreParamsSheet`）。
- 不引入右侧抽屉或模态 sheet。
- 不做参数的智能自动显隐（根据尺寸/比例推断是否展开策略卡）。
- 不重构 `InputBar.tsx` 整体结构（2667 行保持），只重组布局分层。
- 不动 `src/store.ts` 的状态结构与字段。
- 不清理 `src/components/input/` 下的 stale 子组件（与本任务无关）。

## 设计

### 1. 确定的交互范式

**混合范式：精简常驻栏 + 按需内联向上展开。**

- 默认状态：底部仅一条精简栏（提示词 + 尺寸快接 + 上传 + 生成），最大化画廊可视面积。
- 按需展开：点击「参数」钮，常驻栏上方用 `.collapse-section` 动画撑出参数区；再点收起。
- 4K 策略卡从常驻移入展开区顶部，默认不再占用常驻空间。

范式选型理由：兼顾「画廊空间最大化」与「参数一步可达」。与 ChatGPT / Claude 输入栏一致的心智模型，降低学习成本。相比「抽屉式」（压缩画廊宽度、参数跳转）和「底部 sheet」（模态中断看图），内联展开在两个维度上表现最均衡。

### 2. 常驻栏结构（默认/收起状态）

常驻栏从左到右包含以下控件：

1. **「参数」切换钮**：小按钮，使用 `lucide-react` 的 `SlidersHorizontal` 图标（项目已依赖该图标库），点击展开/收起上方参数区。展开时变为激活态（图标旋转 90° 或背景高亮）。位于常驻栏最左。
2. **尺寸胶囊（高频快接）**：显示当前尺寸（如 `1024²`），点击弹出迷你 `SizePickerModal`（复用 `InputBar.tsx:1788` 现有弹窗）。这是常驻栏上唯一的参数控件。
3. **提示词输入框**：`contentEditable`（保持 `InputBar.tsx:2402-2448` 现有实现），单行起步，**增长上限改为 `8rem`（128px，约 3 行）**（替换现有 `innerHeight * 0.4` 上限，见 `InputBar.tsx:1274` 的 `adjustTextareaHeight`），避免栏过高。该上限在收起与展开两种状态下一致。
4. **已上传参考图缩略图**：有图时在输入框上方显示一排紧凑小缩略图（**40×40，比现有 52×52 更小**，见 `renderImageThumbs` at `InputBar.tsx:1757`），无图时不占位。
5. **上传按钮（📎）**：保持 `InputBar.tsx:2484` 现状。
6. **生成按钮（→）**：保持 `InputBar.tsx:2504` 现状（agent 运行中变红色 stop）。

参考图缩略图条与提示词框的相对位置保持现有上下结构（缩略图在上、输入框在下），不引入水平并排。

### 3. 展开参数区（点击「参数」后）

展开区位于常驻栏上方，使用 `.collapse-section`（`src/index.css:373-388`，`grid-template-rows: 0fr → 1fr`）做高度动画，零额外依赖。

展开区内容（从上到下）：

1. **4K 生成策略卡**：从常驻移入展开区顶部。内部「保持比例 / 改比例」子面板的折叠行为不变（`renderGenerationStrategy`, `InputBar.tsx:2012-2156`）。
2. **7 列参数行**：现有 `renderParams('grid-cols-7')`（`InputBar.tsx:2474`）整体搬入展开区，包含：
   - 尺寸（按钮，弹 `SizePickerModal`）
   - 精确尺寸（`exact_size` select）
   - 质量（select）
   - 格式（`output_format` select）
   - 透明背景 / 压缩率（PNG 时互斥，`InputBar.tsx:1875-1935`）
   - 审核（`moderation` select）
   - 数量（`n` number input）

> 注：尺寸在常驻栏与展开区都可达——常驻栏是高频快接胶囊（迷你选择器），展开区是完整尺寸按钮。二者共享同一 store 字段 `params.size`。

### 4. 核心修复：画廊避让机制

这是解决遮挡根因的关键一步——把现有未完成的机制补全：

- **修改 `src/App.tsx:225`**：将 `<main className="pb-48">` 改为消费 CSS 变量：
  `className="pb-[calc(var(--input-bar-clearance,12rem)+1.5rem)]"`
- **`--input-bar-clearance` 已就绪**：`InputBar.tsx:750-780` 的 `ResizeObserver` + `visualViewport` 监听会实时发布真实高度。收起时变量自动变小、展开时自动变大、提示词增长时也会更新。
- **与 `AgentWorkspace` 一致**：`AgentWorkspace.tsx:941` 与 `:1236` 已验证此消费模式（`pb-[calc(var(--input-bar-clearance,12rem)+1.5rem)]`），本设计是对同一模式在画廊页的补全。

效果：画廊底部留白始终精确匹配输入栏真实高度，任意状态切换都不再遮挡。

### 5. 展开状态记忆

- **持久化**：用 `localStorage` 存储 key `inputBar.paramsExpanded`（boolean）。
- **恢复时机**：`InputBar` 挂载时读取该 key 恢复展开状态。
- **默认值**：新用户（无 localStorage 记录）默认收起，最大化首屏画廊面积。
- **不自动收起**：生成提交后不自动收起，避免打断连续调参工作流。如未来需要可在设置中加开关，本次不做。

### 6. 移动端边界

- 本次改动仅影响桌面分支（`useIsMobile` 判定 `>= 640px`，见 `src/hooks/useIsMobile.ts:3`）。
- `< 640px` 仍走 `MobileShell` + `MobileComposeSheet`（FAB 触发抽屉）+ `MobileMoreParamsSheet`，交互与遮挡问题不严重，不动。
- `InputBar.tsx` 内部残留的 `sm:hidden` mobile 分支（`InputBar.tsx:2531-2636`）属于 stale 代码，不在本次清理范围，保持原样。

### 7. 能力保留

所有现有参数能力功能不变，只是重新分布到常驻/展开两层：

- fal.ai、4K、精确尺寸、压缩率与透明背景互斥逻辑、审核、数量上限——全部保留。
- `useImageComposer` hook（`src/hooks/useImageComposer.ts`）作为两个面板共享的逻辑层不动。
- store 字段（`prompt` / `inputImages` / `maskDraft` / `params` / `settings`）结构不变。

## 涉及文件

| 文件 | 改动类型 | 说明 |
| --- | --- | --- |
| `src/App.tsx:225` | 修改 | `<main>` 的 `pb-48` 改为消费 `--input-bar-clearance` |
| `src/components/InputBar.tsx` | 修改 | 常驻栏重组（尺寸胶囊常驻、提示词增长上限调低、缩略图缩小），新增展开/收起状态与「参数」钮，参数行与 4K 策略卡移入展开区，新增 localStorage 记忆 |
| `src/index.css` | 不改 | 复用现有 `.collapse-section`（373-388） |
| `src/hooks/useImageComposer.ts` | 不改 | 共享逻辑层不动 |
| `src/store.ts` | 不改 | 状态结构不动 |

## 验证

完成后按 `AGENTS.md` 的 Verification Gates 执行：

```bash
npm test
npm run build
npm run lint
npm run verify:ui -- https://image.taostudioai.com/
```

并在浏览器中实地验证：

- 桌面 1280px：默认收起状态画廊底部图卡元数据完整可见，无遮挡。
- 桌面 1280px：展开参数区，画廊自动上移让出空间，参数一步可达。
- 桌面 1280px：上传参考图、输入长提示词，输入栏增长时画廊仍无遮挡。
- 桌面 1280px：刷新页面，展开状态按 localStorage 恢复。
- 移动 390px：仍走 `MobileComposeSheet`，不受影响。
