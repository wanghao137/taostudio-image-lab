# 外部 Agent 测试提示词

这份文档用于把 Task API、MCP 和独立 Skill 分配给不同 Agent 做黑盒测试。推荐使用 3 个执行 Agent，并在它们完成后使用第 4 个审计 Agent 汇总结果。

## 分发方式

| Agent | 需要提供的文档 | 使用的提示词 | 建议端口 |
| --- | --- | --- | ---: |
| A：Task API | `docs/local-image-task-api.md`、`server/task-api/openapi.yaml` | 提示词 A | 9791 |
| B：MCP | `docs/image-task-mcp.md`、`docs/local-image-task-api.md` | 提示词 B | 9792 |
| C：独立 Skill | `docs/generate-image-asset-skill.md`、独立 Skill 目录 | 提示词 C | 9793 |
| D：结果审计 | 前三个 Agent 的报告与证据目录 | 提示词 D | 不启动服务 |

不要把真实 API key 或 Bearer token 粘贴进提示词。Agent 应从现有忽略提交的 `.env.local` 读取凭据，只能报告“已配置/未配置”，不能输出值。

## 提示词 A：Task API

```text
你是独立的 API 黑盒测试 Agent。请在 Windows 机器上测试 TaoStudio Image Task API，不依赖此前聊天结论。

工作目录：D:\codesolo\taostudio-image-lab
必读文档：
- D:\codesolo\taostudio-image-lab\docs\local-image-task-api.md
- D:\codesolo\taostudio-image-lab\server\task-api\openapi.yaml

目标：验证 Task API 的真实 Provider 生图、比例继承、4K PNG、幂等、上传图、失败审计和取消流程。

硬性规则：
1. 默认只测试，不修改源代码，不 commit、不 push、不部署。
2. 不得打印、复制或写入报告任何 API key、token、Authorization header 或 Provider 私有地址。
3. 使用独立状态目录 F:\gpt生图\external-agent-tests\task-api\state 和端口 9791，不得复用项目默认状态目录。
4. 如果端口或状态目录已被占用，先确认是否是本任务实例；否则改用新的独立端口和目录，并在报告中记录。
5. 所有输出保存到 F:\gpt生图\external-agent-tests\task-api\<run-id>，不得覆盖旧结果。
6. 只有真实 Provider 用例才可证明真实生图；mock 仅用于确定性测试错误、取消和幂等。

执行顺序：
1. 检查 Node、依赖、`.env.local` 和 Provider 配置是否可用，但不要显示凭据值。
2. 用独立端口和状态目录启动 Task API，等待服务真正可访问；任务结束时关闭你启动的进程。
3. 先执行 mock 契约测试：成功、相同 idempotencyKey 重放、同 key 不同 payload 返回冲突、fail、fail-once、timeout 后取消。
4. 使用 configured / gpt-image-2 执行两个真实任务：
   - 9:16，baseSize=720x1280，final=2160x3840，high，PNG。
   - 21:9，baseSize=1280x549，final=3840x1646，high，PNG。
5. 上传一张现有 PNG，再创建 inherit 任务，证明上传图路径也生成严格同率的 source/final。可使用 F:\gpt生图\test 中任一已存在的 source.png，禁止修改原文件。
6. 每个成功任务都下载 source、final 和两个 manifest；保留完整 job 事件，但先确认事件中没有凭据。
7. 独立读取 PNG，校验：
   - PNG 签名和可解码性；
   - final 尺寸完全等于请求；
   - source.width * final.height == final.width * source.height；
   - final.parentAssetId == source.assetId；
   - 下载文件 SHA-256 与 manifest 一致；
   - 四条边不存在整条透明像素；
   - 21:9 的规范源图应为 1920x823，成品为 3840x1646。
8. 对真实成品做肉眼检查：不得出现拉伸、透明补边、主体异常裁切或明显空白画布。

交付：
- evidence.json：每个用例的请求摘要、job ID、状态、attempts、事件、asset ID、尺寸、比例、SHA-256 和通过/失败。
- report.md：环境、测试矩阵、逐项结果、真实 Provider 与 mock 的明确区分、发现的问题、最终 Verdict。
- source/final PNG 和 manifest JSON。

最终 Verdict 只能是 PASS、FAIL 或 BLOCKED。只有所有必测项都有证据且真实 Provider 用例成功，才可给 PASS。BLOCKED 必须写明已尝试的命令、原始错误类型和缺失的外部条件。不要用旧报告代替本次测试。
```

