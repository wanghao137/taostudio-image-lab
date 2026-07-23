# Image Task MCP 使用说明

`server/task-api/mcp-server.mjs` 把 Image Task API 暴露为 stdio MCP，供 ZCode、Codex 或其他支持 MCP 的 Agent 调用。MCP 不保存 Provider 密钥，只通过本地 Task API 的 Bearer token 访问服务。

## 前置条件

1. 启动 Task API：`npm run task-api`。
2. 设置 `IMAGE_TASK_API_URL`，默认 `http://127.0.0.1:9789`。
3. 设置 `IMAGE_TASK_API_TOKEN`，必须与服务端一致。

通用 MCP 配置：

```json
{
  "command": "node",
  "args": ["D:/codesolo/taostudio-image-lab/server/task-api/mcp-server.mjs"],
  "env": {
    "IMAGE_TASK_API_URL": "http://127.0.0.1:9789",
    "IMAGE_TASK_API_TOKEN": "从本地安全配置注入"
  }
}
```

不要把真实 token 提交到 Git、说明文档或 Agent 提示词。

## 工具

- `image_asset_upload(path)`：上传本地 PNG，返回 asset ID 和 manifest。
- `image_job_create(...)`：创建幂等生成任务。
- `image_job_get(jobId)`：读取状态与事件。
- `image_job_wait(jobId, timeoutMs)`：最多等待 30 分钟。
- `image_job_cancel(jobId)`：取消任务。
- `image_asset_download(assetId, outputPath)`：以独占写入方式下载 PNG，避免静默覆盖。

## 创建任务参数

```json
{
  "idempotencyKey": "external-agent:poster:001",
  "prompt": "高级编辑风格产品海报",
  "ratio": "3:4",
  "dimensions": "2400x3200",
  "provider": "configured",
  "model": "gpt-image-2",
  "apiMode": "images",
  "enhancement": "lanczos3",
  "contentClass": "text",
  "maxAttempts": 5
}
```

`ratio` 决定第一次生成的画布，`dimensions` 只决定最终像素。两者必须是同一比例。Agent 不应在 4K 阶段再次选择比例。

`apiMode`（可选，默认 `images`）选择 Provider 端点：
- `images`：打 `/images/generations`，用于图像模型（`gpt-image-2` 等）。
- `responses`：打 `/responses` + `image_generation` 工具，用于通过 Responses API 生图的文本模型（`gpt-5.6-sol` 等）。

省略 `apiMode` 时走 `images`，已有调用无需改动。要切换到文本模型生图，同时改 `model` 和 `apiMode`：

```json
{
  "idempotencyKey": "external-agent:poster:responses-001",
  "prompt": "极简科技品牌横幅插画",
  "ratio": "1:1",
  "dimensions": "2880x2880",
  "provider": "configured",
  "model": "gpt-5.6-sol",
  "apiMode": "responses",
  "enhancement": "lanczos3",
  "contentClass": "illustration",
  "maxAttempts": 5
}
```

## Agent 调用顺序

1. 生成稳定的 `idempotencyKey`。
2. 调用 `image_job_create`。
3. 调用 `image_job_wait`；网络超时后用同一 job ID 继续等待。
4. 任务成功后分别下载 `sourceAssetId` 和 `finalAssetId`。
5. 检查两个 manifest 的比例、PNG 格式、最终尺寸和父子 asset ID。
6. 业务重试复用同一幂等键；新创意或新比例必须使用新幂等键。

## 失败判断

- `retryable: true`：服务端仍可能自动重试，继续等待同一任务。
- 终态 `failed`：读取 `error.code`、`providerCode`、`stage` 和 `attempts`。
- `PROVIDER_TIMEOUT`、`PROVIDER_NETWORK_ERROR`、`PROVIDER_HTTP_ERROR`、`PROVIDER_RESPONSE_ERROR` 用于区分上游故障。
- `STATE_DIR_LOCKED` 表示已有另一个 Task API 实例使用该状态目录，应连接现有实例而不是启动第二个。
