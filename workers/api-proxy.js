const TARGET_HEADER = 'x-taostudio-api-base-url'
const DEFAULT_TARGET = 'https://www.ydn99.com/v1'
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

function resolveTargetUrl(request, env) {
  const defaultTarget = env.IMAGE_API_PROXY_TARGET || env.API_PROXY_TARGET || DEFAULT_TARGET
  const defaultTargetUrl = new URL(normalizeBaseUrl(defaultTarget))
  const requestedTarget = request.headers.get(TARGET_HEADER)?.trim() || ''
  const targetUrl = new URL(normalizeBaseUrl(requestedTarget || defaultTarget))

  if (requestedTarget && env.IMAGE_API_PROXY_ALLOW_DYNAMIC_TARGETS !== 'true') {
    const allowedHosts = getAllowedHosts(env, defaultTargetUrl)
    if (!allowedHosts.has(targetUrl.hostname.toLowerCase())) {
      return { errorStatus: 403, errorMessage: 'API proxy target host is not allowed.' }
    }
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

function createCorsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('origin') || '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers') ||
      'authorization,content-type,accept,x-taostudio-api-base-url',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function jsonResponse(request, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...createCorsHeaders(request),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function createForwardHeaders(request, body, contentTypeOverride, env) {
  const headers = new Headers()
  const authorization = request.headers.get('authorization')?.trim() || ''
  const fallbackAuthorization = env.IMAGE_API_PROXY_AUTHORIZATION ||
    env.API_PROXY_AUTHORIZATION ||
    (env.YDN_API_KEY ? `Bearer ${env.YDN_API_KEY}` : '')
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

function copyResponseHeaders(upstreamResponse, request, diagnostics) {
  const headers = new Headers(createCorsHeaders(request))
  upstreamResponse.headers.forEach((value, name) => {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName)) return
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
      return jsonResponse(request, 404, { error: { message: 'Not found.' } })
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: createCorsHeaders(request),
      })
    }

    const target = resolveTargetUrl(request, env)
    if (target.errorStatus) {
      return jsonResponse(request, target.errorStatus, { error: { message: target.errorMessage } })
    }

    const routePath = getRoutePath(requestUrl)
    const upstreamUrl = buildUpstreamUrl(target.targetUrl, routePath, requestUrl)
    const { body, contentTypeOverride } = await readRequestBody(request)
    const forwardHeaders = createForwardHeaders(request, body, contentTypeOverride, env)

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
        }),
      })
    } catch (error) {
      return jsonResponse(request, 502, {
        error: {
          message: error instanceof Error ? error.message : 'API proxy request failed.',
        },
      })
    }
  },
}
