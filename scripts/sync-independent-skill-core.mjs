import { cp, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join, resolve } from 'node:path'

const targetRoot = process.argv[2]
if (!targetRoot) throw new Error('usage: node scripts/sync-independent-skill-core.mjs <skill-directory> [--check]')
const sourceRoot = resolve('packages/image-job-core')
const target = resolve(targetRoot, 'vendor/image-job-core')
const files = [
  'index.mjs',
  'index.d.mts',
  'schemas/image-job-contract-v1.schema.json',
  'schemas/image-asset-manifest-v1.schema.json',
]
const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

if (process.argv.includes('--check')) {
  for (const file of files) {
    if (await digest(join(sourceRoot, file)) !== await digest(join(target, file))) throw new Error(`independent Skill core drift: ${file}`)
  }
  console.log('Independent Skill core matches the platform source of truth.')
} else {
  for (const file of files) {
    await mkdir(join(target, file.slice(0, -basename(file).length)), { recursive: true })
    await cp(join(sourceRoot, file), join(target, file), { force: true })
  }
  console.log('Independent Skill core synchronized.')
}
