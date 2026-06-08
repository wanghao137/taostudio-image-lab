# TaoStudio Image Lab Next Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn TaoStudio Image Lab into a stable internal `gpt-image-2` generation system while keeping provider-neutral configuration and upstream upgrade ability.

**Architecture:** Keep the existing gallery, Agent, profile, proxy, and IndexedDB architecture. Improve reliability through small typed helpers, focused tests, browser smoke checks, and production verification instead of adding a second generation stack.

**Tech Stack:** React 19, Zustand, TypeScript, Vite, Vitest, Playwright, Vercel, Cloudflare Worker proxy, IndexedDB, OpenAI-compatible Images/Responses APIs.

---

## Current Baseline

- Production app: `https://image.taostudioai.com/`.
- Current app version: `0.6.0`.
- Common single-image 4K generation has been verified online.
- Direct 4K smoke path succeeds with `2160x3840` output.
- Proxy 4K smoke path succeeds and can recover after a Worker `524`.
- Complex Chinese long prompts and multi-image Agent proposal flows are not part of the current stable baseline. Treat them as a separate track.
- Current persistence is local IndexedDB; cloud storage is not implemented yet.

## Files Map

- `src/lib/openaiCompatibleImageApi.ts`: OpenAI-compatible request construction, retries, fallback, diagnostics, Images API, Responses API, edit, mask, stream handling.
- `src/lib/api.ts`: provider dispatch wrapper used by gallery generation.
- `src/lib/agentApi.ts`: Agent Responses calls, image tool extraction, batch function-call handling.
- `src/store.ts`: task lifecycle, gallery records, Agent rounds, IndexedDB image/task persistence.
- `src/components/SettingsModal.tsx`: provider/profile/proxy settings UI.
- `src/components/InputBar.tsx`: prompt, params, reference image entry points.
- `src/components/TaskGrid.tsx`: generated task cards and failure/success display.
- `src/lib/devProxy.ts`: client proxy prefix and runtime proxy configuration.
- `api/proxy.js`: Vercel fallback proxy.
- `workers/api-proxy.js`: Cloudflare Worker production proxy.
- `scripts/verify-ui.mjs`: browser UI smoke.
- `.omx/deployed-smoke/*.mjs`: ignored local production smoke tools.
- `docs/storage-roadmap.md`: existing storage direction.
- `docs/upstream-upgrade.md`: upstream upgrade contract.

---

### Task 1: Lock the Current Stable 4K Baseline

**Files:**
- Modify: `docs/superpowers/plans/2026-06-08-image-lab-next-roadmap.md`
- Modify: `README.md`
- Test: `src/lib/api.test.ts`
- Test: `src/lib/devProxy.test.ts`

- [ ] **Step 1: Confirm the verification evidence still matches production**

Run:

```powershell
npm test
npm run build
npm run lint
npm run verify:ui -- https://image.taostudioai.com/
node .omx\deployed-smoke\proxy-routing-check.mjs
$env:DEPLOYED_IMAGE_LAB_PROXY='false'; node .omx\deployed-smoke\verify-deployed-4k.mjs
node .omx\deployed-smoke\verify-deployed-4k.mjs
```

Expected:

```text
Vitest: all tests pass.
Build: exits 0.
Lint: exits 0 with zero errors.
UI smoke: UI verification passed.
Routing smoke: first image request is direct-first for common 4K.
4K direct smoke: latest.status is done and image width/height are 2160/3840.
4K proxy smoke: latest.status is done and image width/height are 2160/3840.
```

- [ ] **Step 2: Add a short verified-baseline note to `README.md`**

Add this section near `Verification`:

```markdown
## Current Stable Baseline

- Common single-image 4K generation is verified with `gpt-image-2` at `2160x3840`.
- Direct OpenAI-compatible Images API requests are the preferred path for long-running 4K jobs.
- The deployed proxy can be used for browser/CORS recovery, but Cloudflare/Vercel edge timeouts are still possible on long jobs.
- Complex long Chinese prompts and multi-image Agent workflows are handled as a separate optimization track.
```

- [ ] **Step 3: Run README-related checks**

Run:

```powershell
npm run build
```

Expected:

```text
Build exits 0.
```

- [ ] **Step 4: Commit the baseline note**

