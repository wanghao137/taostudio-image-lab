# 4K Quality Benchmark

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
