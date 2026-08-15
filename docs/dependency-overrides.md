# package.json overrides 说明

npm `overrides` 会强制解析传递依赖到指定版本，且仓库里没有任何注释解释
它们存在的原因——这里集中记录，避免未来"不知道为什么钉着"而被误删。

## `mdast-util-gfm-autolink-literal: 2.0.0`

`remark-gfm`（Markdown 渲染）的传递依赖。fork 自上游 `gpt_image_playground`
初始提交带入的版本钉子：上游当时遇到 `remark-gfm@4` 解析出的
`mdast-util-gfm-autolink-literal` 与其内部类型/行为不匹配（duplication
导致 autolink 行为不稳定），将这个子依赖钉回 2.0.0 以保持一致。

**若要解除**：先在 Agent 工作台渲染含自动链接（裸 URL）的 Markdown，
确认渲染正常再移除；解除后 `npm ls mdast-util-gfm-autolink-literal`
应只剩一个副本。

## `dompurify: ^3.4.7`

`streamdown`（Agent 聊天的 Markdown 渲染器）的传递依赖。安全补丁性升级：
早期版本链会解析到含已知 XSS 修复缺口的旧 dompurify，向上钉到
`^3.4.7` 确保始终拿到安全版本。

**若要解除**：`npm ls dompurify` 确认 streamdown 自身已解析到 ≥3.4.7
即可移除。

## 依赖分层（2026-08-15 调整）

以下包只被 Node 端（`server/`、`scripts/`、Workers）使用，前端 `src/`
零 import——已从 `dependencies` 挪到 `devDependencies`，避免 Vercel
前端构建装入无用的原生模块（sharp 是含平台二进制的重依赖）：

- `sharp`（`server/task-api`、批量脚本的图像处理）
- `@modelcontextprotocol/sdk`（`server/task-api/mcp-server.mjs`）
- `zod`（MCP server 的 schema 校验）

`core-js` 已删除：仅剩的一个用途是 `Array.prototype.at` polyfill，
而它自 2021-22 起在全部常青浏览器基线支持。

## CI 注意

`deploy-vercel.yml` 在 Vercel 上跑 `npm ci`——devDependencies 在 Vercel
前端构建中同样会安装（Vercel 默认 `NODE_ENV=production` 时 npm 会跳过
devDeps；本项目 Vercel 构建需要 typescript/vite 等 devDeps，Vercel 对
framework preset 自动用 `--include=dev`，不受影响）。`deploy-worker.yml`
同理。若未来出现安装超时，可考虑把 server/ 拆成独立 workspace。