Run:

```powershell
git add README.md docs/superpowers/plans/2026-06-08-image-lab-next-roadmap.md
git commit -m "docs: record image lab stability baseline"
```

Expected:

```text
One commit is created with only documentation changes.
```

---

### Task 2: Improve Provider-Neutral Diagnostics

**Files:**
- Modify: `src/lib/openaiCompatibleImageApi.ts`
- Modify: `src/components/TaskGrid.tsx`
- Modify: `src/components/DetailModal.tsx`
- Test: `src/lib/api.test.ts`

- [ ] **Step 1: Add a failing test for user-readable diagnostics**

Add a test case in `src/lib/api.test.ts` that simulates a retryable provider error and asserts the diagnostic object keeps provider-neutral fields:

```ts
it('keeps provider-neutral diagnostics for failed 4K Images API requests', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ error: { message: 'upstream timeout' } }), {
      status: 524,
      headers: { 'Content-Type': 'application/json' },
    }))

  const promise = callImageApi({
    settings: createOpenAISettings(),
    prompt: 'simple 4k prompt',
    params: { ...DEFAULT_PARAMS, size: '2160x3840' },
    inputImageDataUrls: [],
  })

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  await vi.advanceTimersByTimeAsync(1000)
  await vi.advanceTimersByTimeAsync(1000)

  await expect(promise).rejects.toMatchObject({
    apiDiagnostics: expect.objectContaining({
      endpoint: 'images/generations',
      apiMode: 'images',
      model: expect.any(String),
      size: '2160x3840',
      retryable: true,
      status: 524,
    }),
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails for the expected reason**

Run:

```powershell
npx vitest run src/lib/api.test.ts --testNamePattern "provider-neutral diagnostics"
```

Expected:

```text
The new test fails only if diagnostics are missing or malformed.
```

- [ ] **Step 3: Keep diagnostics structured in `openaiCompatibleImageApi.ts`**

Ensure failure objects include:

```ts
{
  endpoint,
  apiMode,
  method,
  bodyKind,
  proxy,
  urlHost,
  model,
  timeout,
  size,
  outputFormat,
  stream,
  inputImageCount,
  hasMask,
  attempts,
  elapsedMs,
  retryable,
  status,
}
```

Do not include the API key, bearer token, or full prompt in the diagnostic payload.

- [ ] **Step 4: Render diagnostics in task error UI**

In `src/components/TaskGrid.tsx` or the existing task detail error surface, show a compact Chinese summary:

```text
请求模式：Images API
尺寸：2160x3840
路径：images/generations
网络：直连或代理
状态：524
是否可重试：是
```

Keep the raw JSON behind an expandable detail block or copy button.

- [ ] **Step 5: Run focused and full checks**

Run:

```powershell
npx vitest run src/lib/api.test.ts
npm test
npm run build
```

Expected:

```text
All tests pass and build exits 0.
```

- [ ] **Step 6: Commit diagnostics improvement**

Run:

```powershell
git add src/lib/openaiCompatibleImageApi.ts src/components/TaskGrid.tsx src/components/DetailModal.tsx src/lib/api.test.ts
git commit -m "fix: improve image request diagnostics"
```

---

### Task 3: Add Preset Profiles for Common 4K Generation

**Files:**
- Modify: `src/components/SettingsModal.tsx`
- Modify: `src/store.ts`
- Modify: `src/types.ts`
- Test: `src/store.test.ts`

- [ ] **Step 1: Add a failing store test for applying a 4K preset**

Add a test in `src/store.test.ts`:

```ts
it('applies the common 4K single-image preset without changing provider credentials', () => {
  useStore.setState({
    params: {
      ...DEFAULT_PARAMS,
      size: '1024x1024',
      quality: 'auto',
      output_format: 'png',
      n: 1,
    },
  })

  useStore.getState().applyGenerationPreset('common-4k-single')

  expect(useStore.getState().params).toMatchObject({
    size: '2160x3840',
    quality: 'auto',
    output_format: 'png',
    n: 1,
  })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npx vitest run src/store.test.ts --testNamePattern "common 4K single-image preset"
```

Expected:

```text
The test fails because applyGenerationPreset does not exist yet.
```

- [ ] **Step 3: Add the preset action to the store**

Add a store action with this behavior:

```ts
applyGenerationPreset: (presetId) => {
  if (presetId !== 'common-4k-single') return
  set((state) => ({
    params: {
      ...state.params,
      size: '2160x3840',
      quality: 'auto',
      output_format: 'png',
      n: 1,
    },
  }))
}
```

Do not change `settings.apiKey`, `settings.baseUrl`, profile credentials, or provider order.

- [ ] **Step 4: Add the preset control to settings or the parameter panel**

Add a Chinese control label:

```text
常用 4K 单图
```

The control should call:

```ts
applyGenerationPreset('common-4k-single')
```

- [ ] **Step 5: Verify**

Run:

```powershell
npx vitest run src/store.test.ts --testNamePattern "common 4K single-image preset"
npm test
npm run build
npm run verify:ui -- http://127.0.0.1:5175/
```

Expected:

```text
Focused test passes.
Full tests pass.
Build exits 0.
UI smoke passes.
```

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/store.ts src/store.test.ts src/components/SettingsModal.tsx src/types.ts
git commit -m "feat: add common 4k generation preset"
```

---

### Task 4: Build the Long Prompt Preflight Track

**Files:**
- Create: `src/lib/promptPreflight.ts`
- Create: `src/lib/promptPreflight.test.ts`
- Modify: `src/components/InputBar.tsx`
- Modify: `src/store.ts`

- [ ] **Step 1: Define preflight output types**

Create `src/lib/promptPreflight.ts` with:

```ts
export type PromptPreflightRisk = 'none' | 'long' | 'very-long' | 'multi-image'

export interface PromptPreflightResult {
  charCount: number
  risk: PromptPreflightRisk
  warnings: string[]
  recommendedAction: 'submit' | 'review' | 'split'
}
```

- [ ] **Step 2: Add tests for long Chinese prompts and multi-image hints**

Create `src/lib/promptPreflight.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { analyzePromptPreflight } from './promptPreflight'

describe('analyzePromptPreflight', () => {
  it('marks short prompts as submit-ready', () => {
    expect(analyzePromptPreflight('生成一张白色陶瓷花瓶产品图')).toMatchObject({
      risk: 'none',
      recommendedAction: 'submit',
    })
  })

  it('marks very long prompts for review', () => {
    const result = analyzePromptPreflight('品牌视觉提案。'.repeat(500))
    expect(result.risk).toBe('very-long')
    expect(result.recommendedAction).toBe('review')
  })

  it('marks independent multi-image prompts for splitting', () => {
    const result = analyzePromptPreflight('请连续生成4张独立图片，不要四宫格，不要拼成一张总图。')
    expect(result.risk).toBe('multi-image')
    expect(result.recommendedAction).toBe('split')
  })
})
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```powershell
npx vitest run src/lib/promptPreflight.test.ts
```

Expected:

```text
The test file fails until analyzePromptPreflight is implemented.
```

- [ ] **Step 4: Implement preflight analysis**

Implement:

```ts
export function analyzePromptPreflight(prompt: string): PromptPreflightResult {
  const charCount = Array.from(prompt).length
  const multiImage = /(?:[2-9]\s*张|[两二三四五六七八九十]+张).*(?:独立|分别|不要四宫格|不要拼|不要合并|总图)/.test(prompt)
  const warnings: string[] = []

  if (multiImage) {
    warnings.push('检测到多图独立生成需求，建议拆成多个任务。')
    return { charCount, risk: 'multi-image', warnings, recommendedAction: 'split' }
  }

  if (charCount >= 3000) {
    warnings.push('提示词较长，建议先检查结构或拆分任务。')
    return { charCount, risk: 'very-long', warnings, recommendedAction: 'review' }
  }

  if (charCount >= 1500) {
    warnings.push('提示词偏长，生成时间和失败率可能升高。')
    return { charCount, risk: 'long', warnings, recommendedAction: 'review' }
  }

  return { charCount, risk: 'none', warnings, recommendedAction: 'submit' }
}
```

- [ ] **Step 5: Surface preflight warnings in the input area**

In `src/components/InputBar.tsx`, show a compact Chinese warning when `recommendedAction !== 'submit'`:

```text
提示词较长，建议先检查结构或拆分任务。
```

Do not block submit in this task; only inform the user.

- [ ] **Step 6: Verify**

Run:

```powershell
npx vitest run src/lib/promptPreflight.test.ts
npm test
npm run build
```

Expected:

```text
All tests pass and build exits 0.
```

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/lib/promptPreflight.ts src/lib/promptPreflight.test.ts src/components/InputBar.tsx src/store.ts
git commit -m "feat: add prompt preflight warnings"
```

---

### Task 5: Separate Multi-Image Agent Workflows from Single-Image Generation

**Files:**
- Modify: `src/lib/agentApi.ts`
- Modify: `src/store.ts`
- Modify: `src/lib/agentApi.test.ts`
- Modify: `src/store.test.ts`
- Modify: `src/components/AgentWorkspace.tsx`

- [ ] **Step 1: Add a failing Agent test for multi-image route classification**

Add a test in `src/lib/agentApi.test.ts`:

```ts
it('classifies explicit independent multi-image requests without changing single-image tools', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))

  await callAgentResponsesApi({
    settings: DEFAULT_SETTINGS,
    profile: createDefaultOpenAIProfile({ apiKey: 'test-key', apiMode: 'responses' }),
    params: DEFAULT_PARAMS,
    input: [{
      role: 'user',
      content: [{ type: 'input_text', text: '请生成4张独立图片，不要四宫格。' }],
    }],
  })

  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
  expect(body.tools.some((tool: { name?: string }) => tool.name === 'generate_image_batch')).toBe(true)
})
```

- [ ] **Step 2: Add a store test for single-image Agent staying simple**

Add a test in `src/store.test.ts`:

```ts
it('does not route normal single-image Agent prompts through batch generation', async () => {
  useStore.setState({
    prompt: '生成一张白色花瓶产品图',
    inputImages: [],
    tasks: [],
  })

  vi.mocked(callAgentResponsesApi).mockResolvedValueOnce({
    text: '',
    images: [{ dataUrl: 'data:image/png;base64,aW1hZ2U=' }],
    outputItems: [],
    responseId: 'response-1',
  })

  await useStore.getState().submitAgentMessage()

  expect(callBatchImageSingle).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: Run focused tests**

Run:

```powershell
npx vitest run src/lib/agentApi.test.ts src/store.test.ts --testNamePattern "multi-image|single-image Agent"
```

Expected:

```text
Tests fail only where classification or store routing is missing.
```

- [ ] **Step 4: Implement routing as a separate Agent track**

Keep normal single-image Agent generation on the existing image tool path. Route only explicit independent multi-image requests to `generate_image_batch`.

Allowed multi-image indicators:

```text
4张独立图片
分别生成
不要四宫格
不要拼成一张总图
independent images
do not make a collage
```

Do not route ordinary "generate one image" prompts into batch mode.

- [ ] **Step 5: Verify**

Run:

```powershell
npx vitest run src/lib/agentApi.test.ts src/store.test.ts
npm test
npm run build
```

Expected:

```text
Agent tests pass.
Store tests pass.
Full tests pass.
Build exits 0.
```

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/lib/agentApi.ts src/store.ts src/lib/agentApi.test.ts src/store.test.ts src/components/AgentWorkspace.tsx
git commit -m "fix: separate agent multi-image routing"
```

---

### Task 6: Implement Durable Cloud Storage Design

**Files:**
- Modify: `docs/storage-roadmap.md`
- Create: `src/lib/storage/cloudStorage.ts`
- Create: `src/lib/storage/cloudStorage.test.ts`
- Modify: `src/store.ts`
- Modify: `src/store.test.ts`

- [ ] **Step 1: Update storage roadmap with the target architecture**

Document this final storage design:

```text
Cloudflare R2 or S3 stores original images and thumbnails.
Database stores task metadata, prompt, params, provider profile id, image object keys, dimensions, and timestamps.
IndexedDB remains a local cache and offline view only.
```

- [ ] **Step 2: Define cloud storage interfaces**

Create `src/lib/storage/cloudStorage.ts`:

```ts
export interface CloudImageRecord {
  id: string
  originalKey: string
  thumbnailKey: string
  width: number
  height: number
  contentType: string
  byteLength: number
}

export interface CloudStorageClient {
  putGeneratedImage(input: {
    taskId: string
    imageId: string
    dataUrl: string
  }): Promise<CloudImageRecord>
}
```

- [ ] **Step 3: Add interface tests**

Create `src/lib/storage/cloudStorage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { CloudImageRecord } from './cloudStorage'

describe('CloudImageRecord', () => {
  it('keeps object keys separate from local data urls', () => {
    const record: CloudImageRecord = {
      id: 'image-1',
      originalKey: 'images/image-1/original.png',
      thumbnailKey: 'images/image-1/thumb.webp',
      width: 2160,
      height: 3840,
      contentType: 'image/png',
      byteLength: 123,
    }

    expect(record.originalKey).not.toContain('data:image')
    expect(record.thumbnailKey).toContain('thumb')
  })
})
```

- [ ] **Step 4: Keep implementation disabled until backend exists**

Add the interface only. Do not upload images in the frontend until a backend signing/upload API exists.

- [ ] **Step 5: Verify**

Run:

```powershell
npx vitest run src/lib/storage/cloudStorage.test.ts
npm test
npm run build
```

Expected:

```text
New tests pass.
Full tests pass.
Build exits 0.
```

- [ ] **Step 6: Commit**

Run:

```powershell
git add docs/storage-roadmap.md src/lib/storage/cloudStorage.ts src/lib/storage/cloudStorage.test.ts
git commit -m "docs: define cloud image storage contract"
```

---

### Task 7: Upstream Upgrade Discipline

**Files:**
- Modify: `docs/upstream-upgrade.md`
- Modify: `scripts/upgrade-upstream.mjs`
- Modify: `docs/upstream-upgrade-report.md`

- [ ] **Step 1: Run a dry-run upstream check**

Run:

```powershell
npm run upgrade:upstream -- --dry-run
```

Expected:

```text
Dry run completes without modifying product files.
Report identifies upstream version and diff scope.
```

- [ ] **Step 2: Confirm protected local product surfaces**

Protected local surfaces:

```text
TaoStudio branding
Chinese UI copy
provider-neutral proxy configuration
settings profiles
Cloudflare Worker proxy
Vercel deployment config
```

- [ ] **Step 3: Add upgrade notes**

In `docs/upstream-upgrade-report.md`, record:

```text
Upstream version checked:
Local app version:
Files requiring manual conflict review:
Verification commands:
Deployment status:
```

- [ ] **Step 4: Verify after upgrade**

Run:

```powershell
npm test
npm run build
npm run verify:ui -- https://image.taostudioai.com/
```

Expected:

```text
Tests pass.
Build exits 0.
UI smoke passes.
```

- [ ] **Step 5: Commit**

Run:

```powershell
git add docs/upstream-upgrade.md scripts/upgrade-upstream.mjs docs/upstream-upgrade-report.md
git commit -m "docs: tighten upstream upgrade workflow"
```

---

## Execution Order

1. Task 1 first, because it locks the known-good 4K single-image baseline.
2. Task 2 next, because better diagnostics make later provider and prompt work easier to debug.
3. Task 3 next, because it improves daily internal use without touching provider logic.
4. Task 4 next, because long prompt risk should be visible before implementing automatic splitting.
5. Task 5 only after Task 4, because multi-image Agent flows need preflight classification.
6. Task 6 after generation reliability is stable, because storage affects persistence and deployment design.
7. Task 7 whenever upstream releases a useful new version.

## Acceptance Criteria

- Common single-image `gpt-image-2` generation works at `2160x3840` in production.
- The app never stores or displays real API keys in diagnostics or docs.
- Provider configuration remains generic and does not hard-code the current test URL.
- Users can see clear Chinese failure diagnostics for provider, proxy, timeout, and retry failures.
- Long Chinese prompts show preflight warnings before submission.
- Multi-image Agent behavior is isolated from normal single-image generation.
- Cloud storage work has a typed contract before backend upload code is introduced.
- Upstream upgrade remains a documented, repeatable workflow.

## Deferred Items

- 50-way provider concurrency testing.
- Full automatic prompt decomposition.
- Automatic four-image brand proposal generation.
- R2/S3 upload backend and database schema.
- Team multi-user permissions.
- Billing, quota, and audit logs.

