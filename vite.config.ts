/// <reference types="vitest" />

import { readFileSync } from 'fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { normalizeDevProxyConfig } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

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

function loadEnvProxyConfig(mode: string) {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.IMAGE_API_PROXY_TARGET?.trim()
  if (!target) return null

  return normalizeDevProxyConfig({
    enabled: true,
    prefix: '/api-proxy',
    target,
    changeOrigin: true,
    secure: false,
  })
}

export default defineConfig(({ command, mode }) => {
  const canLoadLocalProxy = command === 'serve' && mode !== 'test'
  const fileProxyConfig = canLoadLocalProxy ? loadDevProxyConfig() : null
  const envProxyConfig = canLoadLocalProxy && !fileProxyConfig ? loadEnvProxyConfig(mode) : null
  const devProxyConfig = fileProxyConfig ?? envProxyConfig

  return {
    plugins: [react()],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy:
        devProxyConfig?.enabled
          ? {
              [devProxyConfig.prefix]: {
                target: devProxyConfig.target,
                changeOrigin: devProxyConfig.changeOrigin,
                secure: devProxyConfig.secure,
                rewrite: (path) =>
                  path.replace(
                    new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
                    '',
                  ),
              },
            }
          : undefined,
    },
    test: {
      exclude: ['**/node_modules/**', '**/dist/**', '**/.upstream/**', '**/.omx/**'],
    },
  }
})
