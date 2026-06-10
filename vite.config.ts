import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { Readable } from 'stream'
import type { IncomingMessage, ServerResponse } from 'http'
import {
  normalizeDevProxyConfig,
  resolveDevProxyTarget,
  type DevProxyConfig,
} from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const buildId = process.env.VERCEL_GIT_COMMIT_SHA ||
  process.env.CF_PAGES_COMMIT_SHA ||
  process.env.GITHUB_SHA ||
  `${pkg.version}-${Date.now()}`

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw error
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-encoding',
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getProxyPrefixPath(prefix: string): string {
  try {
    return new URL(prefix).pathname.replace(/\/+$/, '') || '/api-proxy'
  } catch {
    return prefix.startsWith('/') ? prefix.replace(/\/+$/, '') : `/${prefix.replace(/^\/+|\/+$/g, '')}`
  }
}

function isProxyRequest(req: IncomingMessage, prefixPath: string): boolean {
  if (!req.url) return false
  const requestUrl = new URL(req.url, 'http://localhost')
  return requestUrl.pathname === prefixPath || requestUrl.pathname.startsWith(`${prefixPath}/`)
}

function buildUpstreamUrl(target: string, requestPath: string, prefixPath: string): URL {
  const requestUrl = new URL(requestPath || '/', 'http://localhost')
  const routePath = requestUrl.pathname.replace(new RegExp(`^${escapeRegExp(prefixPath)}\\/?`), '')
  const routeSegments = routePath.split('/').filter(Boolean)
  const targetUrl = new URL(target)
  const targetPath = targetUrl.pathname.replace(/\/+$/, '')
  const suffixSegments = targetPath.endsWith('/v1') && routeSegments[0] === 'v1'
    ? routeSegments.slice(1)
    : routeSegments

  targetUrl.pathname = suffixSegments.length
    ? `${targetPath}/${suffixSegments.join('/')}`.replace(/\/{2,}/g, '/')
    : targetPath || '/'
  targetUrl.search = requestUrl.search
  return targetUrl
}

async function readRawRequestBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined

  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return chunks.length ? Buffer.concat(chunks) : undefined
}

function createForwardHeaders(req: IncomingMessage, body: Buffer | undefined): Headers {
  const headers = new Headers()
  Object.entries(req.headers).forEach(([name, value]) => {
    const lowerName = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === 'x-taostudio-api-base-url') return
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item))
      return
    }
    if (typeof value === 'string') headers.set(name, value)
  })

  if (body) headers.set('content-length', String(body.length))
  return headers
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function sendUpstreamResponse(upstreamResponse: Response, res: ServerResponse): Promise<void> {
  res.statusCode = upstreamResponse.status
  upstreamResponse.headers.forEach((value, name) => {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) return
    res.setHeader(name, value)
  })
  res.setHeader('Cache-Control', 'no-store')

  if (!upstreamResponse.body) {
    res.end()
    return
  }

  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(upstreamResponse.body)
    stream.on('error', reject)
    res.on('finish', resolve)
    res.on('error', reject)
    stream.pipe(res)
  })
}

function createDevApiProxyPlugin(devProxyConfig: DevProxyConfig): Plugin {
  const prefixPath = getProxyPrefixPath(devProxyConfig.prefix)

  return {
    name: 'taostudio-dev-api-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!isProxyRequest(req, prefixPath)) {
          next()
          return
        }

        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
          res.setHeader(
            'Access-Control-Allow-Headers',
            req.headers['access-control-request-headers'] || 'authorization,content-type,accept,x-taostudio-api-base-url',
          )
          res.end()
          return
        }

        const target = devProxyConfig.allowBrowserTarget
          ? resolveDevProxyTarget(req.headers['x-taostudio-api-base-url'], devProxyConfig.target)
          : devProxyConfig.target
        const upstreamUrl = buildUpstreamUrl(target, req.url || '/', prefixPath)
        const body = await readRawRequestBody(req)
        const headers = createForwardHeaders(req, body)

        try {
          const upstreamResponse = await fetch(upstreamUrl, {
            method: req.method,
            headers,
            body,
            redirect: 'manual',
          })
          await sendUpstreamResponse(upstreamResponse, res)
        } catch (error) {
          writeJson(res, 502, {
            error: {
              message: error instanceof Error ? error.message : 'Local API proxy request failed.',
            },
          })
        }
      })
    },
  }
}

export default defineConfig(({ command }) => {
  const devProxyConfig = command === 'serve' ? loadDevProxyConfig() : null

  return {
    plugins: [
      react(),
      ...(devProxyConfig?.enabled ? [createDevApiProxyPlugin(devProxyConfig)] : []),
    ],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __BUILD_ID__: JSON.stringify(buildId),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom', 'zustand'],
            'markdown-vendor': ['streamdown', 'react-markdown', 'remark-gfm'],
            'icons-vendor': ['lucide-react'],
            'image-api-vendor': ['@fal-ai/client', 'fflate'],
          },
        },
      },
    },
    server: {
      host: true,
    },
  }
})
