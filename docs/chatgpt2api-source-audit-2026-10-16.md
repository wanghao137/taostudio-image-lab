# chatgpt2api 源码审计与本地部署优化升级方案

审计日期：2026-10-16
审计对象：`basketikun/chatgpt2api` v1.8.0（main@dc105e5，2026-07-28 发布，上游最终版本）
本地部署：`chatgpt2api-test` 容器 @ `127.0.0.1:3001`（Docker，`D:\codesolo\chatgpt2api-test`）
方法：人工精读生图链路 + 两个只读探查代理（号池/存储、协议一致性）+ 官方 changelog 增量核对；所有重发现均回到源码原文复核。

## 0. 结论速览

1. **上游已停更**：v1.8.0（2026-07-28）是最终版本，仓库 07-29 后无提交，作者注意力已转向 `basketikun/infinite-canvas`（7667★，10 月仍活跃）。远端 ghcr 镜像与本地 07-28 构建一致，没有新版可拉。
2. **官方契约对照**（基线 = 09-09 审计报告 + changelog 增量核对，09-09 后 Images API 无新参数）：web 生图链路的功能性差距与 9 月实测结论一致（size/quality 仅提示词）；本轮新增发现主要是**协议层一致性缺口**（function calling 缺失、跨端点缓存串答、usage/事件形状缺口）和**工程健壮性缺口**（n 无钳制、号池非原子写、无鉴权图片端点）。
3. **最重的三个问题都在"号池资产安全"**：accounts.json 非原子覆写（崩溃即静默清零）、单因子 admin key 可导出全部明文凭据、明文密码 + `verify=False` 的自动重登链路。对本地部署而言，前两个可以直接用配置和小补丁消除。
4. **本地部署有一个时效性风险**：09-09 的 2.5 别名补丁活在容器可写层里，任何一次 `docker compose up` 重建（而不是 restart）都会打回未补丁状态。compose 虽已指向补丁镜像 `chatgpt2api:gpt-image-2.5`，但运行容器仍是 08-07 创建的旧镜像 + 可写层。

## 1. 架构一页图

```
客户端(工作台/sub2api/Cherry Studio…)
  │  Bearer CHATGPT2API_AUTH_KEY
  ▼
api/ (FastAPI)
  ├─ /v1/images/generations|edits   → protocol/openai_v1_image_*.py（薄适配）
  ├─ /v1/chat/completions           → protocol/openai_v1_chat_complete.py
  ├─ /v1/responses                  → protocol/openai_v1_response.py
  ├─ /v1/messages (Anthropic兼容)   → protocol/anthropic_v1_messages.py
  ├─ /v1/models、/v1/search、/v1/ppt|psd、/api/image-tasks
  └─ /accounts/ 管理页（SPA，数据走 /api/accounts，admin key 保护）
        ▼
services/protocol/conversation.py（编排：重试/换号/并行池/会话恢复）
  ├─ web 流：openai_backend_api.py → chatgpt.com /backend-api/f/conversation
  │    （sentinel/pow/turnstile 反检测；图片经 Azure blob 上传；SSE→轮询文件→下载）
  └─ codex 流：/backend-api/codex/responses（image_generation 工具，真参数）
        ▼
account_service（轮询选号 + 每号并发槽位 + 5min 远程额度刷新 + token 刷新）
storage（json 默认 / sqlite / postgres / git）
```

## 2. 官方契约对照差距清单

分级：P0=会造成数据/安全事故或功能坏死；P1=契约缺口影响正确性/可用性；P2=低优先。

### P0

