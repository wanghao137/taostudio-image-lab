# 4K Quality Benchmark v2（Production 4K v2）

运行（要求 Node ≥ 22.18：脚本直接 `import '../src/lib/lanczos.ts'`，依赖 Node
类型剥离默认开启）：

```bash
npm run benchmark:4k:v2                      # quick：合成 3 类 × [1.5625, 2.25] + alpha 专项 + 真实图 4 张
npm run benchmark:4k:v2 -- --full            # 全量 scale 矩阵（1.10/1.25/1.50/1.5625/2.00/2.25/3.00）
npm run benchmark:4k:v2 -- --real 8          # 更多真实样本
npm run benchmark:4k:v2 -- --dataset-dir "F:/gpt生图/4K"
TAOSTUDIO_IMAGE_MAGICK=0 npm run benchmark:4k:v2   # 无 sidecar：跳过 IM 候选（报告如实记录）
```

输出：`output/quality-benchmark-v2/report.json`（逐行原始指标）、`report.md`（汇总表）。

## 与 v1（benchmark:4k）的方法学差异

v1 已**停用为生产决策依据**（保留作历史），四个致命问题：

1. **循环偏置**：v1 用 sharp lanczos3 下采样制造低清图，再用候选恢复——天然偏向
   lanczos 家族。v2 的退化管线与全体候选独立：ImageMagick EWA `Box` filter +
   sharp `mitchell` 两条独立退化（mitchell 退化与 mitchell 候选同族，报告已标注，
   排名以 im-box 退化 + 真实图行为准）。
2. **SSIM 是全图单值统计**：v2 使用标准 8×8 分窗 SSIM（stride 4，luma）+ 5 尺度
   MS-SSIM（2×2 平均金字塔，标准权重）。
3. **样本只有 3 张且路径硬编码**：v2 = 合成边缘用例（渐变风景 / 棋盘+文字+斜线
   海报 / Siemens 星+1px UI 线，GT 尺寸即生产预设 3456×2304、2400×3000、2160×3840）
   + alpha 合成专项（半透明主体+阴影）+ TaoStudio 真实历史生成图（默认
   `F:/gpt生图/4K` 抽样，可 `--dataset-dir` 换源）。
4. **候选标注失真**：sharp 旧路径按事实标注为
   `sharp-lanczos3-kernel(upscale≈cubic)`——libvips 放大时 kernel 缺少对应
   interpolator，实际是 cubic 插值，不再是"lanczos3 upscale"。

## 候选

| id | 实现 | 说明 |
| --- | --- | --- |
| browser-lanczos3 | `src/lib/lanczos.ts` 同一纯函数核 + Worker 同款 pre/post multiply | 浏览器生产实现（无 DOM 依赖，可直接在 Node 跑） |
| sharp-lanczos3-kernel(upscale≈cubic) | sharp resize kernel lanczos3 | 引擎旧生产路径（放大≈cubic） |
| ewa-lanczos-sharp | IM `-filter LanczosSharp -distort Resize` | P0 生产默认 |
| ewa-lanczos-radius | IM LanczosRadius | 更锐 / halo 更明显 |
| ewa-robidoux | IM Robidoux | 低 halo 候选 |
| mitchell | IM Mitchell | ringing 敏感内容候选 |

real-esrgan / hat（生成式）刻意排除在确定性 benchmark 之外（core contract 对
text/logo/ui 强制 deterministic 的原则不变）。

## 指标

- 全图 RGB PSNR；
- 8×8 分窗 SSIM（stride 4，luma）；
- 5 尺度 MS-SSIM（luma）；
- 边缘过冲/欠冲（sobel>80 的强边缘像素，候选超出 GT 5×5 局部 min/max 的均值/最大值）；
- ΔE76 色漂（1/64 采样，mean + P95）；
- alpha 合成色偏（半透明边缘像素归一后的合成色差异——黑边/白边检测）；
- 精确尺寸断言（exactDimensions 必须 100%）；
- 运行时间 median / P95；
- 确定性探针（IM LanczosSharp 同输入两跑：字节 + 像素 SHA-256 一致）。

## 已知局限（诚实声明）

- 合成 SVG 内容不是摄影；**感知排名以真实图行为准**。
- SSIM/MS-SSIM 在原生分辨率 luma 上计算，无观看距离模型；数学指标与人眼冲突时
  必须人工盲测仲裁（100%/200%/400% 随机 A/B），P1-A 的 per-class AUTO 路由
  （text/logo/ui → 低 halo 候选分叉）在盲测结论出来前不启用——当前全部
  contentClass 统一 EWA LanczosSharp（见 `server/task-api/resampler/policy.mjs`）。
- 人工盲测资产未自动化；`report.json` 的 per-case 数据可供盲测取样。

## 结论用途

- P0-C 引擎生产 resampler 的默认滤镜（EWA LanczosSharp）以本基准 + resampler
  单测（确定性/alpha/精确尺寸）背书；
- P1-A contentClass 路由分叉必须引用本基准 `--full` 数据 + 人工盲测结论，不允许
  凭感觉 hardcode。
