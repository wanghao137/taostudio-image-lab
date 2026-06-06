# GPT Image Playground UI-Only Migration Record

Date: 2026-06-05
Status: recorded, then implementation approved by user

## Immediate UI Cleanup

- Remove the large hero copy block from TaoStudio Image Lab:
  - `INTERNAL STUDIO CONSOLE`
  - `从 Prompt 到 4K 成片，一屏完成。`
  - `连接任意 OpenAI-compatible 图片接口，保留 4K、自定义参数、历史任务和团队素材复用。`
- Keep the TaoStudio brand/header and operational workspace.
- Reason: the block consumes vertical workspace and does not help the internal generation workflow.

## Migration Rule

- Reference repo is read-only: `D:\codesolo\gpt_image_playground`.
- New app target: `D:\codesolo\taostudio-image-lab`.
- Only the UI/branding may change in the target app.
- Functional behavior, data models, API contracts, task semantics, import/export, settings, Agent behavior, mask editing, storage behavior, and provider behavior must be preserved.
- Do not add machine-specific gateway branding or hard-code provider-specific product identity. Use provider-neutral terms such as API Base URL, gateway, provider, and OpenAI-compatible API.

## Implementation Strategy

- Use `D:\codesolo\gpt_image_playground` as the functional baseline.
- Move the reference app's source modules, state, storage, API clients, settings, Agent workspace, mask editor, favorites, downloads, PWA assets, mock API, and deployment configs into the new app.
- Apply TaoStudio Studio Console styling and branding in the new app only.
- Preserve light, dark, and system theme behavior.
- Preserve the new app's ignored local environment files and do not expose credentials.

## Feature Inventory To Preserve

### App Shell And Modes

- Gallery mode.
- Agent mode.
- Global header, mode switch, settings modal, input bar, task grid, task card, detail modal, lightbox, mask editor, image context menu, toasts, confirm dialog, support prompt modal.
- PWA install detection and service worker behavior.
- Mobile header behavior, mobile viewport guards, modal escape handling, background scroll prevention.

### Gallery Generation

- Prompt input.
- Image upload/reference input.
- Drag/drop and clipboard image support.
- Multiple reference images, including reorder, replace, remove, clear, and URL/context-menu add flows.
- Text-to-image generation.
- Image edit when input images exist.
- Mask-based editing.
- Submit task, retry task, reuse task parameters, edit outputs by adding generated outputs back as inputs.
- Clear input after submit, persist input after restart, enter-to-submit, and temporary reuse of a task's original API profile.

### Generation Parameters

- `TaskParams.size`.
- `TaskParams.quality`: `auto`, `low`, `medium`, `high`.
- `TaskParams.output_format`: `png`, `jpeg`, `webp`.
- `TaskParams.output_compression`.
- `TaskParams.moderation`: `auto`, `low`.
- `TaskParams.n`.
- Size presets and custom size normalization.
- Provider compatibility normalization.
- OpenAI and fal.ai output image limits.
- Actual parameter storage and comparison:
  - `actualParams`
  - `actualParamsByImage`
  - `revisedPromptByImage`
  - changed parameter highlighting in detail UI.

### OpenAI-Compatible Providers

- Images API `images/generations`.
- Images API `images/edits`.
- Responses API `responses` with `image_generation` tool and `tool_choice: required`.
- Streaming for Images API and Responses API through SSE.
- Partial image previews:
  - `streamImages`
  - `streamPartialImages` 0-3, default 1.
- `response_format: b64_json`.
- URL and `b64_json` image outputs.
- HTTP image URL to data URL conversion.
- Raw image URL and raw response payload tracking on errors.
- Prompt rewrite guard.
- Codex CLI compatibility mode:
  - omit unsupported parameters.
  - split multi-image generation into concurrent single-image requests.
  - apply prompt rewrite guard to Images API.

### fal.ai Provider

- Built-in `fal` provider.
- Default base URL `https://fal.run`.
- Default model `openai/gpt-image-2`.
- `@fal-ai/client` integration.
- Generation and edit endpoint mapping.
- Size to `image_size` mapping.
- `quality=auto` to `high` mapping.
- Queue lifecycle:
  - `onEnqueue`
  - `falRequestId`
  - `falEndpoint`
  - queued result recovery after connection interruption.
- Custom fal proxy URL support.

### Custom HTTP Providers

