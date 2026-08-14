const TARGET_HEADER = 'x-taostudio-api-base-url'
const PROXY_TOKEN_HEADER = 'x-taostudio-proxy-token'
const DEFAULT_ALLOWED_ORIGIN_HOSTS = ['image.taostudioai.com']
// 开发服务器 host:true，LAN/IPv6 localhost 源也应放行（任意端口）。
const LOCAL_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

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

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function getAllowedHosts(env, defaultTargetUrl) {
  const hosts = new Set(splitList(env.IMAGE_API_PROXY_ALLOWED_HOSTS || env.API_PROXY_ALLOWED_HOSTS))
  if (defaultTargetUrl) hosts.add(defaultTargetUrl.hostname.toLowerCase())
  return hosts
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase())
}

function getProxyToken(env) {
  return String(env.IMAGE_API_PROXY_TOKEN || env.API_PROXY_TOKEN || '').trim()
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// Token auth is opt-in: when IMAGE_API_PROXY_TOKEN is configured every request
// (except CORS preflights) must present a matching x-taostudio-proxy-token
// header. Without a configured token the proxy stays open for relay use, but
// server-side credential injection stays disabled (see createForwardHeaders).
function checkProxyToken(request, env) {
  const expected = getProxyToken(env)
  if (!expected) return { tokenAuthEnabled: false, authorized: true }
  const presented = String(request.headers.get(PROXY_TOKEN_HEADER) ?? '').trim()
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

function getDynamicTargetErrorMessage(targetUrl, env, defaultTargetUrl) {
  const allowedHosts = getAllowedHosts(env, defaultTargetUrl)
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
    const allowPublicTargets = isTruthy(env.IMAGE_API_PROXY_ALLOW_PUBLIC_TARGETS)
    const allowDynamicTargets = isTruthy(env.IMAGE_API_PROXY_ALLOW_DYNAMIC_TARGETS)
    if (!allowPublicTargets && !allowDynamicTargets) {
      return 'API proxy target host is not allowed.'
    }
  }

  return ''
}

function resolveTargetUrl(request, env) {
  const defaultTarget = env.IMAGE_API_PROXY_TARGET || env.API_PROXY_TARGET || ''
  const defaultTargetUrl = defaultTarget ? new URL(normalizeBaseUrl(defaultTarget)) : null
  const requestedTarget = request.headers.get(TARGET_HEADER)?.trim() || ''
  const rawTarget = requestedTarget || defaultTarget

  if (!rawTarget) {
    return { errorStatus: 503, errorMessage: 'API proxy target is not configured.' }
  }

  let targetUrl
  try {
    targetUrl = new URL(normalizeBaseUrl(rawTarget))
  } catch {
    return { errorStatus: 400, errorMessage: 'API proxy target is invalid.' }
  }

  const dynamicTargetErrorMessage = requestedTarget ? getDynamicTargetErrorMessage(targetUrl, env, defaultTargetUrl) : ''
  if (dynamicTargetErrorMessage) {
    return { errorStatus: 403, errorMessage: dynamicTargetErrorMessage }
  }

  return { targetUrl }
}

function getRoutePath(requestUrl) {
  const queryPath = requestUrl.searchParams.get('path') || ''
  if (queryPath) return queryPath
  return requestUrl.pathname.replace(/^\/api-proxy\/?/, '')
}

function buildUpstreamUrl(targetUrl, routePath, requestUrl) {
  const routeSegments = routePath.split('/').filter(Boolean)
  const targetPath = targetUrl.pathname.replace(/\/+$/, '')
  const suffixSegments = targetPath.endsWith('/v1') && routeSegments[0] === 'v1'
    ? routeSegments.slice(1)
    : routeSegments

  const upstreamUrl = new URL(targetUrl.toString())
  upstreamUrl.pathname = suffixSegments.length
    ? `${targetPath}/${suffixSegments.join('/')}`.replace(/\/{2,}/g, '/')
    : targetPath || '/'

  const params = new URLSearchParams(requestUrl.searchParams)
  params.delete('path')
  upstreamUrl.search = params.toString()
  return upstreamUrl
}

function createCorsHeaders(request, env) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,accept,x-taostudio-api-base-url,x-taostudio-proxy-token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }

  // Reflect only explicitly allowed origins instead of echoing any Origin.
  // Non-browser clients (curl, node scripts) are unaffected by CORS.
  const allowedHosts = new Set([
    ...DEFAULT_ALLOWED_ORIGIN_HOSTS,
    ...splitList(env.IMAGE_API_PROXY_ALLOWED_ORIGINS).map((origin) => origin.replace(/^https?:\/\//, '').toLowerCase()),
  ])
  const origin = request.headers.get('origin')?.trim().toLowerCase() || ''
  if (!origin) return headers
  let originHost = ''
  try {
    originHost = new URL(origin).hostname.toLowerCase()
  } catch {
    return headers
  }
  if (allowedHosts.has(originHost) || LOCAL_ORIGIN_PATTERN.test(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

function jsonResponse(request, status, payload, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...createCorsHeaders(request, env),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function createForwardHeaders(request, body, contentTypeOverride, env, canInjectCredentials) {
  const headers = new Headers()
  const authorization = request.headers.get('authorization')?.trim() || ''
  // Server-held credentials are only injected for token-authenticated callers.
  // An open (unauthenticated) proxy must never attach the owner's key to
  // anonymous traffic — that is the credit-burning vector.
  const fallbackAuthorization = canInjectCredentials
    ? (env.IMAGE_API_PROXY_AUTHORIZATION || env.API_PROXY_AUTHORIZATION)
    : ''
  const resolvedAuthorization = (!authorization || authorization === 'Bearer') ? fallbackAuthorization : authorization
  if (resolvedAuthorization) headers.set('authorization', resolvedAuthorization)

  const contentType = contentTypeOverride || request.headers.get('content-type')?.trim() || ''
  if (contentType) headers.set('content-type', contentType)
  const accept = request.headers.get('accept')?.trim() || ''
  if (accept) headers.set('accept', accept)
  if (body) headers.set('content-length', String(body.byteLength))
  return headers
}

async function readRequestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return { body: undefined, contentTypeOverride: '' }

  const body = await request.arrayBuffer()
  const contentType = request.headers.get('content-type')?.toLowerCase() || ''
  if (!body.byteLength || !contentType.includes('application/json')) return { body, contentTypeOverride: '' }

  try {
    const normalizedJson = JSON.stringify(JSON.parse(new TextDecoder().decode(body)))
    return {
      body: new TextEncoder().encode(normalizedJson).buffer,
      contentTypeOverride: 'application/json',
    }
  } catch {
    return { body, contentTypeOverride: '' }
  }
}

function copyResponseHeaders(upstreamResponse, request, diagnostics, env) {
  const headers = new Headers(createCorsHeaders(request, env))
  upstreamResponse.headers.forEach((value, name) => {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName)) return
    // CORS 由本代理的 allowlist 决定，上游不得覆盖（否则可注入任意 Origin 放行）。
    if (lowerName.startsWith('access-control-')) return
    headers.set(name, value)
  })
  headers.set('Cache-Control', 'no-store')
  headers.set('X-TaoStudio-Proxy-Path', diagnostics.path)
  headers.set('X-TaoStudio-Proxy-Body-Bytes', String(diagnostics.bodyBytes))
  headers.set('X-TaoStudio-Proxy-Content-Type', diagnostics.contentType || 'none')
  return headers
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url)
    if (!requestUrl.pathname.startsWith('/api-proxy')) {
      return jsonResponse(request, 404, { error: { message: 'Not found.' } }, env)
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: createCorsHeaders(request, env),
      })
    }

    const { tokenAuthEnabled, authorized } = checkProxyToken(request, env)
    if (!authorized) {
      return jsonResponse(request, 401, { error: { message: 'API proxy token is missing or invalid.' } }, env)
    }

    const target = resolveTargetUrl(request, env)
    if (target.errorStatus) {
      return jsonResponse(request, target.errorStatus, { error: { message: target.errorMessage } }, env)
    }

    const routePath = getRoutePath(requestUrl)
    const upstreamUrl = buildUpstreamUrl(target.targetUrl, routePath, requestUrl)
    const { body, contentTypeOverride } = await readRequestBody(request)
    const forwardHeaders = createForwardHeaders(request, body, contentTypeOverride, env, tokenAuthEnabled && authorized)

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: forwardHeaders,
        body,
        redirect: 'manual',
      })
      const responseBody = await upstreamResponse.arrayBuffer()
      return new Response(responseBody, {
        status: upstreamResponse.status,
        headers: copyResponseHeaders(upstreamResponse, request, {
          path: upstreamUrl.pathname,
          bodyBytes: body?.byteLength ?? 0,
          contentType: forwardHeaders.get('content-type') || '',
        }, env),
      })
    } catch (error) {
      return jsonResponse(request, 502, {
        error: {
          message: error instanceof Error ? error.message : 'API proxy request failed.',
        },
      }, env)
    }
  },
}
