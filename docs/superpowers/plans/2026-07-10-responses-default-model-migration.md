# Responses API Default Model Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apiMode=images` default to `gpt-image-2`, make `apiMode=responses` default to `gpt-5.6-sol`, and migrate persisted Responses profiles whose exact model is the former default `gpt-5.5` without overwriting other custom model IDs.

**Architecture:** Keep model defaults and migration rules in `src/lib/apiProfiles.ts`, then make Settings and URL-import consumers call those shared rules. Existing settings normalization remains the migration boundary, so no new storage schema or remote model-discovery request is introduced.

**Tech Stack:** TypeScript, React, Zustand persisted settings, Vitest, Vite, ESLint.

## Global Constraints

- Work only in `D:\codesolo\taostudio-image-lab`.
- Keep Images API default exactly `gpt-image-2`.
- Keep Responses API default exactly `gpt-5.6-sol`.
- Treat exact `gpt-5.5` on OpenAI Responses profiles as the legacy managed default and migrate it.
- Preserve every other non-empty custom model ID.
- Do not hard-code an API host, gateway, credential, or provider-specific URL.
- Do not alter historical task `apiModel` metadata.
- Do not change API request shapes, proxy behavior, authentication, streaming, or Agent routing.
- Keep Chinese UI copy.
- Do not commit, push, deploy, or publish without separate user authorization.

---

## File Map

- Modify `src/lib/apiProfiles.ts`: own default-model constants, mode-to-model mapping, managed-default detection, profile creation defaults, and legacy normalization.
- Modify `src/lib/apiProfiles.test.ts`: prove mode defaults, legacy migration, and custom-model preservation.
- Modify `src/lib/urlSettings.ts`: consume the shared mode-to-model mapping for URL-created profiles.
- Modify `src/lib/urlSettings.test.ts`: prove `apiMode=responses` URL defaults and explicit custom model preservation.
- Modify `src/components/SettingsModal.tsx`: consume shared mapping and managed-default detection when switching API modes and showing placeholders/help copy.

### Task 1: Add mode-default and legacy-migration behavior

**Files:**

- Modify: `src/lib/apiProfiles.test.ts`
- Modify: `src/lib/apiProfiles.ts`

**Interfaces:**

- Produces: `getDefaultOpenAIModel(apiMode: ApiMode): string`
- Produces: `isManagedDefaultOpenAIModel(model: string): boolean`
- Produces: `LEGACY_DEFAULT_RESPONSES_MODEL: 'gpt-5.5'`
- Preserves: `createDefaultOpenAIProfile(overrides?: Partial<ApiProfile>): ApiProfile`
- Preserves: `normalizeSettings(input): AppSettings`

- [ ] **Step 1: Add failing behavioral tests using existing public APIs**

Add `DEFAULT_RESPONSES_MODEL` to the existing import list in `src/lib/apiProfiles.test.ts`, then add this block after the `default API URL env` tests:

```ts
describe('OpenAI model defaults by API mode', () => {
  it('uses gpt-image-2 for Images API and gpt-5.6-sol for Responses API', () => {
    expect(createDefaultOpenAIProfile({ apiMode: 'images' }).model).toBe('gpt-image-2')
    expect(createDefaultOpenAIProfile({ apiMode: 'responses' }).model).toBe('gpt-5.6-sol')
    expect(DEFAULT_RESPONSES_MODEL).toBe('gpt-5.6-sol')
  })

  it('migrates the legacy Responses default model while preserving custom models', () => {
    const legacyProfile = {
      ...createDefaultOpenAIProfile({ id: 'legacy-responses', apiMode: 'responses', model: 'custom-placeholder' }),
      model: 'gpt-5.5',
    }
    const customProfile = createDefaultOpenAIProfile({
      id: 'custom-responses',
      apiMode: 'responses',
      model: 'provider/custom-text-model',
    })

    const normalized = normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [legacyProfile, customProfile],
      activeProfileId: legacyProfile.id,
    })

    expect(normalized.profiles.find((profile) => profile.id === legacyProfile.id)?.model).toBe('gpt-5.6-sol')
    expect(normalized.profiles.find((profile) => profile.id === customProfile.id)?.model).toBe('provider/custom-text-model')
  })
})
```

- [ ] **Step 2: Run the targeted tests and verify RED**

Run:

```bash
npm test -- src/lib/apiProfiles.test.ts
```

Expected: FAIL because the current Responses constant is `gpt-5.5`, `createDefaultOpenAIProfile({ apiMode: 'responses' })` currently resolves to `gpt-image-2`, and normalization does not migrate the legacy value.

