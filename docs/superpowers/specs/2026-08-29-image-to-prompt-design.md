# 图片反推提示词（Image-to-Prompt）设计文档

- 日期：2026-08-29（同日完成实证验证 + 全网调研，v3）
- 状态：待用户审阅
- 参考产品：Viko（viko.fun）；全网竞品与学术调研见 §1
- 范围：TaoStudio Image Lab 生图工作台新功能（v1 绿地功能，无既有代码包袱）
- 实验产物：`.omx/reverse-lab/`（step1–step7 脚本）与 `.omx/reverse-lab/artifacts/`（全部输出与 ground truth）

## 1. 全网调研结论（三路来源：Viko 一手、英文/开源生态、中文生态）

### 1.1 Viko 一手解剖（官网/文档站/定价页）

- 形态：Chrome 插件（悬停按 P 反推；V=反推+出图）+ 网页创作空间，四类资产云端同步（关键词/提示词/作品/色卡）。
- 定价：反推 1 积分、高精度 2 积分、生图 6 积分、动作参考 6 积分、色卡 0 积分（本地计算）、变体提示词 0 积分；订阅 $5.90–$24.90/月。
- 输出（官方文档原文立场）：**一段自然语言提示词 + 按图像类型分维度的「画面解构」**；「适合 GPT 图像模型的自然语言提示词」「绝对不用 JSON」「服务于创作，不追求机械还原」。
- 高精度 vs 标准（官方配置项）：标准=「保持整洁，精简冗余」；高精度=「尽可能覆盖所有关键解构参数：机位、构图、色彩、光影、材质」。
- 变体提示词：「保留核心视觉体系，改变 2–4 个具体维度」。
- 解构维度按图型分化：人像摄影（主体/动作表情/造型/身形轮廓/肤色肤调/光线色彩/成像质感）、插画动漫（画风笔触/角色设计/脸部风格/眼型瞳孔/服装道具）、海报版式（版式层级/图层堆叠/字体文字/色彩系统/构图节奏）、产品图（产品主体/卖点表达/品牌情绪/材质印刷感）、通用。官方明言「解构不是固定模板」。
- 后端 = VLM 转售（APIMart、AICOMING、Volcengine Ark），**无公开 API**。差异化在「解构→资产→再创作」闭环，不在反推精度。

### 1.2 英文/开源生态（JoyCaption/Florence-2/CLIP Interrogator/WD14/学术）

- **JoyCaption Beta One**（开源质量标杆，Llama3.1-8B+SigLIP2）：11 种官方反推模式；其 README 的附加指令开关是现成的维度 PRD——光照/相机角度/景别七档/机位高度/构图法则/景深/人造vs自然光/水印/JPEG伪影/图内文字逐字引用/方向宽高比/SFW；**质量关键句：「输出将被 text-to-image 模型使用，避免 meta 短语」**。
- **Florence-2-PromptGen 家族**（~1G 显存）：专训「吐生成器风格 prompt」，v2.0 的 MIXED_CAPTION 一段输出同时服务 Flux 双编码器——「多方言渲染」思想的模型化实现。开源界端到端专训反推的只有这一支，其余全是「通用 VLM + 指令工程」。
- **CLIP Interrogator**：BLIP caption + CLIP 词表排序（classic/fast/best/negative 四模式）；产出绑定 SD1.5/2.x 时代 CLIP 空间，**对 gpt-image 相关性弱**。img2prompt（Replicate）是其 v1 改版，单 string 输出。
- **WD14**：Danbooru 三层 tag（rating/character/general），SD 方言专用。
- **学术**：PEZ（CLIP 空间梯度优化）可读性差、无产品化；Textual Inversion/DreamArtist 产出 embedding 非文本；**DALL-E 3 论文的高密度 caption 重训是「反推应输出自然语言长描述」的证据基础**。
- **Midjourney /describe**：4 组不同角度候选（客观描述/风格媒介/情绪氛围/联想拓展），1️⃣2️⃣3️⃣4️⃣ 一键进入可编辑输入框，🔄 整组重掷；官方立场「是猜测，不能准确复刻」；输出带 `--ar`（比例单列字段，正文不混入）。
- **imageprompt.org**：输出模式下拉 General/Structured/JSON/Flux/MJ/SD，支持 15 种语言含中文，有 Developer API——「多方言 + 结构化」双形态的商业验证。

