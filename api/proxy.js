const TARGET_HEADER = 'x-taostudio-api-base-url'
const PROXY_TOKEN_HEADER = 'x-taostudio-proxy-token'
const DEFAULT_ALLOWED_ORIGIN_HOSTS = ['image.taostudioai.com']
// 开发服务器 host:true，LAN/IPv6 localhost 源也应放行（任意端口）。
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const DEFAULT_PROXY_TIMEOUT_MS = 600_000
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
  maxDuration: 300,
}

function env(name) {
  return process.env[name]?.trim() ?? ''
}

function normalizeBaseUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return ''

  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  const url = new URL(input)
  const segments = url.pathname.split('/').filter(Boolean)
  const v1Index = segments.indexOf('v1')
  const normalizedSegments = v1Index >= 0
    ? segments.slice(0, v1Index + 1)
    : segments.length
      ? [...segments, 'v1']
      : ['v1']
  url.pathname = `/${normalizedSegments.join('/')}`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function splitHeaderList(value) {
  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function getAllowedHosts(defaultTargetUrl) {
  const configured = env('IMAGE_API_PROXY_ALLOWED_HOSTS') || env('API_PROXY_ALLOWED_HOSTS')
  const hosts = new Set(splitHeaderList(configured))
  if (defaultTargetUrl) hosts.add(defaultTargetUrl.hostname.toLowerCase())
  return hosts
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

function getProxyToken() {
  return env('IMAGE_API_PROXY_TOKEN') || env('API_PROXY_TOKEN')
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// Mirrors the Worker: when IMAGE_API_PROXY_TOKEN is configured, every request
// (except CORS preflights) must present a matching token; without a configured
// token the proxy relays with the caller's own credentials only.
function checkProxyToken(request) {
  const expected = getProxyToken()
  if (!expected) return { tokenAuthEnabled: false, authorized: true }
  const presented = getHeaderValue(request, PROXY_TOKEN_HEADER).trim()
  return { tokenAuthEnabled: true, authorized: timingSafeEqual(presented, expected) }
}

function normalizeHostname(hostname) {
  return hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet, index) => !/^\d+$/.test(parts[index]) || !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [a, b] = octets
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
}

function isPrivateIpv6(hostname) {
  const normalized = normalizeHostname(hostname)
  return normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:192.168.')
}

function isPrivateOrLocalHostname(hostname) {
  const normalized = normalizeHostname(hostname)
  return normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    isPrivateIpv4(normalized) ||
    isPrivateIpv6(normalized)
}

function getDynamicTargetErrorMessage(targetUrl, defaultTargetUrl) {
  const allowedHosts = getAllowedHosts(defaultTargetUrl)
  const hostname = targetUrl.hostname.toLowerCase()

  if (isPrivateOrLocalHostname(hostname)) {
    return 'API proxy target host is local or private. Use a public HTTPS API base URL, or run the app locally to reach a local service.'
  }

  // 所有动态目标（含白名单主机）一律要求 HTTPS：白名单只放宽主机名，
  // 不放宽协议——http 会让注入的凭证明文过网。
  if (targetUrl.protocol !== 'https:') {
    return 'API proxy dynamic targets must use HTTPS.'
  }

  if (!allowedHosts.has(hostname)) {
    const allowPublicTargets = isTruthy(env('IMAGE_API_PROXY_ALLOW_PUBLIC_TARGETS'))
    const allowDynamicTargets = isTruthy(env('IMAGE_API_PROXY_ALLOW_DYNAMIC_TARGETS'))
    if (!allowPublicTargets && !allowDynamicTargets) {
      return 'API proxy target host is not allowed.'
    }
  }

  return ''
}

function resolveTargetUrl(request) {
  const defaultTarget = env('IMAGE_API_PROXY_TARGET') || env('API_PROXY_TARGET')
  const defaultTargetUrl = defaultTarget ? new URL(normalizeBaseUrl(defaultTarget)) : null
  const requestedTarget = String(request.headers[TARGET_HEADER] ?? '').trim()
  const rawTarget = requestedTarget || defaultTarget

  if (!rawTarget) {
    return {
      errorStatus: 503,
      errorMessage: 'API proxy target is not configured.',
    }
  }

  let targetUrl
  try {
    targetUrl = new URL(normalizeBaseUrl(rawTarget))
  } catch {
    return {
      errorStatus: 400,
      errorMessage: 'API proxy target is invalid.',
    }
  }

  const dynamicTargetErrorMessage = requestedTarget ? getDynamicTargetErrorMessage(targetUrl, defaultTargetUrl) : ''
  if (dynamicTargetErrorMessage) {
    return {
      errorStatus: 403,
      errorMessage: dynamicTargetErrorMessage,
    }
  }

  return { targetUrl }
}

function normalizeRoutePath(value) {
  if (Array.isArray(value)) return value.join('/')
  if (typeof value !== 'string') return ''
  return value
}

function getRoutePath(request) {
  const requestUrl = new URL(request.url ?? '/', `https://${request.headers.host ?? 'localhost'}`)
  return requestUrl.searchParams.get('path') || normalizeRoutePath(request.query?.path)
}

function buildUpstreamUrl(targetUrl, routePath, request) {
  const routeSegments = routePath.split('/').filter(Boolean)
  const targetPath = targetUrl.pathname.replace(/\/+$/, '')
  const suffixSegments = targetPath.endsWith('/v1') && routeSegments[0] === 'v1'
    ? routeSegments.slice(1)
    : routeSegments

  const upstreamUrl = new URL(targetUrl.toString())
  upstreamUrl.pathname = suffixSegments.length
    ? `${targetPath}/${suffixSegments.join('/')}`.replace(/\/{2,}/g, '/')
    : targetPath || '/'

  const requestUrl = new URL(request.url ?? '/', `https://${request.headers.host ?? 'localhost'}`)
  requestUrl.searchParams.delete('path')
  upstreamUrl.search = requestUrl.searchParams.toString()
  return upstreamUrl
}

function setCorsHeaders(request, response) {
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    'authorization,content-type,accept,x-taostudio-api-base-url,x-taostudio-proxy-token',
  )
  response.setHeader('Access-Control-Max-Age', '86400')
  response.setHeader('Vary', 'Origin')

  // Reflect only explicitly allowed origins instead of echoing any Origin.
  const allowedHosts = new Set([
    ...DEFAULT_ALLOWED_ORIGIN_HOSTS,
    ...splitHeaderList(env('IMAGE_API_PROXY_ALLOWED_ORIGINS')).map((origin) => origin.replace(/^https?:\/\//, '')),
  ])
  const origin = String(request.headers.origin ?? '').trim().toLowerCase()
  if (!origin) return
  let originHost = ''
  try {
    originHost = new URL(origin).hostname.toLowerCase()
  } catch {
    return
  }
  if (allowedHosts.has(originHost) || LOCAL_ORIGIN_PATTERN.test(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin)
  }
}

function writeJson(response, statusCode, payload) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(payload))
}

function getHeaderValue(request, name) {
  const value = request.headers[name]
  if (Array.isArray(value)) return value.find(Boolean) ?? ''
  return typeof value === 'string' ? value : ''
}

function createForwardHeaders(request, body, contentTypeOverride, canInjectCredentials) {
  const headers = new Headers()

  const authorization = getHeaderValue(request, 'authorization').trim()
  const proxyAuthorization = env('IMAGE_API_PROXY_AUTHORIZATION') || env('API_PROXY_AUTHORIZATION')
  const proxyApiKey = env('IMAGE_API_PROXY_API_KEY') || env('API_PROXY_API_KEY')
  // Server-held credentials are only injected for token-authenticated callers;
  // an open proxy must never attach the owner's key to anonymous traffic.
  const fallbackAuthorization = canInjectCredentials
    ? (proxyAuthorization || (proxyApiKey ? `Bearer ${proxyApiKey}` : ''))
    : ''
  const resolvedAuthorization = (!authorization || authorization === 'Bearer') ? fallbackAuthorization : authorization
  if (resolvedAuthorization) headers.set('authorization', resolvedAuthorization)

  const contentType = contentTypeOverride || getHeaderValue(request, 'content-type').trim()
  if (contentType) headers.set('content-type', contentType)
  const accept = getHeaderValue(request, 'accept').trim()
  if (accept) headers.set('accept', accept)
  if (body) headers.set('content-length', String(body.length))

  return headers
}

async function readRawRequestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined

  const chunks = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return chunks.length ? Buffer.concat(chunks) : undefined
}

