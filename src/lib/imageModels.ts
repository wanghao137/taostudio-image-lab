import type { ApiProfile } from '../types'

// TaoStudio 产品默认沿用 flare（见 d9ed12c）；上游默认为 sunburst，两者均为官方 2.5 模型 ID。
export const DEFAULT_IMAGES_MODEL = 'gpt-image-2.5-flare'

export function getImageGenerationModel(profile: ApiProfile) {
  return profile.provider === 'openai' && profile.apiMode === 'responses'
    ? profile.imageGenerationModel?.trim() ?? ''
    : profile.model
}

export function isGptImage25Model(model: string) {
  return model.trim().toLowerCase().includes('gpt-image-2.5')
}
