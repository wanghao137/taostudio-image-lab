import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('standalone image pipeline engine sync', () => {
  it('copies the engine and OpenAPI contract with portable core paths and detects drift', async () => {
    const target = await mkdtemp(join(tmpdir(), 'taostudio-engine-sync-'))
    temporaryDirectories.push(target)
    const script = resolve('scripts/sync-skill-engine.mjs')

    await execFileAsync(process.execPath, [script, target], { cwd: resolve('.') })

    const service = await readFile(join(target, 'engine', 'service.mjs'), 'utf8')
    const automation = await readFile(join(target, 'engine', 'batch-automation.mjs'), 'utf8')
    const openapi = await readFile(join(target, 'engine', 'openapi.yaml'), 'utf8')
    expect(service).toContain("from '../vendor/image-job-core/index.mjs'")
    expect(service).not.toContain('../../packages/image-job-core')
    expect(automation).toContain("from '../vendor/image-job-core/index.mjs'")
    expect(openapi).toContain('../vendor/image-job-core/schemas/image-job-contract-v1.schema.json')
    expect(openapi).not.toContain('../../packages/image-job-core')

    await expect(execFileAsync(process.execPath, [script, target, '--check'], { cwd: resolve('.') })).resolves.toMatchObject({
      stdout: expect.stringContaining('Skill engine matches the platform source of truth.'),
    })

    await writeFile(join(target, 'engine', 'openapi.yaml'), `${openapi}\n# drift\n`, 'utf8')
    await expect(execFileAsync(process.execPath, [script, target, '--check'], { cwd: resolve('.') })).rejects.toThrow(/skill engine drift: openapi\.yaml/)
  })
})