async function readRequestBody(request) {
  const body = await readRawRequestBody(request)
  const contentType = getHeaderValue(request, 'content-type').toLowerCase()
  if (!body || !contentType.includes('application/json')) return { body, contentTypeOverride: '' }

  try {
    const normalizedJson = JSON.stringify(JSON.parse(body.toString('utf8')))
    return {
      body: Buffer.from(normalizedJson, 'utf8'),
      contentTypeOverride: 'application/json',
    }
  } catch {
    return { body, contentTypeOverride: '' }
  }
}

function copyResponseHeaders(upstreamResponse, response) {
  upstreamResponse.headers.forEach((value, name) => {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName)) return
    if (lowerName === 'content-encoding') return
    // CORS 由本代理的 allowlist 决定，上游不得覆盖（否则可注入任意 Origin 放行）。
    if (lowerName.startsWith('access-control-')) return
    response.setHeader(name, value)
  })
  response.setHeader('Cache-Control', 'no-store')
}

async function sendUpstreamResponse(upstreamResponse, response, diagnostics) {
  response.statusCode = upstreamResponse.status
  copyResponseHeaders(upstreamResponse, response)
  response.setHeader('X-TaoStudio-Proxy-Path', diagnostics.path)
  response.setHeader('X-TaoStudio-Proxy-Body-Bytes', String(diagnostics.bodyBytes))
  response.setHeader('X-TaoStudio-Proxy-Content-Type', diagnostics.contentType || 'none')

  const bytes = Buffer.from(await upstreamResponse.arrayBuffer())
  response.setHeader('Content-Length', String(bytes.length))
  response.end(bytes)
}

