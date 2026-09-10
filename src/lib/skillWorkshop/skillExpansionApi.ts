// ---------------------------------------------------------------------------
// Skill 扩写 API（Skill Workshop P2 Task 3）
// 用文本模型对 skill 正文 + 用户锚点输入做单轮扩写，返回原始输出文本；
// 条目解析（parseExpansionEntries）由调用方负责。
// 调用链镜像 callPromptReverseApi（src/lib/promptReverse.ts），差异：
// 无 input_image（仅一条 input_text）、instructions=buildExpansionInstructions、
// 错误文案用「Skill 扩写」措辞、兼容顶层 output_text 返回形态。
// ---------------------------------------------------------------------------

import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from '../devProxy'
import { createHeaders, extractText, getApiErrorMessage, normalizeResponsePayload } from '../imageApiShared'
import type { ApiProfile, AppSettings, ResponsesApiResponse } from '../../types'
import { buildExpansionInstructions } from './expansion'

/** 部分 OpenAI 兼容网关直接返回顶层 output_text（SDK 便捷字段形态），类型层补齐该字段。 */
type SkillExpansionPayload = ResponsesApiResponse & { output_text?: unknown }

export async function callSkillExpansionApi(opts: {
  settings: AppSettings
  profile: ApiProfile
  skillBody: string
  userInput: string
  signal?: AbortSignal
}): Promise<string> {
  const { settings, profile, skillBody, userInput, signal } = opts
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, profile.timeout * 1000)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  try {
    const content: Array<Record<string, string>> = [{ type: 'input_text', text: userInput }]
    const body: Record<string, unknown> = {
      model: profile.model || settings.model,
      instructions: buildExpansionInstructions(skillBody),
      input: [{ role: 'user', content }],
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }

    try {
      const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
        method: 'POST',
        headers: createHeaders(profile),
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(await getApiErrorMessage(response))
      }
      const payload = normalizeResponsePayload(await response.json()) as SkillExpansionPayload | null
      if (!payload) throw new Error('Skill 扩写接口返回格式无效')
      const structured = extractText(payload)
      if (structured) return structured
      // output 数组无文本时兜底顶层 output_text（normalizeResponsePayload 展开保留未知字段）。
      if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim()
      throw new Error('Skill 扩写接口未返回文本内容')
    } catch (error) {
      // 超时 abort 抛出的是裸 AbortError，用户看不懂——换成可行动的中文提示。
      if (timedOut) {
        throw new Error(`Skill 扩写请求超时（${profile.timeout} 秒），请重试或在设置中调大超时`)
      }
      throw error
    }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}
