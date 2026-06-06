#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
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

function toPosix(value) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(`${filePath}.tmp`, filePath)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? projectRoot,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: false,
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

function prepareUpstreamCheckout(cfg) {
  const cacheDir = path.resolve(projectRoot, cfg.cacheDir)
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true })

  if (!fs.existsSync(path.join(cacheDir, '.git'))) {
    run('git', ['clone', '--depth', '1', '--branch', cfg.upstream.ref, cfg.upstream.repo, cacheDir])
  } else {
    run('git', ['remote', 'set-url', 'origin', cfg.upstream.repo], { cwd: cacheDir })
    run('git', ['fetch', 'origin', cfg.upstream.ref, '--depth', '1'], { cwd: cacheDir })
    run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: cacheDir })
  }

  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: cacheDir, capture: true }).trim()
  return { cacheDir, commit }
}

function shouldIgnoreUpstreamPath(relativePath) {
  const rel = toPosix(relativePath)
  if (!rel) return true
  if (rel === '.git' || rel.startsWith('.git/')) return true
  if (rel === 'node_modules' || rel.startsWith('node_modules/')) return true
  if (rel === 'dist' || rel.startsWith('dist/')) return true
  if (rel === 'dist-ssr' || rel.startsWith('dist-ssr/')) return true
  if (rel.endsWith('.log')) return true
  return false
}

function createPreserveMatcher(preservePaths) {
  const exact = preservePaths.map(toPosix).filter(Boolean)
  return (relativePath) => {
    const rel = toPosix(relativePath)
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
      if (entry.isDirectory()) {
        walk(absolutePath)
      } else if (entry.isFile()) {
        files.push(relativePath)
      }
    }
  }
  walk(rootDir)
  return files.sort()
}

function sameFile(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false
  const left = fs.readFileSync(a)
  const right = fs.readFileSync(b)
  return left.length === right.length && left.equals(right)
}

function copyFileAtomic(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, `${target}.tmp`)
  fs.renameSync(`${target}.tmp`, target)
}

function mergePackageJson(upstreamPackagePath, localPackagePath, dryRun) {
  if (!fs.existsSync(upstreamPackagePath) || !fs.existsSync(localPackagePath)) return { changed: false, skipped: false }

  const upstreamPackage = readJson(upstreamPackagePath, {})
  const localPackage = readJson(localPackagePath, {})
  const merged = {
    ...upstreamPackage,
    ...localPackage,
    scripts: {
      ...(upstreamPackage.scripts ?? {}),
      ...(localPackage.scripts ?? {}),
    },
    dependencies: {
      ...(localPackage.dependencies ?? {}),
      ...(upstreamPackage.dependencies ?? {}),
    },
    devDependencies: {
      ...(localPackage.devDependencies ?? {}),
      ...(upstreamPackage.devDependencies ?? {}),
    },
    overrides: {
      ...(upstreamPackage.overrides ?? {}),
      ...(localPackage.overrides ?? {}),
    },
  }

  merged.name = localPackage.name ?? 'taostudio-image-lab'
  merged.private = localPackage.private ?? true
  merged.version = localPackage.version ?? upstreamPackage.version

  const next = `${JSON.stringify(merged, null, 2)}\n`
  const current = fs.readFileSync(localPackagePath, 'utf8')
  if (next === current) return { changed: false, skipped: false }
  if (!dryRun) fs.writeFileSync(localPackagePath, next, 'utf8')
  return { changed: true, skipped: false }
}

