# TaoStudio Image Lab Agent Guide

This repository is the TaoStudio internal image-generation workbench. It is
based on `CookSleep/gpt_image_playground`, but this repo is the product app that
is deployed to `https://image.taostudioai.com/`.

## Project Boundaries

- Work in this repo: `D:\codesolo\taostudio-image-lab`.
- Do not edit the upstream reference clone at `D:\codesolo\gpt_image_playground`
  unless the user explicitly asks.
- Preserve upstream upgrade ability. Use `npm run upgrade:upstream` and the
  documents under `docs/upstream-upgrade.md` when syncing from upstream.
- Keep provider behavior neutral. Do not hard-code a specific API host, gateway,
  vendor, or temporary test URL into product logic.
- Keep TaoStudio branding and Chinese UI copy in this app.

## Secrets

- Never commit real API keys, bearer tokens, cookies, Cloudflare tokens, Vercel
  tokens, or gateway credentials.
- Keep local credentials in ignored files such as `.env.local` or provider
  secret stores.
- Do not print secrets in chat, docs, commits, examples, screenshots, or test
  output.
- If a real credential is found in a tracked file or git history, treat it as
  exposed and rotate it before considering the cleanup complete.

## Architecture Notes

- `src/lib/api.ts` dispatches image requests by active provider/profile.
- `src/lib/openaiCompatibleImageApi.ts` owns OpenAI-compatible Images API,
  Responses API, retry, proxy fallback, edit, mask, streaming, and diagnostics.
- `src/lib/agentApi.ts` owns Agent/Responses orchestration and Agent tool calls.
- `src/store.ts` owns task lifecycle, IndexedDB-backed records, gallery state,
  Agent conversations, and generated image persistence in the browser.
- `src/lib/devProxy.ts`, `api/proxy.js`, `workers/api-proxy.js`, and
  `wrangler.proxy.jsonc` own local, Vercel, and Cloudflare Worker proxy behavior.
- Current image storage is browser IndexedDB. The intended future storage design
  is Cloudflare R2 or S3 for originals and thumbnails, database metadata for
  tasks, and IndexedDB only as local cache.

## Development Rules

- Prefer the existing code paths and component patterns before adding new
  abstractions.
- Use structured APIs and typed helpers instead of ad hoc string parsing when
  reasonable.
- For frontend work, verify the real app in a browser at desktop and mobile
  widths.
- Keep UI copy in Chinese unless the product surface intentionally needs English
  labels.
- Do not add unrelated refactors while fixing generation stability.
- Do not commit, push, deploy, or publish unless the user explicitly asks.

## Verification Gates

Run the relevant gates before claiming a change is complete:

```bash
npm test
npm run build
npm run lint
npm run verify:ui -- https://image.taostudioai.com/
```

For provider/proxy work, also run the smoke checks when credentials are
available locally:

```bash
node .omx\deployed-smoke\proxy-routing-check.mjs
$env:DEPLOYED_IMAGE_LAB_PROXY='false'; node .omx\deployed-smoke\verify-deployed-4k.mjs
node .omx\deployed-smoke\verify-deployed-4k.mjs
```

Expected current lint baseline is zero errors. Existing unused-variable warnings
may remain unless the current task explicitly includes cleanup.

## Deployment Notes

- Production app: `https://image.taostudioai.com/`.
- Production frontend host: Vercel project `taostudio-image-lab`.
- Production API proxy host: `https://image-proxy.taostudioai.com/api-proxy`.
- Cloudflare Worker config: `wrangler.proxy.jsonc`.
- Vercel fallback proxy config: `api/proxy.js` and `vercel.json`.
- Vercel Hobby functions have a 300 second max duration; long 4K requests should
  not rely only on the Vercel fallback proxy.

## Current Product Priorities

- P0: Stable common single-image and 4K generation for OpenAI-compatible
  providers.
- P1: Better UI/UX for internal daily use.
- P1: Provider-neutral configuration, diagnostics, and proxy behavior.
- P2: Long Chinese prompt and multi-image Agent workflows as a separate
  specialist track.
- P2: Cloud object storage and task metadata persistence beyond local IndexedDB.

