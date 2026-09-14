# ImageMagick Pinned Sidecar

生产 4K v2 的原生 EWA 重采样后端。二进制不入库（体积与许可分发原因），
本文件是版本锚定与完整性校验的唯一真源。

## 当前锚定版本

| 项 | 值 |
| --- | --- |
| 版本 | ImageMagick 7.1.2-31 Q16 x64（portable） |
| 发布资产 | `ImageMagick-7.1.2-31-portable-Q16-x64.7z` |
| 来源 | https://github.com/ImageMagick/ImageMagick/releases/tag/7.1.2-31 |
| 下载通道 | GitHub Releases（经 api.github.com 资产通道亦可，仍为官方源） |
| 归档 SHA-256 | `33d8b47bb404a6b30c672195795e64a8ce0c807f9bba084e359ff086d6c5d50d` |
| 许可 | ImageMagick License（允许内部与商业使用，见解压后 LICENSE.txt） |

## 安装（本机一次）

```bash
cd tools/imagemagick
mkdir -p .download
curl -L -o .download/im.7z \
  "https://github.com/ImageMagick/ImageMagick/releases/download/7.1.2-31/ImageMagick-7.1.2-31-portable-Q16-x64.7z"
# 校验（PowerShell: Get-FileHash；Git Bash: sha256sum）
sha256sum .download/im.7z   # 必须等于上表 SHA-256
# 解压到本目录（Windows 自带 bsdtar 支持 7z 读取）
tar -xf .download/im.7z -C .
./magick.exe -version       # 应输出 Version: ImageMagick 7.1.2-31 Q16 x64
```

## 引擎如何发现它

`server/task-api/resampler/imagemagick.mjs` 按序探测：

1. 环境变量 `TAOSTUDIO_IMAGE_MAGICK`（显式路径；`0`/`off` 显式禁用）；
2. 本目录 `magick.exe`（pinned sidecar，推荐）；
3. `PATH` 中的 `magick`（开发机兜底；transform 会如实记录 unpinned 版本串）。

注意：`scripts/sync-skill-engine.mjs` 会把 resampler 拷贝到独立 skill 引擎
（`<skill>/engine/resampler/`），该布局下仓库根探测不适用——skill 引擎如需 EWA，
请设置 `TAOSTUDIO_IMAGE_MAGICK` 指向一份 sidecar，或确保 PATH 可用；否则
skill 引擎走 sharp 确定性回退（transform.fallback 如实记录，非静默）。

## 升级纪律

- 升级 = 更新本文件（版本、SHA-256）+ 重新下载解压 + 重跑
  `server/task-api/resampler/resampler.test.mjs` 的确定性用例
  （同 Source+Target 下 pixelSha256 必须仍然两跑一致）。
- 不同 ImageMagick 版本可能产生微小像素差异；生产环境不得混用版本。
