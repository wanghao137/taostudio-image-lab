// @vitest-environment jsdom
// I1：反推（PromptReverseModal）的文本模型解析走场景链——场景 textProfileId 优先，
// 未设置时回落全局链（textApiProfileId > 跟随生图 > 唯一文本配置）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import PromptReverseModal from '../PromptReverseModal'
import { callPromptReverseApi, parsePromptReverseResult, resolveReverseImageTarget } from '../../lib/promptReverse'
import { useStore } from '../../store'
import { DEFAULT_SETTINGS, createDefaultOpenAIProfile, normalizeSettings } from '../../lib/apiProfiles'
import type { PromptReverseResult } from '../../lib/promptReverse'

vi.mock('../../lib/promptReverse', () => ({
  callPromptReverseApi: vi.fn(async () => 'raw reverse text'),
  parsePromptReverseResult: vi.fn((): PromptReverseResult => ({
    imageType: 'portrait',
    breakdown: [],
    prompts: [{ label: '大师版', text: '人像提示词' }],
    promptEn: 'portrait prompt',
  })),
  resolveReverseImageTarget: vi.fn(() => null),
}))

vi.mock('../../lib/imageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/imageCache')>()
  return { ...actual, ensureImageCached: vi.fn(async () => 'data:image/png;base64,AAAA') }
})

// jsdom 不加载图片：stub Image 让 readImageSize 的 onload 同步触发
class FakeImage {
  naturalWidth = 800
  naturalHeight = 600
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private _src = ''
  set src(value: string) {
    this._src = value
    this.onload?.()
  }
  get src() {
    return this._src
  }
}

const IMAGE_PROFILE = createDefaultOpenAIProfile({ id: 'img-profile', apiMode: 'images', name: '生图配置' })
const GLOBAL_TEXT_PROFILE = createDefaultOpenAIProfile({ id: 'global-text', apiMode: 'responses', model: 'gpt-global-text', name: '全局文本' })
const SCENE_TEXT_PROFILE = createDefaultOpenAIProfile({ id: 'scene-text', apiMode: 'responses', model: 'gpt-scene-text', name: '场景文本' })

function buildSettings(sceneTextProfileId: string | null) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [IMAGE_PROFILE, GLOBAL_TEXT_PROFILE, SCENE_TEXT_PROFILE],
    activeProfileId: IMAGE_PROFILE.id,
    textApiProfileId: GLOBAL_TEXT_PROFILE.id,
    activeScene: 'portrait',
    scenes: { portrait: { textProfileId: sceneTextProfileId } },
  })
}

describe('PromptReverseModal 场景文本解析链', () => {
  beforeEach(() => {
    vi.stubGlobal('Image', FakeImage)
    vi.mocked(callPromptReverseApi).mockClear()
    useStore.setState({
      promptReverseSource: { imageId: 'reverse-img' },
      settings: buildSettings(SCENE_TEXT_PROFILE.id),
      showToast: vi.fn(),
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('场景 textProfileId 设置时，反推请求使用场景文本配置', async () => {
    render(<PromptReverseModal />)

    await waitFor(() => {
      expect(callPromptReverseApi).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(callPromptReverseApi).mock.calls[0]?.[0].profile).toMatchObject({ id: 'scene-text', model: 'gpt-scene-text' })
  })

  it('场景 textProfileId 未设置时，走全局链（textApiProfileId 显式选择）', async () => {
    useStore.setState({ settings: buildSettings(null) })
    render(<PromptReverseModal />)

    await waitFor(() => {
      expect(callPromptReverseApi).toHaveBeenCalledTimes(1)
    })
    expect(vi.mocked(callPromptReverseApi).mock.calls[0]?.[0].profile).toMatchObject({ id: 'global-text', model: 'gpt-global-text' })
    expect(resolveReverseImageTarget).toHaveBeenCalledWith(800, 600)
    expect(parsePromptReverseResult).toHaveBeenCalledWith('raw reverse text')
  })
})