| # | 问题 | 现状（证据） | 官方/安全预期 | 建议 |
|---|---|---|---|---|
| P0-1 | 号池 JSON 非原子全量覆写，损坏后静默清零 | `storage/json_storage.py:26-35`：`JSONDecodeError` 被吞返回 `[]`；`write_text` 整体覆写无 tmp+rename；每次生图成功/失败都全量重写（`account_service.py:1331` 等） | 一次崩溃/断电/磁盘满 → 整个号池（含 refresh_token、**明文密码**）静默归零 | 改为 tmp+`os.replace` 原子写；load 失败时把坏文件改名保留并报错拒启（约 15 行）；或切 `STORAGE_BACKEND=sqlite`（diff upsert 单事务） |
| P0-2 | `GET /images/{path}`、`/image-thumbnails/{path}`、`GET /files/{path}` 完全无鉴权 | `api/system.py:102-108`、`api/ai.py:183-189`；且端口绑 `0.0.0.0:3001`（LAN 可达） | 任何局域网设备可枚举读取全部生成图与文件 | `/images`、`/image-thumbnails`、`/files` 加 `require_identity`；端口改绑 `127.0.0.1:3001:80`（若无其他设备访问） |
| P0-3 | 单因子 admin key 直通全部明文凭据 | `api/support.py:23-27`（legacy key 即 admin）；`GET /api/accounts` 返回明文 token/密码（`account_service.py:1072-1085`）；`/api/accounts/export` 导出 token+密码（`accounts.py:306-331`）；无防爆破 | key 泄露 = OpenAI 账号本身沦陷 | key 换强随机值；仅本机访问；确认 `auto_relogin_after_refresh` 场景下密码是否必需，非必需则从池中清除密码字段 |

### P1 — 协议一致性（对照 OpenAI 官方契约）

| # | 问题 | 现状（证据） | 官方契约 | 影响 |
|---|---|---|---|---|
| P1-1 | 无 function calling：任何 tools 静默降级为"工具不可用"系统提示 + 纯文本 200 | `openai_v1_chat_complete.py:40-44,179-180`；全仓无 `tool_calls` 产出 | 官方返回 `delta.tool_calls` + `finish_reason:"tool_calls"` | agent 类客户端（含本工作台 Agent 轨）接到 200 + 文本，静默坏掉 |
| P1-2 | `/v1/chat/completions` 与 `/v1/responses` 共用缓存且缓存键无端点判别 | `chat_completion_cache.py:61-75`；两路由同键（`openai_v1_chat_complete.py:297,308`；`openai_v1_response.py:419`） | — | Responses 流式客户端可能收到 `chat.completion.chunk` 事件；TTL 内无视 temperature/seed 回放旧答 |
| P1-3 | `stream_options.include_usage` 未实现 | `completion_chunk` 无 usage 字段，全链路无人读 stream_options | 官方流式最后一个 chunk 带 usage | 按契约统计 token 的客户端拿不到数据 |
| P1-4 | 参数校验失败返回 422 且 `param` 恒空；401 为中文消息 | `api/errors.py:42-46`、`error_response.py:77,86`、`api/support.py:34` | 官方 400 + `error.param` 定位字段 | 程序化错误处理无法定位参数 |
| P1-5 | n 无 1–10 钳制；n>1 时"流式"实为全部完成后一次性吐出 | `openai_v1_image_generations.py:18`（`int(body.get("n") or 1)` 无校验）；`conversation.py:1563-1589`（并行池收齐才 yield） | 官方 n∈[1,10]，越界 400；流式渐进产出 | n=1000 会起 1000 线程等账号槽（有 `image_account_concurrency` 兜底但资源浪费）；官方上限 10 |
| P1-6 | edits 上限 10 张、单图 10MB | `utils/helper.py:30-31,97-98` | 官方 edits 最多 16 张、单图 50MB | **4K PNG 编辑链路被 10MB 卡死**（4K PNG 常 20MB+）；多图上限不足 |
| P1-7 | codex 生图通道 tool model 硬编码 `gpt-image-2`；partial_images/background/output_compression/moderation/input_fidelity 全不透传 | `openai_backend_api.py:791-798` | Responses 工具 model 枚举含 2.5 全部 ID；其余参数官方均支持 | codex 通道（真参数通道）用不上 2.5 flare/sunburst 及部分控制 |
| P1-8 | web 流 size/quality 只是中文提示词注入 | `conversation.py:217-223`（"输出图片尺寸为 X。输出图片质量为 Y。"）；请求体无任何 size 字段（`openai_backend_api.py:1003-1034`） | 官方 size/quality 是真参数 | 9 月已实测该类提示"不贡献画布却诱导主体拉长"（工作台 3b58b4a 已全删同类注入）；网关侧注入同样无效且可能变形 |
| P1-9 | Responses 流缺 `output_item.added`、`response.in_progress`、partial_image 事件；无 `previous_response_id`/GET /responses/{id} | `openai_v1_response.py:382-397`；全仓无 previous_response_id 引用 | 官方 Responses 事件序列 | 依赖增量事件的客户端渲染退化 |
| P1-10 | Anthropic 层图片块静默丢失 + tool_choice 从未读取 | `utils/helper.py:398-414`（不认 `{"type":"image","source":…}`）；`anthropic_v1_messages.py` 无 tool_choice 读取 | Anthropic 官方契约 | /v1/messages 的视觉输入 silently 丢失 |

