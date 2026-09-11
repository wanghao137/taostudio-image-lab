import { describe, expect, it } from 'vitest'
import type { AppSettings, FavoriteCollection } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_IMAGES_MODEL, DEFAULT_SETTINGS, switchApiProfileProvider } from './apiProfiles'
import { DEFAULT_FAVORITE_COLLECTION_ID } from './favoriteState'
import { createPersistedState, migratePersistedState, normalizePersistedState } from './persistedState'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,image-a' }
const collectionA: FavoriteCollection = { id: 'collection-a', name: '收藏夹 A', createdAt: 1, updatedAt: 1 }

function source(settings: AppSettings = DEFAULT_SETTINGS) {
  return {
    settings,
    params: { ...DEFAULT_PARAMS },
    prompt: '画廊输入',
    inputImages: [imageA],
    maskDraft: null,
    maskEditorImageId: null,
    dismissedCodexCliPrompts: [],
    appMode: 'gallery' as const,
    galleryInputDraft: null,
    favoriteCollections: [collectionA],
    defaultFavoriteCollectionId: collectionA.id,
    supportPromptDismissed: false,
    supportPromptOpen: false,
    supportPromptSkippedForImportedData: false,
  }
}

function fallback() {
  return {
    settings: DEFAULT_SETTINGS,
    params: { ...DEFAULT_PARAMS },
    dismissedCodexCliPrompts: ['current'],
    favoriteCollections: [collectionA],
    defaultFavoriteCollectionId: collectionA.id,
  }
}

