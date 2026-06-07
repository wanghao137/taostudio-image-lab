# Storage Roadmap

## 2026-06-07: Cloud image storage upgrade direction

Current behavior:

- Generated original images are stored in browser IndexedDB.
- Generated thumbnails are stored in browser IndexedDB.
- Task records store image ids and metadata locally.
- IndexedDB is the current durable store for each browser profile and domain.

Future target:

- Store original generated images and thumbnails in cloud object storage.
- Recommended candidates: Cloudflare R2 or S3-compatible storage.
- Store task metadata, image metadata, ownership, and project/group relations in a database.
- Keep IndexedDB as a local cache only, not the source of truth.

Expected benefits:

- Generated images survive browser cache/site-data cleanup.
- Images can be shared across devices and team members.
- The app can support team-level galleries, projects, favorites, and audit history.
- CDN/object-storage URLs can improve preview and download reliability.
- Browser memory and IndexedDB quota pressure can be reduced for large 4K image workflows.

Implementation notes:

- Preserve the current local-first experience during migration.
- Do not hard-code one specific image API provider or base URL.
- Keep provider configuration compatible with the upstream gpt_image_playground model.
- Prefer an abstraction such as `ImageStorageProvider` so local IndexedDB and cloud object storage can coexist.
- Store only safe metadata in the database; never store API keys in task records or exported public data.
- Add backup/export behavior that can include either local images or cloud image references.

Open decisions:

- Object storage provider: Cloudflare R2 vs S3-compatible provider.
- Metadata database: D1, Postgres, Supabase, or another managed database.
- Auth model: personal-only, internal team, or future multi-user workspace.
- Retention policy for originals, thumbnails, temporary stream previews, and failed-task partial images.
- Migration path for existing IndexedDB images.
