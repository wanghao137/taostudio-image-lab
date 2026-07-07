# Local Auto Save Design

## Context

TaoStudio Image Lab currently keeps generated images in browser IndexedDB. Task
records and image bytes are stored separately, and the gallery depends on local
browser storage remaining available. This is convenient for a browser-first
workspace, but it is not a reliable archive for high-value 4K outputs.

This feature adds a second, user-controlled local archive for successful 4K
gallery generations. It does not replace IndexedDB or change how the gallery
renders. It automatically saves finished assets to a local folder selected by
the user.

## First Principles Rationale

The primary user problem is not that export takes too many clicks. The primary
problem is that valuable generated assets can disappear when browser-managed
local storage is cleared, quota pressure occurs, IndexedDB writes are
incomplete, or the user returns after the page has restarted. A correct solution
must create an independent durable copy outside browser-managed app storage.

From that problem, the required properties are:

- The archive must be written as soon as a valuable result is created, not at
  the end of the day or only when the user remembers to export.
- The archive must live in a user-selected normal filesystem folder, because
  that is inspectable, portable, backed up by existing OS tools, and independent
  of IndexedDB.
- The archive unit must be a generation group, not a global database dump,
  because the user needs to browse, share, and reuse each prompt/result set as a
  coherent asset.
- The archive must include the prompt and generation metadata, because the image
  alone is not enough to reproduce or audit the result.
- Local archive failure must never invalidate image generation success, because
  generation and archiving are separate responsibilities.
- Failures must be visible and retryable, because silent backup failure creates
  false confidence.

The platform constraint follows directly from the current product shape: this is
a browser app, not an Electron or native Windows app. A browser cannot write
arbitrary local files by path. The appropriate first-version mechanism is the
File System Access API, which makes the honest product scope desktop
Chrome/Edge. Mobile support and unsupported browsers must be treated as explicit
non-goals or fallbacks, not as promised behavior.

The first-version scope is intentionally narrow. Gallery 4K outputs are the
highest-value and highest-risk assets: they are large, expensive to regenerate,
and most exposed to browser storage pressure. Agent outputs, non-4K images,
cloud sync, and mobile behavior are separate product problems with different
state models and should not be coupled to the first reliability fix.

## Goals

- Automatically save successful 4K outputs from gallery mode to a user-selected
  local folder.
- Save each generation group into its own folder.
- Save both the image files and prompt/metadata needed to understand or reuse
  the result.
- Make save failures visible and recoverable.
- Keep generation success independent from local save success.

## Non-Goals

- No mobile support in the first version.
- No Safari, Firefox, or cross-browser polyfill support in the first version.
- No Agent mode auto-save in the first version.
- No cloud storage, R2, S3, sync, or account-level persistence.
- No background Service Worker export pipeline.
- No automatic export of failed, partial, or non-4K tasks.

## Platform Scope

The first version targets desktop Chrome and Edge only. The feature relies on
the File System Access API, specifically directory handles selected through
`showDirectoryPicker()`.

When the browser does not support this API, the UI must show the feature as
unavailable and explain that local auto-save requires desktop Chrome or Edge.
On mobile browsers, the UI must not promise automatic local folder saving.

## Product Behavior

The settings page gets a new Data tab section named `本地自动保存`.

Controls:

- `本地自动保存`: enable or disable the feature.
- `选择文件夹`: prompts the user to choose the archive root folder.
- Save location status: `未选择`, `已授权`, or `需要重新授权`.
- Save scope text: `仅自动保存画廊模式下成功生成的 4K 图片`.
- Pending retry summary: `待保存 N 组`.
- Retry action: `立即补保存`.
- Recent save summary: latest successfully saved folder name and time.

Task cards should stay visually quiet. The first version should not add a
success badge to every saved card. A failed or permission-blocked save may show a
small warning in task detail or a lightweight card indicator if that is already
consistent with local UI patterns.

## Eligibility

A task is eligible for local auto-save only when all conditions are true:

- The feature is enabled.
- A save directory has been selected.
- The browser supports File System Access directory handles.
- The task is a gallery task, not an Agent task.
- The task status is `done`.
- The task has at least one output image.
- The generation path is marked as a 4K strategy.
- The actual stored output dimensions confirm the expected 4K result.

The 4K check uses both intent and result:

- Intent: task parameters or derived task metadata indicate the 4K output path.
- Result: stored image dimensions confirm the output, for example `2160x3840` or
  `3840x2160`.

If the task is not eligible, it is not an error. It should be classified as not
applicable for auto-save.

## Folder Structure

Each eligible task is saved into one folder under the chosen archive root.

Folder name format:

```text
YYYY-MM-DD_HH-mm-ss_WIDTHxHEIGHT_PROMPT_PREFIX
```

Example:

```text
2026-07-07_21-35-12_2160x3840_城市夜晚人像
```

Folder names must be safe for Windows:

- Replace `< > : " / \ | ? *` with a safe separator.
- Collapse whitespace.
- Remove line breaks.
- Trim leading and trailing punctuation or spaces.
- Limit the prompt prefix to a short readable length, around 20 Chinese
  characters or a comparable number of visible characters.
- If the target folder already exists, append `-2`, `-3`, and so on.

## Saved Files

Each group folder contains:

```text
image-1.png
image-2.png
prompt.txt
metadata.json
```

The image extension should be derived from the actual image MIME type when
available. PNG is expected to be the common first-version case.