export default async function handler(request, response) {
  setCorsHeaders(request, response)

  if (request.method === 'OPTIONS') {
    response.statusCode = 204
    response.end()
    return
  }

  const { tokenAuthEnabled, authorized } = checkProxyToken(request)
  if (!authorized) {
    writeJson(response, 401, {
      error: {
        message: 'API proxy token is missing or invalid.',
      },
    })
    return
  }

  const target = resolveTargetUrl(request)
  if (target.errorStatus) {
    writeJson(response, target.errorStatus, {
      error: {
        message: target.errorMessage,
      },
    })
    return
  }

  const upstreamUrl = buildUpstreamUrl(target.targetUrl, getRoutePath(request), request)
  const controller = new AbortController()
  const timeoutMs = Number(env('IMAGE_API_PROXY_TIMEOUT_MS')) || DEFAULT_PROXY_TIMEOUT_MS
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const { body, contentTypeOverride } = await readRequestBody(request)
    const forwardHeaders = createForwardHeaders(request, body, contentTypeOverride, tokenAuthEnabled && authorized)
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: forwardHeaders,
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
    await sendUpstreamResponse(upstreamResponse, response, {
      path: upstreamUrl.pathname,
      bodyBytes: body?.length ?? 0,
      contentType: forwardHeaders.get('content-type') ?? '',
    })
  } catch (error) {
    if (!response.headersSent) {
      writeJson(response, 502, {
        error: {
          message: error instanceof Error ? error.message : 'API proxy request failed.',
        },
      })
    } else {
      response.destroy(error)
    }
  } finally {
    clearTimeout(timeout)
  }
}
