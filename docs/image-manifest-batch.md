# Image Manifest Batch Runner

`scripts/run-image-manifest-batch.mjs` is the versioned runner for durable,
manifest-driven image batches. It owns reusable orchestration only:

- strict manifest preflight and multi-output expansion;
- server-side Batch and Job creation through the Task API MCP server;
- primary generation and fallback routing;
- policy-safe rewrite and QA-guided revision;
- PNG, dimensions, exact-ratio, and SHA-256 verification;
- generation, visual QA, and acceptance state recording;
- resumable local status and canonical output asset handling.

Machine-specific inputs remain outside Git. Do not place manifests, execution
state, generated assets, SQLite files, logs, provider URLs, or credentials in
this directory.

## Required Configuration

The runner reads machine paths from environment variables:

| Variable | Purpose |
| --- | --- |
| `IMAGE_BATCH_OUTPUT_ROOT` | Root directory for generated case folders |
| `IMAGE_BATCH_MANIFEST_PATH` | Input manifest JSON |
| `IMAGE_BATCH_STATUS_PATH` | Mutable execution status JSON |

Optional variables:

| Variable | Default |
| --- | --- |
| `IMAGE_BATCH_REPO_ROOT` | Current working directory |
| `IMAGE_BATCH_WORK_DIR` | `.local-task-api/<batch-key>` |
| `IMAGE_BATCH_KEY` | `image-manifest-batch` |
| `IMAGE_BATCH_NAME` | Batch key |
| `IMAGE_BATCH_CLIENT_NAME` | `<batch-key>-client` |
| `IMAGE_BATCH_CONTACT_SHEET_PREFIX` | `<batch-key>-preview` |
| `IMAGE_BATCH_MIGRATE_INDEXES` | Empty; comma-separated prior accepted indexes |
| `IMAGE_BATCH_PRIMARY_MODEL` | `gpt-image-2` |
| `IMAGE_BATCH_PRIMARY_API_MODE` | `images` |
| `IMAGE_BATCH_REVISION_MODEL` | `gpt-5.6-sol` |
| `IMAGE_BATCH_REVISION_API_MODE` | `responses` |

Task API and provider credentials continue to come from process environment or
the ignored `.env.local`. The runner never writes those values to the manifest,
status, metadata, or logs.

## Local Profiles

Keep each dataset profile under the ignored `.local-task-api/` directory:

```text
.local-task-api/
  dataset-batch.config.json
  run-dataset-batch.mjs
  jobs.sqlite
  *.log
```

The local wrapper should only map profile values into the generic
`IMAGE_BATCH_*` variables and then import:

```js
await import('../scripts/run-image-manifest-batch.mjs')
```

This preserves convenient one-command local operation without committing
machine paths or mutable data.

## Manifest Contract

Only entries meeting all of these conditions are queued:

- `promptStatus` is `exact_prompt_recovered`;
- `duplicateOf` is absent;
- `generation.status` is `ready`;
- prompt and output folder are non-empty;
- `generation.ratio` is explicit and supported;
- `generation.dimensions` exactly match the configured dimensions for that ratio.

The runner does not infer a ratio from words such as "landscape" or "portrait".
An unknown ratio blocks preflight instead of silently defaulting.

Reference-dependent entries may provide `referenceUrl`; the legacy
`tweet.mediaUrls[0]` field remains supported. The downloaded PNG is checked
before upload, and the returned upload manifest must match its format,
dimensions, and SHA-256.

## Running

Start the Task API separately, then run:

```powershell
npm run batch:manifest
```

Useful scoped probes:

```powershell
npm run batch:manifest -- --preflight-only
npm run batch:manifest -- --index=12 --limit=1
npm run batch:manifest -- --limit=5
```

`--preflight-only` validates configuration, manifest eligibility, ratios,
dimensions, and output-root containment without connecting to the Task API or
changing execution state.

`BATCH_PAUSED` is a circuit-breaker result, not an instruction to immediately
restart. Run a one-item health probe and confirm generation, visual QA, and 4K
asset verification before resuming a full run.
