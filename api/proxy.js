const TARGET_HEADER = 'x-taostudio-api-base-url'
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

function isDynamicTargetAllowed(targetUrl, defaultTargetUrl) {
  if (env('IMAGE_API_PROXY_ALLOW_DYNAMIC_TARGETS').toLowerCase() === 'true') return true
  return getAllowedHosts(defaultTargetUrl).has(targetUrl.hostname.toLowerCase())
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

  if (requestedTarget && !isDynamicTargetAllowed(targetUrl, defaultTargetUrl)) {
    return {
      errorStatus: 403,
      errorMessage: 'API proxy target host is not allowed.',
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
  response.setHeader('Access-Control-Allow-Origin', request.headers.origin || '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  response.setHeader(
    'Access-Control-Allow-Headers',
    request.headers['access-control-request-headers'] ||
      'authorization,content-type,accept,x-taostudio-api-base-url',
  )
  response.setHeader('Access-Control-Max-Age', '86400')
  response.setHeader('Vary', 'Origin')
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

function createForwardHeaders(request, body) {
  const headers = new Headers()

  const authorization = getHeaderValue(request, 'authorization').trim()
  const proxyAuthorization = env('IMAGE_API_PROXY_AUTHORIZATION') || env('API_PROXY_AUTHORIZATION')
  const proxyApiKey = env('YDN_API_KEY') || env('IMAGE_API_PROXY_API_KEY') || env('API_PROXY_API_KEY')
  const fallbackAuthorization = proxyAuthorization || (proxyApiKey ? `Bearer ${proxyApiKey}` : '')
  const resolvedAuthorization = (!authorization || authorization === 'Bearer') ? fallbackAuthorization : authorization
  if (resolvedAuthorization) headers.set('authorization', resolvedAuthorization)

  const contentType = getHeaderValue(request, 'content-type').trim()
  if (contentType) headers.set('content-type', contentType)
  const accept = getHeaderValue(request, 'accept').trim()
  if (accept) headers.set('accept', accept)
  if (body) headers.set('content-length', String(body.length))

  return headers
}

async function readRequestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined

  const chunks = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return chunks.length ? Buffer.concat(chunks) : undefined
}

function copyResponseHeaders(upstreamResponse, response) {
  upstreamResponse.headers.forEach((value, name) => {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName)) return
    if (lowerName === 'content-encoding') return
    response.setHeader(name, value)
  })
  response.setHeader('Cache-Control', 'no-store')
}

async function sendUpstreamResponse(upstreamResponse, response) {
  response.statusCode = upstreamResponse.status
  copyResponseHeaders(upstreamResponse, response)

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
    const body = await readRequestBody(request)
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: createForwardHeaders(request, body),
      body,
      redirect: 'manual',
      signal: controller.signal,
    })
    await sendUpstreamResponse(upstreamResponse, response)
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
