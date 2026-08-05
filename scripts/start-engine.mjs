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
    if (restartCount >= MAX_RESTARTS) {
      writeLog(`restart limit (${MAX_RESTARTS}) reached, giving up`)
      process.exit(1)
    }
    restartCount += 1
    writeLog(`restarting in ${RESTART_BACKOFF_MS}ms (attempt ${restartCount}/${MAX_RESTARTS})`)
    setTimeout(startOnce, RESTART_BACKOFF_MS)
  })

  child.on('error', (error) => {
    writeLog(`engine child error: ${error.message}`)
  })

  return child
}

let current = startOnce()

const shutdown = (signal) => {
  writeLog(`supervisor received ${signal}, stopping engine`)
  deliberate = true
  if (current && !current.killed) {
    current.kill(signal === 'SIGTERM' ? 'SIGTERM' : 'SIGINT')
  }
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
