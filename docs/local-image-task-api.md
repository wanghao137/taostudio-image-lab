# Local Image Task API

The local service is the reference implementation of Image Job Contract v1.
It is intentionally bound to `127.0.0.1` and is not deployed to production.

## Invariants

1. Composition ratio is selected once. `output.ratioMode` must be `inherit`.
2. Provider output is stored unchanged as an immutable source PNG.
3. Final pixels are produced in a separate post-processing stage. Ratio
   conflicts are rejected; stretching is not allowed.
4. Source, final, manifests, jobs, and transition events are linked by IDs.
5. Text, logo, and UI content always use deterministic Lanczos3.
6. Agent retries reuse one idempotency key and therefore one billable job.

The shared implementation and schemas are under
`packages/image-job-core/`. Browser code, Node probes, the task worker, and the
independent Skill use this source of truth.

## Start

Add local-only values to `.env.local`:

```dotenv
IMAGE_TASK_API_TOKEN=generate-a-local-random-token
IMAGE_TASK_API_PORT=9789
IMAGE_TASK_PROVIDER_BASE_URL=https://provider.example/v1
IMAGE_TASK_PROVIDER_API_KEY=provider-secret
IMAGE_TASK_PROVIDER_MODEL=gpt-image-2

VITE_IMAGE_TASK_API_URL=http://127.0.0.1:9789
VITE_IMAGE_TASK_API_TOKEN=generate-a-local-random-token
```

Then run the service and web app in separate terminals:

```powershell
npm run task-api
npm run dev
```

The server also accepts existing `IMAGE_API_BASE_URL` and `IMAGE_API_KEY`
values as local compatibility fallbacks. Secrets are never stored in SQLite,
manifests, task responses, or logs.

## Endpoints

- `POST /v1/assets/uploads`: raw `image/png`; returns a content-addressed source
  asset ID. Identical bytes return the same ID.
- `POST /v1/image-jobs`: creates or replays one idempotent job.
- `GET /v1/image-jobs/{id}`: returns state, asset IDs, error, and events.
- `POST /v1/image-jobs/{id}/cancel`: cancels queued work or aborts the active
  provider request.
- `GET /v1/assets/{id}`: streams PNG bytes.
- `GET /v1/assets/{id}?manifest=1`: returns Image Asset Manifest v1.

All endpoints require `Authorization: Bearer <token>`. Large image Base64 is
never retained in job records or returned by job status calls.

## Agents

The web Agent uses this API when both `VITE_IMAGE_TASK_API_URL` and
`VITE_IMAGE_TASK_API_TOKEN` are configured. Otherwise its existing production
path is unchanged.

External agents can use `server/task-api/mcp-server.mjs`. ZCode supports this
as a workspace stdio MCP server; a local `.zcode/config.json` is ignored by Git
so it can contain the loopback URL and local service token. The same contract
is documented in `server/task-api/openapi.yaml`.

## Verification

```powershell
npm test
npm run lint
npm run build
npm run benchmark:4k
npm run smoke:task-api:real
$env:IMAGE_TASK_API_TOKEN='local-token'; npm run test:external-agent
npm run verify:ui -- http://127.0.0.1:9531/
node scripts/sync-independent-skill-core.mjs "<skill-dir>" --check
```

## Production Resources

No cloud task service is deployed by this change. A production rollout still
needs an API ingress, durable metadata database, object storage, queue,
long-lived Node workers, and a deliberate GPU/runtime decision for optional AI
enhancement. Vercel's request duration limit is not suitable as the only 4K
worker. The production design should use R2/S3 for assets, D1/PostgreSQL for
metadata, a durable queue, and workers that can survive frontend deployments.
