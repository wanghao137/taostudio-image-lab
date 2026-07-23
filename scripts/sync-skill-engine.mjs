// Sync the Task API engine (service/cli/mcp-server/tests) from the platform
// repo into the standalone generate-image-asset-skill repo's engine/ dir.
// Rewrites the image-job-core import path from the platform layout
// (../../packages/image-job-core) to the skill's vendored layout
// (../vendor/image-job-core) so the copied engine runs standalone.
//
// Usage:
//   node scripts/sync-skill-engine.mjs <skill-directory>           # sync
//   node scripts/sync-skill-engine.mjs <skill-directory> --check   # verify drift
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

const targetRoot = process.argv[2]
if (!targetRoot) throw new Error('usage: node scripts/sync-skill-engine.mjs <skill-directory> [--check]')
const sourceDir = resolve('server/task-api')
const targetDir = resolve(targetRoot, 'engine')
const files = ['service.mjs', 'cli.mjs', 'mcp-server.mjs', 'service.test.mjs']

// The import rewrite: platform path -> vendored skill path.
const PLATFORM_IMPORT = "../../packages/image-job-core/index.mjs"
const SKILL_IMPORT = "../vendor/image-job-core/index.mjs"

async function readWithRewrite(srcPath) {
  const content = await readFile(srcPath, 'utf8')
  return content.replaceAll(PLATFORM_IMPORT, SKILL_IMPORT)
}

// For --check: compare hashes. Because the target has the rewritten import,
// we hash the rewritten source content and compare to the target content.
async function rewrittenDigest(srcPath) {
  return createHash('sha256').update(await readWithRewrite(srcPath)).digest('hex')
}
async function fileDigest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

if (process.argv.includes('--check')) {
  for (const file of files) {
    const src = join(sourceDir, file)
    const dst = join(targetDir, file)
    const srcHash = await rewrittenDigest(src)
    const dstHash = await fileDigest(dst)
    if (srcHash !== dstHash) throw new Error(`skill engine drift: ${file}`)
  }
  console.log('Skill engine matches the platform source of truth.')
} else {
  await mkdir(targetDir, { recursive: true })
  for (const file of files) {
    const content = await readWithRewrite(join(sourceDir, file))
    await writeFile(join(targetDir, file), content, 'utf8')
  }
  console.log(`Skill engine synchronized (${files.length} files, import paths rewritten).`)
}