### P1 — 可用性/健壮性

| # | 问题 | 现状（证据） | 建议 |
|---|---|---|---|
| P1-11 | 全局 token 刷新锁串行化所有账号；429 无账号级退避标记 | `account_service.py:52,440,373`（一次 60s 超时刷新阻塞全池 preflight）；429 仅请求内退避（`openai_backend_api.py:2139-2142`），调度不避让（轮询选号 `account_service.py:938-939`），靠 5min 远程额度刷新周期纠偏 | 刷新锁按 token 分桶；429/配额错误短期跳过该号 |
| P1-12 | `default_thinking_effort: "max"`（本地配置）附加到每次 web 生图请求 | `openai_backend_api.py:559-561,876-888`；图像路径无独立旋钮 | host 模型先 max 推理再调生图工具 → 单图延迟放大。用 v1.8.0 的模型名 `-standard/-extended/-max` 后缀或调低全局值 A/B 实测 |
| P1-13 | `force_paragen` 硬编码 False | `openai_backend_api.py:536-537` | 9 月实锤这是 web 流出图路由的"唯一杠杆"，却无配置旋钮；建议配置化 |

### P2（列出备查）

- 模型广播与账号真实能力脱钩：`web_image_accounts` 过滤无任何条件（上游 v1.8.0 自带，非本地补丁引入，`openai_v1_models.py:17-22`）——任何账号在池都会广告生图模型。
- usage 为 tiktoken 本地估算值（非官方计费值）；reasoning_tokens 恒 0。
- 文本请求 n>1 静默当 1；developer role 原样透传上游未并入 system；非文本 content part 静默丢弃。
- Anthropic 流缺 `ping`、可能缺 content_block_stop 收尾、`message_stop` 带非规范字段、input_json_delta 一次性整包。
- oauth finish 的 callback URL 前 80 字符进日志（`accounts.py:367-372`）；debug 日志打印 token 前 12 字符。
- 密码重登 OAuth 硬编码 `verify=False`（`account_service.py:598,777`）——代理场景凭据可被截获。
- 代理无池化轮换/失败摘除（`proxy_service.py:194-207`，静态优先级单值）。

### 与官方契约对齐良好的部分（不需要动）

- 错误 envelope 形状（`error.message/type/param/code`）、号池耗尽映射 429 `insufficient_quota`（`log_service.py:182-197`）；
- 生图重试矩阵（文本回复/TLS/连接超时/轮询超时分别退避换号，`conversation.py:1300-1523`）、并行池部分失败不阻塞成功结果；
- 会话 ID 丢失恢复、文本回复延长轮询（300s×3 次）、任务错误与轮询竞态的处理——web 流逆向中最难的部分做得相当扎实；
- token 日志统一 `anonymize_token`（sha256 前 10 位）；路径穿越防护、hmac 恒时比较、CORS credentials=False。

## 3. 官方文档增量核对（2026-09-09 之后）