### 1.3 中文生态

- **双语双输出是最强共识**：「中文长句看懂 + 英文可用」（豆包输出中文长句为社区复刻主流；偷师插件中英文都行；中英对照词库是国民习惯）。
- **豆包是事实上的国民反推入口**（零门槛聊天式）；社区三步指令：「拆解主体、场景、风格、色调、构图和细节」→整合成 prompt。
- 国内平台：通义万相流程内有可选反推开关；LiblibAI 输入框有「提示词反推」按钮（Florence-2 驱动）；即梦=Agent 指令反推+灵感广场看词；可灵/堆友只是「反推结果的粘贴地」；元宝反推口碑差（「过于笼统」）。
- ComfyUI 社区排名：JoyCaption（最强，7.7G 显存劝退）> Florence-2-PromptGen（1G 显存媲美）> WD14/DeepBooru（被超越）；**Qwen3-VL 是 2025 后中文反推主力**。
- **社区最高级批判**（B站高赞）：「把图丢给 AI 反推 = 抽卡，AI 会把结果当成原因」——与本项目 A/B 实验中朴素模板的翻车完全互证（见 §3.2）。
- **社区已自发形成往返验证方法论**：「用 FLUX.1 模型检验反推结果」（反推→再生图→对比）——与 §3.2-⑤ 的往返实验、§5.9 QC 同构。
- MJ /describe 中文社区共识：「四组取共性关键词」；反推词可直接用于可灵/即梦等平台。

### 1.4 调研对设计的总收敛

| 设计决策 | 证据来源 |
|---|---|
| 自然语言长文为最终交付（中文主 + 英文镜像） | DALL-E 3 论文；Viko「适合 GPT 图像模型自然语言」；豆包/即梦范式；双语共识 |
| 结构化 JSON 仅作内部传输，UI 渲染维度卡片 | Viko「绝对不用 JSON」（面向用户）；imageprompt.org Structured/JSON 模式；PromptGen MIXED |
| 多候选（3 条）+ 可编辑 + 一键填入 | MJ /describe 4 候选；Viko 变体；「多候选取交集」社区共识 |
| 动态维度（菜单自选 4~8 个） | Viko「解构不是固定模板」；JoyCaption 开关表；豆包三步指令维度并集 |
| 禁 meta 短语、禁臆测人名品牌、图内文字逐字引用 | JoyCaption 质量关键项；本项目 A/B 实验反证（A 臆测人名） |
| negative prompt / MJ 参数不进输出（gpt-image 无此参数） | 英文调研第 6 条；A 实验反证（吐负面提示词+--ar） |
| 期望管理：「推测而非精确复刻」文案 | MJ 官方立场；CLIP Interrogator「approximate」；JoyCaption 1.5–3% glitch |
| 闭环（填入→生成→对比→收藏）决定留存 | Viko 资产闭环；社区「FLUX 检验反推」方法论 |
| 方案 C（本地小模型）不进 v1 | CLIP Interrogator 绑定 SD 时代；Florence-2-PromptGen 出英文 tag 风格；备注为未来离线选项 |

## 2. 第一性原理分析

反推提示词本质是一个逆问题：生图是提示词到图像的多对一映射 P→I，反推是从 I 反解 P。映射不可逆（无数 P 均可产生相似 I），因此目标不是"唯一正解"，而是"**对目标生成器最有效的一组描述**"——直接推出两条设计结论：

1. **输出必须是多候选**（一条提示词只是解空间的一个采样点；MJ/Viko/社区共识均验证）。
2. **解构维度必须动态**（不同图像的有效描述子空间不同）。

质量决定因素（按重要性）：

1. **VLM 能力**——唯一能执行像素→语言逆映射的组件（全网调研确认：除 Florence-2-PromptGen 外，所有方案本质都是「通用 VLM + 指令工程」；本项目实测 gpt-5-6 可用，见 §3）。
2. **指令工程**——唯一需自研打磨的核心资产（本项目 A/B 实证 + JoyCaption README 模板交叉验证）。
3. **与生成回路的距离**——工作台的原生优势（生成器就在旁边）。

成本结构：Viko 积分制 = VLM 调用转售加价。我们边际成本 ≈ 1700 输入 + 1200 输出 token/次（实测），无新增付费依赖，图片不出自有 provider 链路。

