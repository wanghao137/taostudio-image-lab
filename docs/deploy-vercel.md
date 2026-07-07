# Vercel 自动部署配置（一次性）

配置完成后，**任何 push 到 main 的代码都会自动部署到 https://image.taostudioai.com/**，不需要手动操作，也不需要本地 vercel CLI。

## 为什么需要这一步

`vercel.json` 里 `git.deploymentEnabled: false`（项目一开始就关闭了 git 自动部署）。原因是早期想用别的部署方式但没落地。本次改用 **GitHub Actions 触发 Vercel 部署**（见 `.github/workflows/deploy-vercel.yml`），比 Vercel 原生 git 集成更可控（CI 里能跑 lint/test/build gates，失败则不部署）。

## 你要做的 3 件事（约 5 分钟，一次性）

### 第 1 步：创建 Vercel Token

1. 打开 https://vercel.com/account/tokens
2. 点 **Create Token**
3. 名称随便填（如 `github-actions-deploy`）
4. **Scope 选 `taostudio-image-lab` 项目**（或 Full Account，但项目级更安全）
5. **Expiration 建议设 No expiration 或 1 年**（设短了会到期，又得配）
6. 创建后**立刻复制 token**（页面关掉就看不到了，形如 `vercel_xxxxxxxxxxxx`）

### 第 2 步：在 GitHub 仓库加 3 个 Secrets

打开 https://github.com/wanghao137/taostudio-image-lab/settings/secrets/actions
点 **New repository secret**，加这 3 个：

| Name | Value |
|---|---|
| `VERCEL_TOKEN` | 第 1 步复制的 token |
| `VERCEL_ORG_ID` | `team_yLkWFllwHMElnHL2UPdCMrHO` |
| `VERCEL_PROJECT_ID` | `prj_3YEQuSzkM4uqRJ3yCgrrFlXSIu8s` |

> 后两个值来自仓库里 `.vercel/project.json`，已经查好了，直接复制粘贴。

### 第 3 步：确认 GitHub Actions 权限

打开 https://github.com/wanghao137/taostudio-image-lab/settings/actions
- **Actions permissions** → 选 "Allow all actions and reusable workflows"
- **Workflow permissions** → 选 "Read and write permissions"（部署需要写 deployment 状态）
- 勾选 "Allow GitHub Actions to create and approve pull requests"（可选）

## 配置完后

下次任何 push 到 main，GitHub Actions 会自动：
1. `npm ci` 装依赖
2. `npm run lint` + `npm test` + `npm run build`（gates，失败则不部署）
3. `vercel --prod` 部署到生产

在 https://github.com/wanghao137/taostudio-image-lab/actions 能看到每次部署的日志。

## 首次部署（手动触发一次，验证配置）

配置好 secrets 后，因为 main 最新 commit（62c46ff）的 push 已发生过，workflow 可能没自动跑（workflow 文件本身在那个 commit 之后才会被 GitHub 识别）。手动触发一次：

1. 打开 https://github.com/wanghao137/taostudio-image-lab/actions/workflows/deploy-vercel.yml
2. 右上角 **Run workflow** → 选 `main` 分支 → 点绿色 **Run workflow**
3. 等 2-3 分钟，绿色✓ = 部署成功，红色✗ = 点进去看日志（常见问题：token 权限不够、orgId/projectId 填错）

成功后访问 https://image.taostudioai.com/ （手机模式或 DevTools 切 390 宽），应该看到移动端新界面（底部 Tab + 创作 FAB）。

## 故障排查

**"Vercel Error: Unauthorized"** → token 过期或 scope 不对，重新生成并更新 `VERCEL_TOKEN` secret。

**"Could not find project"** → `VERCEL_ORG_ID` 或 `VERCEL_PROJECT_ID` 填错，对照 `.vercel/project.json`。

**Build 失败** → workflow 在 lint/test/build 阶段挂掉，说明 gates 没过，**不会**部署半成品（这是好事）。看日志修。

**想关掉某次自动部署** → push 时在 commit message 加 `[skip ci]`，或临时在 GitHub Actions 页面 disable workflow。

## 安全

- Token 存在 GitHub Secrets 里（加密，仓库 owner 可见但不会在日志里明文输出）
- Token scope 限定在单个项目，泄露也只能部署这一个项目
- 想撤销：vercel.com/account/tokens 删除 token 即可立刻失效
