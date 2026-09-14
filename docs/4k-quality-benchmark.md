# 4K Quality Benchmark（v1 — 已停用为生产决策依据）

> **状态（2026-09-14）**：本基准存在循环偏置（sharp lanczos3 自造退化再自恢复）、
> 全图单值 SSIM、样本仅 3 张等方法学问题，**不再作为生产决策依据**，仅保留作
> 历史记录。生产决策请使用 **v2**：`npm run benchmark:4k:v2` +
> [4k-quality-benchmark-v2.md](./4k-quality-benchmark-v2.md)。
> v1 的「Default: deterministic Sharp lanczos3」结论已被 Production 4K v2 取代
> （引擎默认 ImageMagick EWA LanczosSharp，sharp 仅为确定性回退；libvips 放大时
> lanczos3 kernel 实际映射为 cubic 插值）。

## Decision

- Default: deterministic Sharp `lanczos3` resize.
- Text, logo, and UI: generative super-resolution is forbidden.
- Photo and illustration: an AI enhancer may be selected explicitly only when
  its model is installed and passes this benchmark. Any load, inference, or
  verification failure falls back to `lanczos3`.
- Real-ESRGAN and HAT are candidates, not production dependencies.

## Method

`npm run benchmark:4k` uses two real TaoStudio source images and one synthetic
text/logo/UI reference. Each reference is downsampled 4x and reconstructed to
the original pixel dimensions. The report records elapsed time, RGB PSNR, and
global SSIM. It also times one full `1536x1024 -> 3456x2304` 3:2 resize.

Optional model commands use `{input}` and `{output}` placeholders:

```powershell
$env:REALESRGAN_BENCHMARK_COMMAND='path-to-runner {input} {output}'
$env:HAT_BENCHMARK_COMMAND='path-to-runner {input} {output}'
npm run benchmark:4k
```

Missing models are reported as `no-go`, not silently omitted. The generated
artifacts and machine-readable report live under `output/quality-benchmark/`.

## Current Local Evidence

- No NVIDIA GPU is available on this workstation.
- A CPU PyTorch environment was created in an ignored directory.
- Real-ESRGAN imports only after pinning compatible Torch/Torchvision and
  correcting BasicSR's removed `functional_tensor` import.
- Official model asset downloads were reset or unreachable from the current
  network; HAT weights are distributed through Google Drive/Baidu rather than
  the source repository. Therefore both AI candidates are currently `No-Go`
  for this local production worker until weights and a supported inference
  runtime are provisioned.
- Lanczos3 remains immediately deployable, deterministic, provider-neutral,
  and exact in output dimensions. It does not invent detail and must not be
  described as AI enhancement.
