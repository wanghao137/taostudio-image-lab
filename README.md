# TaoStudio 生图工作台

TaoStudio 生图工作台是一个内部使用的生图工作台，底层基于开源项目 `CookSleep/gpt_image_playground`。参考仓库不直接修改；本项目保留完整功能，并叠加 TaoStudio 品牌与 Studio Console UI。

## Scope

- Target app: `D:\codesolo\taostudio-image-lab`.
- Reference app: `D:\codesolo\gpt_image_playground`.
- UI and branding are customized for TaoStudio.
- Generation, edit, mask, history, favorites, Agent, provider, proxy, import/export, IndexedDB, PWA, mock API, and deployment behavior are preserved from the reference app.
- Provider wording is neutral. The app supports OpenAI-compatible APIs, fal.ai, and custom HTTP image providers. It does not hard-code a machine-specific gateway identity.

The full migration inventory is recorded in:

```text
docs/plans/2026-06-05-gpt-image-playground-ui-only-migration.md
```

## Start

Windows one-click startup:

```text
start-local.cmd
```

Or run the same local dev server from a terminal:

```bash
npm install
npm run start:local
```

Open:

```text
http://127.0.0.1:5173/
```

## Upstream Upgrade

保留从 `CookSleep/gpt_image_playground` 一键同步底层能力的升级入口：

```bash
npm run upgrade:upstream -- --dry-run
npm run upgrade:upstream -- --install --verify
```

Windows 下也可以直接双击：

```text
upstream-upgrade.cmd
```

详细规则见：

```text
docs/upstream-upgrade.md
```

## Local API Proxy

For local development, create `dev-proxy.config.json` from `dev-proxy.config.example.json`.
`start-local.cmd` creates this file automatically when it is missing and never overwrites an existing local config.
You can also use the target project's convenience environment variable:

```text
IMAGE_API_PROXY_TARGET=https://your-gateway.example.com/v1
```

When this variable is present, Vite exposes the same-origin proxy at:

```text
/api-proxy
```

When `allowBrowserTarget` is `true` in `dev-proxy.config.json`, the local Vite proxy reads the API URL selected in the app settings through `x-taostudio-api-base-url`. This keeps local testing provider-neutral: change the API URL in the frontend settings, keep API proxy enabled, and the local proxy will route to that selected OpenAI-compatible base URL. Set `allowBrowserTarget` to `false` only when you want the local proxy locked to `dev-proxy.config.json.target`.

The API key should be entered in the app settings or kept in ignored local configuration. Do not commit real API keys, bearer tokens, cookies, or gateway credentials.

For deployed same-origin proxy usage, dynamic browser-selected API targets are controlled by deployment environment variables:

- `IMAGE_API_PROXY_ALLOWED_HOSTS`: comma-separated host allow-list. The configured default `IMAGE_API_PROXY_TARGET` host is always allowed.
- `IMAGE_API_PROXY_ALLOW_PUBLIC_TARGETS=true`: allow any public HTTPS OpenAI-compatible API base URL passed by the browser through `x-taostudio-api-base-url`.

Localhost and private network targets such as `http://127.0.0.1:7892` are rejected by the deployed proxy even when public dynamic targets are enabled. Use a real public HTTPS API base URL in production, or run the app locally when the target only exists on your computer.

## Theme

The header theme control supports:

- light
- dark
- system

The preference is stored in browser `localStorage` under `taostudio.imageLab.theme`.

## Verification

Run the available gates before considering a change complete:

```bash
npm run lint
npm run test
npm run build
npm run verify:ui -- http://127.0.0.1:5175/
```

For UI work, also verify the app in a browser at desktop and mobile widths.

## Attribution

This app is modified from `GPT Image Playground` by CookSleep and keeps the required MIT license attribution in the About/settings surface.