`prompt.txt` is human-readable Chinese text:

```text
提示词：
...

尺寸：2160x3840
模型：...
质量：high
格式：PNG
生成时间：2026-07-07 21:35:12
任务ID：...
```

`metadata.json` is machine-readable:

```json
{
  "version": 1,
  "taskId": "...",
  "createdAt": "...",
  "finishedAt": "...",
  "prompt": "...",
  "params": {
    "size": "2160x3840",
    "quality": "high",
    "output_format": "png"
  },
  "actualSize": {
    "width": 2160,
    "height": 3840
  },
  "api": {
    "provider": "openai",
    "profileName": "...",
    "model": "..."
  },
  "images": [
    {
      "file": "image-1.png",
      "width": 2160,
      "height": 3840
    }
  ]
}
```

The metadata must not include API keys, bearer tokens, cookies, or other
credentials.

## Save State Model

Each task can have a local auto-save status:

- `not_applicable`: task is outside first-version scope.
- `pending`: eligible or potentially eligible, but not yet saved.
- `saving`: a save attempt is in progress.
- `saved`: all files were written successfully.
- `failed`: saving failed and can be retried.
- `needs_permission`: the browser requires renewed write permission.

Saved tasks should record:

- status
- folder name
- saved time
- image file names
- last error, when relevant

The status belongs to local archive behavior only. It must not change the task's
generation status.

## Save Flow

1. A gallery task completes successfully.
2. The auto-save service checks whether local auto-save is enabled.
3. It checks whether the task is eligible.
4. It reads the stored output image records from IndexedDB.
5. It verifies actual dimensions against the 4K rule.
6. It checks or requests write permission for the selected directory.
7. It creates the generation folder.
8. It writes each image file.
9. It writes `prompt.txt`.
10. It writes `metadata.json`.
11. It marks the local auto-save status as `saved`.

Generation success must be finalized before or independently from local archive
success. A local save failure must never turn a successful generation into a
failed generation.

## Permission Handling

The selected `FileSystemDirectoryHandle` should be stored in IndexedDB, not in
localStorage. Before writing, the app checks:

```ts
queryPermission({ mode: 'readwrite' })
```

If permission is not granted, the app may request:

```ts
requestPermission({ mode: 'readwrite' })
```

If permission remains unavailable, the task becomes `needs_permission`.

If the directory handle cannot be reused after browser restart, the settings UI
must ask the user to choose the folder again. Pending tasks remain pending or
permission-blocked until the user restores access.

## Failure Handling

Failures are visible and recoverable:

- Unsupported browser: disable the feature and show an explanatory message.
- No folder selected: keep eligible tasks pending.
- Permission lost: mark tasks `needs_permission`.
- Missing image data: mark the task `failed` with `图片数据已不存在`.
- Not actually 4K: mark `not_applicable`.
- Write failure: mark `failed` and store the error message.

The settings page shows the count of tasks needing retry. After permission is
restored, the user can run `立即补保存` to process pending, failed, and
permission-blocked tasks that are still eligible.

Already saved tasks are not saved again by default. A future manual action may
allow `重新保存`, but it is not required for the first version.

## Data Model Additions

Add a local auto-save settings group to app settings:

- enabled
- selected directory handle id or persisted handle reference
- selected directory display name, when available
- last successful save timestamp
- last successful folder name

Add local auto-save status to task records:

- status
- folderName
- savedAt
- files
- error

Because `FileSystemDirectoryHandle` values are structured-cloneable but not
JSON-serializable, the handle itself should be stored in a dedicated IndexedDB
store. JSON app settings should only hold lightweight metadata.

## Architecture

Add a small local archive module rather than embedding file-system writes inside
the task execution path.

Suggested boundaries:

- `localAutoSaveEligibility`: decides whether a task should be saved.
- `localAutoSaveFileNames`: builds safe folder and file names.
- `localAutoSaveWriter`: owns File System Access API calls.
- `localAutoSaveStore`: persists the directory handle and save status metadata.
- store integration: schedules auto-save after a gallery task reaches `done`.

This keeps browser API details out of core generation logic and makes the
feature testable without real file-system writes.

## Security And Privacy

- Do not save credentials.
- Do not include API keys or request headers in metadata.
- Do not write outside the selected user directory.
- Keep folder and file names derived from sanitized prompt text.
- Treat local file write permission as user-controlled and revocable.

## Testing Plan

Automated tests:

- unsupported browser detection
- folder name sanitization
- duplicate folder suffixing
- eligibility rules for gallery vs Agent tasks
- 4K double-check behavior
- metadata generation without credentials
- pending, saved, failed, and needs-permission transitions

Manual/browser checks:

- desktop Chrome or Edge can select a folder and write files
- generated 4K gallery task creates the expected folder
- image files open from disk
- `prompt.txt` and `metadata.json` contents are correct
- disabling auto-save stops future writes
- permission loss produces a recoverable status
- save failure does not affect gallery task success

## First-Version Acceptance Criteria

- A user on desktop Chrome or Edge can enable local auto-save and choose a
  folder.
- A successful gallery 4K task writes image files, `prompt.txt`, and
  `metadata.json` into one task-specific folder.
- Non-4K tasks and Agent tasks are not auto-saved.
- Save failures are visible and retryable.
- The original generation result remains successful even if local saving fails.
- No credentials are written to disk.
