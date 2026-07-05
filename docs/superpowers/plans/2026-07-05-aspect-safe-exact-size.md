# Aspect-Safe Exact Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TaoStudio Image Lab produce exact-size outputs without geometric deformation, regardless of requested aspect ratio or provider-returned source dimensions.

**Architecture:** Treat API generation and local exact-size processing as two separate contracts. The API receives both a machine size parameter and a derived semantic aspect-ratio prompt hint, but the app still assumes providers may return any source dimensions. Local exact-size processing must preserve source geometry by using a single uniform scale, then either crop (`cover`) or pad (`contain`) to the requested target.

**Tech Stack:** React, TypeScript, Zustand, IndexedDB, browser Canvas, Vitest.

---

## First Principles

There are four independent invariants:

1. Final file dimensions: when `exact_size=true`, the stored final image must be exactly `target.width x target.height`.
2. Visual geometry: source pixels must never be scaled with different X and Y factors.
3. Source preservation: the provider-returned image must remain available unchanged as `exactSizeOriginalImages`.
4. Observability: requested params, API-returned actual params, source dimensions, final dimensions, and local fit mode must be visible enough to debug.

When source aspect ratio differs from target aspect ratio, it is impossible to satisfy all of these at once: exact size, no distortion, no crop, no padding. The app must choose a policy:

- `cover`: uniform scale until the target canvas is filled, then crop overflow. Good default for generated commercial assets because the final frame is filled and geometry is preserved.
- `contain`: uniform scale until the whole source is visible, then pad remaining area. Good for source-preserving workflows where cropping is unacceptable.
- `stretch`: legacy behavior only. Do not use by default because it breaks visual geometry.

The current bug exists because `src/lib/exactImageSize.ts` uses `ctx.drawImage(image, 0, 0, target.width, target.height)`, which creates independent X/Y scale factors whenever source and target ratios differ.

## File Structure

- Modify `src/lib/exactImageSize.ts`
  - Own pure geometry planning and canvas rendering for exact-size post-processing.
  - Export `computeExactSizeDrawPlan` for unit tests and UI/debug metadata.

- Create `src/lib/exactImageSize.test.ts`
  - Unit-test generic aspect-safe draw plans for portrait, landscape, square, same-ratio, and mismatch cases.

- Create `src/lib/targetAspectPrompt.ts`
  - Derive a provider-neutral prompt hint from any concrete `WIDTHxHEIGHT`.
  - Do not hard-code `9:16`; reduce arbitrary dimensions to a ratio.

- Create `src/lib/targetAspectPrompt.test.ts`
  - Unit-test ratio reduction and prompt hint generation.

- Modify `src/types.ts`
  - Add minimal metadata for local exact-size transforms.
  - Keep existing `TaskParams.size`, `TaskParams.exact_size`, and `exactSizeOriginalImages`.

- Modify `src/store.ts`
  - Append the target aspect hint before API submission.
  - Use aspect-safe exact-size post-processing.
  - Store transform metadata on the task.

- Modify `src/components/DetailModal.tsx`
  - Show whether local exact-size processing used `cover` or `contain`.
  - Show source dimensions and final dimensions when available.

- Modify `src/store.test.ts`
  - Update mocks and assertions for the new resize result metadata.

---

### Task 1: Add Aspect-Safe Geometry Planning

**Files:**
- Modify: `src/lib/exactImageSize.ts`
- Create: `src/lib/exactImageSize.test.ts`

- [ ] **Step 1: Write failing unit tests for generic draw plans**

