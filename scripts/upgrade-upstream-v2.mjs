#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const configPath = path.join(projectRoot, 'upstream-upgrade.config.json')

const defaultConfig = {
  upstream: {
    repo: 'https://github.com/CookSleep/gpt_image_playground.git',
    ref: 'main',
  },
  cacheDir: '.upstream/gpt_image_playground',
  stateFile: 'docs/upstream-upgrade-state.json',
  reportFile: 'docs/upstream-upgrade-report.md',
  preservePaths: [],
}

const args = process.argv.slice(2)

function hasFlag(name) {
  return args.includes(name)
}

function readOption(name, fallback) {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

function readOptions(name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1])
  }
  return values
}

function validateCliArguments(argv = args) {
  const present = (flag) => argv.includes(flag)
  const problems = []
  if (present('--finalize') && present('--dry-run')) problems.push('--finalize cannot be combined with --dry-run')
  if (present('--finalize') && present('--write-conflicts')) problems.push('--finalize cannot be combined with --write-conflicts')
  if (present('--dry-run') && present('--write-conflicts')) problems.push('--dry-run cannot be combined with --write-conflicts')
  if (present('--dry-run') && (present('--install') || present('--verify'))) {
    problems.push('--dry-run cannot be combined with --install or --verify')
  }
  if (present('--write-conflicts') && (present('--install') || present('--verify'))) {
    problems.push('--write-conflicts cannot be combined with --install or --verify; run those gates during --finalize')
  }
  if (!present('--finalize') && argv.includes('--acknowledge')) {
    problems.push('--acknowledge is only valid with --finalize')
  }
  if (problems.length) throw new Error(`Invalid upstream upgrade arguments:\n${problems.map((item) => `- ${item}`).join('\n')}`)
}

function toPosix(value) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function run(command, commandArgs, options = {}) {
  const isWindowsNpm = process.platform === 'win32' && command === 'npm'
  const executable = isWindowsNpm ? 'npm.cmd' : command
  const result = spawnSync(executable, commandArgs, {
    cwd: options.cwd ?? projectRoot,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: isWindowsNpm,
    maxBuffer: 32 * 1024 * 1024,
  })

  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : ''
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit ${result.status}${stderr}`)
  }

  return result.stdout ?? ''
}

function config() {
  const userConfig = readJson(configPath, {})
  return {
    ...defaultConfig,
    ...userConfig,
    upstream: {
      ...defaultConfig.upstream,
      ...(userConfig.upstream ?? {}),
      repo: readOption('--repo', userConfig.upstream?.repo ?? defaultConfig.upstream.repo),
      ref: readOption('--ref', userConfig.upstream?.ref ?? defaultConfig.upstream.ref),
    },
    preservePaths: userConfig.preservePaths ?? defaultConfig.preservePaths,
  }
}

function isGitRepo() {
  return fs.existsSync(path.join(projectRoot, '.git'))
}

function assertCleanWorktree() {
  if (!isGitRepo() || hasFlag('--allow-dirty')) return
  const status = run('git', ['status', '--porcelain'], { capture: true })
  if (status.trim()) {
    throw new Error('Git worktree is not clean. Commit or stash changes first, or rerun with --allow-dirty.')
  }
}

function prepareCheckout(repo, ref, cacheDir) {
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true })
  if (!fs.existsSync(path.join(cacheDir, '.git'))) {
    run('git', ['clone', '--no-checkout', repo, cacheDir])
  } else {
    run('git', ['remote', 'set-url', 'origin', repo], { cwd: cacheDir })
  }

  run('git', ['fetch', '--no-filter', 'origin', ref, '--depth', '1'], { cwd: cacheDir })
  run('git', ['checkout', '--detach', '--force', 'FETCH_HEAD'], { cwd: cacheDir })
  run('git', ['clean', '-ffdx'], { cwd: cacheDir })
  return run('git', ['rev-parse', 'HEAD'], { cwd: cacheDir, capture: true }).trim()
}

function parseSupportedGitModes(staged) {
  const modes = new Map()
  const unsupported = []
  for (const line of staged.split(/\r?\n/)) {
    if (!line) continue
    const match = line.match(/^(\d{6}) [0-9a-f]+ \d+\t(.+)$/)
    if (!match) throw new Error(`Could not parse upstream git index entry: ${line}`)
    const [, mode, filePath] = match
    if (mode !== '100644' && mode !== '100755') unsupported.push(`${filePath} (${mode})`)
    else modes.set(toPosix(filePath), mode)
  }
  if (unsupported.length) {
    throw new Error(`Upstream symlinks, gitlinks, or special files are not supported:\n${unsupported.map((item) => `- ${item}`).join('\n')}`)
  }
  return modes
}

function readSupportedGitModes(checkoutDir) {
  if (!fs.existsSync(path.join(checkoutDir, '.git'))) return new Map()
  return parseSupportedGitModes(run('git', ['ls-files', '--stage'], { cwd: checkoutDir, capture: true }))
}

function readLocalGitModes(checkoutDir) {
  const modes = readSupportedGitModes(checkoutDir)
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: checkoutDir,
    capture: true,
  })
  for (const filePath of untracked.split('\0').filter(Boolean)) {
    if (!modes.has(toPosix(filePath))) modes.set(toPosix(filePath), '100644')
  }
  return modes
}

function assertNoIgnoredUpstreamAdditions(baseModes, upstreamModes, localModes, localRoot) {
  if (!fs.existsSync(path.join(localRoot, '.git'))) return
  const candidates = [...upstreamModes.keys()].filter((filePath) =>
    !baseModes.has(filePath) && !localModes.has(filePath),
  )
  if (!candidates.length) return

  const result = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    cwd: localRoot,
    input: `${candidates.join('\0')}\0`,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore failed with exit ${result.status}${result.stderr ? `\n${result.stderr}` : ''}`)
  }
  const ignored = (result.stdout ?? '').split('\0').filter(Boolean)
  if (ignored.length) {
    throw new Error(`New upstream files are ignored by the TaoStudio repository and require manual migration:\n${ignored.map((item) => `- ${item}`).join('\n')}`)
  }
}

