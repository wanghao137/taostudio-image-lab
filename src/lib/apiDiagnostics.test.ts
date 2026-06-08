import { describe, expect, it } from 'vitest'
import type { ApiRequestDiagnostics } from '../types'
import { extractApiDiagnosticsFromError, formatApiDiagnosticsSummary, stripApiDiagnosticsFromMessage } from './apiDiagnostics'

describe('api diagnostics helpers', () => {
  const diagnostics: ApiRequestDiagnostics = {
    endpoint: 'images/generations',
    apiMode: 'images',
    method: 'POST',
    bodyKind: 'json',
    proxy: true,
    urlHost: 'image-proxy.taostudioai.com',
    model: 'gpt-image-2',
    timeout: 600,
    size: '2160x3840',
    outputFormat: 'png',
    responseFormat: 'b64_json',
    stream: false,
    inputImageCount: 0,
    hasMask: false,
    attempts: 2,
    elapsedMs: 345159,
    retryable: true,
    status: 524,
    errorName: 'Error',
    errorMessage: 'gateway timeout',
  }

  it('extracts diagnostics from the attached error object', () => {
    const error = new Error('gateway timeout') as Error & { apiDiagnostics?: unknown }
    error.apiDiagnostics = diagnostics

    expect(extractApiDiagnosticsFromError(error)).toEqual(diagnostics)
  })

  it('extracts diagnostics from persisted error text', () => {
    const errorText = `gateway timeout\nAPI request diagnostics: ${JSON.stringify(diagnostics)}`

    expect(extractApiDiagnosticsFromError(errorText)).toEqual(diagnostics)
  })

  it('removes raw diagnostics JSON from the user-facing message', () => {
    const errorText = `gateway timeout\nAPI request diagnostics: ${JSON.stringify(diagnostics)}`

    expect(stripApiDiagnosticsFromMessage(errorText)).toBe('gateway timeout')
  })

  it('formats a compact Chinese diagnostic summary', () => {
    expect(formatApiDiagnosticsSummary(diagnostics)).toEqual([
      { label: '请求模式', value: 'Images API' },
      { label: '请求路径', value: 'images/generations' },
      { label: '网络路径', value: 'API 代理' },
      { label: '状态码', value: '524' },
      { label: '是否可重试', value: '是' },
      { label: '模型', value: 'gpt-image-2' },
      { label: '尺寸', value: '2160x3840' },
      { label: '耗时', value: '345.2s' },
      { label: '尝试次数', value: '2' },
    ])
  })
})