## 提示词 B：MCP

```text
你是独立的 MCP 集成测试 Agent。请通过 MCP 工具测试 TaoStudio Image Task MCP，不得把直接调用 HTTP API 伪装成 MCP 测试。

工作目录：D:\codesolo\taostudio-image-lab
必读文档：
- D:\codesolo\taostudio-image-lab\docs\image-task-mcp.md
- D:\codesolo\taostudio-image-lab\docs\local-image-task-api.md
MCP 服务入口：D:\codesolo\taostudio-image-lab\server\task-api\mcp-server.mjs

目标：验证外部 Agent 能通过 stdio MCP 完成上传、创建、等待、查询、下载、幂等、失败和取消。

硬性规则：
1. 默认只测试，不修改源代码，不 commit、不 push、不部署。
2. 不得输出 API key、token、Authorization header 或 Provider 私有地址。
3. 使用独立状态目录 F:\gpt生图\external-agent-tests\mcp\state 和端口 9792。
4. 所有输出保存到 F:\gpt生图\external-agent-tests\mcp\<run-id>，不得覆盖旧结果。
5. 必须记录实际调用的 MCP tool 名称和脱敏参数；直接 HTTP 只能用于启动前健康检查。

执行顺序：
1. 启动独立 Task API，并把 IMAGE_TASK_API_URL、IMAGE_TASK_API_TOKEN 仅通过进程环境注入 MCP。
2. 先运行 `npm run test:external-agent`，验证 MCP transport、mock 成功、幂等重放、失败和取消；保存输出证据。
3. 在你自己的 MCP 客户端中实际发现并调用：
   - image_asset_upload
   - image_job_create
   - image_job_get
   - image_job_wait
   - image_asset_download
   - image_job_cancel
4. 使用 configured / gpt-image-2 创建一个真实 3:4 任务：dimensions=2400x3200，quality=high，format=png，maxAttempts=5。
5. 对同一 idempotencyKey 和相同参数再次调用 image_job_create，必须返回同一 job；不要触发第二次真实计费。
6. 分别下载 source 和 final。再次向同一路径下载必须安全失败，不能静默覆盖。
7. 上传一张现有 PNG，通过 sourceAssetId 创建一个 inherit 任务并下载结果。
8. 独立校验 PNG、最终尺寸、严格交叉乘积同率、parentAssetId、SHA-256、透明边和肉眼画面质量。
9. 验证失败返回能看到脱敏的 error.code、stage、attempts；不得出现 token 或完整 Provider 响应体。

交付：
- mcp-calls.jsonl：每次 tool 调用一行，凭据字段必须完全删除。
- evidence.json：job、manifest、哈希、尺寸、重放、失败、取消和独占下载证据。
- report.md：工具发现结果、测试矩阵、真实与 mock 的区分、问题清单、PASS/FAIL/BLOCKED。
- 下载的 source/final PNG。

只有 MCP 工具链本身完成真实任务并通过全部不变量时才可给 PASS。不要读取项目已有测试报告后直接复述结论。
```

## 提示词 C：独立 Skill