### 2.1 工作台现状盘点（已验证的落点）

| 能力 | 现状 | 位置 |
|---|---|---|
| 看图调用样板 | `callAgentConversationTitleApi`：代理决策/超时/input_image 全套 | `src/lib/agentApi.ts:662-712` |
| 视觉模型选择 | 双 profile；`getAgentTextApiProfile` agent 关闭时回退激活 profile | `src/lib/apiProfiles.ts:798-802` |
| 模态驱动模式 | `stickerSplitSource` state + lazy Modal | `src/store.ts:423,925-929`、`src/App.tsx:31,347` |
| 工具条入口 | DetailModal 图片工具按钮 | `src/components/DetailModal.tsx:580-645` |
| 右键菜单入口 | 全局 contextmenu，需同步 `menuItemCount` | `src/components/ImageContextMenu.tsx:222` |
| 提示词回填 | `setPrompt`（zustand，草稿自动持久化） | `src/store.ts:847-848` |
| 资产沉淀 | `recordPromptHistory(prompt, params)` 去重存 20 条 | `src/store.ts:1049-1066` |
| 图片预缩放 | `resizeImageHighQuality` | `src/lib/imageResizer.ts:105` |
| 代理链 | 与 agentApi 同链路自动继承 | `src/lib/devProxy.ts:110-157` |

## 3. 实证验证（2026-08-29，本机真实链路，step1–step7）

### 3.1 实验设置

- 链路：chatgpt2api 本地 Docker（:3001）`/v1/responses`，模型 `gpt-5-6`，`input_image` 内联 JPEG（1024px q85）；生图走 sub2api（:8090）`/images/generations`，**载荷严格镜像引擎 `compatibleGenerate`**（`server/task-api/service.mjs:2228`：`{model, prompt, size:'1536x2048', quality:'high', output_format:'png', n:1}`）+ 引擎同款重试语义（429/5xx 可重试退避）。
- Ground truth：`F:\gpt生图\*` 现存「成图+真实提示词」配对，选风格两极样本：`portrait`（中文长文人像杂志海报，1047 字提示词含 12 条英文排版文字清单）、`felt`（英文毛毡微缩玩偶插画，材质/风格密集）。

### 3.2 结果

**① 视觉链路**：7/7 反推调用成功，单次 13–27s；token in≈1700 / out≈950–1330。

**② A/B 对照（朴素 vs 结构化，核心结论：结构化全面胜出）**：

| 维度 | 模板 A（朴素） | 模板 B（结构化） |
|---|---|---|
| 格式可控性 | 失控：错误 JSON（16:9 与后文 9:16 自相矛盾）+ Markdown 多段落 | 直接 `JSON.parse` 成功 |
| 目标生成器适配 | 漂移到 MJ/SD 惯例：`--ar`、负面提示词、"适用于即梦/可灵"、8K 词 | 纯中文自然语言，无 MJ 参数无负面提示词 |
| 关键细节保真 | 完全漏掉图中杂志英文排版文字 | **逐字读出图中真实排版文字**（LUMINOUS PRESENCE 等 5 条，与 ground truth 完全吻合） |
| 细节命中 | 泛泛 | 白袜+黑色玛丽珍鞋、草帽、藤编篮、金色逆光光斑全命中 |
| 合规风险 | **主动建议加"埃隆·马斯克风格"（人名臆测）** | 反臆测守则生效，零人名 |

A 的翻车正是社区批判「把图丢给 AI=抽卡」的实证复现。

**③ 动态维度按图型分化**：portrait 选「版式与文字/色彩体系」；felt 选「材质与质感/成像特征」；同图重复运行维度 8/8 重合；`imageType` 在边界图两类间摆动（按信息徽章处理，不做门控）。

**④ 超 ground truth 覆盖现象**：felt 原提示词只写田园场景，gpt-image-2 自行加了火箭/红色跑车/Tesla 文字建筑；三条独立反推一致看到（重复运行逐字读出 "T E S L A"）——模型在看像素而非复述先验；**评估必须往返对比，纯文本对比会系统性低估**。

**⑤ 往返重生成（两样本，双信号相似度：16×16 均值哈希 + 64bin RGB 直方图）**：