Create `src/lib/exactImageSize.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { computeExactSizeDrawPlan } from './exactImageSize'

describe('computeExactSizeDrawPlan', () => {
  it('uses full-canvas resize when source and target ratios already match', () => {
    expect(computeExactSizeDrawPlan(
      { width: 941, height: 1672 },
      { width: 2160, height: 3840 },
      'cover',
    )).toMatchObject({
      mode: 'cover',
      targetWidth: 2160,
      targetHeight: 3840,
      drawX: 0,
      drawY: 0,
      drawWidth: 2160,
      drawHeight: 3840,
      aspectMismatch: false,
    })
  })

  it('cover-crops horizontally when a 2:3 source is converted to 9:16', () => {
    expect(computeExactSizeDrawPlan(
      { width: 1024, height: 1536 },
      { width: 2160, height: 3840 },
      'cover',
    )).toMatchObject({
      mode: 'cover',
      scale: 2.5,
      drawX: -200,
      drawY: 0,
      drawWidth: 2560,
      drawHeight: 3840,
      aspectMismatch: true,
    })
  })

  it('contain-pads vertically when a 2:3 source is converted to 9:16', () => {
    expect(computeExactSizeDrawPlan(
      { width: 1024, height: 1536 },
      { width: 2160, height: 3840 },
      'contain',
    )).toMatchObject({
      mode: 'contain',
      scale: 2.109375,
      drawX: 0,
      drawY: 300,
      drawWidth: 2160,
      drawHeight: 3240,
      aspectMismatch: true,
    })
  })

  it('cover-crops vertically for a wide source into a square target', () => {
    expect(computeExactSizeDrawPlan(
      { width: 1600, height: 900 },
      { width: 1024, height: 1024 },
      'cover',
    )).toMatchObject({
      mode: 'cover',
      scale: 1.137778,
      drawX: -397,
      drawY: 0,
      drawWidth: 1818,
      drawHeight: 1024,
      aspectMismatch: true,
    })
  })
})
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm test -- src/lib/exactImageSize.test.ts
```

Expected: fail because `computeExactSizeDrawPlan` is not exported.

- [ ] **Step 3: Implement the pure geometry helper**

Modify `src/lib/exactImageSize.ts`:

```ts
export type ExactSizeFitMode = 'cover' | 'contain'

export interface ExactSizeDrawPlan {
  mode: ExactSizeFitMode
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
  scale: number
  drawX: number
  drawY: number
  drawWidth: number
  drawHeight: number
  aspectMismatch: boolean
}

const ASPECT_EPSILON = 0.01

function round6(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000
}

function roundPixel(value: number) {
  return Math.round(value)
}

export function computeExactSizeDrawPlan(
  source: ImageSize,
  target: ImageSize,
  mode: ExactSizeFitMode = 'cover',
): ExactSizeDrawPlan {
  const widthScale = target.width / source.width
  const heightScale = target.height / source.height
  const scale = mode === 'contain'
    ? Math.min(widthScale, heightScale)
    : Math.max(widthScale, heightScale)
  const drawWidth = roundPixel(source.width * scale)
  const drawHeight = roundPixel(source.height * scale)
  const drawX = roundPixel((target.width - drawWidth) / 2)
  const drawY = roundPixel((target.height - drawHeight) / 2)
  const sourceAspect = source.width / source.height
  const targetAspect = target.width / target.height

  return {
    mode,
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetWidth: target.width,
    targetHeight: target.height,
    scale: round6(scale),
    drawX,
    drawY,
    drawWidth,
    drawHeight,
    aspectMismatch: Math.abs(sourceAspect - targetAspect) > ASPECT_EPSILON,
  }
}
```

- [ ] **Step 4: Run the geometry tests**

Run:

```bash
npm test -- src/lib/exactImageSize.test.ts
```

Expected: pass.

---

### Task 2: Replace Non-Uniform Stretching With Aspect-Safe Rendering

**Files:**
- Modify: `src/lib/exactImageSize.ts`
- Modify: `src/store.test.ts`

- [ ] **Step 1: Extend the resize result type**

Modify `ExactImageResizeResult` in `src/lib/exactImageSize.ts`:

```ts
export interface ExactImageResizeResult {
  dataUrl: string
  width: number
  height: number
  resized: boolean
  sourceWidth: number
  sourceHeight: number
  drawPlan?: ExactSizeDrawPlan
}
```

- [ ] **Step 2: Make canvas rendering use the draw plan**

Modify `resizeImageDataUrlToExactSize`:

```ts
export async function resizeImageDataUrlToExactSize(
  dataUrl: string,
  target: ImageSize,
  outputFormat: TaskParams['output_format'],
  fitMode: ExactSizeFitMode = 'cover',
): Promise<ExactImageResizeResult> {
  const image = await loadImage(dataUrl)
  const sourceWidth = image.naturalWidth
  const sourceHeight = image.naturalHeight

  if (sourceWidth === target.width && sourceHeight === target.height) {
    return {
      dataUrl,
      width: sourceWidth,
      height: sourceHeight,
      resized: false,
      sourceWidth,
      sourceHeight,
    }
  }

  const drawPlan = computeExactSizeDrawPlan(
    { width: sourceWidth, height: sourceHeight },
    target,
    fitMode,
  )
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持 Canvas')

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, target.width, target.height)
  ctx.drawImage(
    image,
    drawPlan.drawX,
    drawPlan.drawY,
    drawPlan.drawWidth,
    drawPlan.drawHeight,
  )

  const mime = OUTPUT_MIME_BY_FORMAT[outputFormat] ?? 'image/png'
  const quality = outputFormat === 'png' ? undefined : 0.95
  const blob = await canvasToBlob(canvas, mime, quality)
  return {
    dataUrl: await blobToDataUrl(blob, mime),
    width: target.width,
    height: target.height,
    resized: true,
    sourceWidth,
    sourceHeight,
    drawPlan,
  }
}
```