function applyUpstreamFiles(cfg, upstreamDir, commit, dryRun) {
  const isPreserved = createPreserveMatcher(cfg.preservePaths)
  const upstreamFiles = listFiles(upstreamDir)
  const copied = []
  const changed = []
  const unchanged = []
  const skipped = []

  const packageResult = mergePackageJson(
    path.join(upstreamDir, 'package.json'),
    path.join(projectRoot, 'package.json'),
    dryRun,
  )
  if (packageResult.changed) changed.push('package.json')

  for (const rel of upstreamFiles) {
    if (rel === 'package.json' || rel === 'package-lock.json') {
      skipped.push(rel)
      continue
    }

    if (isPreserved(rel)) {
      skipped.push(rel)
      continue
    }

    const source = path.join(upstreamDir, rel)
    const target = path.join(projectRoot, rel)
    if (sameFile(source, target)) {
      unchanged.push(rel)
      continue
    }

    if (fs.existsSync(target)) changed.push(rel)
    else copied.push(rel)
    if (!dryRun) copyFileAtomic(source, target)
  }

  const report = {
    upstreamRepo: cfg.upstream.repo,
    upstreamRef: cfg.upstream.ref,
    upstreamCommit: commit,
    upgradedAt: new Date().toISOString(),
    dryRun,
    copied,
    changed,
    unchangedCount: unchanged.length,
    skipped,
  }

  if (!dryRun) {
    writeJson(path.join(projectRoot, cfg.stateFile), {
      upstreamRepo: cfg.upstream.repo,
      upstreamRef: cfg.upstream.ref,
      lastAppliedCommit: commit,
      upgradedAt: report.upgradedAt,
      notes: 'Updated by scripts/upgrade-upstream.mjs. Local TaoStudio UI overlay paths were preserved.',
    })
    writeReport(path.join(projectRoot, cfg.reportFile), report)
  }

  return report
}

function writeReport(filePath, report) {
  const renderList = (title, items) => [
    `## ${title}`,
    '',
    items.length ? items.slice(0, 200).map((item) => `- ${item}`).join('\n') : '- None',
    items.length > 200 ? `\n- ... ${items.length - 200} more` : '',
    '',
  ].join('\n')

  const body = [
    '# Upstream Upgrade Report',
    '',
    `- Upstream: ${report.upstreamRepo}`,
    `- Ref: ${report.upstreamRef}`,
    `- Commit: ${report.upstreamCommit}`,
    `- Upgraded at: ${report.upgradedAt}`,
    '',
    renderList('Copied files', report.copied),
    renderList('Changed files', report.changed),
    renderList('Preserved or skipped files', report.skipped),
    `Unchanged upstream files: ${report.unchangedCount}`,
    '',
  ].join('\n')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, body, 'utf8')
}

function printSummary(report) {
  console.log('')
  console.log('Upstream upgrade summary')
  console.log(`- upstream: ${report.upstreamRepo}`)
  console.log(`- ref: ${report.upstreamRef}`)
  console.log(`- commit: ${report.upstreamCommit}`)
  console.log(`- copied: ${report.copied.length}`)
  console.log(`- changed: ${report.changed.length}`)
  console.log(`- skipped/preserved: ${report.skipped.length}`)
  console.log(`- dry run: ${report.dryRun ? 'yes' : 'no'}`)
}

function printHelp() {
  console.log(`Usage:
  npm run upgrade:upstream -- [options]

Options:
  --dry-run        Fetch upstream and show what would change without editing files.
  --install        Run npm install after applying upstream files.
  --verify         Run npm run lint, npm run test, and npm run build after applying.
  --allow-dirty    Allow upgrading when git status is not clean.
  --repo <url>     Override upstream repository URL.
  --ref <ref>      Override upstream branch/ref. Default comes from upstream-upgrade.config.json.
`)
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp()
    return
  }

  const cfg = config()
  const dryRun = hasFlag('--dry-run')
  assertCleanWorktree()
  const { cacheDir, commit } = prepareUpstreamCheckout(cfg)
  const report = applyUpstreamFiles(cfg, cacheDir, commit, dryRun)
  printSummary(report)

  if (dryRun) return

  if (hasFlag('--install')) {
    run('npm', ['install'])
  }

  if (hasFlag('--verify')) {
    run('npm', ['run', 'lint'])
    run('npm', ['run', 'test'])
    run('npm', ['run', 'build'])
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
