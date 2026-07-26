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
- `image_job_retry(jobId)`：重新执行失败任务，保留原 job ID 和事件历史，并重置尝试预算。
- `image_batch_create(...)`：创建服务端持久批次，每个条目使用稳定派生的任务幂等键。
- `image_batch_get(batchId)`：读取批次真实总进度、条目任务和批次事件。
- `image_batch_pause(batchId)`：暂停领取新的排队任务；已经执行中的任务继续完成。
- `image_batch_resume(batchId)`：恢复批次调度。
- `image_batch_retry_failed(batchId)`：重置并重新排队全部失败任务，同时恢复批次。
- `image_asset_download(assetId, outputPath)`：以独占写入方式下载 PNG，避免静默覆盖。

批次状态由服务端任务事实派生：

- `running`：仍有排队或执行中的任务。
- `paused`：批次被暂停，排队任务不会被 worker 领取。
- `completed`：全部条目都已进入成功、失败或取消终态。

暂停不会取消正在生成的任务，避免浪费已经发生的 Provider 成本。

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
  "fallback": {
    "provider": "configured",
    "model": "gpt-5.6-sol",
    "apiMode": "responses"
  },
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

`fallback` 是可选的第二条路由。主路由与备用路由始终共享同一个 job ID、Prompt、资产链和事件历史。`maxAttempts` 按每条路由分别计算，`attempts` 是累计调用次数，`routeAttempts` 是当前路由调用次数，`actualRoute` 是当前或最终实际使用的路由。

只有额度不足、429、超时、网络、网关、空图和 Provider 暂时不可用会进入备用路由。内容策略、鉴权和无效参数错误不会切换。切换时事件中会出现 `reason: "route_fallback"`，并记录 `from`、`to` 与 `previousError`。

Job 详情中的 `accounting` 是 Provider 调用账本：每一次真实上游请求都有独立记录，包含路由、模型、API 模式、状态、开始/结束时间、Provider 返回的原始 `usage`（若有）和错误。当前界面和 API 不展示价格，调用次数也不等同于金额。

## Agent 调用顺序

1. 生成稳定的 `idempotencyKey`。
2. 调用 `image_job_create`。
3. 调用 `image_job_wait`；网络超时后用同一 job ID 继续等待。
4. 任务成功后分别下载 `sourceAssetId` 和 `finalAssetId`。
5. 检查两个 manifest 的比例、PNG 格式、最终尺寸和父子 asset ID。
6. 重放同一幂等键只返回原 job，不会隐式重新生成；需要重跑终态失败任务时调用 `image_job_retry`。新创意或新比例必须使用新幂等键。

## 失败判断

- `retryable: true`：服务端仍可能自动重试，继续等待同一任务。
- 终态 `failed`：读取 `error.code`、`providerCode`、`stage`、`attempts`、`routeAttempts` 和 `actualRoute`。
- `PROVIDER_TIMEOUT`、`PROVIDER_NETWORK_ERROR`、`PROVIDER_HTTP_ERROR`、`PROVIDER_RESPONSE_ERROR` 用于区分上游故障。
- `STATE_DIR_LOCKED` 表示已有另一个 Task API 实例使用该状态目录，应连接现有实例而不是启动第二个。
