import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('deployment config', () => {
  it('routes the same-origin API proxy prefix to the Vercel function', () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'))

    expect(config.rewrites).toEqual(expect.arrayContaining([
      {
        source: '/api-proxy/:path*',
        destination: '/api/proxy?path=:path*',
      },
    ]))
  })

  it('excludes local diagnostics and env files from Vercel uploads', () => {
    const ignore = readFileSync(resolve(process.cwd(), '.vercelignore'), 'utf8')

    expect(ignore).toContain('.omx')
    expect(ignore).toContain('.env.local')
  })

  it('serves upstream release checks through a same-origin function', () => {
    expect(existsSync(resolve(process.cwd(), 'api/upstream-release.js'))).toBe(true)
  })
})
