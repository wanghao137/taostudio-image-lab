# gpt-image-2.5 官方 API 参数一致性审查报告

审查日期：2026-09-09（上游 v0.7.11 升级上线当天，a3e3d09）
信息来源：OpenAI 官方 OpenAPI 规范（openai.yaml）、官方 changelog（2026-09-08）、官方模型页/指南/弃用页、开发者论坛官方公告。所有官方事实均可溯源；社区/第三方网关行为单独标注。

## 一、gpt-image-2.5 官方事实清单

### 1. 模型 ID（官方共 4 个，无裸 `gpt-image-2.5`、无 mini）

| ID | 定位 |
|---|---|
| `gpt-image-2.5-flare` | 快速、高质量日常生图；官方推荐起步模型 |
| `gpt-image-2.5-flare-2026-09-08` | flare 日期快照 |
| `gpt-image-2.5-sunburst` | 最强图像模型，编辑精度最高，生成更慢 |
| `gpt-image-2.5-sunburst-2026-09-08` | sunburst 日期快照 |

- 两个都是官方 ID（非第三方命名）。官方建议：大多数场景用 Flare，需要更高编辑精度/控制用 Sunburst。
- token 单价两者完全相同（output $30/1M）；但 max 档单图成本 sunburst 更高（1536x1024 max：flare $1.233 vs sunburst $1.672；4K max：$7.397 vs $10.036）。
- `gpt-image-2` 未弃用（弃用的是 gpt-image-1/-1-mini/-1.5/chatgpt-image-latest 与 dall-e-2/3）。官方对**新集成**建议直接用 2.5。
- Images API 的 `model` 规范默认值是旧模型（generations 默认 dall-e-2、edits 默认 gpt-image-1.5、Responses 工具默认 gpt-image-1）——实际使用必须显式指定 2.5 ID。

### 2. Images API 参数（generations / edits）

| 参数 | 官方取值 | 我们工作台 |
|---|---|---|
| model | 上述 2.5 四 ID、gpt-image-2 等 | ✅ flare 默认 + sunburst（datalist 双选项），任意手填网关 ID |
| prompt | 最长 32000 字符 | ⚠️ 无客户端长度校验（服务端会报错；日常使用无碍） |
| size | 固定档 1024x1024/1536x1024/1024x1536/auto + 任意 WIDTHxHEIGHT（16 倍数、宽高比 1:3–3:1、最长边 3840、总像素 655,360–8,294,400、>2560x1440 实验性） | ✅ **size.ts 约束常量与官方完全一致**（SIZE_MULTIPLE=16、MAX_EDGE=3840、MAX_ASPECT_RATIO=3、MIN/MAX_PIXELS 同值）；固定档+13 种比例预设+自定义宽高+4K 资产管线 |
| quality | low/medium/high/**xhigh/max**（仅 2.5）/auto | ✅ 已随 v0.7.11 升级对齐：仅 2.5 模型显示 xhigh/max，其他模型提交前自动降 high；fal 2.5 透传 |
| background | transparent/opaque/auto（transparent 须 png/webp） | ✅ 透明开关按 profile 的 transparentBackgroundMethod 走 api(参数)/local(后处理)；chatgpt2api 叠加提示词方案保留 |
| moderation | low/auto | ✅ 已发送（edits multipart 无此字段，我们按官方契约处理） |
| output_format / output_compression | png/jpeg/webp，0–100 | ✅ 一致 |
| n | 1–10 | ✅ MAX_OPENAI_OUTPUT_IMAGES=10（fal 限 4 符合 fal 契约） |
| input_fidelity | high/low（gpt-image-1/1.5+ 支持） | ❌ **未支持**（唯一缺失的官方参数） |
| stream / partial_images | bool / 0–3 | ✅ 流式开关+partial_images 已实现 |
| edits 多图 | 最多 16 张 | ✅ API_MAX_IMAGES=16 |
| mask | PNG（官方文档自身 4MB/50MB 表述不一） | ✅ 掩码编辑链路已有 |

### 3. Responses API image_generation 工具

| 官方能力 | 我们工作台 |
|---|---|
| tool.model 可独立指定图像模型（枚举含 2.5 全部 ID；默认 gpt-image-1，显式指定更优） | ✅ v0.7.11 新增 imageGenerationModel 字段：设置界面新输入框+datalist、?imageGenerationModel= URL 参数、分享链接导出；存量 profile 留空=不发送（保持旧行为），新建默认 flare |
| tool.quality 含 xhigh/max | ✅ 已透传（经 paramCompatibility 守卫） |
| tool.size / background / output_format / output_compression / moderation / input_image_mask / partial_images | ✅ 均已实现 |
| 工具无 n 参数（一次一张） | ✅ Agent 批量走逐张工具调用 |
| 宿主模型须 gpt-5 及以后 | ✅ 默认 gpt-5.6-sol，文本路由独立 |

### 4. fal.ai（第三方，非官方基准）

上游 v0.7.11 已适配 fal 的 2.5 端点（`openai/gpt-image-2.5/{sunburst,flare}` 自动补 `/text-to-image`、`/edit` 后缀）+ xhigh/max 透传 + 原生透明 background。已随升级吸收（fal 透明默认 local→api，存量显式配置不变）。

## 二、一致性结论

**升级后我们的生图参数已与 gpt-image-2.5 官方 API 全面对齐。** 关键对齐项：模型 ID 双变体、xhigh/max 质量档（含非 2.5 自动降档）、Responses 工具独立图像模型、尺寸全部约束常量（本就一致）、n/partial_images/moderation/background/输出格式。

**仅有的两个缺口（均为低优先）**：
1. `input_fidelity`（high/low）未暴露——影响参考图编辑的输入保真控制，可作为后续小功能加入编辑参数区。
2. prompt 32000 字符上限无客户端预检——超长中文提示词场景可在提交前给出提示。

**有意保留的本地差异（非遗漏）**：
- 默认模型 flare 而非上游的 sunburst——flare 是官方推荐的日常起步模型，且与我们网关（chatgpt2api 2.5 别名补丁）现状一致；sunburst 已进 datalist 一键可选。
- 手填 `gpt-image-2` 粘住不迁移——官方未弃用 gpt-image-2，且部分网关仅认旧 ID。
- exact_size 4K 的请求侧收口（1K 底图+本地放大）是我们针对网关真实渲染能力的实测决策，4K 目标尺寸仍由 params.size 保留。

## 三、官方来源

- 官方公告帖：community.openai.com/t/introducing-gpt-images-2-5-in-the-api-and-chatgpt/1395897（2026-09-08 发布）
- API changelog：developers.openai.com/api/docs/changelog（2026-09-08 条目）
- OpenAPI 规范提交：github.com/openai/openai-openapi/commit/21cb7e98
- 模型页：developers.openai.com/api/docs/models/gpt-image-2.5-{flare,sunburst}
- 指南：developers.openai.com/api/docs/guides/image-generation、/guides/image-prompting
- 弃用页：developers.openai.com/api/docs/deprecations
