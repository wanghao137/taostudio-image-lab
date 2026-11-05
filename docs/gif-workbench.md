# GIF 工作台参数与验证说明

更新日期：2026 年 11 月 5 日。

GIF 工作台已取代原先的静态表情快捷区和战斗精灵图界面。用户输入任意动画描述，通过 GPT Image 2.6 的 Images 生成端点获取完整 GIF，结果进入现有任务历史，支持预览、静态封面和原件下载。

## 可配置参数

下表对应用户指定的[官方图像生成指南](https://developers.openai.com/api/docs/guides/image-generation#generate-animated-gif-output)。工作台配置会保存在本机，刷新与切换页面后恢复；任务同时记录本次实际使用的参数。

| 工作台选项 | 请求字段 | 范围 | 初始值 |
| --- | --- | --- | --- |
| 生成模型 | `model` | `gpt-image-2.6-flare`、`gpt-image-2.6-sunburst` | Flare |
| 动画描述 | `prompt` | 主体、运动与循环要求，最多 32000 字符 | 用户填写 |
| 帧数 | `frame_count` | 2–64 整数 | 9 |
| 每帧时长 | `frame_duration_ms` | 20–2000ms，界面按 10ms 步进 | 200ms |
| 每帧尺寸 | `size` | `auto` 或 `WIDTHxHEIGHT`，宽高为正整数且为 16 的倍数 | `auto` |
| 生成数量 | `n` | 1–10 整数，见[生成接口参考](https://developers.openai.com/api/reference/resources/images/methods/generate) | 1 |
| 画质 | `quality` | `auto`、`low`、`medium`、`high`、`xhigh`、`max` | `auto` |
| 规划强度 | `complexity` | `low`、`medium`、`high`，与画质独立 | `high` |
| 内容审核 | `moderation` | `auto`、`low` | `auto` |

帧数、时长和逐帧尺寸是指南专门列出的 GIF 控制项。画质、规划强度与审核属于该生成接口的共享选项。生成数量影响同一请求返回的动画数量，因此已与多个结果的预览、保存和下载一起接通，不只是展示一个输入框。

显示的周期按帧数乘每帧时长计算，属于请求目标。最终预览显示文件实际尺寸、帧数、周期与字节大小；返回时序或数量不符时给出提示，不自动增加付费请求。

## 文档冲突与预算

当前官方指南明确列出 2–64 帧，生成接口参考仍写 2–16 帧并提示需要 GIF preview 权限。本工作台按用户指定的指南开放 64 帧，选择超过 16 帧时提示这一兼容性差异；服务商实际支持范围仍需验证。

GIF 的 `size` 是每一帧的尺寸，不能沿用整张精灵图的网格尺寸，也不能把静态图的 4K 范围当成 GIF 保证。帧数、逐帧像素和动画数量共同占用模型的像素预算。指南没有给出可统一写死的 GIF 总预算数值，超限时应减少其中一项，或使用自动尺寸。

9 帧乘 200ms 等于 1.8 秒；64 帧乘 120ms 等于 7.68 秒。循环是否自然由内容决定，不能用文件重复播放代替视觉验收。

## 固定和排除的参数

请求固定走 `POST /v1/images/generations`，`output_format` 固定为 `gif`。本任务局部使用 Images 模式，不更改共享档案或其他场景的模型与流式设置。

GIF 不发送 `stream`、`partial_images`、自定义 `output_compression` 或 `prompt_rewriter`。GPT Image 的 base64 输出也不需要额外发送旧式 `response_format`。

编辑端点不支持 GIF，因此工作台不提供参考图或遮罩编辑。透明背景的公开配置要求 PNG 或 WebP，工作台也不提供未经确认的透明 GIF 开关。背景、镜头与循环意图写在提示词中，不虚构 `fps`、`duration`、`loop` 等生成参数。

GIF 原件绕过单张静态图的尺寸裁切、自动比例校正和去底处理。停止预览使用单独的静态封面，原件仍保留全部帧。多个输出分别保存与预览，下载不重新编码。

## 验证

参数验证与接口测试覆盖默认值、64 帧、2000ms、自定义尺寸、max 画质、多个动画、无效值、禁止参数、错误响应和伪 GIF。原件保存测试确保静态图后处理不会破坏动画。

本地完整流程可运行：

```powershell
npm run dev -- --host 127.0.0.1 --port 5196
node scripts/verify-gif.mjs
```

`verify-gif.mjs` 在独立浏览器上下文拦截服务商请求，不使用真实生成凭据。它检验桌面、手机与深色布局、真实 GIF 解码、参数进入请求、多个输出切换、原件下载字节一致、任务刷新恢复、配置恢复和拒绝响应。证据保存在 `output/playwright/gif-workbench/`。

2026 年 11 月 5 日已实测本地 8090（Sub2API）与 3001（ChatGPT2API）。3001 能返回真实 GIF，但没有可靠执行原生时序与尺寸参数；8090 的当前版本将 2.6 请求送入不支持 GIF 的旧路径。详见 [GIF 双接口实测报告](gif-live-validation-2026-11-05.md)。用户在知晓该结果后明确要求先发布当前版本；工作台发布不表示两套服务已通过原生参数验收。

当前兼容处理按文件签名识别 GIF，保留完整动画，排除服务商另附的 PNG/JPEG/WebP，并单独显示静态辅助图数量。仅静态输出、未知文件和损坏的 GIF 仍报告失败。帧数、时长、尺寸和数量偏差会明确显示，不通过缩放、重编码或追加请求伪造参数生效。

可回放真实产物验证保存、下载与刷新恢复，不产生额外生成费用：

```powershell
$env:GIF_TEST_ARTIFACT='output/gif-live-20261105/3001-character-gpt-image-2.6-flare-0.gif'
node scripts/verify-gif.mjs
```

`scripts/verify-gif-live.mjs` 则从实际工作台向两个本地端口发起真实生成。凭据从 `GIF_TEST_8090_API_KEY`、`GIF_TEST_3001_API_KEY` 进程环境或 `--credentials-stdin` 标准输入读取，不写入报告。它严格检查请求的帧数、时长与尺寸；收到 GIF 但参数不符也返回失败退出码。64 帧、批量真实生成和服务商像素预算仍未通过真实服务验收。