| 样本 | 原图 vs 反推重生成(A) | 原图 vs 原词重生成(B，校准基线) | 结论 |
|---|---|---|---|
| portrait | hamming **0.277** / hist **0.872** | 0.406 / 0.639 | 反推显著更相似（原词含大量未实现条件项，反推只述实际内容） |
| felt | 0.344 / 0.685 | hamming **0.285** / hist **0.810** | 原词略胜（其原词本就紧凑无冗余） |

**反推提示词的往返保真度与原提示词同一水平（hamming 差 ±0.06 内），是功能性等价替代**。n=2×1 的方差 caveat 保留（两组 A vs B 距离 0.355–0.465 可见生成方差量级）。通道本身：sub2api 首个 502 重试即过、单张 66–72s——之前"通道不可用"的误判是载荷拼错 + 未按引擎语义重试，已纠正。

**⑥ reverse-of-reverse 闭环一致性**：对 A（反推→重生成图）再反推：imageType/维度数/内容特征（白蕾丝层叠裙/白袜黑玛丽珍鞋/向日葵/回眸/金色逆光）全链路保真。

**⑦ 模板 v3 回归（§5.4 定稿版，两样本）**：portrait 一次通过（promptEn 英文镜像高质量、无 meta 短语、成像特征按新规则纳入忠实复刻）；felt 抓到**尾随逗号缺陷**（`"...。",\n}`）——真实世界的 VLM JSON 形态，解析链已升级防御（见 §5.5），增强解析链对全部 6 份历史产物 6/6 通过。

## 4. 方案对比

**方案 A（推荐，实证背书）：自研反推**——复用自有 provider 的 VLM。零外部依赖、零新增费用、图片不出自有链路、provider 中立、格式语言完全受控、与生成回路零距离。指令模板已三轮实测定型。

**方案 B（否决）：接第三方反推服务**。Viko 无 API；imageprompt.org 等需图片外发+按次付费+vendor 锁定，违反 provider 中立。

**方案 C（否决，留作未来离线选项）：本地小模型**。CLIP Interrogator 绑定 SD 时代 CLIP 空间对 gpt-image 弱；Florence-2-PromptGen（1G 显存）出英文 tag 风格，可作未来离线兜底备注，不进 v1。

## 5. 方案 A 详细设计

### 5.1 模块与数据流

```
入口（DetailModal 工具条 / ImageContextMenu 右键）
  → store.setPromptReverseSource({ imageId })
  → App 渲染 lazy <PromptReverseModal>
      ├─ ensureImageCached(imageId)
      ├─ resizeImageHighQuality(≤1536px, JPEG q85)
      ├─ getPromptReverseApiProfile(settings)
      ├─ callPromptReverseApi({settings, profile, imageDataUrl, signal})
      ├─ parsePromptReverseResult(text)   // 四级解析链，见 5.5
      └─ 展示 → [复制(中/英)] [填入提示词(按候选)] [自动记入提示词历史]
```

### 5.2 新增文件与改动

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/lib/promptReverse.ts` | 新增 | `PROMPT_REVERSE_INSTRUCTIONS`（§5.4 定稿）、`callPromptReverseApi`、`parsePromptReverseResult`、`PromptReverseResult` 类型 |
| `src/components/PromptReverseModal.tsx` | 新增（lazy） | 反推结果模态 |
| `src/store.ts` | 小改 | `promptReverseSource` state + setter（仿 `stickerSplitSource`） |
| `src/App.tsx` | 小改 | lazy import + 渲染模态 |
| `src/components/DetailModal.tsx` | 小改 | 工具条"反推提示词"按钮 |
| `src/components/ImageContextMenu.tsx` | 小改 | 菜单项 + `menuItemCount` 同步 |
| `src/lib/apiProfiles.ts` | 小改 | `getPromptReverseApiProfile` |
| 测试 | 新增/同步 | 解析器（含尾随逗号用例）与 profile 解析单测；同步测试工厂（mock 模块加导出须同步测试工厂） |

### 5.3 模型解析（零新设置项）

1. `agentApiConfigMode !== 'off'` 且 `agentTextProfileId` 有效 → 用它；
2. 否则激活 profile 是 `openai + responses` 类型 → 用激活 profile（gallery-only 开箱即用）；
3. 否则 `null`，模态引导："请在 设置 → API 配置 中启用 Agent 独立配置并选择 Responses 类型的文本模型"。

### 5.4 指令模板定稿（v3，三轮实测版本，实现时原文内置）

```
你是一位顶级的视觉分析师与 AI 生图提示词工程师。你的输出将直接用于 OpenAI 兼容的 gpt-image 类图像生成器。

