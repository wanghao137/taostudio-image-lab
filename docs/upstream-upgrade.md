# 上游安全升级

本项目基于 `CookSleep/gpt_image_playground`，同时保留 TaoStudio 自己的品牌、UI、Task API、精确尺寸、本地自动保存和部署配置。

升级器使用三方合并，而不是用上游文件覆盖本地文件：

- `base`：`docs/upstream-upgrade-state.json` 记录的上次上游提交。
- `local`：当前 TaoStudio 工作树。
- `upstream`：本次指定的上游 tag、分支或 commit。

只有能证明不会丢失本地修改的文件才会自动写入。发生冲突时，默认不修改项目文件。

## 组成

- `upstream-upgrade.cmd`：Windows 双击入口。
- `npm run upgrade:upstream`：命令行入口。
- `scripts/upgrade-upstream-v2.mjs`：带 pending/CAS 保护和单次 apply 回滚的三方升级器。
- `scripts/upgrade-upstream-v2.test.mjs`：升级器行为测试。
- `upstream-upgrade.config.json`：上游地址、默认 ref 和保留路径。
- `docs/upstream-upgrade-state.json`：已确认完成的上游基线。
- `.upstream/upstream-upgrade-pending.json`：冲突迁移期间的临时状态，不提交。
- `docs/upstream-upgrade-report.md`：真实升级生成的报告，不提交。

## 推荐流程

先在独立升级分支和干净工作树中预检目标版本：

```bash
npm run upgrade:upstream -- --ref v0.7.1 --dry-run
```

如果没有冲突，可直接应用并验证：

```bash
npm run upgrade:upstream -- --ref v0.7.1 --install --verify
```

如果有冲突或保留文件审计项，升级器会保持项目不变。确认位于独立迁移分支后，显式开始迁移：

```bash
npm run upgrade:upstream -- --ref v0.7.1 --write-conflicts
```

解决报告中的文本冲突。所有冲突和保留文件都必须逐项审计，并用可重复的 `--acknowledge <路径>` 显式确认，再 finalize：

```bash
npm run upgrade:upstream -- --finalize --acknowledge src/types.ts --acknowledge public/brand/logo.png --install --verify
```

`--finalize` 之前：

- `docs/upstream-upgrade-state.json` 仍指向旧基线。
- 冲突文件中不能残留 `<<<<<<<` / `>>>>>>>`。
- pending 的 base、仓库、分支和 HEAD 必须仍与迁移起点一致。
- 自动应用文件的 SHA-256/删除状态必须仍与 pending 一致；如果人工调整了自动合并结果，也必须对该路径显式 `--acknowledge`。
- 所有冲突和保留文件审计项都必须显式 `--acknowledge`。
- `git diff --check` 必须通过。
- `--verify` 是推进基线的硬门槛；依赖元数据变化时还必须使用 `--install`。
- 不应提交半完成的 pending 迁移。

finalize 成功后，可再次运行相同目标的 dry run 验证状态机幂等性。这个结果只能证明没有重复待应用变更，不能替代对保留文件和产品行为契约的审计：

```bash
npm run upgrade:upstream -- --ref v0.7.1 --dry-run
```

## 文件分类

升级器会把文件分为：

- `copied`：上游新增、本地不存在。
- `updated`：本地仍等于旧基线，可安全替换为上游版本。
- `merged`：本地和上游都修改，但三方合并无冲突。
- `deleted`：上游删除且本地未修改。
- `localOnly`：只有 TaoStudio 修改，上游相对基线未变。
- `preservedUpstreamChanges`：保留文件在上游发生变化，必须人工审计。
- `conflicts`：双方修改同一区域、双方新增同一路径，或删除/修改冲突。

`package.json` 使用结构化合并：

- 每个字段都以旧上游为 base 做三方判断。
- 只有一方变化时吸收该方；双方得到相同结果时直接接受。
- 同一字段被 TaoStudio 和上游改成不同值时产生 markerless 冲突，不允许按固定优先级静默覆盖。
- 同一 `package.json` 内无冲突字段仍会写入 proposed merge，冲突字段保留 local 值并要求人工确认。
- `package-lock.json` 只有上游变化时吸收上游版本；双方变化或上游删除时进入 markerless 冲突，随后由 `npm install` 校验最终锁文件。

## TaoStudio 行为契约

每次升级必须证明以下能力仍然存在，不能只以“编译通过”为完成条件：

- Task API 配置读取、参考图上传、`executeImageTask` 调度和普通 API fallback。
- OpenAI Images、Responses、Edit、fal.ai 和自定义异步任务路径。
- 精确尺寸后处理、原图关联和变换记录。
- 本地自动保存、权限恢复、失败重试、导入后 pending 归一化。
- Agent 批量生成、分支对话、删除事务和图片引用清理。
- 收藏夹、输入草稿、IndexedDB 图片和缩略图恢复。
- TaoStudio 品牌、中文 UI、移动端布局和本地部署配置。

至少运行：

```bash
npm run test:upgrade
npm run lint
npm test
npm run build
npx vitest run server/task-api/service.test.mjs server/task-api/web-agent.e2e.test.mjs
```

前端升级还必须在本地浏览器验证桌面和移动宽度。

## 保留路径

`upstream-upgrade.config.json` 的 `preservePaths` 用于明确由 TaoStudio 完全所有的覆盖层，例如：

- 品牌和入口文件。
- TaoStudio 的核心 UI 覆盖。
- `src/types.ts` 等需要加法式合并的公共契约。
- 本地代理、部署、验证和升级工具。
- 文档、环境文件及本地运行目录。

保留不等于上游改动可以忽略。报告出现 `preservedUpstreamChanges` 时，必须逐项判断：

1. 上游改动是否修复安全、数据一致性或接口契约问题。
2. TaoStudio 是否已有等价实现。
3. 是否需要把上游逻辑手工移植到本地覆盖层。
4. 是否需要新增回归测试固定结论。

深度定制的 UI 文件无法做到永远零人工冲突。可持续升级的目标是：底层通用逻辑尽量归入上游模块边界，自有功能保持独立模块和明确适配层，使人工工作集中在少量真实产品差异上。

定时同步工作流只跟踪最新的 `v*` Release tag，不直接追踪上游 `main`。发现新 Release 后，它使用同一升级器和验证门禁创建审查 PR；遇到冲突或保留文件审计项时只报告失败，不自动推进基线。

升级器只处理普通 Git 文件。symlink、submodule、特殊 index mode、可执行位变化、case-only 重命名/碰撞、命中 TaoStudio `.gitignore` 的上游新增文件，以及 file/directory 形态切换都会在写项目文件前硬失败，必须单独审计迁移。

## 参数

```text
--dry-run          只拉取并分类，不写项目文件
--write-conflicts  应用安全变更并显式写入文本冲突
--finalize         完成 pending 迁移并更新基线
--acknowledge <p>  显式确认一个保留文件或无文本标记冲突，可重复
--install          执行 npm install
--verify           执行 lint、test、build；推进基线时必需
--allow-dirty      允许脏工作树，仅限已审计的迁移分支
--repo <url>       临时覆盖上游仓库
--ref <ref>        指定 tag、分支或 commit
```
