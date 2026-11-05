import { getCustomProviderDefinition, getSceneImageApiProfile } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { getGifProfile, validateGifParams } from './gif'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  let profile = opts.apiProfile ?? getSceneImageApiProfile(opts.settings)
  if (opts.params.output_format === 'gif') {
    validateGifParams(opts.params)
    if (opts.inputImageDataUrls.length || opts.maskDataUrl || opts.nativeTransparentBackground) throw new Error('原生 GIF 只支持文字生成，不支持参考图或遮罩编辑')
    profile = getGifProfile(profile, opts.params.gif!.model)
  }
  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)

  return callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
