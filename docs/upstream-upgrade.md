# 上游一键升级

本项目基于 `CookSleep/gpt_image_playground`，但保留 TaoStudio 自己的品牌、UI 和本地配置。上游升级能力由以下文件组成：

- `upstream-upgrade.cmd`：Windows 双击入口。
- `npm run upgrade:upstream`：命令行入口。
- `scripts/upgrade-upstream.mjs`：升级执行脚本。
- `upstream-upgrade.config.json`：上游地址、分支和本地保留路径配置。
- `docs/upstream-upgrade-state.json`：上游基线和最近应用记录。
- `docs/upstream-upgrade-report.md`：每次真实升级后生成的本地报告，不提交到仓库。

## 一键升级

在 Windows 文件管理器里双击：

```text
upstream-upgrade.cmd
```

它会执行：

```bash
npm run upgrade:upstream -- --install --verify
```

也就是：

- 拉取 `https://github.com/CookSleep/gpt_image_playground.git` 的 `main` 分支。
- 将上游底层功能文件同步到当前项目。
- 保留 TaoStudio 的 UI/品牌覆盖文件。
- 合并上游 `package.json` 依赖，同时保留本项目名称和本地脚本。
- 执行 `npm install`。
- 执行 `npm run lint`、`npm run test`、`npm run build`。
- 生成 `docs/upstream-upgrade-report.md`。

## 先预览变更

如果只想看会改哪些文件，不实际写入：

```bash
npm run upgrade:upstream -- --dry-run
```

## 保护规则

升级脚本默认要求 git 工作区是干净的。如果有未提交改动，会停止，避免覆盖本地工作。

保留路径由 `upstream-upgrade.config.json` 的 `preservePaths` 控制。当前重点保留：

- TaoStudio 品牌和入口：`index.html`、`public/brand`、`public/manifest.webmanifest`
- Studio Console UI 覆盖：`src/App.tsx`、`src/components/Header.tsx`、`src/components/SearchBar.tsx`、`src/components/TaskGrid.tsx`、`src/components/InputBar.tsx`、`src/index.css`
- 项目文档、升级脚本、本地验证脚本和 GitHub 工作流相关文件
- 本地环境文件和运行产物：`.env*`、`.omx`、`.upstream`

如果上游在这些被保留文件里新增了关键功能，升级后需要人工对比上游对应文件，把必要逻辑手动移植到 TaoStudio UI 覆盖文件。

## 更换上游分支或地址

临时指定：

```bash
npm run upgrade:upstream -- --ref main
npm run upgrade:upstream -- --repo https://github.com/CookSleep/gpt_image_playground.git --ref main
```

长期修改请编辑：

```text
upstream-upgrade.config.json
```

## 升级后的检查

至少执行：

```bash
npm run lint
npm run test
npm run build
```

如果本地 dev server 已启动，还可以执行：

```bash
npm run verify:ui -- http://127.0.0.1:5175/
```