function assertNoGitModeChanges(baseModes, upstreamModes) {
  const changed = []
  for (const [filePath, upstreamMode] of upstreamModes) {
    const baseMode = baseModes.get(filePath)
    if (baseMode && upstreamMode !== baseMode) {
      changed.push(`${filePath} (${baseMode} -> ${upstreamMode})`)
    } else if (!baseMode && upstreamMode === '100755') {
      changed.push(`${filePath} (new executable 100755)`)
    }
  }
  if (changed.length) {
    throw new Error(`Upstream file-mode changes require manual migration:\n${changed.map((item) => `- ${item}`).join('\n')}`)
  }
}

function assertNoGitPathCaseChanges(baseModes, upstreamModes) {
  const indexByLowercase = (modes, label) => {
    const indexed = new Map()
    const collisions = []
    for (const filePath of modes.keys()) {
      const key = toPosix(filePath).toLocaleLowerCase('en-US')
      const existing = indexed.get(key)
      if (existing && existing !== filePath) collisions.push(`${label}: ${existing} <> ${filePath}`)
      else indexed.set(key, filePath)
    }
    if (collisions.length) {
      throw new Error(`Case-colliding Git paths are not supported:\n${collisions.map((item) => `- ${item}`).join('\n')}`)
    }
    return indexed
  }

  const baseByLowercase = indexByLowercase(baseModes, 'base')
  const upstreamByLowercase = indexByLowercase(upstreamModes, 'upstream')
  const renamed = []
  for (const [key, basePath] of baseByLowercase) {
    const upstreamPath = upstreamByLowercase.get(key)
    if (upstreamPath && upstreamPath !== basePath) renamed.push(`${basePath} -> ${upstreamPath}`)
  }
  if (renamed.length) {
    throw new Error(`Case-only upstream renames require manual migration:\n${renamed.map((item) => `- ${item}`).join('\n')}`)
  }
}

function shouldIgnoreUpstreamPath(relativePath) {
  const rel = toPosix(relativePath)
  if (!rel) return true
  if (rel === '.git' || rel.startsWith('.git/')) return true
  return false
}

function createPreserveMatcher(preservePaths) {
  const exact = preservePaths.map((item) => toPosix(item).toLocaleLowerCase('en-US')).filter(Boolean)
  return (relativePath) => {
    const rel = toPosix(relativePath).toLocaleLowerCase('en-US')
    return exact.some((item) => rel === item || rel.startsWith(`${item}/`))
  }
}

function listFiles(rootDir) {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name)
      const relativePath = toPosix(path.relative(rootDir, absolutePath))
      if (shouldIgnoreUpstreamPath(relativePath)) continue
      if (entry.isDirectory()) walk(absolutePath)
      else if (entry.isFile()) files.push(relativePath)
      else if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not supported by the upstream upgrader: ${relativePath}`)
      } else {
        throw new Error(`Unsupported filesystem entry in upstream checkout: ${relativePath}`)
      }
    }
  }
  walk(rootDir)
  return files.sort()
}

function readBuffer(filePath) {
  if (!fs.existsSync(filePath)) return null
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile()) {
    throw new Error(`File/directory shape changes require manual migration: ${filePath}`)
  }
  return fs.readFileSync(filePath)
}

function sameBuffer(left, right) {
  if (left === null || right === null) return left === right
  return left.length === right.length && left.equals(right)
}

function temporarySibling(target) {
  return `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tempPath = temporarySibling(target)
  const previousMode = fs.existsSync(target) ? fs.statSync(target).mode : undefined
  try {
    fs.writeFileSync(tempPath, content)
    if (previousMode !== undefined) fs.chmodSync(tempPath, previousMode)
    fs.renameSync(tempPath, target)
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
  }
}

