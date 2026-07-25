# TaoStudio 图像引擎操作手册

这套引擎适合个人日常生图和批量任务。网页负责创建、查看和取消任务；本机 Task API 负责排队、重试、生成、4K 增强和保存资产。网页关掉后，已经提交的任务仍由本机引擎继续执行。

生产界面：<https://image.taostudioai.com/>

## 一、第一次使用

### 1. 配置本机引擎

在项目根目录的 `.env.local` 中配置以下内容。该文件已被 Git 忽略，不要把真实 Token 或 Provider 密钥写入文档、截图或提交记录。

```dotenv
IMAGE_TASK_API_TOKEN=换成一段只在本机保存的随机字符串
IMAGE_TASK_API_PORT=9789
IMAGE_TASK_API_CONCURRENCY=2
IMAGE_TASK_API_PROVIDER_TIMEOUT_MS=600000
IMAGE_TASK_API_PROVIDER_RETRY_BASE_MS=15000
IMAGE_TASK_API_ALLOWED_ORIGINS=https://image.taostudioai.com

IMAGE_TASK_PROVIDER_BASE_URL=https://你的图片服务地址/v1
IMAGE_TASK_PROVIDER_API_KEY=你的图片服务密钥
IMAGE_TASK_PROVIDER_MODEL=gpt-image-2
```

参数含义：

- `IMAGE_TASK_API_TOKEN`：网页连接本机引擎时使用的密码。
- `IMAGE_TASK_API_CONCURRENCY`：同时生成几张图。个人电脑建议先用 `1` 或 `2`。
- `IMAGE_TASK_API_PROVIDER_TIMEOUT_MS`：单次上游请求最长等待时间，复杂图片建议使用 10 分钟。
- `IMAGE_TASK_API_ALLOWED_ORIGINS`：允许生产网页访问本机引擎。使用线上界面时必须包含 `https://image.taostudioai.com`。
- `IMAGE_TASK_PROVIDER_*`：实际负责生图的 OpenAI 兼容服务配置。

### 2. 启动引擎

打开 PowerShell，进入项目目录：

```powershell
cd D:\codesolo\taostudio-image-lab
npm install
npm run task-api
```

保持这个窗口运行。看到监听地址后，再打开生产网页。

如果端口不是 `9789`，后面连接时使用实际端口。不要让两个引擎实例共用同一个状态目录；出现 `STATE_DIR_LOCKED` 时，应连接已运行的实例，而不是再启动一个。

### 3. 在网页中连接

1. 打开 <https://image.taostudioai.com/>。
2. 顶部选择“引擎”。
3. 服务地址填写 `http://127.0.0.1:9789`。
4. Bearer token 填写 `.env.local` 中的 `IMAGE_TASK_API_TOKEN`。
5. 点击“验证并连接”。

连接成功后会显示“引擎在线”和 Contract 版本。Token 只保存在当前标签页的 `sessionStorage` 中；关闭标签页后需要重新填写，但服务端任务不会丢失。

## 二、在界面生成一张图

1. 点击“新建任务”。
2. 在“提示词”中粘贴完整提示词。
3. 选择比例。
4. 选择 API 模式和匹配的模型。
5. 点击“提交任务”。

常用搭配：

| 用途 | API 模式 | 模型示例 |
| --- | --- | --- |
| 图片模型直接生图 | `images` | `gpt-image-2` |
| 文本模型通过工具生图 | `responses` | `gpt-5.6-sol` |

不要只改 API 模式而不改模型。图像模型通常配 `images`，支持 `image_generation` 工具的文本模型配 `responses`。

比例决定第一次生成时的构图，也决定最终 PNG 尺寸：

| 比例 | 最终尺寸 |
| --- | --- |
| `1:1` | `2880x2880` |
| `3:2` | `3456x2304` |
| `2:3` | `2304x3456` |
| `16:9` | `3840x2160` |
| `9:16` | `2160x3840` |
| `4:3` | `3200x2400` |
| `3:4` | `2400x3200` |
| `21:9` | `3840x1646` |

引擎先保存规范 source PNG，再用 Lanczos3 等比生成 final PNG。它不会在增强阶段重新选择构图比例。

## 三、看懂任务状态

选中左侧任务后，右侧会显示阶段时间线：

```text
排队 -> 校验 -> 生成底图 -> 底图就绪 -> 增强 -> 收尾 -> 成功
```

- “执行次数”显示当前尝试次数和最大尝试次数。
- 短暂的 `429`、`5xx`、网络中断或无效图片响应会自动重试。
- 任务失败后，查看错误代码、Provider 错误和失败阶段。
- 成功后，右侧显示 final 产物预览。可以在预览图上使用浏览器右键“图片另存为”。
- “取消任务”可取消排队任务，或中断正在等待的 Provider 请求。
- 顶部“刷新任务”会从服务端重新读取任务事实，不依赖浏览器本地记录。

常见错误：

