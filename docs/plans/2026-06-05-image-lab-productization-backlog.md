# TaoStudio Image Lab Productization Backlog

Date: 2026-06-05
Status: recorded for tomorrow
Scope: non-UI work intentionally deferred after the first P1 UI/UX pass

## Tomorrow Rule

- Keep `D:\codesolo\gpt_image_playground` read-only.
- Continue work in `D:\codesolo\taostudio-image-lab`.
- Preserve every migrated `gpt_image_playground` feature unless a later product decision explicitly replaces it.
- Do not expose real API keys in docs, chat, tracked files, screenshots, URLs, or exported examples.

## P0

- Initialize a git baseline for `D:\codesolo\taostudio-image-lab` or move the project into the user's preferred repo workflow, then capture the clean starting state before further productization.
- Move team usage toward a server-side API gateway so browser-held API keys are not the default team operating model.
- Remove or gate URL-based real API key import/export flows for team usage; imported settings should avoid leaking credentials through browser history, logs, screenshots, or shared URLs.
- Add authentication and basic access control before any multi-user/team deployment.
- Define provider-neutral gateway naming and configuration; avoid coupling the product identity to any one local gateway or machine-specific service.

## P1

- Add a provider capability matrix in settings so model, size, streaming, edit, partial preview, and parameter availability are visible before submit.
- Add queue, batch, retry, and cost visibility for internal team usage.
- Add team workspace concepts: projects, campaigns, tags, shared collections, and asset ownership.
- Add audit history for submissions, parameter changes, provider/profile usage, and downloads.
- Add output QA metadata: dimensions, file size, format, provider/model, prompt revision, seed or request id when available.
- Review service worker and cache behavior so API responses, key-bearing URLs, and generated private assets are not accidentally cached or served stale.
- Split large UI modules and heavy dependencies with route/component code splitting, especially Agent, settings, Mermaid/Markdown, and image utilities.
- Create a first-party update/version channel instead of inheriting upstream release expectations.

## P2

- Align README, local ports, mock API docs, and deployment docs with TaoStudio Image Lab naming and the current local dev server.
- Add CI for lint, test, build, and the Playwright UI smoke script.
- Add a browser test matrix for desktop and mobile widths, light/dark/system themes, gallery mode, Agent mode, settings, and empty states.
- Create a safe API smoke test path using mock or throwaway credentials without printing secrets.
- Add onboarding docs for internal users: provider profile setup, local gateway setup, backup/export policy, and key rotation policy.
- Review current inherited copy and icons for mixed Chinese/English consistency after the functional migration is stable.

## Deferred From Today's UI Pass

- Security hardening.
- Team account model.
- Backend gateway implementation.
- CI and repository setup.
- API/provider behavior changes.
- Real image-generation smoke testing.
