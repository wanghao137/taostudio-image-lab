import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_BASE_URL = 'https://www.ydn99.com'
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_SIZE = '1024x1024'
const DEFAULT_TIMEOUT_MS = 600_000
const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {}

  const env = {}
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function getConfigValue(dotEnv, key, fallback = '') {
  return process.env[key]?.trim() || dotEnv[key]?.trim() || fallback
}

function getBooleanConfigValue(dotEnv, key, fallback = false) {
  const value = getConfigValue(dotEnv, key, String(fallback)).toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function normalizeBaseUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_BASE_URL
  return /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

function buildEndpoint(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl)
  return normalized.endsWith('/v1')
    ? `${normalized}/images/generations`
    : `${normalized}/v1/images/generations`
}

async function readErrorMessage(response) {
  const text = await response.text().catch(() => '')
  if (!text) return `HTTP ${response.status}`

  try {
    const json = JSON.parse(text)
    return json?.error?.message || json?.message || json?.detail || `HTTP ${response.status}`
  } catch {
    return text.slice(0, 500)
  }
}

function extractImages(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : []
  const images = []

  for (const item of data) {
    if (typeof item?.b64_json === 'string' && item.b64_json.trim()) {
      images.push({ kind: 'b64', value: item.b64_json.trim() })
    } else if (typeof item?.url === 'string' && item.url.trim()) {
      images.push({ kind: 'url', value: item.url.trim() })
    }
  }

  return images
}

async function materializeImage(image, index, outputDir) {
  if (image.kind === 'b64') {
    const bytes = Buffer.from(image.value, 'base64')
    const outputPath = path.join(outputDir, `ydn-smoke-${Date.now()}-${index + 1}.png`)
    fs.writeFileSync(outputPath, bytes)
    return { path: outputPath, bytes: bytes.length }
  }

  const response = await fetch(image.value)
  if (!response.ok) throw new Error(`Image URL fetch failed with HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const outputPath = path.join(outputDir, `ydn-smoke-${Date.now()}-${index + 1}.png`)
  fs.writeFileSync(outputPath, bytes)
  return { path: outputPath, bytes: bytes.length }
}

const dotEnv = readDotEnv(path.join(process.cwd(), '.env.local'))
const apiKey = getConfigValue(dotEnv, 'YDN_API_KEY')

if (!apiKey) {
  console.error('Missing YDN_API_KEY. Add it to ignored .env.local or set it only for this shell session.')
  process.exit(2)
}

const baseUrl = getConfigValue(dotEnv, 'YDN_API_BASE_URL', DEFAULT_BASE_URL)
const model = getConfigValue(dotEnv, 'YDN_IMAGE_MODEL', DEFAULT_MODEL)
const size = getConfigValue(dotEnv, 'YDN_TEST_SIZE', DEFAULT_SIZE)
const prompt = getConfigValue(dotEnv, 'YDN_TEST_PROMPT', 'A simple clean TaoStudio smoke test image with geometric shapes.')
const codexCli = getBooleanConfigValue(dotEnv, 'YDN_TEST_CODEX_CLI', true)
const moderation = getConfigValue(dotEnv, 'YDN_TEST_MODERATION', 'auto')
const timeoutMs = Number(getConfigValue(dotEnv, 'YDN_TEST_TIMEOUT_MS', String(DEFAULT_TIMEOUT_MS))) || DEFAULT_TIMEOUT_MS
const endpoint = buildEndpoint(baseUrl)
const startedAt = Date.now()
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), timeoutMs)

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt: codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}` : prompt,
      size,
      output_format: 'png',
      moderation,
    }),
    signal: controller.signal,
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  const payload = await response.json()
  const images = extractImages(payload)
  if (!images.length) {
    throw new Error('YDN response did not contain data[].b64_json or data[].url image output.')
  }

  const outputDir = path.join(process.cwd(), '.omx', 'ydn-smoke')
  fs.mkdirSync(outputDir, { recursive: true })
  const savedFiles = []
  for (let index = 0; index < images.length; index += 1) {
    savedFiles.push(await materializeImage(images[index], index, outputDir))
  }

  console.log(JSON.stringify({
    ok: true,
    endpoint,
    model,
    size,
    codexCli,
    moderation,
    elapsedMs: Date.now() - startedAt,
    imageCount: images.length,
    savedFiles,
  }, null, 2))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({
    ok: false,
    endpoint,
    model,
    size,
    codexCli,
    moderation,
    elapsedMs: Date.now() - startedAt,
    error: message,
  }, null, 2))
  process.exit(1)
} finally {
  clearTimeout(timeout)
}