function copyFileAtomic(source, target) {
  writeFileAtomic(target, fs.readFileSync(source))
  fs.chmodSync(target, fs.statSync(source).mode)
}

const MISSING = Symbol('missing')

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function hashFileOrNull(filePath) {
  const content = readBuffer(filePath)
  return content === null ? null : sha256(content)
}

function mergeJsonValue(base, local, upstream, keyPath, conflicts) {
  if (isDeepStrictEqual(local, upstream)) return local
  if (isDeepStrictEqual(base, upstream)) return local
  if (isDeepStrictEqual(base, local)) return upstream

  const values = [base, local, upstream]
  const canMergeObjects = values.every((value) =>
    value === MISSING || (value !== null && typeof value === 'object' && !Array.isArray(value)),
  )
  if (canMergeObjects) {
    const baseObject = base === MISSING ? {} : base
    const localObject = local === MISSING ? {} : local
    const upstreamObject = upstream === MISSING ? {} : upstream
    const merged = {}
    const keys = new Set([...Object.keys(baseObject), ...Object.keys(localObject), ...Object.keys(upstreamObject)])
    for (const key of keys) {
      const nextPath = keyPath ? `${keyPath}.${key}` : key
      const value = mergeJsonValue(
        Object.hasOwn(baseObject, key) ? baseObject[key] : MISSING,
        Object.hasOwn(localObject, key) ? localObject[key] : MISSING,
        Object.hasOwn(upstreamObject, key) ? upstreamObject[key] : MISSING,
        nextPath,
        conflicts,
      )
      if (value !== MISSING) merged[key] = value
    }
    return merged
  }

  conflicts.push(keyPath || '<root>')
  return local
}

function mergedPackageJsonContent(basePackagePath, upstreamPackagePath, localPackagePath) {
  if (!fs.existsSync(basePackagePath) || !fs.existsSync(upstreamPackagePath) || !fs.existsSync(localPackagePath)) return null
  const basePackage = readJson(basePackagePath, {})
  const upstreamPackage = readJson(upstreamPackagePath, {})
  const localPackage = readJson(localPackagePath, {})
  const conflicts = []
  const merged = mergeJsonValue(basePackage, localPackage, upstreamPackage, '', conflicts)
  return {
    content: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8'),
    conflicts,
  }
}

