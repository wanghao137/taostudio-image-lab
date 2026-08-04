import { resolve } from 'node:path'

const API_MODES = new Set(['images', 'responses'])

function requiredPath(environment, name) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return resolve(value)
}

function safeSlug(value) {
  const slug = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new Error('IMAGE_BATCH_KEY must contain at least one safe identifier character')
  return slug
}

function apiMode(environment, name, fallback) {
  const value = environment[name]?.trim() || fallback
  if (!API_MODES.has(value)) throw new Error(`${name} must be images or responses`)
  return value
}

function parseIndexSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((item) => Number(item.trim()))
      .filter(Number.isInteger),
  )
}

const MAX_RUNNER_CONCURRENCY = 8

function runnerConcurrency(environment) {
  const raw = Number(environment.IMAGE_BATCH_RUNNER_CONCURRENCY)
  if (!Number.isInteger(raw) || raw < 1) return 1
  return Math.min(raw, MAX_RUNNER_CONCURRENCY)
}

export function resolveImageManifestBatchConfig(environment = process.env, cwd = process.cwd()) {
  const repoRoot = resolve(environment.IMAGE_BATCH_REPO_ROOT || cwd)
  const batchKey = safeSlug(environment.IMAGE_BATCH_KEY || 'image-manifest-batch')
  return {
    repoRoot,
    outputRoot: requiredPath(environment, 'IMAGE_BATCH_OUTPUT_ROOT'),
    manifestPath: requiredPath(environment, 'IMAGE_BATCH_MANIFEST_PATH'),
    statusPath: requiredPath(environment, 'IMAGE_BATCH_STATUS_PATH'),
    workDir: resolve(
      environment.IMAGE_BATCH_WORK_DIR || resolve(repoRoot, '.local-task-api', batchKey),
    ),
    batchKey,
    batchName: environment.IMAGE_BATCH_NAME?.trim() || batchKey,
    clientName: environment.IMAGE_BATCH_CLIENT_NAME?.trim() || `${batchKey}-client`,
    contactSheetPrefix: environment.IMAGE_BATCH_CONTACT_SHEET_PREFIX?.trim() || `${batchKey}-preview`,
    migrateIndexes: parseIndexSet(environment.IMAGE_BATCH_MIGRATE_INDEXES),
    runnerConcurrency: runnerConcurrency(environment),
    routes: [
      {
        name: 'primary',
        model: environment.IMAGE_BATCH_PRIMARY_MODEL?.trim() || 'gpt-image-2',
        apiMode: apiMode(environment, 'IMAGE_BATCH_PRIMARY_API_MODE', 'images'),
      },
      {
        name: 'fallback',
        model: environment.IMAGE_BATCH_REVISION_MODEL?.trim() || 'gpt-5.6-sol',
        apiMode: apiMode(environment, 'IMAGE_BATCH_REVISION_API_MODE', 'responses'),
      },
    ],
  }
}