| 错误 | 处理 |
| --- | --- |
| 无法连接 | 确认 PowerShell 中的引擎仍在运行，地址和 Token 一致 |
| 浏览器提示跨域 | 检查 `IMAGE_TASK_API_ALLOWED_ORIGINS` 是否包含生产网页 origin，修改后重启引擎 |
| `PROVIDER_HTTP_ERROR` / `PROVIDER_RESPONSE_ERROR` | 通常是上游服务暂时不可用；先看任务是否仍会自动重试 |
| `PROVIDER_TIMEOUT` | 增大 Provider timeout，或检查上游长任务限制 |
| 内容策略或权限错误 | 修改提示词、模型或 Provider 凭据；这类错误通常不会重试 |
| `STATE_DIR_LOCKED` | 已有引擎占用同一状态目录，连接已有实例 |

## 四、批量出图

### 方法 A：直接在界面排队

适合一次生成 2 至 10 张：

1. 创建第一张任务并提交。
2. 不必等它完成，继续点击“新建任务”。
3. 为每张图填写提示词、比例、API 模式和模型。
4. 连续提交后，任务会进入服务端队列。
5. 引擎按 `IMAGE_TASK_API_CONCURRENCY` 控制同时运行数量，其余任务保持“排队”。

同一批图建议先统一以下内容：

- 同一个模型和 API 模式。
- 同一套视觉风格关键词。
- 明确每张图的用途和比例。
- 每张图只改变主题、文案或镜头，不要无意中同时改变全部变量。

界面会为每次提交生成新的幂等键。重复点击提交不会作为正式的“重试方式”；需要重试时先查看原任务是否仍在自动重试。

### 方法 B：用 MCP 或 Skill 自动批量提交

超过 10 张、需要从文件读取提示词、需要自动命名和下载时，推荐使用 Task API 的 MCP 或 `generate-image-asset` Skill。它们与网页使用同一个引擎和同一套任务契约，网页仍可用来查看队列和结果。

MCP 的标准批量流程：

1. 为每个提示词生成稳定且唯一的 `idempotencyKey`，例如 `daily:2026-07-25:poster-001`。
2. 对每个提示词调用 `image_job_create`。
3. 记录返回的 job ID。
4. 调用 `image_job_wait` 等待；超时后继续等待同一个 job ID，不要重复创建。
5. 成功后分别用 `image_asset_download` 下载 source 和 final。
6. 核对 manifest 的尺寸和 SHA-256。

可以直接让已连接 MCP 的 Agent 执行：

```text
读取 prompts 目录下的所有 txt 文件，每个文件创建一个图片任务。
统一使用 3:4、2400x3200、images、gpt-image-2、lanczos3，
最大尝试 5 次。幂等键使用 daily:<日期>:<文件名>。
提交完全部任务后逐个等待，下载 source、final 和 manifest，
最后给我成功、失败、重试次数和输出路径汇总。
```

MCP 配置和工具参数见 [image-task-mcp.md](./image-task-mcp.md)，Skill 用法见 [generate-image-asset-skill.md](./generate-image-asset-skill.md)。

## 五、磁盘、备份和日常习惯

- 任务、事件和资产保存在 Task API 的状态目录中，浏览器 IndexedDB 不是引擎任务的事实源。
- 不要把状态目录放进 Git，也不要手工修改 SQLite 或资产文件。
- 定期停止引擎后，完整备份状态目录；数据库和资产目录必须一起备份。
- 同一个状态目录不要同时被两个引擎进程使用。
- 磁盘空间不足前先归档旧批次。4K PNG 单张可能达到数 MB 到数十 MB。
- Provider 密钥只放在 `.env.local` 或安全的密钥管理中。
- 当前版本是“本机引擎 + 线上界面”：还没有云端共享资产库、多用户权限和跨设备任务同步。
- 当前界面适合创建、排队、监控和预览；大量任务的自动命名、批量下载和报表应交给 MCP/Skill。

## 六、已验证的实际结果

2026-07-25 使用生产界面连接本机 Task API，并从 `YouMind-OpenLab/awesome-gpt-image-2` 选择三个提示词实测：

| 案例 | 比例 | 结果 | source | final | 尝试次数 |
| --- | --- | --- | --- | --- | --- |
| Illustrated City Food Map | `1:1` | 成功 | `1254x1254` | `2880x2880` | 2 |
| VR Headset Exploded View Poster | `3:4` | 成功 | `768x1024` | `2400x3200` | 1 |
| Celestial Mechanical Dragon Observatory | `9:16` | 成功 | `720x1280` | `2160x3840` | 1 |

三组任务均保存了 source/final 资产，实际像素与 manifest 一致，下载文件 SHA-256 与服务端 manifest 一致。成都地图第一次遇到上游 `502`，引擎自动重试后成功；这同时验证了任务时间线和重试机制。

中文、日文等密集文字仍可能出现模型常见的错字。引擎保证任务、比例、尺寸、重试和资产完整性，但不能保证模型把每个字都画对；正式发布前仍需人工校对图片内容。