describe('persisted state codec', () => {
  it.each([undefined, 'custom-image-model', '', '   '])('restores profile and legacy top-level tool model %s without autofilling', (imageGenerationModel) => {
    const profile = { apiMode: 'responses', model: 'legacy-text-model', ...(imageGenerationModel === undefined ? {} : { imageGenerationModel }) }
    for (const settings of [profile, { profiles: [profile] }]) {
      const result = normalizePersistedState({ settings }, fallback(), 100)!
      expect(result.settings.profiles[0]).toMatchObject({
        model: 'legacy-text-model',
        imageGenerationModel: imageGenerationModel?.trim() ?? '',
      })
    }
  })

  it.each([undefined, 'draft-image-model', ''])('restores saved provider tool model %s instead of inheriting the active model', (imageGenerationModel) => {
    const result = normalizePersistedState({ settings: { profiles: [{
      provider: 'fal',
      imageGenerationModel: DEFAULT_IMAGES_MODEL,
      providerDrafts: { openai: { apiMode: 'responses', model: 'saved-text-model', ...(imageGenerationModel === undefined ? {} : { imageGenerationModel }) } },
    }] } }, fallback(), 100)!
    expect(switchApiProfileProvider(result.settings.profiles[0], 'openai')).toMatchObject({
      apiMode: 'responses',
      model: 'saved-text-model',
      imageGenerationModel: imageGenerationModel ?? '',
    })
  })

  it('retains new defaults when no settings were persisted', () => {
    expect(normalizePersistedState({}, fallback(), 100)!.settings.profiles[0].imageGenerationModel).toBe(DEFAULT_IMAGES_MODEL)
  })

  it('normalizes skill expansion prefs: defaults, clamping, and garbage fallback', () => {
    expect(normalizePersistedState({}, fallback(), 100)!.skillExpansionPrefs).toEqual({ strictMode: true, entryCount: 5 })
    expect(normalizePersistedState({ skillExpansionPrefs: { strictMode: false, entryCount: 99 } }, fallback(), 100)!.skillExpansionPrefs)
      .toEqual({ strictMode: false, entryCount: 10 })
    expect(normalizePersistedState({ skillExpansionPrefs: { strictMode: 'yes', entryCount: -2 } }, fallback(), 100)!.skillExpansionPrefs)
      .toEqual({ strictMode: true, entryCount: 1 })
    expect(normalizePersistedState({ skillExpansionPrefs: 'garbage' }, fallback(), 100)!.skillExpansionPrefs)
      .toEqual({ strictMode: true, entryCount: 5 })
  })

  it.each(['xhigh', 'max'] as const)('restores the %s GPT Image 2.5 quality level', (quality) => {
    const result = normalizePersistedState({ params: { ...DEFAULT_PARAMS, quality } }, fallback(), 100)!

    expect(result.params.quality).toBe(quality)
  })

  it('rejects non-record unknown data and falls back field-by-field for an invalid record', () => {
    class ExternalState {}

    expect(normalizePersistedState(null, fallback(), 100)).toBeNull()
    expect(normalizePersistedState([], fallback(), 100)).toBeNull()
    expect(normalizePersistedState(new Date(), fallback(), 100)).toBeNull()
    expect(normalizePersistedState(new Map(), fallback(), 100)).toBeNull()
    expect(normalizePersistedState(new ExternalState(), fallback(), 100)).toBeNull()

    const result = normalizePersistedState({
      params: { quality: 'invalid', n: Number.NaN },
      dismissedCodexCliPrompts: 'invalid',
      favoriteCollections: 'invalid',
      appMode: 'invalid',
      setPrompt: 'external action must not escape the codec',
    }, fallback(), 100)!

    expect(result.params).toEqual(DEFAULT_PARAMS)
    expect(result.dismissedCodexCliPrompts).toEqual(['current'])
    expect(result.favoriteCollections).toEqual([collectionA])
    expect(result.appMode).toBe('gallery')
    expect(result).not.toHaveProperty('setPrompt')
  })

  it('drops legacy agent data instead of migrating it', () => {
    const legacy = {
      agentConversations: [{
        id: 'conversation-a',
        title: '对话 A',
        activeRoundId: 'round-a',
        createdAt: 1,
        updatedAt: 1,
        rounds: [{
          id: 'round-a',
          userMessageId: 'user-a',
          prompt: '画一张图',
          responseOutput: [{ type: 'image_generation_call', id: 'image-call-a', result: 'legacy-base64' }],
          status: 'done',
        }],
        messages: [],
      }],
      activeAgentConversationId: 'conversation-a',
      agentInputDrafts: { 'conversation-a': { prompt: 'Agent 草稿', inputImages: [], maskDraft: null, maskEditorImageId: null } },
      agentSidebarCollapsed: true,
      agentAssetTab: 'references',
      agentAssetPanelCollapsed: true,
    }

    const migrated = migratePersistedState(legacy, 1) as Record<string, unknown>
    expect(migrated).not.toHaveProperty('agentConversations')
    expect(migrated).not.toHaveProperty('activeAgentConversationId')
    expect(migrated).not.toHaveProperty('agentInputDrafts')
    expect(migrated).not.toHaveProperty('agentSidebarCollapsed')
    expect(migrated).not.toHaveProperty('agentAssetTab')
    expect(migrated).not.toHaveProperty('agentAssetPanelCollapsed')
    expect(JSON.stringify(migrated)).not.toContain('legacy-base64')
    expect(migratePersistedState('invalid', 1)).toBe('invalid')
  })

  it('normalizes legacy agent-mode persisted state down to gallery', () => {
    const result = normalizePersistedState({
      settings: DEFAULT_SETTINGS,
      appMode: 'agent',
      agentConversations: [{ id: 'conversation-a', title: '对话 A', createdAt: 1, updatedAt: 1, rounds: [], messages: [] }],
      activeAgentConversationId: 'conversation-a',
      prompt: '旧版 Agent 草稿',
      inputImages: [imageA],
    }, fallback(), 100)!

    expect(result.appMode).toBe('gallery')
    expect(result).not.toHaveProperty('agentConversations')
    expect(result).not.toHaveProperty('activeAgentConversationId')
    // 顶层输入在旧格式里属于画廊草稿（agent 输入存于 agentInputDrafts，随移除丢弃），
    // 无独立画廊草稿时按旧格式回落到顶层输入。
    expect(result.prompt).toBe('旧版 Agent 草稿')
    expect(result.inputImages).toEqual([imageA])
  })

  it('persists the gallery draft only when input persistence is enabled', () => {
    const previousPresetConfig = {
      customProviders: [],
      profiles: [DEFAULT_SETTINGS.profiles[0]],
    }
    const enabled = createPersistedState({
      ...source(),
      previousPresetConfig,
    })
    const disabled = createPersistedState({
      ...source({ ...DEFAULT_SETTINGS, persistInputOnRestart: false }),
      prompt: '不应持久化的可见输入',
    })

    expect(enabled.prompt).toBe('画廊输入')
    expect(enabled.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
    expect(enabled.galleryInputDraft?.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
    expect(enabled.previousPresetConfig).toEqual(previousPresetConfig)
    expect(disabled).not.toHaveProperty('prompt')
    expect(disabled).not.toHaveProperty('inputImages')
    expect(disabled.galleryInputDraft).toBeNull()
  })

  it('persists skill expansion prefs with clamped entry count', () => {
    const persisted = createPersistedState({
      ...source(),
      skillExpansion: { strictMode: false, entryCount: 3 },
    })
    expect(persisted.skillExpansionPrefs).toEqual({ strictMode: false, entryCount: 3 })
  })

  it('preserves an empty deployed profile snapshot when restoring persisted state', () => {
    const result = normalizePersistedState({
      previousPresetConfig: {
        customProviders: [{ id: 'provider-a', name: 'Provider A', submit: { path: 'generate' } }],
        profiles: [],
      },
    }, fallback())!

    expect(result.previousPresetConfig?.profiles).toEqual([])
    expect(result.previousPresetConfig?.customProviders).toEqual([
      expect.objectContaining({ id: 'provider-a' }),
    ])
  })

  it('does not restore gallery drafts or legacy top-level input when input persistence is disabled', () => {
    const result = normalizePersistedState({
      settings: { ...DEFAULT_SETTINGS, persistInputOnRestart: false },
      prompt: '旧版顶层输入',
      inputImages: [imageA],
      galleryInputDraft: { prompt: '画廊草稿', inputImages: [imageA] },
    }, fallback(), 100)!

    expect(result.galleryInputDraft).toBeNull()
    expect(result.prompt).toBe('')
    expect(result.inputImages).toEqual([])
    expect(result.maskDraft).toBeNull()
    expect(result.maskEditorImageId).toBeNull()
  })

  it('restores old gallery drafts while normalizing favorites and default ID', () => {
    const gallery = normalizePersistedState({
      settings: DEFAULT_SETTINGS,
      prompt: '旧画廊草稿',
      inputImages: [{ id: imageA.id, dataUrl: 123 }],
      favoriteCollections: [
        { id: '', name: '无效' },
        { id: 'collection-b', name: '  收藏夹 B  ', createdAt: 2, updatedAt: 3 },
      ],
      defaultFavoriteCollectionId: 'missing',
    }, fallback(), 100)!
    const emptyFavorites = normalizePersistedState({ favoriteCollections: [] }, fallback(), 100)!

    expect(gallery.galleryInputDraft).toMatchObject({ prompt: '旧画廊草稿', inputImages: [{ id: imageA.id, dataUrl: '' }] })
    expect(gallery.favoriteCollections).toEqual([{ id: 'collection-b', name: '收藏夹 B', createdAt: 2, updatedAt: 3 }])
    expect(gallery.defaultFavoriteCollectionId).toBe('collection-b')
    expect(emptyFavorites.favoriteCollections[0].id).toBe(DEFAULT_FAVORITE_COLLECTION_ID)
    expect(emptyFavorites.defaultFavoriteCollectionId).toBe(DEFAULT_FAVORITE_COLLECTION_ID)
  })
})

describe('normalizePromptHistory', () => {
  it('sanitizes malformed entries and caps at 20', async () => {
    const { normalizePromptHistory } = await import('./persistedState')
    const malformed = [
      { prompt: 'ok prompt', size: '1024x1024', usedAt: 1 },
      { prompt: '', usedAt: 2 },
      { nope: true },
      'garbage',
    ]
    const result = normalizePromptHistory(malformed)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ prompt: 'ok prompt', quality: 'auto', output_format: 'png', n: 1 })

    const many = Array.from({ length: 30 }, (_, i) => ({ prompt: `p${i}`, usedAt: i }))
    expect(normalizePromptHistory(many)).toHaveLength(20)
  })

  it('is idempotent for already-normalized entries', async () => {
    const { normalizePromptHistory } = await import('./persistedState')
    const once = normalizePromptHistory([{ id: 'a', prompt: 'x', size: 'auto', quality: 'high', output_format: 'png', n: 2, usedAt: 5 }])
    const twice = normalizePromptHistory(once)
    expect(twice).toEqual(once)
  })
})