- JSON-importable `customProviders`.
- `http-image` template.
- Configurable submit and edit submit paths.
- GET/POST methods.
- JSON and multipart content types.
- Query and body templates using `$profile`, `$prompt`, `$params`, `$inputImages`, `$mask`.
- File mappings for input images and mask.
- `taskIdPath`.
- Result mappings for image URL paths and `b64_json` paths.
- Async polling:
  - status path.
  - success/failure/pending values.
  - interval seconds.
  - error path.
- Legacy migration from `openai-compatible` and `openai-compatible-async`.
- Sync and async custom provider support.
- Recovery for async custom tasks after interruption.
- Existing proxy limitations must remain explicit:
  - proxy does not support GET submit.
  - proxy does not support async custom task providers.

### API Profiles And Settings

- Multiple API profiles.
- Profile fields:
  - id, name, provider, baseUrl, apiKey, model, timeout, apiMode, codexCli, apiProxy, responseFormatB64Json, streamImages, streamPartialImages, providerDrafts.
- Built-in OpenAI and fal.ai providers.
- Custom provider list and provider order.
- Active profile switching.
- Duplicate/copy current profile.
- Import/export settings through JSON and URL.
- Provider/profile drag sorting.
- Profile validation for name, API URL unless proxy, API key, and model.
- Default OpenAI base `https://api.openai.com/v1`.
- Default images model `gpt-image-2`.
- Default responses model.
- Default timeout 600 seconds.
- Settings tabs:
  - general
  - agent
  - api
  - data
  - about
- General settings:
  - clear input after submit.
  - persist input on restart.
  - reuse task API profile temporarily.
  - always show retry button.
  - task completion notification.
  - enter submit.
  - reference image edit action: `ask`, `replace-reference`, `add-mask`.
  - ZIP download route toggles.
- Agent settings:
  - scroll to bottom after submit.
  - max tool rounds, default 15, range 1-50.
  - web search toggle.
- Docker/runtime environment migration notice.

### API Proxy And URL Import

- `dev-proxy.config.example.json`.
- Client-side proxy config read.
- Same-origin `/api-proxy/` support.
- Proxy availability and lock from runtime environment.
- URL params:
  - `apiUrl`
  - `apiKey`
  - `apiMode`
  - `model`
  - `codexCli`
  - `settings`
- Automatic cleanup of URL setting params after import.
- Custom provider config URL import.
- New app local `IMAGE_API_PROXY_TARGET` convenience should remain available without changing the functional proxy contract.

### Local Data Storage

- IndexedDB storage through `src/lib/db.ts`.
- Local task records.
- Images stored locally by SHA-256 ID.
- Thumbnails stored separately.
- Thumbnail versioning.
- Image dedupe by hash.
- In-memory LRU caches:
  - full image cache max 8 entries.
  - thumbnail cache max 80 entries.
- Thumbnail background backfill:
  - visible/background priorities.
  - concurrency based on megapixels.
- Stores for:
  - task records.
  - images.
  - image thumbnails.
  - agent conversations.
- Unreferenced image cleanup after task/image deletion.
- Gallery and Agent input draft persistence.

### Task Records And History

- Full `TaskRecord` shape and semantics:
  - prompt, params, status, error.
  - provider/profile metadata.
  - fal recovery metadata.
  - custom async recovery metadata.
  - input images, mask target, mask image.
  - output images.
  - stream partial image IDs.
  - raw image URLs.
  - raw response payload.
  - created, finished, elapsed.
  - favorite state and collection IDs.
  - source mode gallery/agent.
  - Agent conversation, round, message, tool IDs.
  - actual params and revised prompts.
- Status filter: all/running/done/error.
- Search by prompt, size, model, etc.
- Favorite filter.
- Favorite collections view.
- Task detail modal.
- Full image lightbox.
- Image downloads.
- Batch ZIP download.
- Export/import data backup ZIP with `manifest.json`.
- Clear config and/or tasks.
- Retry failed/running tasks.
- Delete task and multiple tasks.
- Desktop drag selection.
- Ctrl/Meta additive selection.
- Mobile swipe selection/actions.
- Batch favorite and batch delete.
- Right-click and long-press image context menu.

### Favorites And Collections

- Default favorites collection.
- All favorites virtual collection.
- Add/remove favorite tasks.
- Favorite collection picker modal.
- Manage collections modal.
- Rename/delete collections.
- Optional delete tasks when deleting a collection.
- Select favorite collections in collection view.
- Collection overview cover thumbnails.

### Detail Modal

- Task details.
- Output image preview.
- Lightbox open.
- Download all outputs and partial outputs.
- Add output to favorites.
- Add output to input for edit.
- Reuse config.
- Retry.
- Delete.
- Requested versus actual params.
- Revised prompts.
- Raw response and raw image URL information on errors.
- Codex CLI prompt suggestions and dismissals.