function mergeTextFiles(localPath, basePath, upstreamPath, cwd = projectRoot) {
  const inputs = [localPath, basePath, upstreamPath].map((filePath) => fs.readFileSync(filePath))
  if (inputs.some((content) => content.includes(0))) {
    return { clean: false, binary: true, content: null }
  }

  const result = spawnSync('git', ['merge-file', '-p', '--diff3', localPath, basePath, upstreamPath], {
    cwd,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.status === null || result.status < 0) {
    throw new Error(`git merge-file failed for ${path.relative(projectRoot, localPath)} with exit ${result.status}`)
  }
  return {
    clean: result.status === 0,
    binary: false,
    content: result.stdout,
  }
}

function createPlan(cfg, baseDir, upstreamDir, localRoot = projectRoot) {
  const isPreserved = createPreserveMatcher(cfg.preservePaths)
  const baseFiles = new Set(listFiles(baseDir))
  const upstreamFiles = new Set(listFiles(upstreamDir))
  const allFiles = [...new Set([...baseFiles, ...upstreamFiles])].sort()
  const report = {
    copied: [],
    updated: [],
    merged: [],
    deleted: [],
    unchanged: [],
    localOnly: [],
    skipped: [],
    preservedUpstreamChanges: [],
    conflicts: [],
    dependencyMetadataChanged: false,
  }
  const actions = []

  const basePackagePath = path.join(baseDir, 'package.json')
  const upstreamPackagePath = path.join(upstreamDir, 'package.json')
  const localPackagePath = path.join(localRoot, 'package.json')
  const basePackageContent = readBuffer(basePackagePath)
  const upstreamPackageContent = readBuffer(upstreamPackagePath)
  const currentPackageContent = readBuffer(localPackagePath)
  if (sameBuffer(basePackageContent, upstreamPackageContent)) {
    if (sameBuffer(currentPackageContent, basePackageContent)) report.unchanged.push('package.json')
    else report.localOnly.push('package.json')
  } else {
    const packageMerge = mergedPackageJsonContent(basePackagePath, upstreamPackagePath, localPackagePath)
    if (!packageMerge) {
      report.conflicts.push({ path: 'package.json', kind: 'package-json-shape', hasMarkers: false })
      report.dependencyMetadataChanged = true
    } else if (packageMerge.conflicts.length) {
      report.dependencyMetadataChanged = true
      for (const field of packageMerge.conflicts) {
        report.conflicts.push({
          path: 'package.json',
          kind: `package-json-field:${field}`,
          hasMarkers: false,
        })
      }
      if (!sameBuffer(packageMerge.content, currentPackageContent)) {
        actions.push({ type: 'write-conflict', rel: 'package.json', content: packageMerge.content })
      }
    } else if (!sameBuffer(packageMerge.content, currentPackageContent)) {
      actions.push({ type: 'write', rel: 'package.json', content: packageMerge.content })
      report.updated.push('package.json')
      report.dependencyMetadataChanged = true
    } else {
      report.unchanged.push('package.json')
    }
  }

  const baseLock = readBuffer(path.join(baseDir, 'package-lock.json'))
  const upstreamLock = readBuffer(path.join(upstreamDir, 'package-lock.json'))
  const localLock = readBuffer(path.join(localRoot, 'package-lock.json'))
  if (!sameBuffer(baseLock, upstreamLock)) {
    report.dependencyMetadataChanged = true
    if (sameBuffer(localLock, upstreamLock)) {
      report.unchanged.push('package-lock.json')
    } else if (sameBuffer(baseLock, localLock) && upstreamLock !== null) {
      actions.push({ type: 'copy', rel: 'package-lock.json', source: path.join(upstreamDir, 'package-lock.json') })
      if (baseLock === null) report.copied.push('package-lock.json')
      else report.updated.push('package-lock.json')
    } else {
      report.conflicts.push({
        path: 'package-lock.json',
        kind: upstreamLock === null ? 'upstream-deleted-lockfile' : 'package-lock-both-modified',
        hasMarkers: false,
      })
    }
  } else if (sameBuffer(localLock, baseLock)) {
    report.unchanged.push('package-lock.json')
  } else {
    report.localOnly.push('package-lock.json')
  }

  for (const rel of allFiles) {
    if (rel === 'package.json' || rel === 'package-lock.json') continue

    const basePath = path.join(baseDir, rel)
    const upstreamPath = path.join(upstreamDir, rel)
    const localPath = path.join(localRoot, rel)
    const base = readBuffer(basePath)
    const upstream = readBuffer(upstreamPath)
    const local = readBuffer(localPath)
    const upstreamChanged = !sameBuffer(base, upstream)

    if (isPreserved(rel)) {
      report.skipped.push(rel)
      if (upstreamChanged) report.preservedUpstreamChanges.push(rel)
      continue
    }

    if (base === null && upstream !== null) {
      if (local === null) {
        actions.push({ type: 'copy', rel, source: upstreamPath })
        report.copied.push(rel)
      } else if (sameBuffer(local, upstream)) {
        report.unchanged.push(rel)
      } else {
        report.conflicts.push({ path: rel, kind: 'both-added', hasMarkers: false })
      }
      continue
    }

    if (base !== null && upstream === null) {
      if (local === null) {
        report.unchanged.push(rel)
      } else if (sameBuffer(local, base)) {
        actions.push({ type: 'delete', rel })
        report.deleted.push(rel)
      } else {
        report.conflicts.push({ path: rel, kind: 'upstream-deleted-local-modified', hasMarkers: false })
      }
      continue
    }

    if (base === null || upstream === null) continue
    if (local === null) {
      if (sameBuffer(base, upstream)) {
        report.localOnly.push(rel)
      } else {
        report.conflicts.push({ path: rel, kind: 'local-deleted-upstream-modified', hasMarkers: false })
      }
      continue
    }

    if (sameBuffer(local, upstream)) {
      report.unchanged.push(rel)
      continue
    }
    if (sameBuffer(base, upstream)) {
      report.localOnly.push(rel)
      continue
    }
    if (sameBuffer(local, base)) {
      actions.push({ type: 'copy', rel, source: upstreamPath })
      report.updated.push(rel)
      continue
    }

    const merge = mergeTextFiles(localPath, basePath, upstreamPath, localRoot)
    if (merge.clean) {
      actions.push({ type: 'write', rel, content: merge.content })
      report.merged.push(rel)
    } else {
      report.conflicts.push({
        path: rel,
        kind: merge.binary ? 'binary-both-modified' : 'text-both-modified',
        hasMarkers: !merge.binary,
      })
      if (merge.content) actions.push({ type: 'write-conflict', rel, content: merge.content })
    }
  }

  return { actions, report }
}

function applyPlan(actions, writeConflicts, localRoot = projectRoot) {
  const root = path.resolve(localRoot)
  const selectedActions = actions.filter((action) => action.type !== 'write-conflict' || writeConflicts)
  const backups = new Map()

  for (const action of selectedActions) {
    const target = path.resolve(root, action.rel)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Refusing to write outside project root: ${action.rel}`)
    }
    if (backups.has(target)) continue
    if (!fs.existsSync(target)) {
      backups.set(target, null)
      continue
    }
    const stat = fs.lstatSync(target)
    if (!stat.isFile()) throw new Error(`Refusing to replace non-file path during upgrade: ${action.rel}`)
    backups.set(target, { content: fs.readFileSync(target), mode: stat.mode })
  }

  try {
    for (const action of selectedActions) {
      const target = path.resolve(root, action.rel)
      if (action.type === 'copy') copyFileAtomic(action.source, target)
      else if (action.type === 'write' || action.type === 'write-conflict') writeFileAtomic(target, action.content)
      else if (action.type === 'delete' && fs.existsSync(target)) fs.rmSync(target)
    }
  } catch (error) {
    const rollbackErrors = []
    for (const [target, backup] of [...backups.entries()].reverse()) {
      try {
        if (backup === null) {
          if (fs.existsSync(target)) fs.rmSync(target, { force: true })
        } else {
          writeFileAtomic(target, backup.content)
          fs.chmodSync(target, backup.mode)
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], 'Upgrade apply failed and rollback was incomplete.')
    }
    if (error && typeof error === 'object') error.rollbackComplete = true
    throw error
  }
}

function expectedAppliedTree(actions) {
  const expected = new Map()
  for (const action of actions) {
    if (action.type === 'write-conflict') continue
    if (action.type === 'delete') {
      expected.set(action.rel, null)
    } else if (action.type === 'copy') {
      expected.set(action.rel, sha256(fs.readFileSync(action.source)))
    } else if (action.type === 'write') {
      expected.set(action.rel, sha256(action.content))
    }
  }
  return [...expected.entries()].map(([filePath, hash]) => ({ path: filePath, sha256: hash }))
}

function validateExpectedTree(pending, acknowledgements, localRoot = projectRoot) {
  const root = path.resolve(localRoot)
  const acknowledged = new Set(acknowledgements.map((item) => toPosix(item)))
  const problems = []
  for (const expected of pending.expectedAppliedTree ?? []) {
    if (acknowledged.has(toPosix(expected.path))) continue
    const target = path.resolve(root, expected.path)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      problems.push(`${expected.path} resolves outside project root`)
      continue
    }
    if (expected.sha256 === null) {
      if (fs.existsSync(target)) problems.push(`${expected.path} should remain deleted`)
      continue
    }
    if (!fs.existsSync(target)) {
      problems.push(`${expected.path} is missing after automatic apply`)
      continue
    }
    const stat = fs.lstatSync(target)
    if (!stat.isFile()) {
      problems.push(`${expected.path} is no longer a regular file`)
      continue
    }
    if (sha256(fs.readFileSync(target)) !== expected.sha256) {
      problems.push(`${expected.path} changed after automatic apply; review it and pass --acknowledge ${expected.path}`)
    }
  }
  return problems
}

function writeReport(filePath, report) {
  const renderList = (title, items) => [
    `## ${title}`,
    '',
    items.length
      ? items.slice(0, 300).map((item) => `- ${typeof item === 'string' ? item : `${item.path} (${item.kind})`}`).join('\n')
      : '- None',
    items.length > 300 ? `\n- ... ${items.length - 300} more` : '',
    '',
  ].join('\n')

  const body = [
    '# Upstream Upgrade Report',
    '',
    `- Upstream: ${report.upstreamRepo}`,
    `- Base commit: ${report.baseCommit}`,
    `- Target ref: ${report.upstreamRef}`,
    `- Target commit: ${report.upstreamCommit}`,
    `- Generated at: ${report.generatedAt}`,
    `- Dry run: ${report.dryRun ? 'yes' : 'no'}`,
    '',
    renderList('Copied files', report.copied),
    renderList('Updated files', report.updated),
    renderList('Clean three-way merges', report.merged),
    renderList('Deleted upstream files', report.deleted),
    renderList('Local-only files left unchanged', report.localOnly),
    renderList('Preserved files changed upstream', report.preservedUpstreamChanges),
    renderList('Conflicts', report.conflicts),
  ].join('\n')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, body, 'utf8')
}