- **Images API 无新参数**：changelog 在 09-09 之后没有 Images/Responses 参数面变化，09-09 审计报告的参数清单仍然完全有效。
- 2026-08（升级公告重复项）：`background: transparent` 预览仅 gpt-image-2 API 通道——web 逆向流做不到，维持工作台现有"提示词叠加+本地后处理"方案即可。
- 2026-09：错误码语义 429 `slow_down` 与 503 `server_is_overloaded` 区分——chatgpt2api 透传上游状态码（UpstreamHTTPError 携带 status/retry_after），基本兼容，无需动作。
- 结论：**官方侧没有新的"补课"项**，优化点全部来自源码本身。

## 4. 本地部署（127.0.0.1:3001）升级方案

### 4.1 现状盘点

| 项 | 现状 | 风险 |
|---|---|---|
| 运行容器 | 08-07 创建自 `ghcr.io/basketikun/chatgpt2api:latest`（07-28 构建 = 上游最终版） | 版本不落后，无需追新 |
| 2.5 别名补丁 | 09-09 docker cp 进**容器可写层**（实测 `/v1/models` 含 flare/sunburst，25 模型） | **一次 `docker compose up` 重建即丢失**；restart 不丢 |
| 补丁镜像 | `chatgpt2api:gpt-image-2.5`（f8eebd，5 周前 docker commit）已存在，compose 已指向它 | 容器从未用重建切过去，镜像与运行态存在漂移 |
| 源码补丁 | `chatgpt2api-src` 工作区未提交（5 文件 11 行） | 无版本记录，重装即失 |
| config | `default_upstream_model_name: gpt-6-astra-wm`、`default_thinking_effort: max`、`image_poll_timeout_secs: 300`、备份关闭、自动清坏号关闭、log_levels 含 debug、auth key 为弱测试值 | 见下文动作 |
| 数据 | `./data`（号池+凭据+图）host 挂载 | 无备份 |

### 4.2 立即执行（不改代码，按顺序）

```bash
# ① 备份（数据+配置+补丁源码）
cp -r /d/codesolo/chatgpt2api-test/data /d/codesolo/chatgpt2api-test/data.bak-20261016
cp /d/codesolo/chatgpt2api-test/config.json /d/codesolo/chatgpt2api-test/config.json.bak-20261016
cd /d/codesolo/chatgpt2api-src && git checkout -b taostudio-patch && git add -A && git commit -m "patch: gpt-image-2.5 flare/sunburst aliases (2026-09-09)"

# ② 重建容器到补丁镜像（消除可写层漂移；数据在 host 卷不受影响）
cd /d/codesolo/chatgpt2api-test
docker compose down && docker compose up -d

# ③ 验证
curl -s -H "Authorization: Bearer <key>" http://127.0.0.1:3001/v1/models | grep -o "gpt-image-2.5-[a-z]*"
# 预期输出 gpt-image-2.5-flare / gpt-image-2.5-sunburst；再核对 /accounts 页面账号数与额度、跑一次生图+编辑冒烟
```

配置硬化（`config.json`，改后 `docker restart chatgpt2api-test`）：

1. `log_levels` 去掉 `"debug"`（生产噪音 + prompt/token 前缀落盘）。
2. `auth-key` 换强随机值；**联动**：工作台 provider 配置里该网关的 key 同步更新。若 3001 仅本机使用，compose 端口改 `"127.0.0.1:3001:80"`。
3. `auto_remove_invalid_accounts: true`（有 10 分钟宽限 + 两次确认机制，不会误杀新号）。
4. 备份：最低成本用计划任务定时 zip `data/`（号池是唯一资产）；或启用自带 `backup.*`（R2）。
5. `default_thinking_effort` 从 `max` 试降 `high`，用同一 prompt A/B 生图延迟与出图质量（模型名后缀 `-max` 可按请求覆盖，不影响全局）。

### 4.3 第二轮代码补丁（建议按此顺序，全部小改动）