- [ ] **Step 3: Centralize the model rules in `apiProfiles.ts`**

Replace the current model constants with:

```ts
export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'
export const DEFAULT_RESPONSES_MODEL = 'gpt-5.6-sol'
export const LEGACY_DEFAULT_RESPONSES_MODEL = 'gpt-5.5'
```

Add these helpers directly below the constants:

```ts
export function getDefaultOpenAIModel(apiMode: ApiMode): string {
  return apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL
}

export function isManagedDefaultOpenAIModel(model: string): boolean {
  const normalized = model.trim()
  return normalized === DEFAULT_IMAGES_MODEL ||
    normalized === DEFAULT_RESPONSES_MODEL ||
    normalized === LEGACY_DEFAULT_RESPONSES_MODEL
}

function normalizeOpenAIModelForMode(model: unknown, apiMode: ApiMode): string {
  const rawModel = typeof model === 'string' ? model : ''
  const normalized = rawModel.trim()
  if (!normalized) return getDefaultOpenAIModel(apiMode)
  if (apiMode === 'responses' && normalized === LEGACY_DEFAULT_RESPONSES_MODEL) {
    return DEFAULT_RESPONSES_MODEL
  }
  return rawModel
}
```

- [ ] **Step 4: Apply the shared rule to default profile creation**

In `createDefaultOpenAIProfile`, compute the final model from the final mode:

```ts
export function createDefaultOpenAIProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  const apiMode = overrides.apiMode ?? DEFAULT_API_URL_PATCH?.apiMode ?? 'images'
  const model = normalizeOpenAIModelForMode(
    overrides.model ?? DEFAULT_API_URL_PATCH?.model,
    apiMode,
  )
  const streamImages = overrides.streamImages ?? DEFAULT_API_URL_PATCH?.streamImages ?? getDefaultStreamImages('openai', apiMode)

  return {
    id: DEFAULT_OPENAI_PROFILE_ID,
    name: DEFAULT_API_URL_PATCH?.name ?? '默认',
    provider: 'openai',
    baseUrl: DEFAULT_BASE_URL,
    apiKey: DEFAULT_API_URL_PATCH?.apiKey ?? '',
    timeout: DEFAULT_API_TIMEOUT,
    codexCli: DEFAULT_API_URL_PATCH?.codexCli ?? false,
    apiProxy: DEFAULT_OPENAI_API_PROXY,
    streamPartialImages: DEFAULT_API_URL_PATCH?.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES,
    ...overrides,
    apiMode,
    model,
    streamImages,
  }
}
```

Retain the repository's existing Chinese source text exactly as encoded; only replace the relevant fields and ordering.

- [ ] **Step 5: Apply legacy migration during profile normalization**

In `normalizeApiProfile`, replace the model assignment with provider-aware normalization:

```ts
model: provider === 'openai'
  ? normalizeOpenAIModelForMode(
      typeof record.model === 'string' ? record.model : defaults.model,
      apiMode,
    )
  : typeof record.model === 'string' && record.model.trim() ? record.model : defaults.model,
```

In the legacy settings profile creation, replace the Images-only fallback with:

```ts
model: typeof record.model === 'string' && record.model.trim()
  ? record.model
  : getDefaultOpenAIModel(legacyApiMode),
```

When switching back to the built-in OpenAI provider, calculate `nextApiMode` before the return value and use:

```ts
model: normalizeOpenAIModelForMode(savedDraft?.model, nextApiMode),
```

For `DEFAULT_SETTINGS`, make the initial model match the initial mode:

```ts
model: DEFAULT_API_URL_PATCH?.model ?? getDefaultOpenAIModel(DEFAULT_API_URL_PATCH?.apiMode ?? 'images'),
```

- [ ] **Step 6: Run the targeted tests and verify GREEN**

Run:

```bash
npm test -- src/lib/apiProfiles.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 7: Review the focused diff**

Run:

```bash
git diff -- src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts
```

Expected: only default-model constants, shared helpers, mode-aware defaults, migration logic, and their tests have changed. Do not commit.

### Task 2: Route Settings and URL imports through the shared rules

**Files:**

- Modify: `src/lib/urlSettings.test.ts`
- Modify: `src/lib/urlSettings.ts`
- Modify: `src/components/SettingsModal.tsx`

**Interfaces:**

- Consumes: `getDefaultOpenAIModel(apiMode: ApiMode): string`
- Consumes: `isManagedDefaultOpenAIModel(model: string): boolean`
- Consumes: `DEFAULT_RESPONSES_MODEL`

- [ ] **Step 1: Add URL regression tests before changing consumers**

Add `DEFAULT_RESPONSES_MODEL` to the import list in `src/lib/urlSettings.test.ts`, then add these tests inside `describe('URL settings params', ...)`:

```ts
it('uses the Responses default model when URL params only select Responses API', () => {
  const current = normalizeSettings(DEFAULT_SETTINGS)
  const next = normalizeSettings({
    ...current,
    ...buildSettingsFromUrlParams(current, new URLSearchParams('apiMode=responses')),
  })

  expect(next.profiles.find((profile) => profile.id === next.activeProfileId)).toMatchObject({
    apiMode: 'responses',
    model: DEFAULT_RESPONSES_MODEL,
  })
})

it('preserves an explicit custom Responses model from URL params', () => {
  const current = normalizeSettings(DEFAULT_SETTINGS)
  const next = normalizeSettings({
    ...current,
    ...buildSettingsFromUrlParams(current, new URLSearchParams('apiMode=responses&model=provider/custom-text-model')),
  })

  expect(next.profiles.find((profile) => profile.id === next.activeProfileId)).toMatchObject({
    apiMode: 'responses',
    model: 'provider/custom-text-model',
  })
})
```

- [ ] **Step 2: Run URL tests as characterization coverage**

Run:

```bash
npm test -- src/lib/urlSettings.test.ts
```

Expected after Task 1: PASS. These tests lock the behavior before the consumer refactor.

- [ ] **Step 3: Replace URL-local constant selection with the shared mapping**

In `src/lib/urlSettings.ts`, remove `DEFAULT_IMAGES_MODEL` and `DEFAULT_RESPONSES_MODEL` from the imports, import `getDefaultOpenAIModel`, and replace:

```ts
model: profileApiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL,
```

with:

```ts
model: getDefaultOpenAIModel(profileApiMode),
```

The existing explicit `modelParam` assignment remains unchanged so non-empty custom values continue to win.

- [ ] **Step 4: Replace Settings-local model rules with shared helpers**

In `src/components/SettingsModal.tsx`, import:

```ts
getDefaultOpenAIModel,
isManagedDefaultOpenAIModel,
```

Remove the component-local `getDefaultModelForMode` function. Replace its call sites with `getDefaultOpenAIModel`.

Replace the API mode switch calculation with:

```ts
const nextModel = isManagedDefaultOpenAIModel(activeProfile.model)
  ? getDefaultOpenAIModel(apiMode)
  : activeProfile.model
```

Keep the existing input editable. The Responses help text continues to render `DEFAULT_RESPONSES_MODEL`, which will now display `gpt-5.6-sol`.

- [ ] **Step 5: Run focused tests after the consumer refactor**

Run:

```bash
npm test -- src/lib/apiProfiles.test.ts src/lib/urlSettings.test.ts
```

Expected: PASS with zero failures.

- [ ] **Step 6: Run the repository verification gates**

Run each command separately and inspect its full output:

```bash
npm test
npm run build
npm run lint
```

Expected:

- Vitest exits `0` with zero failed tests.
- TypeScript and Vite build exit `0`.
- ESLint exits `0` with zero errors; existing warnings may remain at the repository baseline.

- [ ] **Step 7: Verify the real settings UI locally**

Start the existing local app without changing package scripts:

```bash
npm run start:local
```

Open `http://127.0.0.1:9527/` and verify:

1. Settings -> API 配置 -> Images API shows or defaults to `gpt-image-2`.
2. Switching to Responses API changes a managed default model to `gpt-5.6-sol`.
3. Switching back changes a managed default model to `gpt-image-2`.
4. A manually entered value such as `provider/custom-text-model` is preserved across mode changes.
5. Responses help copy names `gpt-5.6-sol` and the model input remains editable.

Stop only the local process started for this verification. Do not deploy.

- [ ] **Step 8: Review final scope and status**

Run:

```bash
git status --short
git diff -- src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts src/lib/urlSettings.ts src/lib/urlSettings.test.ts src/components/SettingsModal.tsx docs/superpowers/specs/2026-07-10-responses-default-model-migration-design.md docs/superpowers/plans/2026-07-10-responses-default-model-migration.md
```

Expected: only the approved design/plan documents and the five intended source/test files appear in the task diff. Ignore and preserve unrelated pre-existing untracked artifacts. Do not stage or commit.