function printSummary(report) {
  console.log('')
  console.log('Upstream three-way upgrade summary')
  console.log(`- base: ${report.baseCommit}`)
  console.log(`- target: ${report.upstreamRef} (${report.upstreamCommit})`)
  console.log(`- copied: ${report.copied.length}`)
  console.log(`- updated: ${report.updated.length}`)
  console.log(`- clean merges: ${report.merged.length}`)
  console.log(`- deleted: ${report.deleted.length}`)
  console.log(`- local-only: ${report.localOnly.length}`)
  console.log(`- preserved but changed upstream: ${report.preservedUpstreamChanges.length}`)
  console.log(`- conflicts: ${report.conflicts.length}`)
  console.log(`- dry run: ${report.dryRun ? 'yes' : 'no'}`)
  if (report.dryRun) {
    const printFiles = (label, files) => {
      if (!files.length) return
      console.log(`- ${label}:`)
      for (const file of files.slice(0, 300)) console.log(`  - ${file}`)
      if (files.length > 300) console.log(`  - ... ${files.length - 300} more`)
    }
    printFiles('files to copy', report.copied)
    printFiles('files to update', report.updated)
    printFiles('files to merge', report.merged)
    printFiles('files to delete', report.deleted)
  }
  if (report.preservedUpstreamChanges.length) {
    console.log('- preserved files changed upstream:')
    for (const file of report.preservedUpstreamChanges) console.log(`  - ${file}`)
  }
  if (report.conflicts.length) {
    console.log('- conflicts:')
    for (const conflict of report.conflicts) console.log(`  - ${conflict.path} (${conflict.kind})`)
  }
}

