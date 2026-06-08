import type { ApiRequestDiagnostics } from '../types'

const API_DIAGNOSTICS_MARKER = 'API request diagnostics:'

export interface ApiDiagnosticSummaryRow {
  label: string
  value: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isApiRequestDiagnostics(value: unknown): value is ApiRequestDiagnostics {
  if (!isRecord(value)) return false
  return typeof value.endpoint === 'string' &&
    typeof value.apiMode === 'string' &&
    typeof value.method === 'string' &&
    typeof value.bodyKind === 'string' &&
    typeof value.proxy === 'boolean' &&
    typeof value.model === 'string' &&
    typeof value.timeout === 'number' &&
    typeof value.attempts === 'number' &&
    typeof value.elapsedMs === 'number' &&
    typeof value.retryable === 'boolean'
}

function parseDiagnosticsFromMessage(message: string): ApiRequestDiagnostics | undefined {
  const markerIndex = message.indexOf(API_DIAGNOSTICS_MARKER)
  if (markerIndex < 0) return undefined

  const afterMarker = message.slice(markerIndex + API_DIAGNOSTICS_MARKER.length).trimStart()
  const jsonText = afterMarker.split(/\r?\n/)[0]?.trim()
  if (!jsonText) return undefined

  try {
    const parsed = JSON.parse(jsonText)
    return isApiRequestDiagnostics(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function extractApiDiagnosticsFromError(error: unknown): ApiRequestDiagnostics | undefined {
  if (isRecord(error) && isApiRequestDiagnostics(error.apiDiagnostics)) return error.apiDiagnostics
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return message ? parseDiagnosticsFromMessage(message) : undefined
}

export function stripApiDiagnosticsFromMessage(message: string): string {
  const markerIndex = message.indexOf(API_DIAGNOSTICS_MARKER)
  if (markerIndex < 0) return message.trim()

  const beforeMarker = message.slice(0, markerIndex).trimEnd()
  const afterMarker = message.slice(markerIndex + API_DIAGNOSTICS_MARKER.length).trimStart()
  const [, ...remainingLines] = afterMarker.split(/\r?\n/)
  const afterDiagnostics = remainingLines.join('\n').trim()
  return [beforeMarker, afterDiagnostics].filter(Boolean).join('\n').trim()
}

function getApiModeLabel(apiMode: ApiRequestDiagnostics['apiMode']) {
  if (apiMode === 'images') return 'Images API'
  if (apiMode === 'responses') return 'Responses API'
  return 'Custom API'
}

function formatElapsed(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

export function formatApiDiagnosticsSummary(diagnostics: ApiRequestDiagnostics): ApiDiagnosticSummaryRow[] {
  const rows: ApiDiagnosticSummaryRow[] = [
    { label: '请求模式', value: getApiModeLabel(diagnostics.apiMode) },
    { label: '请求路径', value: diagnostics.endpoint },
    { label: '网络路径', value: diagnostics.proxy ? 'API 代理' : '直连' },
  ]

  if (typeof diagnostics.status === 'number') rows.push({ label: '状态码', value: String(diagnostics.status) })
  rows.push({ label: '是否可重试', value: diagnostics.retryable ? '是' : '否' })
  if (diagnostics.model) rows.push({ label: '模型', value: diagnostics.model })
  if (diagnostics.size) rows.push({ label: '尺寸', value: diagnostics.size })
  const elapsed = formatElapsed(diagnostics.elapsedMs)
  if (elapsed) rows.push({ label: '耗时', value: elapsed })
  rows.push({ label: '尝试次数', value: String(diagnostics.attempts) })

  return rows
}

export function formatApiDiagnosticsForCopy(diagnostics: ApiRequestDiagnostics): string {
  return JSON.stringify(diagnostics, null, 2)
}
