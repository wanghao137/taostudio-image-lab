// Headless image-generation client. Mirrors the request contract used by the
// production UI (src/lib/openaiCompatibleImageApi.ts) so headless requests are
// byte-for-byte aligned with what the app would send.
//
// Two modes are supported, matching the app's apiMode toggle:
//   - images:   POST {base}/v1/images/generations
//   - responses: POST {base}/v1/responses  (tools:[image_generation], tool_choice:required)
//
// Browser-only concerns (FormData edits, Canvas, streaming, refusal-recovery,
// dev proxy) are intentionally NOT mirrored here. This MVP does pure
// text-to-image generation with no input images.

const PROMPT_REWRITE_GUARD_PREFIX = 'Use the following text as the complete prompt. Do not rewrite it:'

export function buildApiUrl(baseUrl, path) {
  // Mirrors devProxy.buildApiUrl() for the direct (no-proxy) case.
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '')
  const endpointPath = path.replace(/^\/+/, '')
  const apiPath = normalizedBaseUrl.endsWith('/v1') ? endpointPath : ['v1', endpointPath].join('/')
  return normalizedBaseUrl ? `${normalizedBaseUrl}/${apiPath}` : `/${apiPath}`
}

function normalizeBase64Image(value, fallbackMime) {
  return value.startsWith('data:') ? value : `data:${fallbackMime};base64,${value}`
}

function pickActualParams(source) {
  if (!source || typeof source !== 'object') return {}
  const record = source
  const actualParams = {}
  if (typeof record.size === 'string') actualParams.size = record.size
  if (record.quality === 'auto' || record.quality === 'low' || record.quality === 'medium' || record.quality === 'high') {
    actualParams.quality = record.quality
  }
  if (record.output_format === 'png' || record.output_format === 'jpeg' || record.output_format === 'webp') {
    actualParams.output_format = record.output_format
  }
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n
  return actualParams
}

function mergeActualParams(...sources) {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}
function isDataUrl(value) {
  return typeof value === 'string' && value.startsWith('data:')
}

async function readJsonOrFail(response) {
  // Some gateways answer 4K/high requests with HTTP 200 + Content-Type: application/json
  // but an HTML body (a fallback page). Detect that and fail loudly instead of
  // crashing later with an opaque JSON parse error.
  const text = await response.text()
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<')) {
    throw new Error(`Provider returned HTML (not JSON) with status ${response.status}. First 200 chars: ${trimmed.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Provider response was not valid JSON (status ${response.status}). First 200 chars: ${text.slice(0, 200)}`)
  }
}

async function getApiErrorMessage(response) {
  let errorMsg = `HTTP ${response.status}`
  const textResponse = response.clone()
  try {
    const errJson = await response.json()
    if (errJson.error?.message) errorMsg = errJson.error.message
    else if (errJson.error?.code) errorMsg = errJson.error.code
    else if (typeof errJson.detail === 'string') errorMsg = errJson.detail
    else if (Array.isArray(errJson.detail)) errorMsg = errJson.detail.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n')
    else if (typeof errJson.error === 'string') errorMsg = errJson.error
    else if (errJson.message) errorMsg = errJson.message
  } catch {
    try {
      errorMsg = await textResponse.text()
    } catch {
      /* ignore */
    }
  }
  return errorMsg
}

// ---- images mode (mirrors callImagesApiSingle sendRequest, else-branch) ----

export function buildImagesPayload({ prompt, params, profile }) {
  const body = {
    model: profile.model,
    prompt,
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }
  if (!profile.codexCli) body.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) body.output_compression = params.output_compression
  if (params.n > 1) body.n = params.n
  if (profile.responseFormatB64Json) body.response_format = 'b64_json'
  return body
}

function parseImagesResponse(payload, mime) {
  const data = payload.data
  if (!Array.isArray(data) || !data.length) {
    const err = new Error('接口没有返回图片数据')
    err.rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }
  const images = []
  const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
  const revisedPrompts = []
  for (const item of data) {
    const b64 = item.b64_json
    if (b64) {
      images.push(normalizeBase64Image(b64, mime))
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      continue
    }
    if (isHttpUrl(item.url) || isDataUrl(item.url)) {
      // Headless probe: we don't fetch remote URLs. Record them for reporting.
      images.push(item.url)
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
    }
  }
  if (!images.length) {
    const err = new Error('接口没有返回可识别的图片数据')
    err.rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }
  const actualParams = mergeActualParams(pickActualParams(payload))
  return { images, actualParams, actualParamsList: images.map(() => actualParams), revisedPrompts, rawImageUrls }
}