function pendingPathFor(cfg) {
  return path.resolve(projectRoot, cfg.cacheDir, '..', 'upstream-upgrade-pending.json')
}

function currentGitContext() {
  if (!isGitRepo()) return null
  return {
    branch: run('git', ['branch', '--show-current'], { capture: true }).trim(),
    head: run('git', ['rev-parse', 'HEAD'], { capture: true }).trim(),
  }
}

function requiredAcknowledgements(report) {
  return [...new Set([
    ...report.preservedUpstreamChanges,
    ...report.conflicts.map((conflict) => conflict.path),
  ])].sort()
}

function assertReleaseGates(installRequired) {
  if (!hasFlag('--verify')) {
    throw new Error('Refusing to advance the upstream baseline without --verify.')
  }
  if (installRequired && !hasFlag('--install')) {
    throw new Error('Dependency metadata changed. Rerun with --install --verify.')
  }
}

function runVerification() {
  if (hasFlag('--install')) run('npm', ['install'])
  const installedLockSha256 = hasFlag('--install')
    ? hashFileOrNull(path.join(projectRoot, 'package-lock.json'))
    : undefined
  run('npm', ['run', 'lint'])
  run('npm', ['run', 'test'])
  run('npm', ['run', 'build'])
  return { installedLockSha256 }
}

function validatePendingContext(pending, state, acknowledgements, gitContext) {
  const problems = []
  if (pending.schemaVersion !== 3) {
    problems.push(`pending schema is ${pending.schemaVersion ?? '<missing>'}, expected 3`)
  }
  if (pending.phase !== 'applied' && pending.phase !== 'applying') {
    problems.push(`pending migration phase is ${pending.phase ?? '<missing>'}, expected applying/applied`)
  }
  if (pending.baseCommit !== state?.lastAppliedCommit) {
    problems.push(`recorded base ${pending.baseCommit} does not match current state ${state?.lastAppliedCommit ?? '<missing>'}`)
  }
  if (pending.upstreamRepo !== state?.upstreamRepo) {
    problems.push(`pending repo ${pending.upstreamRepo} does not match current state ${state?.upstreamRepo ?? '<missing>'}`)
  }
  if (pending.gitContext && gitContext) {
    if (pending.gitContext.branch !== gitContext.branch) {
      problems.push(`migration branch ${pending.gitContext.branch || '<detached>'} does not match current branch ${gitContext.branch || '<detached>'}`)
    }
    if (pending.gitContext.head !== gitContext.head) {
      problems.push(`migration HEAD ${pending.gitContext.head} does not match current HEAD ${gitContext.head}`)
    }
  }

  const acknowledged = new Set(acknowledgements.map(toPosix))
  for (const item of pending.requiredAcknowledgements ?? []) {
    if (!acknowledged.has(toPosix(item))) problems.push(`missing --acknowledge ${item}`)
  }
  return problems
}