### Lightbox

- Fullscreen preview.
- Previous/next navigation.
- Mobile swipe navigation.
- Download and copy image actions.
- Open from gallery, detail, Agent chat, and input thumbnails.

### Mask Editor

- Visual mask editor modal.
- Target image selection.
- Brush drawing.
- Undo/history.
- Clear/fill mask.
- Pan, zoom, and pinch through `viewportTransform.ts`.
- Mask dimension validation.
- Target preprocessing to model-safe working size.
- Dimension multiple 64 behavior.
- Mask coverage classification and validation:
  - empty.
  - full.
  - usable.
- Full-mask confirmation through `submitTask({ allowFullMask })`.
- Reference image edit action setting integration.

### Agent Mode

- Separate Agent workspace.
- Conversation list/sidebar with search.
- Create conversation.
- Rename conversation.
- Delete conversation with keep/delete gallery task confirmation.
- Auto conversation title generation.
- Active conversation and active branch/round.
- Multi-turn user/assistant messages.
- Responses API context memory.
- Branching:
  - edit prior user message and regenerate.
  - regenerate assistant message.
  - sibling rounds.
  - branch switching.
  - active round path filtering.
- Stop generation with `AbortController`.
- Scroll-to-bottom behavior.
- Mobile pull-down/header behavior.
- Agent assets panel:
  - references tab.
  - outputs tab.
  - collapsible panel.
- `@` image mentions:
  - input refs and previous generated images.
  - active branch path resolution.
  - removed refs represented and not reused.
- Agent image generation:
  - built-in `image_generation` tool.
  - custom `generate_image_batch` function.
  - custom `continue_generation` function.
  - progressive batch strategy instructions.
- Optional `web_search`.
- Streaming:
  - text deltas.
  - web search status.
  - image partials.
  - image tool started/completed.
- Agent-generated images synced into gallery tasks.
- Deleting gallery tasks scrubs remaining Agent output payload references.
- Deleting conversations can preserve gallery records.
- Agent output task actions:
  - detail.
  - favorite.
  - reuse/edit.
  - download.
  - delete.
- Copy assistant content.
- Markdown renderer with streaming/legacy fallback and GFM.

### Batch Downloads

- Download single image.
- Download task outputs.
- Download selected tasks.
- Download favorite collections.
- Download Agent round outputs.
- ZIP export through `fflate`.
- Route toggles:
  - `task-selection`
  - `favorite-collection-selection`
  - `image-context-menu-all`
  - `task-detail-all`
  - `task-detail-partial`
  - `agent-round-all`

### Notifications And UX Helpers

- Browser notification readiness and permission.
- Task completion notifications.
- Toasts with shortened error titles.
- Confirm dialog:
  - buttons.
  - checkbox.
  - danger/warning tone.
  - minimum confirm delay.
  - custom action/cancel.
- Viewport-positioned tooltips.
- Tooltip dismiss suppression.
- Global click suppression.
- Escape close handling.
- Mobile viewport guards.
- Dropdown max-height positioning.

### Support Prompt

- Opens after successful non-Agent generated image count crosses the threshold.
- Can be dismissed.
- Skips prompt for imported data with many images.

### Deployment And Runtime

- Vercel deploy config.
- Cloudflare Workers via Wrangler.
- Docker with Nginx proxy:
  - `DEFAULT_API_URL`
  - `API_PROXY_URL`
  - `ENABLE_API_PROXY`
  - `LOCK_API_PROXY`
  - `HOST`
  - `PORT`
- Runtime environment injection scripts:
  - `deploy/inject-api-url.sh`
  - `deploy/migrate-api-env.envsh`
- PWA manifest, icon, and service worker.

### Mock API And Docs

- `npm run mock:api`.
- `scripts/mock-image-api.mjs`.
- `docs/mock-image-api.md`.
- `docs/custom-provider-llm-prompt.md`.

## Acceptance Criteria

- No feature category from this inventory is missing in the new app.
- `D:\codesolo\gpt_image_playground` remains unmodified.
- No machine-specific gateway text or provider-specific product coupling appears in the product UI, docs, or examples.
- TaoStudio logo/brand is used.
- Theme modes support light, dark, and system.
- OpenAI-compatible, fal.ai, custom provider, proxy, URL import, ZIP import/export, Agent mode, mask editing, favorites, history, batch operations, and PWA behavior remain functional.
- Later verification must include lint, tests, build, desktop browser check, mobile browser check, and API smoke testing without printing secrets.