| 优先 | 补丁 | 改法 | 规模 |
|---|---|---|---|
| 1 | 号池原子写 | `json_storage.py`：写 tmp → `os.replace`；`_load_json_list` 捕获 JSONDecodeError 时把坏文件 rename 保留并抛错拒启 | ~15 行 |
| 2 | 图片/文件端点鉴权 | `api/system.py:102-108`、`api/ai.py:183-189` 加 `require_identity(authorization)` | ~6 行 |
| 3 | n 钳制 1–10 | `openai_v1_image_generations.py:18` 复用 `parse_image_count` 并把上限改 10；越界走官方 400 error envelope | ~5 行 |
| 4 | edits 上限对齐官方 | `MAX_JSON_EDIT_IMAGES` 10→16、`MAX_JSON_IMAGE_BYTES` 10MB→50MB（4K 编辑链路解锁，工作台侧建议仍预归一控体积） | 2 行 |
| 5 | size/quality 提示词开关 | `build_image_prompt` 加 `image_size_quality_hint_enabled` 配置（默认 true 保持现状），工作台可 A/B 验证"无提示词是否更少构图变形" | ~8 行 |
| 6 | codex 通道 model 透传 | `iter_codex_image_response_events` 的 tool.model 从硬编码 `gpt-image-2` 改为透传请求模型（2.5 ID 直传） | ~5 行 |
| 7 | 校验错误 422→400 | `api/errors.py:42-46` RequestValidationError 映射 400 + 填 `param` | ~10 行 |

补丁流程沿用 09-09 方法但升级为**正式化**：源码分支 commit → `docker build -t chatgpt2api:1.8.1-taostudio .`（若基础镜像拉取受限则继续 docker commit，但必须重建容器使补丁镜像成为运行态，不再依赖可写层）。

### 4.4 中期路线（上游停更应对）

1. **维持现状可用**：web 流免费号池 + 批量任务 + PPT/PSD 是 chatgpt2api 独有能力，v1.8.0 + 上述补丁足够自持。
2. **质量上限通道**：codex 生图路径已内置（`codex-gpt-image-2[-plus|team|pro]` 模型名，真参数）。若未来养 Plus/Pro 号，web 工作台无需改协议即可切 codex 通道拿真 size/quality/2.5 模型。
3. **备选观察**：yukkcat/chatgpt2api（917★，带注册机续号池，09-09 仍在更新）作 fork 后备；router-for-me/CLIProxyAPI（55k★，日更，codex images 亦支持 2.5 ID）作替代底座评估——两者都不支持 web 流免费号池，替换意味着号池策略变更。
4. 工作台侧已在 9 月完成的适配（透明提示词、输入图预归一、n≤4、尺寸本地裁切）继续有效，无需回退。

## 5. 官网逆向层时效性审计（2026-10-16 增补）

针对"ChatGPT 官网更新后逆向层是否跟丢"的专项核查（issues + 活跃 fork + 本地实测三方取证）：

1. **2026-10-14 官网更新确实打破过逆向层**：issue #416（19 人 +1）报告 `/backend-api/conversation` 返回空 404，free/plus/pro/team 全计划复现，文本与图片双挂。issue 于 10-15 关闭——pansx 提交 PR #418（"fix: update sentinel handshake for 2026-10"），核心是 sentinel 握手适配 + 代理池/turnstile 求解器重构（80+ 文件），**未合并**（上游停更，永久 OPEN）。
2. **本地实例实测存活**：10-16 对 3001 实测文本通道正常返回（干净 completion + usage）。#416 打死的是 `/backend-api/conversation`（文本旧路径）报告者所在环境；v1.8.0 的生图链路走 `/backend-api/f/conversation`（`openai_backend_api.py:1037`）未受影响，或服务端已回滚。**结论：逆向层当前可用，但 sentinel/反检测层已进入"每次官网前端更新都可能突发失效"的裸奔状态**——PR #418 应作为备件存档（pansx fork：github.com/pansx/chatgpt2api，10-15 推送）。
3. **模型目录滞后**：issue #403/#413 报告 1.8.0 目录看不到 gpt-6 系；不影响实际路由（宿主模型走 config 自由文本），但 `/v1/models` 目录与 `services/model_service.py` 的静态表需要手工维护。
4. **能力面未见新缺口**：10 月官网图像侧（Images 2.5 服务端后端）chatgpt2api web 流仍可正常出图；未发现官网新增了 web 流可白嫖而项目未封装的能力。