function pendingValidationProblems(pending, cfg, acknowledgements, allowInstalledLockfile = false) {
  const state = readJson(path.join(projectRoot, cfg.stateFile), null)
  const effectiveAcknowledgements = allowInstalledLockfile
    ? [...acknowledgements, 'package-lock.json']
    : acknowledgements
  return [
    ...validatePendingContext(pending, state, acknowledgements, currentGitContext()),
    ...validateExpectedTree(pending, effectiveAcknowledgements),
  ]
}

function finalizePendingUpgrade(cfg) {
  const pendingPath = pendingPathFor(cfg)
  const pending = readJson(pendingPath, null)
  if (!pending) throw new Error('No pending upstream upgrade was found.')
  assertReleaseGates(Boolean(pending.installRequired))

  const acknowledgements = readOptions('--acknowledge')
  const unresolved = pendingValidationProblems(pending, cfg, acknowledgements)
  for (const conflict of pending.conflicts ?? []) {
    if (!conflict.hasMarkers) continue
    const filePath = path.join(projectRoot, conflict.path)
    if (!fs.existsSync(filePath)) {
      unresolved.push(`${conflict.path} (missing)`)
      continue
    }
    const content = fs.readFileSync(filePath)
    if (content.includes(Buffer.from('<<<<<<<')) || content.includes(Buffer.from('>>>>>>>'))) {
      unresolved.push(`${conflict.path} (conflict markers remain)`)
    }
  }
  if (unresolved.length) {
    throw new Error(`Pending upgrade cannot be finalized:\n${unresolved.map((item) => `- ${item}`).join('\n')}`)
  }

  run('git', ['diff', '--check'])
  const verification = runVerification()
  const postVerificationProblems = pendingValidationProblems(
    pending,
    cfg,
    acknowledgements,
    hasFlag('--install'),
  )
  if (
    verification.installedLockSha256 !== undefined
    && verification.installedLockSha256 !== hashFileOrNull(path.join(projectRoot, 'package-lock.json'))
  ) {
    postVerificationProblems.push('package-lock.json changed after npm install completed')
  }
  if (postVerificationProblems.length) {
    throw new Error(`Pending upgrade changed during verification:\n${postVerificationProblems.map((item) => `- ${item}`).join('\n')}`)
  }
  writeJson(path.join(projectRoot, cfg.stateFile), {
    upstreamRepo: pending.upstreamRepo,
    upstreamRef: pending.upstreamRef,
    lastAppliedCommit: pending.upstreamCommit,
    upgradedAt: new Date().toISOString(),
    notes: 'Updated by transactional three-way upstream migration. TaoStudio behavior contracts require independent verification.',
  })
  fs.rmSync(pendingPath)
  console.log(`Finalized upstream ${pending.upstreamRef} at ${pending.upstreamCommit}.`)
}

