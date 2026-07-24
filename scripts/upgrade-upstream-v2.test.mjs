import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPlan,
  assertNoIgnoredUpstreamAdditions,
  assertNoGitModeChanges,
  assertNoGitPathCaseChanges,
  createPlan,
  createPreserveMatcher,
  expectedAppliedTree,
  parseSupportedGitModes,
  requiredAcknowledgements,
  validateCliArguments,
  validateExpectedTree,
  validatePendingContext,
} from './upgrade-upstream-v2.mjs'

const tempRoots = []

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taostudio-upgrade-'))
  tempRoots.push(root)
  const local = path.join(root, 'local')
  const base = path.join(root, 'base')
  const upstream = path.join(root, 'upstream')
  for (const dir of [local, base, upstream]) fs.mkdirSync(dir, { recursive: true })
  return { local, base, upstream }
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function config(preservePaths = []) {
  return { preservePaths }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('transactional upstream upgrade plan', () => {
  it('applies an upstream-only change when the local file still matches the base', () => {
    const fixture = createFixture()
    write(fixture.base, 'src/value.txt', 'base\n')
    write(fixture.local, 'src/value.txt', 'base\n')
    write(fixture.upstream, 'src/value.txt', 'upstream\n')

    const { actions, report } = createPlan(config(), fixture.base, fixture.upstream, fixture.local)

    expect(report.updated).toEqual(['src/value.txt'])
    expect(report.conflicts).toEqual([])
    applyPlan(actions, false, fixture.local)
    expect(read(fixture.local, 'src/value.txt')).toBe('upstream\n')
  })

  it('keeps non-overlapping local and upstream edits through a clean three-way merge', () => {
    const fixture = createFixture()
    write(fixture.base, 'src/value.txt', 'first\nmiddle\nlast\n')
    write(fixture.local, 'src/value.txt', 'local\nmiddle\nlast\n')
    write(fixture.upstream, 'src/value.txt', 'first\nmiddle\nupstream\n')

    const { actions, report } = createPlan(config(), fixture.base, fixture.upstream, fixture.local)

    expect(report.merged).toEqual(['src/value.txt'])
    expect(report.conflicts).toEqual([])
    applyPlan(actions, false, fixture.local)
    expect(read(fixture.local, 'src/value.txt')).toBe('local\nmiddle\nupstream\n')
  })

  it('does not write a conflicted file unless conflict output is explicitly requested', () => {
    const fixture = createFixture()
    write(fixture.base, 'src/conflict.txt', 'base\n')
    write(fixture.local, 'src/conflict.txt', 'local\n')
    write(fixture.upstream, 'src/conflict.txt', 'upstream\n')
    write(fixture.base, 'src/clean.txt', 'old\n')
    write(fixture.local, 'src/clean.txt', 'old\n')
    write(fixture.upstream, 'src/clean.txt', 'new\n')

    const { actions, report } = createPlan(config(), fixture.base, fixture.upstream, fixture.local)

    expect(report.conflicts).toEqual([
      { path: 'src/conflict.txt', kind: 'text-both-modified', hasMarkers: true },
    ])
    applyPlan(actions, false, fixture.local)
    expect(read(fixture.local, 'src/conflict.txt')).toBe('local\n')
    expect(read(fixture.local, 'src/clean.txt')).toBe('new\n')
  })

  it('reports upstream changes under preserved paths without modifying the local overlay', () => {
    const fixture = createFixture()
    write(fixture.base, 'src/keep.txt', 'base\n')
    write(fixture.local, 'src/keep.txt', 'taostudio\n')
    write(fixture.upstream, 'src/keep.txt', 'upstream\n')

    const { actions, report } = createPlan(config(['src/keep.txt']), fixture.base, fixture.upstream, fixture.local)

    expect(report.preservedUpstreamChanges).toEqual(['src/keep.txt'])
    applyPlan(actions, false, fixture.local)
    expect(read(fixture.local, 'src/keep.txt')).toBe('taostudio\n')
  })

  it('deletes a file removed upstream only when the local copy still matches the base', () => {
    const fixture = createFixture()
    write(fixture.base, 'src/removed.txt', 'base\n')
    write(fixture.local, 'src/removed.txt', 'base\n')

    const { actions, report } = createPlan(config(), fixture.base, fixture.upstream, fixture.local)

    expect(report.deleted).toEqual(['src/removed.txt'])
    applyPlan(actions, false, fixture.local)
    expect(fs.existsSync(path.join(fixture.local, 'src/removed.txt'))).toBe(false)
  })

  it('merges package metadata while retaining TaoStudio scripts and local-only dependencies', () => {
    const fixture = createFixture()
    write(fixture.base, 'package.json', `${JSON.stringify({
      name: 'gpt-image-playground',
      version: '0.6.11',
      dependencies: { shared: '1.0.0' },
    }, null, 2)}\n`)
    write(fixture.local, 'package.json', `${JSON.stringify({
      name: 'taostudio-image-lab',
      private: true,
      version: '0.6.11',
      scripts: { local: 'node local.mjs' },
      dependencies: { localOnly: '1.0.0', shared: '1.0.0' },
    }, null, 2)}\n`)
    write(fixture.upstream, 'package.json', `${JSON.stringify({
      name: 'gpt-image-playground',
      version: '0.7.1',
      scripts: { upstream: 'vite' },
      dependencies: { shared: '2.0.0', upstreamOnly: '1.0.0' },
    }, null, 2)}\n`)

    const { actions, report } = createPlan(config(), fixture.base, fixture.upstream, fixture.local)
    applyPlan(actions, false, fixture.local)
    const merged = JSON.parse(read(fixture.local, 'package.json'))

    expect(report.updated).toContain('package.json')
    expect(merged).toMatchObject({
      name: 'taostudio-image-lab',
      private: true,
      version: '0.7.1',
      scripts: { local: 'node local.mjs', upstream: 'vite' },
      dependencies: { localOnly: '1.0.0', shared: '2.0.0', upstreamOnly: '1.0.0' },
    })
  })

  it('reports a package field conflict when local and upstream both change the same dependency', () => {
    const fixture = createFixture()
    for (const [root, dependencies] of [
      [fixture.base, { shared: '1.0.0', clean: '1.0.0' }],
      [fixture.local, { shared: '1.5.0', clean: '1.0.0' }],
      [fixture.upstream, { shared: '2.0.0', clean: '2.0.0' }],
    ]) {
      write(root, 'package.json', `${JSON.stringify({ dependencies }, null, 2)}\n`)
    }

    const { actions, report } = createPlan(config(), fixture.base, fixture.upstream, fixture.local)

    expect(report.conflicts).toEqual([
      {
        path: 'package.json',
        kind: 'package-json-field:dependencies.shared',
        hasMarkers: false,
      },
    ])
    expect(actions).toEqual([
      expect.objectContaining({ type: 'write-conflict', rel: 'package.json' }),
    ])
    applyPlan(actions, true, fixture.local)
    expect(JSON.parse(read(fixture.local, 'package.json')).dependencies).toEqual({
      shared: '1.5.0',
      clean: '2.0.0',
    })
  })

  it('leaves local package metadata untouched when upstream did not change it', () => {
    const fixture = createFixture()
    const upstreamPackage = `${JSON.stringify({ version: '0.7.1' }, null, 2)}\n`
    write(fixture.base, 'package.json', upstreamPackage)
    write(fixture.upstream, 'package.json', upstreamPackage)
    write(fixture.local, 'package.json', `${JSON.stringify({
      version: '0.7.1',
      scripts: { local: 'node local.mjs' },
    }, null, 2)}\n`)

    const { actions, report } = createPlan(config(), fixture.base, fixture.upstream, fixture.local)

    expect(report.localOnly).toContain('package.json')
    expect(actions.some((action) => action.rel === 'package.json')).toBe(false)
  })

  it('requires explicit acknowledgement for preserved and markerless conflicts', () => {
    const report = {
      preservedUpstreamChanges: ['src/types.ts'],
      conflicts: [
        { path: 'assets/logo.png', kind: 'binary-both-modified', hasMarkers: false },
        { path: 'src/store.ts', kind: 'text-both-modified', hasMarkers: true },
        { path: 'src/types.ts', kind: 'both-added', hasMarkers: false },
      ],
    }

    expect(requiredAcknowledgements(report)).toEqual(['assets/logo.png', 'src/store.ts', 'src/types.ts'])
  })

  it('rejects stale pending state and missing acknowledgements', () => {
    const pending = {
      schemaVersion: 3,
      phase: 'applied',
      baseCommit: 'base-a',
      upstreamRepo: 'https://example.com/upstream.git',
      requiredAcknowledgements: ['src/types.ts'],
      gitContext: { branch: 'migration', head: 'head-a' },
    }
    const state = {
      lastAppliedCommit: 'base-b',
      upstreamRepo: 'https://example.com/upstream.git',
    }

    expect(validatePendingContext(
      pending,
      state,
      [],
      { branch: 'migration', head: 'head-a' },
    )).toEqual([
      'recorded base base-a does not match current state base-b',
      'missing --acknowledge src/types.ts',
    ])
    expect(validatePendingContext(
      pending,
      { ...state, lastAppliedCommit: 'base-a' },
      ['src/types.ts'],
      { branch: 'migration', head: 'head-a' },
    )).toEqual([])
  })

  it('binds finalize to every automatically applied file unless explicitly acknowledged', () => {
    const fixture = createFixture()
    write(fixture.local, 'src/value.txt', 'local\n')
    const actions = [{ type: 'write', rel: 'src/value.txt', content: Buffer.from('merged\n') }]
    const pending = { expectedAppliedTree: expectedAppliedTree(actions) }

    applyPlan(actions, false, fixture.local)
    expect(validateExpectedTree(pending, [], fixture.local)).toEqual([])

    write(fixture.local, 'src/value.txt', 'restored-base\n')
    expect(validateExpectedTree(pending, [], fixture.local)).toEqual([
      'src/value.txt changed after automatic apply; review it and pass --acknowledge src/value.txt',
    ])
    expect(validateExpectedTree(pending, ['src/value.txt'], fixture.local)).toEqual([])
  })

  it('copies an upstream-only lockfile refresh and conflicts when both sides changed it', () => {
    const cleanFixture = createFixture()
    write(cleanFixture.base, 'package-lock.json', 'old-lock\n')
    write(cleanFixture.local, 'package-lock.json', 'old-lock\n')
    write(cleanFixture.upstream, 'package-lock.json', 'upstream-lock\n')

    const cleanPlan = createPlan(config(), cleanFixture.base, cleanFixture.upstream, cleanFixture.local)
    expect(cleanPlan.report.updated).toContain('package-lock.json')
    expect(cleanPlan.actions).toContainEqual(expect.objectContaining({ type: 'copy', rel: 'package-lock.json' }))
    applyPlan(cleanPlan.actions, false, cleanFixture.local)
    expect(read(cleanFixture.local, 'package-lock.json')).toBe('upstream-lock\n')

    const conflictFixture = createFixture()
    write(conflictFixture.base, 'package-lock.json', 'old-lock\n')
    write(conflictFixture.local, 'package-lock.json', 'local-lock\n')
    write(conflictFixture.upstream, 'package-lock.json', 'upstream-lock\n')
    const conflictPlan = createPlan(config(), conflictFixture.base, conflictFixture.upstream, conflictFixture.local)
    expect(conflictPlan.report.conflicts).toContainEqual({
      path: 'package-lock.json',
      kind: 'package-lock-both-modified',
      hasMarkers: false,
    })
    expect(conflictPlan.actions.some((action) => action.rel === 'package-lock.json')).toBe(false)
  })

  it('rejects symlink and gitlink modes even when checkout materializes them as regular files', () => {
    expect(() => parseSupportedGitModes('120000 abcdef 0\tlink\n'))
      .toThrow('Upstream symlinks, gitlinks, or special files are not supported')
    expect(() => parseSupportedGitModes('160000 abcdef 0\tsubmodule\n'))
      .toThrow('Upstream symlinks, gitlinks, or special files are not supported')
    expect(parseSupportedGitModes('100644 abcdef 0\tfile.txt\n')).toEqual(new Map([['file.txt', '100644']]))
  })

  it('rejects case-only renames and executable mode changes before filesystem planning', () => {
    expect(() => assertNoGitPathCaseChanges(
      new Map([['src/Widget.ts', '100644']]),
      new Map([['src/widget.ts', '100644']]),
    )).toThrow('Case-only upstream renames require manual migration')
    expect(() => assertNoGitPathCaseChanges(
      new Map([['src/Foo.ts', '100644']]),
      new Map([['src/Foo.ts', '100644'], ['src/foo.ts', '100644']]),
    )).toThrow('Case-colliding Git paths are not supported')
    expect(() => assertNoGitPathCaseChanges(
      new Map([['src/Widget.ts', '100644']]),
      new Map([['src/widget.ts', '100644']]),
    )).toThrow('src/Widget.ts -> src/widget.ts')
    expect(() => assertNoGitModeChanges(
      new Map([['script.sh', '100644']]),
      new Map([['script.sh', '100755']]),
    )).toThrow('Upstream file-mode changes require manual migration')
    expect(() => assertNoGitModeChanges(
      new Map(),
      new Map([['script.sh', '100755']]),
    )).toThrow('new executable 100755')
  })

  it('rejects contradictory CLI modes before any repository mutation', () => {
    expect(() => validateCliArguments(['--finalize', '--dry-run', '--verify']))
      .toThrow('--finalize cannot be combined with --dry-run')
    expect(() => validateCliArguments(['--dry-run', '--write-conflicts']))
      .toThrow('--dry-run cannot be combined with --write-conflicts')
    expect(() => validateCliArguments(['--acknowledge', 'src/types.ts']))
      .toThrow('--acknowledge is only valid with --finalize')
    expect(() => validateCliArguments(['--finalize', '--acknowledge', 'src/types.ts', '--verify']))
      .not.toThrow()
  })

  it('rejects new upstream files that the TaoStudio repository would ignore', () => {
    const fixture = createFixture()
    write(fixture.local, '.gitignore', 'dist/\n')
    const init = spawnSync('git', ['init'], { cwd: fixture.local, encoding: 'utf8' })
    expect(init.status).toBe(0)

    expect(() => assertNoIgnoredUpstreamAdditions(
      new Map(),
      new Map([['dist/bundle.js', '100644']]),
      new Map([['.gitignore', '100644']]),
      fixture.local,
    )).toThrow('New upstream files are ignored by the TaoStudio repository')
    expect(() => assertNoIgnoredUpstreamAdditions(
      new Map(),
      new Map([['src/new.ts', '100644']]),
      new Map([['.gitignore', '100644']]),
      fixture.local,
    )).not.toThrow()
  })

  it('matches preserved paths case-insensitively', () => {
    const isPreserved = createPreserveMatcher(['src/InputBar.tsx'])

    expect(isPreserved('SRC/inputbar.tsx')).toBe(true)
    expect(isPreserved('src/inputbar.tsx/child')).toBe(true)
  })

  it('fails safely on file-directory shape changes before applying a plan', () => {
    const fixture = createFixture()
    write(fixture.base, 'src/node/value.txt', 'base\n')
    write(fixture.local, 'src/node/value.txt', 'local\n')
    write(fixture.upstream, 'src/node', 'upstream file\n')

    expect(() => createPlan(config(), fixture.base, fixture.upstream, fixture.local))
      .toThrow('File/directory shape changes require manual migration')
    expect(read(fixture.local, 'src/node/value.txt')).toBe('local\n')
  })
})
