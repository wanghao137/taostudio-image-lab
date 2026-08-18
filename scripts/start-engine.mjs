#!/usr/bin/env node
// TaoStudio Image Engine launcher with crash-restart and log rotation.
//
// Designed to be driven by a Windows Scheduled Task (logon trigger, hidden
// window). It supervises server/task-api/cli.mjs: if the engine exits for any
// reason other than a deliberate stop (SIGTERM/SIGINT forwarded from this
// supervisor), it restarts it after a short backoff. Logs are rotated to avoid
// unbounded growth.
//
// Usage:
//   node scripts/start-engine.mjs            # foreground, logs to console
//   node scripts/start-engine.mjs --daemon   # detach, logs to .local-task-api/engine.log
//
// All engine config is read from .env.local by cli.mjs itself; this launcher
// only adds supervision + logging and does not duplicate configuration.

import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const cliPath = resolve(repoRoot, 'server', 'task-api', 'cli.mjs')
const logDir = resolve(repoRoot, '.local-task-api')
const logPath = resolve(logDir, 'engine.log')
const MAX_LOG_BYTES = 5 * 1024 * 1024 // rotate at ~5 MB
const RESTART_BACKOFF_MS = 3000
const MAX_RESTARTS = 10
// Health probe: the engine can hang with its process alive (event loop
// blocked by a synchronous call) — TCP accepts but HTTP never responds.
// A process-exit watcher alone never fires in that state, so probe an
// unauthenticated 404 route on the listening port and force-kill the child
// after consecutive failures. 30s × 2 misses ≈ ≤1.5 min hang visibility.
const HEALTH_PROBE_INTERVAL_MS = 30_000
const HEALTH_PROBE_FAILURES = 2
const HEALTH_PORT = Number(process.env.IMAGE_TASK_API_PORT || 9789)

const daemon = process.argv.includes('--daemon')

function ensureLogDir() {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
}

function rotateLogIfNeeded() {
  try {
    if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) {
      renameSync(logPath, `${logPath}.1`)
    }
  } catch {
    // Rotation is best-effort; never block startup on it.
  }
}

function createLogStream() {
  ensureLogDir()
  rotateLogIfNeeded()
  return createWriteStream(logPath, { flags: 'a' })
}

const log = daemon ? createLogStream() : process.stdout
const err = daemon ? createLogStream() : process.stderr

function writeLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  log.write(`${stamped}\n`)
}

writeLog('=== TaoStudio Image Engine supervisor starting ===')

let restartCount = 0
let deliberate = false
let healthFailures = 0

function scheduleRestart(reason) {
  if (restartCount >= MAX_RESTARTS) {
    writeLog(`restart limit (${MAX_RESTARTS}) reached, giving up (${reason})`)
    process.exit(1)
  }
  restartCount += 1
  writeLog(`restarting in ${RESTART_BACKOFF_MS}ms (attempt ${restartCount}/${MAX_RESTARTS}; ${reason})`)
  setTimeout(startOnce, RESTART_BACKOFF_MS)
}

function startOnce() {
  const child = spawn(process.execPath, [cliPath], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  child.stdout.on('data', (chunk) => log.write(chunk))
  child.stderr.on('data', (chunk) => err.write(chunk))

  writeLog(`engine child spawned (pid ${child.pid})`)

  child.on('exit', (code, signal) => {
    writeLog(`engine child exited code=${code} signal=${signal}`)
    if (deliberate) {
      writeLog('deliberate stop requested, supervisor exiting')
      process.exit(0)
    }
    scheduleRestart(`exit code=${code} signal=${signal}`)
  })

  child.on('error', (error) => {
    writeLog(`engine child error: ${error.message}`)
  })

  return child
}

let current = startOnce()

// Hang self-healing: probe an unknown path; a healthy engine answers quickly
// (401/404), a hung one never answers. Two consecutive misses → force kill;
// the exit handler restarts it.
async function probeHealth() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    await fetch(`http://127.0.0.1:${HEALTH_PORT}/v1/health-probe`, { signal: controller.signal })
    // Any HTTP response (401/404 included) proves the event loop is alive.
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
setInterval(() => {
  if (deliberate || current.killed) return
  void probeHealth().then((alive) => {
    if (alive) {
      healthFailures = 0
      return
    }
    healthFailures += 1
    writeLog(`health probe miss ${healthFailures}/${HEALTH_PROBE_FAILURES} (pid ${current.pid})`)
    if (healthFailures >= HEALTH_PROBE_FAILURES) {
      healthFailures = 0
      writeLog(`engine unresponsive, force-killing pid ${current.pid} for restart`)
      current.kill('SIGKILL')
    }
  })
}, HEALTH_PROBE_INTERVAL_MS)

const shutdown = (signal) => {
  writeLog(`supervisor received ${signal}, stopping engine`)
  deliberate = true
  if (current && !current.killed) {
    current.kill(signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT')
  }
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
