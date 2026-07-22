# Image Task API 使用说明

Image Task API 是 TaoStudio 的服务端任务参考实现，负责排队、重试、比例继承、PNG 资产保存和任务审计。当前实现只监听 `127.0.0.1`，没有随 Vercel 前端部署到公网。

## 核心契约

1. 比例只选一次：`composition.ratio` 是生成阶段的唯一画布比例，`output.ratioMode` 必须为 `inherit`。
2. Provider 原始画布已严格符合最终整数像素比时，直接作为规范源图。
3. Provider 原始画布不符合最终整数像素比时，服务端先以 `cover` 方式生成规范源 PNG，并在 source manifest 中记录原始尺寸、目标尺寸和裁切原因。
4. source 与 final 必须满足 `source.width * final.height == final.width * source.height`；最终 4K 只从该规范源图做 Lanczos3 缩放，不重新选择比例，不允许拉伸或透明补边。
5. source 和 final 都是不可变 PNG，包含 SHA-256、尺寸、父子资产 ID 和处理清单。
6. 同一个 `idempotencyKey` 代表同一个生成意图；自动重试不会创建重复计费任务。
7. 同一状态目录只允许一个服务实例。跨进程锁用于阻止两个 worker 同时驱动同一 SQLite。

流程：

```text
prompt + ratio
  -> Provider 原始画布
  -> 比例校验
  -> 整数像素比严格一致的规范源图 PNG
  -> 等比 4K
  -> source/final manifest
```

`3840x1646` 的 21:9 成品使用 `1920x823` 规范源图，再做精确 2 倍缩放。旧的 `1280x549 -> 3840x1646` 只是近似同率，会在 `contain` 缩放时产生透明边，因此不再允许。

## 启动

在忽略提交的 `.env.local` 中配置：

```dotenv
IMAGE_TASK_API_TOKEN=本地随机令牌
IMAGE_TASK_API_PORT=9789
IMAGE_TASK_API_CONCURRENCY=1
IMAGE_TASK_API_PROVIDER_TIMEOUT_MS=300000
IMAGE_TASK_API_PROVIDER_RETRY_BASE_MS=15000
IMAGE_TASK_PROVIDER_BASE_URL=https://provider.example/v1
IMAGE_TASK_PROVIDER_API_KEY=provider-secret
IMAGE_TASK_PROVIDER_MODEL=gpt-image-2
```

```powershell
npm run task-api
```

服务日志不会打印 Bearer token。所有请求必须携带：

```http
Authorization: Bearer <IMAGE_TASK_API_TOKEN>
```

## 创建任务

```http
POST /v1/image-jobs
Content-Type: application/json
```

```json
{
  "contractVersion": "1",
  "idempotencyKey": "agent:campaign-42:cover-001",
  "input": { "prompt": "一张电影感城市夜景" },
  "composition": { "ratio": "9:16" },
  "generation": {
    "provider": "configured",
    "model": "gpt-image-2",
    "baseSize": "720x1280"
  },
  "output": {
    "ratioMode": "inherit",
    "format": "png",
    "quality": "high",
    "dimensions": "2160x3840",
    "enhancement": "lanczos3",
    "contentClass": "photo"
  },
  "retry": { "maxAttempts": 5 }
}
```

支持比例：`1:1`、`3:2`、`2:3`、`16:9`、`9:16`、`4:3`、`3:4`、`21:9`。

## 端点

- `POST /v1/assets/uploads`：上传不可变 PNG；相同字节返回同一资产 ID。
- `POST /v1/image-jobs`：创建或重放幂等任务。
- `GET /v1/image-jobs/{id}`：读取状态、尝试次数、错误和事件。
- `POST /v1/image-jobs/{id}/cancel`：取消排队任务或中断 Provider 请求。
- `GET /v1/assets/{id}`：下载 PNG。
- `GET /v1/assets/{id}?manifest=1`：读取资产清单。

状态顺序：`queued -> validating -> generating -> source_ready -> enhancing -> finalizing -> succeeded`。瞬时错误会先进入 `failed`，再按退避时间回到 `queued`。

## 错误处理

- HTTP `429`、`5xx`、网关 EOF、空图片和暂时不可用：可重试。
- 请求建立、响应体读取或图片下载中断：记为 `PROVIDER_NETWORK_ERROR` 并重试。
- 内容策略、鉴权、权限、无效请求：不可重试。
- Provider 返回 HTTP 200 但 JSON 没有图片时，服务端按结构化错误处理，不再直接终止。
- 对外错误只保留状态码、错误代码、经过截断和凭据脱敏的消息、顶层响应键；不会保存完整 Provider 响应体。
- 每次失败的脱敏错误详情同时保存在 job 的 `failed` 事件中；后续重试成功也不会丢失失败审计记录。

## 资产清单

规范化过的 source manifest 示例：

```json
{
  "kind": "source",
  "width": 720,
  "height": 1280,
  "ratio": "9:16",
  "transform": {
    "geometry": "cover",
    "reason": "provider-ratio-normalization",
    "providerDimensions": { "width": 941, "height": 1672 },
    "exactPixels": { "width": 720, "height": 1280 },
    "requestedRatio": "9:16"
  }
}
```

## 部署边界

这个服务当前是本地参考实现。生产化需要独立 API 入口、持久数据库、R2/S3、耐久队列和长生命周期 Node worker。Vercel 前端部署不等于 Task API 已部署，长耗时 4K 任务也不应只依赖 Vercel Function。

OpenAPI 定义位于 `server/task-api/openapi.yaml`。
