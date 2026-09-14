/**
 * Production 4K v2 — ImageMagick Sidecar Executor
 *
 * 通过 pinned sidecar（tools/imagemagick/magick.exe，7z 便携版，版本与 SHA-256
 * 见 tools/imagemagick/VERSION.md）执行 EWA distort Resize。安全要求：
 * - 永远 spawn(executable, args, { shell: false })，参数全部来自固定枚举与
 *   本模块生成的临时文件路径，任何用户字符串不进入命令行；
 * - 输入文件只可能是本引擎自己写出的 PNG（调用方已用 sharp 校验格式/尺寸）；
 * - 资源限制（memory/map/disk/time/width/height/area）显式下发给子进程；
 * - 超时与 AbortSignal 都会 kill 子进程并清理临时目录。
 */

import { spawn } from 'node:child_process'
import { access, constants, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RESAMPLER_DIR = fileURLToPath(new URL('.', import.meta.url))
/** 仓库根：server/task-api/resampler → 上三级 */
const REPO_ROOT = join(RESAMPLER_DIR, '..', '..', '..')
const SIDECAR_CANDIDATES = [
  join(REPO_ROOT, 'tools', 'imagemagick', 'magick.exe'),
  join(REPO_ROOT, 'tools', 'imagemagick', 'magick'),
]

const VERSION_TIMEOUT_MS = 10_000
export const RESIZE_TIMEOUT_DEFAULT_MS = 180_000

/** 显式禁用 sidecar 的环境值 */
function isDisabledEnvValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '' || ['0', 'false', 'off', 'none', 'disabled'].includes(normalized)
}

function runVersionProbe(executable) {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(executable, ['-version'], { shell: false, windowsHide: true })
    let stdout = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already dead */ }
      finish(null)
    }, VERSION_TIMEOUT_MS)
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.on('error', () => {
      clearTimeout(timeout)
      finish(null)
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (code !== 0) return finish(null)
      const version = stdout.split('\n').find((line) => line.includes('Version:'))?.trim() ?? 'unknown'
      finish({ executable, version })
    })
  })
}

let detectionPromise = null

/**
 * 解析可用的 ImageMagick 可执行文件（结果缓存）：
 * 1. 环境变量 TAOSTUDIO_IMAGE_MAGICK（显式路径；'0'/'off' 禁用）；
 * 2. 仓库内 pinned sidecar（tools/imagemagick/magick.exe）；
 * 3. PATH 中的 magick（开发机兜底，版本未 pin，transform 会如实记录）。
 * 返回 { executable, version, source } 或 null（不可用）。
 */
export function resolveImageMagick(force = false) {
  if (force) detectionPromise = null
  if (!detectionPromise) {
    detectionPromise = (async () => {
      const envPath = process.env.TAOSTUDIO_IMAGE_MAGICK
      if (envPath !== undefined) {
        if (isDisabledEnvValue(envPath)) return null
        return runVersionProbe(envPath)
      }
      for (const candidate of SIDECAR_CANDIDATES) {
        try {
          await access(candidate, constants.X_OK)
        } catch {
          continue
        }
        const probed = await runVersionProbe(candidate)
        if (probed) return { ...probed, source: 'pinned-sidecar' }
      }
      const probed = await runVersionProbe('magick')
      return probed ? { ...probed, source: 'path' } : null
    })()
  }
  return detectionPromise
}

/** 仅供测试：清空探测缓存（下次调用重新探测） */
export function resetImageMagickDetectionCache() {
  detectionPromise = null
}

/** 在 baseDir（缺省系统 tmp）下创建一次性重采样临时目录 */
export async function createResamplerTempDir(baseDir) {
  const root = baseDir && String(baseDir).trim() ? baseDir : tmpdir()
  await mkdir(root, { recursive: true })
  return mkdtemp(join(root, 'resample-'))
}

/**
 * 执行 EWA distort Resize。
 * 输入输出都由调用方准备/校验；本函数只负责安全地跑子进程。
 */
export function runImageMagickEwaResize(options) {
  const {
    executable,
    inputPath,
    outputPath,
    targetWidth,
    targetHeight,
    filter,
    crop = null,
    timeoutMs = RESIZE_TIMEOUT_DEFAULT_MS,
    signal = null,
  } = options
  const args = [
    '-limit', 'memory', '512MiB',
    '-limit', 'map', '1GiB',
    '-limit', 'disk', '4GiB',
    '-limit', 'time', '240',
    '-limit', 'width', '8192',
    '-limit', 'height', '8192',
    '-limit', 'area', '100MP',
    inputPath,
    // 字节级可复现：剥掉 PNG 属性/注释块（IM 默认会写日期等非确定性元数据；
    // 实测 -strip 后同输入 3 跑 sha256 完全一致）。引擎资产统一 sRGB 语义，
    // 不携带 ICC（与 sharp 路径输出一致）。
    '-strip',
  ]
  if (crop) {
    args.push('-crop', `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, '+repage')
  }
  args.push(
    '-filter', filter,
    // '!' 强制精确输出几何：cover 裁切的整数近似可能带来亚像素比例残差，
    // 保比例 best-fit 会因此差 1px；强制几何 + 输出侧尺寸断言双保险。
    '-distort', 'Resize', `${targetWidth}x${targetHeight}!`,
    '-depth', '8',
    `PNG64:${outputPath}`,
  )

  return new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(executable, args, { shell: false, windowsHide: true })
    const stderrChunks = []
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      if (error) {
        try { child.kill('SIGKILL') } catch { /* already dead */ }
        reject(error)
      } else {
        resolve(result)
      }
    }
    const timeout = setTimeout(() => {
      finish(Object.assign(new Error('imagemagick resize timeout'), { code: 'IMAGEMAGICK_TIMEOUT' }))
    }, timeoutMs)
    function onAbort() {
      finish(Object.assign(new Error('imagemagick resize aborted'), { code: 'IMAGEMAGICK_ABORTED' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // magick 文件到文件模式不写 stdout，但必须排空管道：异常输出超过 OS 管道
    // 缓冲（~64KB）会让子进程写阻塞，白等 JS 侧超时（对抗审查 P2-4）。
    child.stdout?.resume()
    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(chunk)
      if (stderrChunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
        finish(Object.assign(new Error('imagemagick stderr overflow'), { code: 'IMAGEMAGICK_OUTPUT_LIMIT' }))
      }
    })
    child.on('error', (error) => finish(Object.assign(error, { code: 'IMAGEMAGICK_SPAWN_FAILED' })))
    child.on('close', (code) => {
      if (code === 0) return finish(null, { ok: true })
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, 800)
      finish(Object.assign(new Error(`imagemagick exited with ${code}: ${stderr || 'no stderr'}`), { code: 'IMAGEMAGICK_EXIT_NONZERO' }))
    })
  })
}

export async function removeTempDir(tempDir) {
  if (!tempDir) return
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
}