任务：对输入图片做「反推提示词」——写出能最大限度重现这张图的生成提示词。

工作方法（内部完成，不要输出思考过程）：
1. 先判断图片类型：portrait（人像摄影）/ illustration（插画动漫）/ poster（海报版式）/ product（产品图）/ general（通用）。
2. 从下面的维度菜单中，挑选对这张图最关键、最能决定生成结果像不像的 4~8 个维度：主体与身份特征 / 动作与表情 / 服装造型与道具 / 环境场景 / 构图与机位镜头 / 光线 / 色彩体系 / 材质与质感 / 画风与媒介 / 成像特征（颗粒、景深、锐度）/ 版式与文字 / 氛围情绪。
3. 只描述图中可见的内容，禁止臆测不可见的细节、人名、品牌；图中有可读文字时原样引用；不确定的细节用「大约」「类似」弱化表述。
4. 提示词用中文自然语言成段描述（不是标签堆砌），语义完整、空间关系清晰、包含风格与质感线索，不使用 Midjourney 参数语法。正文禁止出现「这张图片」「画面展示了」等元描述措辞，直接以画面内容开头。
5. 「忠实复刻」必须完整覆盖你选中的全部维度（含成像特征，如胶片颗粒、景深、锐度）。

输出要求：只输出一个 JSON 对象，不要输出任何其他文字或代码围栏，字段如下：
{"imageType":"portrait|illustration|poster|product|general","breakdown":[{"dimension":"<维度名，中文>","text":"<该维度的精准描述，一句话>"}],"prompts":[{"label":"忠实复刻","text":"<完整中文提示词，重现整图所有关键维度>"},{"label":"风格强化","text":"<同体系但强化画风与质感表达的变体>"},{"label":"精简速写","text":"<保留核心识别特征的最短可用提示词>"}],"promptEn":"<忠实复刻的英文镜像版，语义等价，可直接用于英文生图API>"}
```

设计出处：动态维度（Viko）/ 维度菜单并集（JoyCaption 开关表 + 豆包三步指令 + Viko 解构维度）/ 反臆测与人名禁令（JoyCaption + A 实验反证）/ 禁 meta 短语（JoyCaption 质量关键项）/ 三候选（MJ 4 候选 + Viko 变体 + 逆问题结论）/ promptEn（中文生态双语共识）。

### 5.5 输出契约与解析

```ts
interface PromptReverseResult {
  imageType: 'portrait' | 'illustration' | 'poster' | 'product' | 'general'
  breakdown: Array<{ dimension: string; text: string }>
  prompts: Array<{ label: string; text: string }>   // 忠实复刻 / 风格强化 / 精简速写
  promptEn?: string                                   // 忠实复刻英文镜像
}
```

四级解析链（实证 6/6 通过；尾随逗号为实测真实缺陷）：

1. 直接 `JSON.parse`；
2. 去尾随逗号（`/,\s*([}\]])/g`）再 parse；
3. 剥 ```json 围栏（含去尾逗号）再 parse；
4. 首个 `{` 到末个 `}` 截取（含去尾逗号）再 parse；
5. 全失败 → 整段文本兜底为单条 prompt、`breakdown` 空，UI 永远有东西可看。

`imageType` 为信息徽章不做门控（实测边界图会摆动）；`prompts` 缺失/空时走兜底；`promptEn` 缺失时隐藏英文区不报错。

### 5.6 调用形态

- 仿 `callAgentConversationTitleApi`：无 tools、非流式、`input_image` 内联、`profile.timeout` 超时、AbortController 双信号、`buildApiUrl(baseUrl,'responses',…)` 自动继承代理链。
- `profile.reasoningEffort` 透传（= Viko「高精度档」的免费等价物；Viko 高精度定义「机位、构图、色彩、光影、材质」已被模板规则 2/5 覆盖）。
- v1 非流式（实测 13–27s，网关抖动需重试兜底优先）；模态骨架屏 + 计时 + 取消 + 手动重试。v1.1 视体感评估流式。
- 网关载荷教训（本次实证）：请求字段严格镜像既有成功路径，不自创载荷；错误按「可重试（429/5xx/网络）/不可重试」分类，模态提供手动重试。

