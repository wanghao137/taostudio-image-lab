# Design QA

Date: 2026-06-05

Result: passed

Scope: migrate the full `gpt_image_playground` feature surface into TaoStudio Image Lab while replacing the visible product shell with a TaoStudio Studio Console UI.

Checks:

- The large hero copy block was removed from the app surface.
- Header branding now uses the TaoStudio logo and `TaoStudio Image Lab`.
- The reference app's source modules, settings, API clients, storage, Agent workspace, mask editor, favorites, downloads, PWA files, mock API, and deployment files were copied into the target app.
- The target app keeps provider-neutral wording and does not expose a machine-specific gateway identity in visible UI.
- `vite.config.ts` keeps the reference `dev-proxy.config.json` behavior and also supports `IMAGE_API_PROXY_TARGET` for local development.
- `mode=test` does not inject the local proxy target, so the original proxy availability tests stay isolated.
- Theme control supports light, dark, and system modes through `taostudio.imageLab.theme`.
- Browser captures were regenerated:
  - `.omx/screenshots/desktop-studio-console.png`
  - `.omx/screenshots/mobile-studio-console.png`
- The Playwright verification script asserts that the removed hero copy and machine-specific gateway markers do not appear in visible page text.
- Temporary Vite service on `http://127.0.0.1:5175/` returned a working UI.
- Proxy smoke request to `/api-proxy/images/generations` returned HTTP 401 without an API key, confirming the request reached an auth-protected upstream instead of a local 404.

Verification:

- `npm run lint`
- `npm run test`
- `npm run build`
- `node .omx/verify-ui.mjs http://127.0.0.1:5175/`
- proxy smoke POST to `http://127.0.0.1:5175/api-proxy/images/generations`

Notes:

- `npm run lint` exits 0 with unused-code warnings inherited from the reference project.
- `npm run build` exits 0 with Vite chunk-size warnings inherited from the full feature bundle.
- Real image generation was not rerun in this pass because no API key was printed or embedded.
- Original reference repo `D:\codesolo\gpt_image_playground` remained unchanged.
