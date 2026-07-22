# YouMind 50 提示词全链路测试报告

测试时间：2026-07-22 至 2026-07-23（Asia/Shanghai）

## 结论

本轮本地真实 Provider 全链路验收通过：最终批次 `50/50` 成功，独立验收器重新读取并验证 `100/100` 个 PNG，未发现尺寸、SHA-256、整数像素比或整条透明边错误。

结论为 **Go（本地 Task API / MCP / 独立 Skill）**。生产网页仍部署在 Vercel；Task API 当前是本地参考服务，不在本次 Vercel 部署范围内。

## 数据集

- 来源：`https://github.com/YouMind-OpenLab/awesome-gpt-image-2`
- 来源 commit：`56d75956f727cc49dd45ef4fb397018a38a6e397`
- 解析条目：120
- 排除依赖参考图条目：15
- 最终提示词：50 个唯一来源
- 路由：API 17、MCP 17、Skill 16
- 类别：8 类
- 内容：photo 24、text 16、illustration 8、ui 2
- 输出：`gpt-image-2`、`high`、PNG

比例与最终尺寸：

| 比例 | 尺寸 | 数量 |
| --- | --- | ---: |
| 1:1 | 2880x2880 | 7 |
| 3:2 | 3456x2304 | 7 |
| 2:3 | 2304x3456 | 6 |
| 16:9 | 3840x2160 | 6 |
| 9:16 | 2160x3840 | 6 |
| 4:3 | 3200x2400 | 6 |
| 3:4 | 2400x3200 | 6 |
| 21:9 | 3840x1646 | 6 |

## 硬性验收

每个任务均满足：

1. source 与 final 都具有有效 PNG 签名并可解码。
2. final 尺寸与预设逐像素一致。
3. source 与 final 满足 `source.width * final.height == final.width * source.height`。
4. 下载文件 SHA-256 与任务证据一致。
5. source 和 final 四条边均不存在整条透明像素。

最终证据：

- `F:\gpt生图\test\batch-results.json`：50 成功，0 失败。
- `F:\gpt生图\test\verification-report.json`：50 个任务、100 个 PNG 全部通过。
- `F:\gpt生图\test\results`：源图、成品、提示词和逐任务 JSON。

## 发现与修复

### 1. 21:9 透明边

独立验收发现 6 个 21:9 成品存在右侧或左右整条透明边。根因是 `1280x549` 与 `3840x1646` 只是近似同率，旧 `contain` 缩放会补透明像素。

修复后，`3840x1646` 使用严格同率的 `1920x823` 规范源图并精确放大 2 倍。旧结果已归档后重建；归档和修复清单位于 `F:\gpt生图\test\archive\integer-ratio-pre-fix-20260723`。

### 2. Provider 返回错误画布

请求比例会作为最高优先级画布要求附加到 Provider 提示词。Provider 仍返回错误或近似画布时，服务端使用居中 `cover` 生成严格同率的规范源图，并在 manifest 中记录原始尺寸、目标尺寸和原因。最终成品只从规范源图生成。

网页直连 Provider 的回退路径也执行同一约束，并将规范源图而不是 Provider 原始响应保存为“源图”。回归用例验证 `1254x1254` 原始响应会先规范化为 `720x1280`，再生成 `2160x3840` 成品；规范源图与成品满足整数像素交叉乘积严格相等。

### 3. Provider 不稳定

真实测试观察到 HTTP 530、HTTP 200 但无图片、伪装为 JSON 的 HTML、截断响应体和连接 `terminated`。服务端现已：

- 对瞬时 HTTP、畸形 JSON、空图片和网络断流按同一 job 自动重试。
- 区分 `PROVIDER_TIMEOUT`、`PROVIDER_NETWORK_ERROR`、`PROVIDER_HTTP_ERROR`、`PROVIDER_RESPONSE_ERROR`。
- 在失败事件中保留脱敏诊断；不保存完整响应体或凭据。
- 默认单 worker、300 秒 Provider 超时、最多 5 次尝试和退避。

测试期间 `/models` 健康探针曾返回 HTTP 530，随后恢复 HTTP 200；这证明部分失败来自整个网关不可用，而不是图像比例代码。

### 4. 并发和恢复

同一状态目录增加跨进程锁，防止两个 worker 同时驱动同一 SQLite。中断任务恢复时不再触发非法 `queued -> failed` 转换。MCP 和 Skill 等待窗口覆盖完整重试预算。

## 提示词替换审计

最初 50 条中的 4 条成人人像提示词在多轮原文和最小安全语境测试后仍持续收到上游 HTML/530，失败证据保存在 `F:\gpt生图\test\archive\persistent-content-prompts-20260723`。为避免把大幅改写伪装成原提示词通过，最终验收集改用同一仓库中未使用且不依赖参考图的提示词。

赛博朋克角色替补也耗尽 5 次 Provider 尝试，证据保存在 `F:\gpt生图\test\archive\replacement-042-cyberpunk-failed-20260723`，最终改用咖啡产品摄影。最终清单仍为 50 个唯一 YouMind 来源，路由和比例槽位不变，且未使用提示词覆盖。

## 视觉抽检

抽检覆盖全部 8 种比例和 photo、text、illustration、ui 等内容类型。重点检查主体缺失、裁切、拉伸、文本布局和透明边。代表项包括 001 至 008，以及新生成的 009、025、033、042；均通过视觉检查。

## 质量门禁

- Task API 定向测试：16/16 通过。
- 比例核心与 Task API 定向测试：38/38 通过。
- 全套测试：649/649 通过。
- 网页直连规范源图回归：`1254x1254 -> 720x1280 -> 2160x3840` 通过。
- 独立 Skill：核心同步检查和 Python 编译通过。

- ESLint：零错误。
- TypeScript / Vite 生产构建：通过；仅保留既有的大 chunk 提示。

生产 `verify:ui` 在部署完成后执行。
