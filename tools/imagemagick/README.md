# ImageMagick Sidecar（Production 4K v2）

引擎 EWA 重采样后端的 pinned 便携版 ImageMagick。**二进制不入库**（本目录除
`VERSION.md` 与本文件外全部被 `.gitignore` 忽略）。

- 版本锚定、归档 SHA-256、安装与升级纪律：见 [VERSION.md](./VERSION.md)
- 引擎探测与安全调用：`server/task-api/resampler/imagemagick.mjs`
- 为什么选 EWA LanczosSharp 与完整链路说明：`docs/production-4k-v2.md`