### 5.7 UI（PromptReverseModal）

- 布局：桌面左图右果（图 ≤40% 宽），移动上下堆叠；风格对齐 StickerSplitModal。
- 结果区：`imageType` 徽章 + **原图尺寸徽章**（比例不混入提示词正文——MJ /describe 的 19:32 教训）+ `breakdown` 维度卡片 + 三候选提示词（分段切换，每条独立「复制」「填入提示词」，默认选中「忠实复刻」，文本可编辑，编辑后以编辑版为准）+ `promptEn` 英文镜像区（独立一键复制）。
- 顶部一行期望管理文案：「反推是对画面的推测而非精确复刻，可编辑后再生成」（MJ 官方立场同款）。
- 「填入提示词」：`setPrompt(候选文本)`，不自动提交；同时自动 `recordPromptHistory(候选文本, 当前params)`（= Viko 提示词册的工作台等价物）。
- 状态：加载（骨架+计时）/ 错误（信息+重试）/ 成功；关闭模态即 abort。
- 入口：DetailModal 工具条 + ImageContextMenu 菜单项（对任何有 `imageId` 的图开放）。

### 5.8 错误处理

| 情形 | 行为 |
|---|---|
| 无可用 Responses profile | 引导文案 + 指向设置 |
| 请求失败/超时/abort | 错误态 + `重试` 按钮 |
| 非 JSON/格式损坏 | 四级解析链 → 整段文本兜底 |
| 图片超大 | 发送前预缩放 ≤1536px JPEG（实测 1024px 已逐字读出排版文字） |

### 5.9 反推质量 QC 方法论

唯一客观度量是**往返对比 + 校准基线**（§3.2-⑤）：反推候选重生成(A) 与 原始提示词重生成(B) 同时跑，双信号（16×16 均值哈希 + 64bin RGB 直方图）对比，A 不得显著劣于 B。工具：`.omx/reverse-lab/step5/6/7`。**每次修改 `PROMPT_REVERSE_INSTRUCTIONS` 必须跑 step7 回归**（契约解析 + promptEn + meta 短语检查），影响较大时加跑 step5/6 往返。社区同构方法论：「用 FLUX 检验反推结果」。

### 5.10 测试与验收门

- 单测：`parsePromptReverseResult`（纯 JSON / 尾随逗号 / 围栏 / 杂文包裹 / 非法兜底 / 缺 prompts 兜底六例）、`getPromptReverseApiProfile`（agent on/off × profile 类型三例）。
- 现有测试工厂同步新导出。
- 门：`npm test`、`npm run build`、`npm run lint`（基线零错误）；浏览器实机验证桌面 + 移动两档宽度。

## 6. 分阶段范围

- **v1（本设计）**：两入口、模态、动态解构、三候选中文提示词 + promptEn 英文镜像、按候选回填 + 历史、期望管理文案、原图尺寸徽章。
- **v1.1/v2 候选（明确不做进 v1）**：
  - InputBar 参考图缩略图悬停"反推"按钮（缩略图无 `data-image-id`，需小改）
  - 色卡本地提取（canvas 量化，0 API 成本 = Viko 0 积分档等价物）
  - 流式输出；显式"标准/高精度"档位开关（当前由 reasoningEffort + 规则 2/5 隐式承担，Viko 三件套已由三候选映射：标准↔精简速写、高精度↔忠实复刻、变体↔风格强化）
  - Agent 工作区内联反推；反推结果内"立即生成相似图"（研究证实"反推→并排对比"闭环价值高，v1 用「填入提示词」+手动生成替代先验证频率）
  - 独立反推历史列表；Florence-2-PromptGen 本地离线兜底
  - 词卡级资产（每条维度单独收藏，= Viko 词卡）——待 v1 使用频率验证

## 7. 开放问题（默认取值已定，可推翻）

1. 反推结果自动记入提示词历史？——默认**记入**（20 条上限去重控污染）。
2. `填入提示词` 直接覆盖输入框？——默认**覆盖**（与历史回填语义一致，草稿有自动保存）。
3. 预缩放上限 1536px——实测 1024px 已够；对极小图不放大。
4. promptEn 只做「忠实复刻」的英文镜像（不做三候选全量英文）——双语共识的核心是"看懂+可用"，全量×2 收益递减且拖长输出（felt 样本 1331 token 已接近舒适上限）。