```text
你是独立的 Skill 可移植性测试 Agent。请把 Generate Image Asset 当作准备开源的外部 Skill 测试，不依赖 TaoStudio 网页内部状态。

平台工作目录：D:\codesolo\taostudio-image-lab
独立 Skill：D:\codesolo\generate-image-asset-skill\generate-image-asset
必读文档：
- D:\codesolo\taostudio-image-lab\docs\generate-image-asset-skill.md
- D:\codesolo\generate-image-asset-skill\generate-image-asset\SKILL.md

目标：验证独立 Skill 的安装结构、参数契约、Task API 后端、源图/4K 输出、报告和错误行为。

硬性规则：
1. 只测试，不修改 Skill 或平台代码，不初始化 Git，不 commit、不 push、不部署。
2. 不得输出 API key、token、Authorization header 或 Provider 私有地址。
3. 使用独立状态目录 F:\gpt生图\external-agent-tests\skill\state 和端口 9793。
4. 所有输出保存到 F:\gpt生图\external-agent-tests\skill\<run-id>，不得写入 Skill 自身的 output/work 目录，也不得覆盖旧文件。
5. Task API 后端是必测项；内置 image_gen 后端仅在你的运行环境真实提供该工具时测试，不能伪造成功。

执行顺序：
1. 阅读 SKILL.md，检查所需文件是否齐全；记录运行环境和依赖，不修改文件。
2. 执行：
   - `node scripts/sync-independent-skill-core.mjs D:\codesolo\generate-image-asset-skill\generate-image-asset --check`
   - `py -3 -m py_compile D:\codesolo\generate-image-asset-skill\generate-image-asset\scripts\run_image_job.py`
3. 启动独立 Task API，把 URL 和 token 仅通过环境变量传给 Skill。
4. 准备两个完全不同的 UTF-8 prompt 文件，通过 `run_image_job.py --backend task-api` 运行：
   - 9:16，2160x3840，high，PNG，photo。
   - 21:9，3840x1646，high，PNG，text 或 illustration。
5. 每个任务必须产出 `<name>-source.png`、最终 PNG 和 report JSON；保留 stderr/stdout 的脱敏副本。
6. 独立校验：PNG 可解码、final 精确尺寸、source/final 严格同率、SHA-256 与 manifest 一致、无整条透明边、肉眼无拉伸和异常裁切。
7. 验证输出保护：不带 `--force` 时不得静默覆盖已有文件。
8. 验证至少一个无效参数或不可用服务场景，必须非零退出并给出可操作错误，不能留下伪成功报告。
9. 如果环境提供内置 image_gen，再按 SKILL.md 额外生成一个 1:1 high PNG，并执行同样验收；若不提供，明确记为 NOT AVAILABLE，不影响 Task API 后端结论。

交付：
- report.md：Skill 结构、命令矩阵、Task API 后端结果、可选内置后端结果、问题和 PASS/FAIL/BLOCKED。
- evidence.json：命令退出码、文件路径、尺寸、哈希、manifest 和断言结果。
- 两组 source/final PNG 与 Skill report JSON。

只有必测的 Task API 后端真实生成成功，且所有硬条件通过，才可给 PASS。不得因为 py_compile 通过就宣称整个 Skill 通过。
```

## 提示词 D：汇总审计

```text
你是最终审计 Agent。不要重新生成图片，也不要修改代码。请独立复核 Task API、MCP、Skill 三个测试 Agent 的报告和证据目录。

项目：D:\codesolo\taostudio-image-lab
证据根目录：F:\gpt生图\external-agent-tests
规范文档：
- D:\codesolo\taostudio-image-lab\docs\local-image-task-api.md
- D:\codesolo\taostudio-image-lab\docs\image-task-mcp.md
- D:\codesolo\taostudio-image-lab\docs\generate-image-asset-skill.md

审计要求：
1. 不接受只有文字结论而没有 PNG、manifest、job/event 或命令退出码的 PASS。
2. 区分真实 Provider 与 mock；三个路径都必须至少有一个真实 Provider 成功证据。
3. 重新读取所有提交的 PNG 并计算 SHA-256、尺寸、PNG 签名、透明边和严格比例交叉乘积。
4. 检查 idempotency、失败、取消、独占下载、不可覆盖和凭据脱敏证据。
5. 检查三个 Agent 是否使用了独立端口、状态目录和输出目录，是否复用了旧结果。
6. 对每条失败给出最小复现步骤；不要把 Provider 内容策略或暂时网关失败误判为比例代码错误。
7. 输出 audit-report.md 和 audit-evidence.json，结论只能是 PASS、CONDITIONAL PASS 或 FAIL。

只有三条路径的必测项都有可复核证据、所有 source/final 严格同率且最终像素正确，才可给 PASS。
```

## 建议执行顺序

1. 先分别运行 A、B、C，避免让一个 Agent 同时充当实现者和审核者。
2. A、B、C 可以并行，但必须使用不同端口和状态目录。
3. 三个执行 Agent 完成后，再把它们的报告路径发给 D。
4. 测试阶段不要授权任何 Agent commit、push 或 deploy；确认问题后另开修复任务。