## 6. 生图质量杠杆清单（2026-10-16 增补，用户核心诉求）

**号池现状实测**（`/api/accounts` 只读统计）：4 个账号全部是 `codex/free` 型；1 个正常（quota 118，success 164/fail 159，失败率 ~49%），3 个禁用（quota 5/5/10）——**全部流量压在单个免费号上**。

按投入产出排序的杠杆：

| # | 杠杆 | 证据 | 动作 | 预期 |
|---|---|---|---|---|
| L1 | 删除 web 流 size/quality 中文提示词注入 | `conversation.py:217-223`；工作台 3b58b4a 已实测同类注入诱导主体拉长（头身比 1:8.4→1:7.5） | 补丁加 `image_size_quality_hint_enabled` 开关（默认保持现状），A/B 对比 | 直接消除可复现的构图变形源 |
| L2 | `force_paragen` / `force_paragen_model_slug` 配置化 | `openai_backend_api.py:536-537` 硬编码 False/""；9-11 审计实锤为 web 流唯一路由杠杆 | 补丁加配置；A/B `force_paragen=true`；可试 slug 值（服务端不认会回退，无害） | 出图率与路由质量可能提升；消耗相同额度 |
| L3 | thinking_effort 保持 max | config `default_thinking_effort: max`，已是最高推理档 | 无动作（模型名后缀可按请求覆盖） | 无升档空间 |
| L4 | 宿主模型选择 | 9-11 A/B 实锤 astra-wm vs gpt-6-pro 画质无差（同一服务端图像后端） | 别再折腾宿主 | 无收益 |
| L5 | 账号等级 = 质量天花板主嫌疑 | 9-11 定论"号池全 free 最大嫌疑"；今测池内 4 号全 free 且 3 个已禁用；#416 评论"免费账号在官网上也没法生图了"提示官网正在按等级收紧图像权益 | 养/导 1 个 Plus 型号对照测试；恢复 3 个禁用号改善可用性 | 决定性变量：同 prompt 双号盲评可直接证实/证伪 |
| L6 | codex 真参数通道 | `openai_backend_api.py:791-798` 真 size/quality；但 plan 过滤只放 plus/team/pro（`utils/helper.py:19-24`），池内 codex 号全 free 进不去；9-11 实锤 codex 流锁 Plus | 有 Plus 号后用 `codex-gpt-image-2-plus` 模型名直通；或打补丁放宽过滤试 free（可能 403，一试便知） | 真 quality=high/max + 真尺寸 + （补丁后）2.5 ID = 框架内质量天花板 |
| L7 | 工作台侧选优与放大 | web 流底图 ~1254px 是服务端硬上限 | n=4 选优（成本×4）；4K 交付继续走已有 EWA lanczos 本地放大管线 | 稳定性质量提升，无额外网关改动 |

**执行顺序建议**：L1+L2 合并为一个补丁包（合计 ~20 行：`config.py` 两个旋钮 + `conversation.py`/`openai_backend_api.py` 各两处读取），打完用同一 prompt 做 baseline / +L1 / +L1L2 三组各 3 张盲评；同时着手 L5 的 Plus 对照号——若 L5 证实等级差异显著，质量路线就转向"Plus 号 + codex 通道（L6）"，web 流补丁作为免费池的日常通道保留。

## 7. 证据文件索引

- 源码：`D:\codesolo\chatgpt2api-src`（main@dc105e5 + 未提交补丁）
- 部署：`D:\codesolo\chatgpt2api-test`（compose/config/PATCH-NOTES.md）
- 官方参数基线：`docs/gpt-image-2.5-api-audit-2026-09-09.md`（本仓库）
- 本文所有 file:line 引用均可在源码目录直接定位复核。
