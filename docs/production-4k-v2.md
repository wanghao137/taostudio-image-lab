# Production 4K v2（2026-09-14 上线说明）

本文件记录 4K 输出链路 v2 改造的**已实现部分**（P0 全量）与后续路线（P1/P2）。
方针对齐《TaoStudio Image Lab — Production 4K v2 顶级本地方案执行任务书》。

## 核心原则（不变式）

```text
源图真实像素量 > 几何正确性 > 重采样算法 > 色彩处理 > 编码 > 锐化
```

- Provider Request Size ≠ Production Target Size：16 倍数是 Provider 约束
  （官方 OpenAI 要求），不是资产约束；交付目标一律精确到预设原始值。
- 原始 Provider 图永久作为 Source of Truth（exactSizeOriginalImages /
  引擎 source asset 双通道保留）。
- 所有生产输出可追溯（manifest transform + SHA-256 + pixelSha256）、可验证
  （精确尺寸断言）、可复现（同输入两跑字节+像素一致）。
- 禁止静默质量降级：任何 fallback 都记录 requested/reason 并在 UI 可见。
- 默认不使用 AI Super Resolution；USM 锐化默认关闭（filter 参数控制清晰度）。

## P0 已实现

### P0-A Provider Capability Resolver（前端画廊链路）

- 新增 `src/lib/providerCapability.ts`：按 `provider|host|apiMode|模型` 记录
  「请求尺寸 → 实际返回尺寸」观测（localStorage `gpt-image-provider-capability-v1`，
  每配置保留最近 12 条），自适应决定请求档位。
- `paramCompatibility.ts`：**移除 2026-08-14 的「openai 一律 cap 1K」全局假设**
  （2026-09-11 实测 images 通道 size 真实生效）。默认全尺寸请求；仅当同一配置
  ≥2 次强请求（≥2.4MP）全部被压回 ~1K 档时才收口。`nativeLargeOutput=true`
  仍为显式豁免。
- 观测只在**纯文生图**链路记录（编辑链路输出画幅锁定输入图，观测会被污染）。
- Provider 中立：host 仅作为 opaque 分组 key。

### P0-B 交付尺寸解耦

- `src/lib/size.ts` 新增 `resolveExactDeliverySize`：入参尺寸归一化后若与某档
  预设的归一化形态一致，交付目标解析为**预设原始精确值**（4:5 4K =
  2400×3000 而非 2400×3008；21:9 = 3840×1646）。预设表本身零改动（保持
  engine 直发 provider 的唯一真源不变）。
- `getExactImageSizeTarget` / 比例校正目标统一走该解析。
- 请求侧仍始终 `normalizeImageSize`（16 倍数，官方约束兼容）。

### P0-C 引擎原生 Production Resampler

- 新增 `server/task-api/resampler/`：`policy.mjs`（contentClass → 滤镜路由，
  业务层只见 auto/faithful/detail 档位）、`imagemagick.mjs`（pinned sidecar
  探测/执行）、`manifest.mjs`（pixelSha256 + transform 组装）、`index.mjs`
  （`resizeProductionAsset` 唯一入口）。
- 后端链：ImageMagick 7 EWA `-filter LanczosSharp -distort Resize WxH!`（默认）
  → sharp 确定性回退（如实标注 upscale≈cubic）。crop 为显式中心 cover 裁切
  并记录像素；源==目标时 passthrough 字节级保留。
- 安全：`spawn(shell:false)`、参数全部固定枚举/内部临时路径、资源限额
  （memory/map/disk/time/width/height/area）、超时 kill、AbortSignal 取消
  （引擎 enhancing 阶段注册 controller，cancel during resize 即时中止）、
  输入仅接受引擎自产 PNG、输出经 sharp 精确尺寸校验。
- 字节级可复现：`-strip`（剥掉 IM 日期等非确定性元数据；实测 3 跑 sha 一致）。
- sidecar：`tools/imagemagick/`（二进制不入库，`VERSION.md` 锚定
  7.1.2-31 Q16 portable + 归档 SHA-256 与安装步骤）；探测顺序 env
  `TAOSTUDIO_IMAGE_MAGICK` → pinned sidecar → PATH。
- manifest：final asset 新增 `transform.resampler`（backend/method/filter/
  colorspace/source/crop/target/scale/passes/fallback）与 `pixelSha256`
  （canonical RGBA + 宽高前缀）；`/v1/capabilities` 暴露 resampler 后端信息。

### P0-D 浏览器统一像素通路

- `exactImageSize.ts`：**所有输出格式共享同一 Lanczos3 像素**——JPEG/WebP 不再
  走 Canvas resize（旧路径输出格式会改变几何采样结果），而是 Worker 像素 1:1
  绘制后仅做编码（Canvas 降级为纯编码器）。
- `imageResizer.ts`：`resizeImageHighQualityDetailed` 返回
  `{backend, requestedBackend, fallbackReason}`；Worker→Canvas 回退不再静默。
- `ExactSizeTransformRecord` 新增 `resizerBackend` / `resizerFallbackReason`；
  详情页显示「处理器」徽标（Lanczos3·本地 / Canvas·兼容回退，回退态琥珀色，
  title 展示原因）。
- Canvas 兼容回退的定位：Compatibility only，不再属于 Production HQ。

### P0-E Benchmark v2

- `scripts/benchmark-4k-v2.mjs`（`npm run benchmark:4k:v2`）：双独立退化
  （IM Box + sharp mitchell，无循环偏置）、分窗 SSIM + MS-SSIM、边缘过冲/
  欠冲、ΔE76、alpha 合成色偏、精确尺寸断言、运行时间、确定性探针；数据集 =
  合成边缘用例（生产预设 GT）+ alpha 专项 + 真实历史生成图。
- v1 benchmark 停用为生产决策依据（文档已标注）。

## 关键测试

- `src/lib/providerCapability.test.ts`、`paramCompatibility.test.ts`（新策略）、
  `size.test.ts` / `exactImageSize.test.ts`（交付尺寸解析）。
- `server/task-api/resampler/resampler.test.mjs`：sharp 回退/EWA/确定性/精确
  crop/alpha 无黑边/abort（无 sidecar 环境自动 skip EWA 组，CI 可跑）。
- `server/task-api/service.test.mjs`：mock job manifest 断言 resampler transform
  + pixelSha256（服务测试固定禁用 sidecar 保证毫秒级；EWA 由专项覆盖）。

## P1/P2 路线（未实施）

- P1-A：contentClass → 滤镜分叉路由（须 benchmark v2 `--full` + 人工盲测背书；
  当前全部统一 LanczosSharp，结构已就绪于 `policy.mjs`）。
- P1-B：Manifest v2 schema 全面化（跨浏览器/引擎统一字段命名）。
- P1-C：引擎侧 provider capability 学习（当前仅前端画廊链路）。
- P1-D：UI 全面透明化（Source/Production/Scale/Processor/Crop 信息板）。
- P2：照片 sigmoidized EWA、显式 Detail+ 档；AI SR 保持 experimental/not
  installed/not production default。