function printHelp() {
  console.log(`Usage:
  npm run upgrade:upstream -- [options]

Options:
  --dry-run          Fetch and classify the three-way upgrade without editing project files.
  --write-conflicts  Apply clean changes and write text conflict markers for an explicit migration.
  --finalize         Finalize a resolved pending migration and update the upstream state file.
  --acknowledge <p>  Explicitly accept one preserved or conflicted path (repeatable).
  --install          Run npm install after a clean apply or during finalize.
  --verify           Run lint, tests, and build. Required before advancing the baseline.
  --allow-dirty      Allow operation with a dirty worktree. Use only after inspecting local changes.
  --repo <url>       Override the upstream repository URL.
  --ref <ref>        Override the upstream tag, branch, or commit.
`)
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp()
    return
  }
  validateCliArguments()

  const cfg = config()
  if (hasFlag('--finalize')) {
    finalizePendingUpgrade(cfg)
    return
  }

  assertCleanWorktree()
  const state = readJson(path.join(projectRoot, cfg.stateFile), null)
  if (!state?.lastAppliedCommit) {
    throw new Error(`Missing lastAppliedCommit in ${cfg.stateFile}; a three-way base is required.`)
  }

  const cacheDir = path.resolve(projectRoot, cfg.cacheDir)
  const baseDir = `${cacheDir}-base`
  const baseCommit = prepareCheckout(cfg.upstream.repo, state.lastAppliedCommit, baseDir)
  const upstreamCommit = prepareCheckout(cfg.upstream.repo, cfg.upstream.ref, cacheDir)
  const baseModes = readSupportedGitModes(baseDir)
  const upstreamModes = readSupportedGitModes(cacheDir)
  const localModes = readLocalGitModes(projectRoot)
  assertNoGitPathCaseChanges(baseModes, upstreamModes)
  assertNoGitPathCaseChanges(localModes, upstreamModes)
  assertNoGitModeChanges(baseModes, upstreamModes)
  assertNoIgnoredUpstreamAdditions(baseModes, upstreamModes, localModes, projectRoot)
  if (baseCommit !== state.lastAppliedCommit) {
    throw new Error(`Fetched base ${baseCommit} does not match recorded base ${state.lastAppliedCommit}.`)
  }

  const { actions, report: planReport } = createPlan(cfg, baseDir, cacheDir)
  const report = {
    upstreamRepo: cfg.upstream.repo,
    upstreamRef: cfg.upstream.ref,
    upstreamCommit,
    baseCommit,
    generatedAt: new Date().toISOString(),
    dryRun: hasFlag('--dry-run'),
    ...planReport,
  }
  printSummary(report)

  if (hasFlag('--dry-run')) {
    if (report.conflicts.length || report.preservedUpstreamChanges.length) process.exitCode = 2
    return
  }

  const pendingPath = pendingPathFor(cfg)
  if (fs.existsSync(pendingPath)) {
    throw new Error(`A pending upstream migration already exists at ${pendingPath}. Finalize or inspect it before starting another migration.`)
  }

  const writeConflicts = hasFlag('--write-conflicts')
  const requiresAttention = report.conflicts.length > 0 || report.preservedUpstreamChanges.length > 0
  writeReport(path.join(projectRoot, cfg.reportFile), report)
  if (requiresAttention && !writeConflicts) {
    throw new Error('Upgrade requires manual conflict/preserved-file review. No project files were changed. Re-run with --write-conflicts only on an isolated migration branch.')
  }

  if (!requiresAttention) assertReleaseGates(report.dependencyMetadataChanged)
  const pending = {
    schemaVersion: 3,
    phase: 'applying',
    upstreamRepo: cfg.upstream.repo,
    upstreamRef: cfg.upstream.ref,
    upstreamCommit,
    baseCommit,
    gitContext: currentGitContext(),
    conflicts: report.conflicts,
    preservedUpstreamChanges: report.preservedUpstreamChanges,
    requiredAcknowledgements: requiredAcknowledgements(report),
    expectedAppliedTree: expectedAppliedTree(actions),
    installRequired: report.dependencyMetadataChanged,
    createdAt: new Date().toISOString(),
  }
  writeJson(pendingPath, pending)
  try {
    applyPlan(actions, writeConflicts)
  } catch (error) {
    if (error?.rollbackComplete && fs.existsSync(pendingPath)) fs.rmSync(pendingPath)
    throw error
  }
  const appliedTreeProblems = validateExpectedTree(pending, [])
  if (appliedTreeProblems.length) {
    throw new Error(`Automatic apply verification failed:\n${appliedTreeProblems.map((item) => `- ${item}`).join('\n')}`)
  }
  const appliedPending = { ...pending, phase: 'applied', appliedAt: new Date().toISOString() }
  writeJson(pendingPath, appliedPending)

  if (requiresAttention) {
    throw new Error(`Applied clean changes; ${report.conflicts.length} conflict(s) and ${report.preservedUpstreamChanges.length} preserved-file audit item(s) remain. Resolve and acknowledge them, then run --finalize --install --verify.`)
  }

  const verification = runVerification()
  const postVerificationProblems = pendingValidationProblems(
    appliedPending,
    cfg,
    [],
    hasFlag('--install'),
  )
  if (
    verification.installedLockSha256 !== undefined
    && verification.installedLockSha256 !== hashFileOrNull(path.join(projectRoot, 'package-lock.json'))
  ) {
    postVerificationProblems.push('package-lock.json changed after npm install completed')
  }
  if (postVerificationProblems.length) {
    throw new Error(`Upgrade changed during verification:\n${postVerificationProblems.map((item) => `- ${item}`).join('\n')}`)
  }
  writeJson(path.join(projectRoot, cfg.stateFile), {
    upstreamRepo: cfg.upstream.repo,
    upstreamRef: cfg.upstream.ref,
    lastAppliedCommit: upstreamCommit,
    upgradedAt: new Date().toISOString(),
    notes: 'Updated by transactional three-way upstream migration. TaoStudio behavior contracts require independent verification.',
  })
  fs.rmSync(pendingPath)
}

export {
  applyPlan,
  assertNoIgnoredUpstreamAdditions,
  assertNoGitModeChanges,
  assertNoGitPathCaseChanges,
  createPlan,
  createPreserveMatcher,
  expectedAppliedTree,
  mergedPackageJsonContent,
  mergeTextFiles,
  parseSupportedGitModes,
  requiredAcknowledgements,
  sameBuffer,
  toPosix,
  validateCliArguments,
  validatePendingContext,
  validateExpectedTree,
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
