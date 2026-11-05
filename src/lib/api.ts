import { getCustomProviderDefinition, getSceneImageApiProfile } from './apiProfiles'
import { composeMarkupDataUrl, toApiInputImageDataUrl } from './canvasImage'
import { callFalAiImageApi } from './falAiImageApi'
import { supportsImageMarkup } from './imageModels'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'
import { getGifProfile, validateGifParams } from './gif'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  let profile = opts.apiProfile ?? getSceneImageApiProfile(opts.settings)
  if (opts.params.output_format === 'gif' && opts.params.gif) {
    validateGifParams(opts.params)
    if (opts.inputImageDataUrls.length || opts.maskDataUrl || opts.nativeTransparentBackground) throw new Error('原生 GIF 只支持文字生成，不支持参考图或遮罩编辑')
    profile = getGifProfile(profile, opts.params.gif!.model)
  }
  const inputImageDataUrls = await Promise.all(opts.inputImageDataUrls.map(toApiInputImageDataUrl))
  const inputImageUrls = opts.inputImageUrls ? [...opts.inputImageUrls] : undefined
  let markupDataUrl = opts.markupDataUrl
  if (markupDataUrl && inputImageDataUrls.length && (opts.maskDataUrl || !supportsImageMarkup(profile))) {
    inputImageDataUrls[0] = await composeMarkupDataUrl(inputImageDataUrls[0], markupDataUrl)
    if (inputImageUrls) inputImageUrls[0] = null
    markupDataUrl = undefined
  }
  const requestOpts = { ...opts, inputImageDataUrls, inputImageUrls, markupDataUrl }
  if (profile.provider === 'fal') return callFalAiImageApi(requestOpts, profile)

  return callOpenAICompatibleImageApi(requestOpts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