- [ ] **Step 3: Update the existing store mock signature**

Modify the mock in `src/store.test.ts` so it accepts the fourth argument and returns a draw plan:

```ts
resizeImageDataUrlToExactSize: vi.fn(async (
  dataUrl: string,
  target: { width: number; height: number },
  _outputFormat: string,
  fitMode = 'cover',
) => {
  const sourceMatch = dataUrl.match(/(\d+)x(\d+)/)
  const sourceWidth = sourceMatch ? Number(sourceMatch[1]) : 1024
  const sourceHeight = sourceMatch ? Number(sourceMatch[2]) : 1024
  if (sourceWidth === target.width && sourceHeight === target.height) {
    return { dataUrl, width: sourceWidth, height: sourceHeight, sourceWidth, sourceHeight, resized: false }
  }
  return {
    dataUrl: `data:image/png;base64,resized-${target.width}x${target.height}`,
    width: target.width,
    height: target.height,
    sourceWidth,
    sourceHeight,
    resized: true,
    drawPlan: {
      mode: fitMode,
      sourceWidth,
      sourceHeight,
      targetWidth: target.width,
      targetHeight: target.height,
      scale: 1,
      drawX: 0,
      drawY: 0,
      drawWidth: target.width,
      drawHeight: target.height,
      aspectMismatch: sourceWidth / sourceHeight !== target.width / target.height,
    },
  }
})
```

- [ ] **Step 4: Run affected tests**

Run:

```bash
npm test -- src/store.test.ts src/lib/exactImageSize.test.ts
```

Expected: pass after signature updates.

---

### Task 3: Store Local Transform Metadata

**Files:**
- Modify: `src/types.ts`
- Modify: `src/store.ts`
- Modify: `src/store.test.ts`

- [ ] **Step 1: Add task metadata types**

Modify `src/types.ts`:

```ts
export type ExactSizeFitMode = 'cover' | 'contain'

export interface ExactSizeTransformRecord {
  mode: ExactSizeFitMode
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
  scale: number
  drawX: number
  drawY: number
  drawWidth: number
  drawHeight: number
  aspectMismatch: boolean
}
```

Add to `TaskRecord`:

```ts
/** 精确尺寸本地后处理几何信息，key 为 outputImages 中的图片 id */
exactSizeTransforms?: Record<string, ExactSizeTransformRecord>
```

- [ ] **Step 2: Return transform metadata from image storage**

Modify `storeGeneratedOutputImage` in `src/store.ts`:

```ts
let exactSizeTransform: ExactSizeTransformRecord | undefined
```

After resize:

```ts
if (resized.drawPlan) {
  exactSizeTransform = {
    mode: resized.drawPlan.mode,
    sourceWidth: resized.drawPlan.sourceWidth,
    sourceHeight: resized.drawPlan.sourceHeight,
    targetWidth: resized.drawPlan.targetWidth,
    targetHeight: resized.drawPlan.targetHeight,
    scale: resized.drawPlan.scale,
    drawX: resized.drawPlan.drawX,
    drawY: resized.drawPlan.drawY,
    drawWidth: resized.drawPlan.drawWidth,
    drawHeight: resized.drawPlan.drawHeight,
    aspectMismatch: resized.drawPlan.aspectMismatch,
  }
}
```

Return it:

```ts
return {
  id: stored.id,
  dataUrl: outputDataUrl,
  size: stored,
  exactSizeOriginalImageId,
  exactSizeTransform,
}
```

- [ ] **Step 3: Build a transform map in task output storage**

In `storeTaskOutputImages`, add:

```ts
const exactSizeTransforms: Record<string, ExactSizeTransformRecord> = {}
```

After `stored` is returned:

```ts
if (stored.exactSizeTransform) {
  exactSizeTransforms[stored.id] = stored.exactSizeTransform
}
```

Return it:

```ts
return {
  outputIds,
  outputDataUrls,
  outputImageSizes,
  transparentOriginalImageIds,
  exactSizeOriginalImageIds,
  exactSizeTransforms: Object.keys(exactSizeTransforms).length ? exactSizeTransforms : undefined,
}
```

- [ ] **Step 4: Persist transform metadata when tasks complete**

Every place that destructures `storeTaskOutputImages(...)` must include `exactSizeTransforms`, and every `updateTaskInStore` completion payload must include:

```ts
exactSizeTransforms,
```

Search:

```bash
rg -n "storeTaskOutputImages\\(" src/store.ts
```

Expected call sites to update include normal task completion, fal recovery, custom recovery, and any agent image completion path that uses this helper.

- [ ] **Step 5: Assert metadata in store tests**

Extend the existing exact-size test in `src/store.test.ts`:

```ts
expect(task.exactSizeTransforms?.[task.outputImages[0]]).toMatchObject({
  mode: 'cover',
  sourceWidth: 1254,
  sourceHeight: 1254,
  targetWidth: 2160,
  targetHeight: 3840,
  aspectMismatch: true,
})
```

- [ ] **Step 6: Run store tests**

Run:

```bash
npm test -- src/store.test.ts
```

Expected: pass.

---

### Task 4: Add Generic Target-Aspect Prompt Hints

**Files:**
- Create: `src/lib/targetAspectPrompt.ts`
- Create: `src/lib/targetAspectPrompt.test.ts`
- Modify: `src/store.ts`
- Modify: `src/components/DetailModal.tsx`

- [ ] **Step 1: Write failing tests for arbitrary ratios**

Create `src/lib/targetAspectPrompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTargetAspectPromptHint } from './targetAspectPrompt'

describe('createTargetAspectPromptHint', () => {
  it('returns null for auto size', () => {
    expect(createTargetAspectPromptHint('auto')).toBeNull()
  })

  it('creates a vertical hint for 2160x3840', () => {
    expect(createTargetAspectPromptHint('2160x3840')).toBe(
      'Target frame: vertical 9:16 composition. Compose the scene to naturally fill this aspect ratio.',
    )
  })

  it('creates a horizontal hint for 3840x2160', () => {
    expect(createTargetAspectPromptHint('3840x2160')).toBe(
      'Target frame: horizontal 16:9 composition. Compose the scene to naturally fill this aspect ratio.',
    )
  })

  it('creates a square hint for 2880x2880', () => {
    expect(createTargetAspectPromptHint('2880x2880')).toBe(
      'Target frame: square 1:1 composition. Compose the scene to naturally fill this aspect ratio.',
    )
  })

  it('reduces arbitrary dimensions instead of using presets only', () => {
    expect(createTargetAspectPromptHint('3456x2304')).toContain('horizontal 3:2 composition')
  })
})
```

- [ ] **Step 2: Implement the helper**

Create `src/lib/targetAspectPrompt.ts`:

```ts
import { parseImageSize } from './size'

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x || 1
}

export function createTargetAspectPromptHint(size: string): string | null {
  const parsed = parseImageSize(size)
  if (!parsed) return null

  const divisor = gcd(parsed.width, parsed.height)
  const ratioWidth = parsed.width / divisor
  const ratioHeight = parsed.height / divisor
  const orientation = ratioWidth === ratioHeight
    ? 'square'
    : ratioWidth > ratioHeight ? 'horizontal' : 'vertical'

  return `Target frame: ${orientation} ${ratioWidth}:${ratioHeight} composition. Compose the scene to naturally fill this aspect ratio.`
}

export function appendTargetAspectPromptHint(prompt: string, size: string): string {
  const hint = createTargetAspectPromptHint(size)
  if (!hint) return prompt
  if (prompt.includes(hint)) return prompt
  return `${prompt.trim()}\n\n${hint}`
}
```

- [ ] **Step 3: Append the hint before API calls**

In `src/store.ts`, import:

```ts
import { appendTargetAspectPromptHint, createTargetAspectPromptHint } from './lib/targetAspectPrompt'
```

In `executeTask`, replace the prompt passed to `callImageApi`:

```ts
const promptForApi = appendTargetAspectPromptHint(
  replaceImageMentionsForApi(requestPrompt, inputDataUrls.length),
  task.params.size,
)
```

Use it:

```ts
prompt: promptForApi,
```

- [ ] **Step 4: Store prompt hint transparency on the task**

Add to `TaskRecord` in `src/types.ts`:

```ts
/** 本地追加给 API 的目标画幅提示 */
targetAspectPromptHint?: string
```

When creating a task in `submitTask` and `retryTask`, set:

```ts
targetAspectPromptHint: createTargetAspectPromptHint(taskParams.size) ?? undefined,
```

- [ ] **Step 5: Show the hint in the detail modal only when present**

In `src/components/DetailModal.tsx`, add a compact parameter row near size/exact size:

```tsx
{task.targetAspectPromptHint && (
  <ParamItem label="目标画幅提示" value={task.targetAspectPromptHint} />
)}
```

Use the existing local parameter display component/pattern in the file; do not introduce a new card.

- [ ] **Step 6: Run prompt tests and store tests**

Run:

```bash
npm test -- src/lib/targetAspectPrompt.test.ts src/store.test.ts
```

Expected: pass.

---

### Task 5: Display Source/Final Geometry and Mismatch Status

**Files:**
- Modify: `src/components/DetailModal.tsx`
- Modify: `src/lib/paramDisplay.tsx` only if existing helpers are insufficient.

- [ ] **Step 1: Identify the active output transform**

In `DetailModal`, compute:

```ts
const currentExactSizeTransform = currentOutputImageId
  ? task.exactSizeTransforms?.[currentOutputImageId]
  : undefined
```

- [ ] **Step 2: Add concise geometry rows**

Add rows in the existing parameter section:

```tsx
{currentExactSizeTransform && (
  <>
    <ParamItem
      label="源图尺寸"
      value={`${currentExactSizeTransform.sourceWidth}x${currentExactSizeTransform.sourceHeight}`}
    />
    <ParamItem
      label="后处理"
      value={currentExactSizeTransform.aspectMismatch
        ? `等比${currentExactSizeTransform.mode === 'cover' ? '裁切' : '留边'}`
        : '等比缩放'}
    />
  </>
)}
```

- [ ] **Step 3: Keep the warning factual**

If `aspectMismatch` is true, show a small neutral text line in the metadata area:

```tsx
{currentExactSizeTransform?.aspectMismatch && (
  <div className="text-xs text-amber-600">
    API 返回比例与目标比例不同，已保持几何比例后处理。
  </div>
)}
```

Do not use a modal or blocking warning; the output is valid and intentionally processed.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: TypeScript and Vite build pass.

---

### Task 6: Full Regression Verification

**Files:**
- No source edits unless tests fail.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- src/lib/exactImageSize.test.ts src/lib/targetAspectPrompt.test.ts src/store.test.ts
```

Expected: pass.

- [ ] **Step 2: Run full tests**

Run:

```bash
npm test
```

Expected: pass.

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: zero errors. Existing warnings may remain only if they are unrelated to this change.

- [ ] **Step 4: Run production build**

Run:

```bash
npm run build
```

Expected: pass.

- [ ] **Step 5: Browser verification**

Start local app:

```bash
npm run start:local
```

Manual/browser checks:

1. Generate or mock an exact-size task where the API source is `1024x1536` and target is `2160x3840`.
2. Confirm final image header is `2160x3840`.
3. Confirm source image remains `1024x1536`.
4. Confirm the final image is cropped or padded, not stretched.
5. Confirm detail modal shows source size and post-processing mode.
6. Repeat with a landscape target, for example `3840x2160`, to prove the logic is not portrait-specific.

If API credentials are available, also run the existing deployed smoke checks from `AGENTS.md` after local tests pass.

---

## Acceptance Criteria

- A source `1024x1536` converted to target `2160x3840` no longer stretches vertically.
- Any source/target ratio mismatch uses one uniform scale factor.
- `exact_size=true` still guarantees final stored output dimensions equal the requested target dimensions.
- The original provider-returned source remains downloadable.
- The app records and displays enough metadata to distinguish:
  - requested size
  - API actual size
  - source image size
  - final image size
  - local exact-size fit mode
- The prompt sent to the provider includes a generic target-frame hint derived from concrete size, not from a hard-coded ratio.
- Tests cover portrait, landscape, square, same-ratio, and mismatch cases.

## Self-Review

- Spec coverage: The plan addresses the observed deformation, source preservation, provider size drift, prompt aspect guidance, and generic ratio handling.
- Placeholder scan: No `TBD`, `TODO`, or missing test commands are present.
- Type consistency: `ExactSizeFitMode`, `ExactSizeDrawPlan`, and `ExactSizeTransformRecord` use consistent field names across exact-size code, store code, and UI.