// ---- responses mode (mirrors createResponsesInput + createResponsesImageTool) ----

export function buildResponsesPayload({ prompt, params, profile }) {
  // codexCli is always false in this MVP, so the guard prefix is never added.
  const input = profile.codexCli ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}` : prompt
  const tool = {
    type: 'image_generation',
    action: 'generate',
    size: params.size,
    output_format: params.output_format,
    moderation: params.moderation,
  }
  if (profile.streamImages) tool.partial_images = profile.streamPartialImages ?? 0
  if (!profile.codexCli) tool.quality = params.quality
  if (params.output_format !== 'png' && params.output_compression != null) tool.output_compression = params.output_compression
  return { model: profile.model, input, tools: [tool], tool_choice: 'required' }
}

function getResponsesImageResultBase64(result) {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object') {
    if (typeof result.b64_json === 'string') return result.b64_json
    if (typeof result.url === 'string') return result.url // not base64; recorded as-is
  }
  return undefined
}

function parseResponsesResponse(payload, fallbackMime) {
  const output = payload.output
  if (!Array.isArray(output) || !output.length) {
    const err = new Error('接口未返回图片数据')
    err.rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }
  const results = []
  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue
    const b64 = getResponsesImageResultBase64(item.result)
    if (b64) {
      results.push({
        image: normalizeBase64Image(b64, fallbackMime),
        actualParams: mergeActualParams(pickActualParams(item)),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
    }
  }
  if (!results.length) {
    const err = new Error('接口没有返回可识别的图片数据')
    err.rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }
  return results
}

// ---- public API ----

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The gateway intermittently returns an HTML fallback page (HTTP 200 + HTML
// body) for 4K/high requests, especially in a cooldown window right after a
// long request. Treat that and transient errors as retryable.
function isRetryableError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /returned HTML|not valid JSON|terminated|ECONNRESET|ETIMEDOUT|fetch failed|network| aborted/i.test(message)
}

async function withRetry(label, fn, { maxRetries = 3, baseDelayMs = 15_000 } = {}) {
  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      const retryable = isRetryableError(error)
      console.log(JSON.stringify({ event: 'retry_eval', label, attempt, retryable, error: (error instanceof Error ? error.message : String(error)).slice(0, 160) }))
      if (!retryable || attempt === maxRetries) throw error
      const delay = baseDelayMs * attempt
      await sleep(delay)
    }
  }
  throw lastError
}

export async function generateImages({ prompt, params, profile, timeoutSeconds = 600, maxRetries = 3 }) {
  const mime = params.output_format === 'jpeg' ? 'image/jpeg' : params.output_format === 'webp' ? 'image/webp' : 'image/png'
  const body = buildImagesPayload({ prompt, params, profile })
  return withRetry('images', async () => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  let response
  try {
    response = await fetch(buildApiUrl(profile.baseUrl, 'images/generations'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
  if (!response.ok) throw new Error(await getApiErrorMessage(response))
  const payload = await readJsonOrFail(response)
  return { requestBody: body, parsed: parseImagesResponse(payload, mime), rawResponse: payload }
  }, { maxRetries })
}

export async function generateResponses({ prompt, params, profile, timeoutSeconds = 600, maxRetries = 3 }) {
  const mime = params.output_format === 'jpeg' ? 'image/jpeg' : params.output_format === 'webp' ? 'image/webp' : 'image/png'
  const body = buildResponsesPayload({ prompt, params, profile })
  return withRetry('responses', async () => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000)
  let response
  try {
    response = await fetch(buildApiUrl(profile.baseUrl, 'responses'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
  if (!response.ok) throw new Error(await getApiErrorMessage(response))
  const payload = await readJsonOrFail(response)
  const results = parseResponsesResponse(payload, mime)
  return {
    requestBody: body,
    parsed: {
      images: results.map((r) => r.image),
      actualParams: mergeActualParams(results[0]?.actualParams ?? {}),
      actualParamsList: results.map((r) => mergeActualParams(r.actualParams ?? {})),
      revisedPrompts: results.map((r) => r.revisedPrompt),
    },
    rawResponse: payload,
  }
  }, { maxRetries })
}
