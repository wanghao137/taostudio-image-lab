# Generate Image Asset Skill 使用说明

独立 Skill 位于 `D:\codesolo\generate-image-asset-skill\generate-image-asset`。它当前未初始化 Git，也不会随 TaoStudio 仓库提交。

## 两种后端

### Codex 内置生图

默认流程使用 Codex 内置 `image_gen`：先生成缓存图，保存为 `*-source.png`，再生成精确像素的最终 PNG。该路径适合个人直接使用 Skill。

### Image Task API

平台或外部 Agent 已启动 Task API 时，Skill 可以复用同一个任务契约：

```powershell
$env:IMAGE_TASK_API_URL='http://127.0.0.1:9789'
$env:IMAGE_TASK_API_TOKEN='从本地安全配置注入'

py -3 scripts\run_image_job.py `
  --backend task-api `
  --prompt-file work\imagegen\prompt.txt `
  --model gpt-image-2 `
  --provider configured `
  --size 2160x3840 `
  --quality high `
  --output-format png `
  --content-class photo `
  --enhancement lanczos3 `
  --max-attempts 5 `
  --out output\imagegen\example.png
```

长任务的轮询窗口会按照 `maxAttempts * 330` 秒自动扩展，避免服务端仍在重试时 Skill 提前退出。

`--api-mode`（默认 `images`）选择 Provider 端点：`images` 打 `/images/generations`（图像模型如 `gpt-image-2`），`responses` 打 `/responses` + `image_generation` 工具（文本模型如 `gpt-5.6-sol`）。用文本模型生图时同时改 `--model` 和 `--api-mode`：

```powershell
py -3 scripts\run_image_job.py `
  --backend task-api `
  --prompt-file work\imagegen\prompt.txt `
  --model gpt-5.6-sol `
  --api-mode responses `
  --provider configured `
  --size 2880x2880 `
  --quality high `
  --output-format png `
  --content-class illustration `
  --enhancement lanczos3 `
  --max-attempts 5 `
  --out output\imagegen\example.png
```

## 输出

- `example-source.png`：规范源图。
- `example.png`：精确目标尺寸的最终 PNG。
- `example.report.json`：路由、任务 ID、源图与成品尺寸、SHA-256、manifest。
- `example.recovery.json`：内置生图拒绝恢复记录。

Task API 后端成功的硬条件：

1. source 和 final 都能解析为 PNG。
2. final 像素与 `--size` 完全一致。
3. source 和 final 在整数像素下严格同率，即交叉乘积完全相等。
4. 下载文件 SHA-256 与服务端 manifest 一致。

## 比例原则

`--size` 同时给出最终尺寸和比例。例如 `2160x3840` 表示 9:16。第一次生成必须按该比例构图，4K 只继承这个比例。若 Provider 返回相近但不精确的画布，Task API 会先生成整数像素比严格一致的规范源图，并在 manifest 里记录 Provider 原始尺寸与 `cover` 规范化信息。`3840x1646` 的 21:9 成品对应 `1920x823` 规范源图，不使用会产生透明边的 `1280x549`。

## 发布前检查

```powershell
py -3 -m py_compile scripts\run_image_job.py
node --% scripts\image_core_cli.mjs calculate-size {\"tier\":\"4K\",\"ratio\":\"9:16\"}
```

开源前还需要补充许可证、仓库 README、CI 和无密钥示例；不要把当前输出图片、work 目录或本地 token 一起发布。
