import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentInputDraft } from '../types'
import { getSelectedImageMentionLabel } from './promptImageMentions'
import {
  normalizeAgentInputDraft,
  restoreGalleryInputDraftState,
  saveGalleryInputDraft,
  syncActiveInputDraft,
  updateInputDraftImages,
} from './inputDraftState'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('input draft normalization', () => {
  it('normalizes old external data and rejects invalid image and mask fields', () => {
    vi.spyOn(Date, 'now').mockReturnValue(90)

    expect(normalizeAgentInputDraft({
      prompt: 123,
      inputImages: [
        imageA,
        { id: 'image-b', dataUrl: 123 },
        { id: 123, dataUrl: 'invalid' },
        null,
      ],
      maskDraft: { targetImageId: 'image-a', maskDataUrl: 123, updatedAt: 5 },
      maskEditorImageId: 123,
      updatedAt: Number.NaN,
    }, 50)).toEqual({
      prompt: '',
      inputImages: [imageA, { id: 'image-b', dataUrl: '' }],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 50,
    })

    expect(normalizeAgentInputDraft({
      prompt: '旧草稿',
      maskDraft: { targetImageId: 'image-a', maskDataUrl: 'data:image/png;base64,mask' },
    }, 50)).toMatchObject({
      prompt: '旧草稿',
      maskDraft: {
        targetImageId: 'image-a',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 90,
      },
      updatedAt: 50,
    })
  })

  it('normalizes legacy top-level input used by the gallery draft fallback', () => {
    expect(normalizeAgentInputDraft({
      prompt: '旧版顶层草稿',
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      maskDraft: null,
      maskEditorImageId: null,
    }, 50)).toEqual({
      prompt: '旧版顶层草稿',
      inputImages: [{ id: imageA.id, dataUrl: '' }],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 50,
    })
  })
})

describe('gallery input draft saves and restores', () => {
  it('saves and restores the gallery draft only in gallery mode', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const state = {
      galleryInputDraft: null,
      prompt: '画廊草稿',
      inputImages: [imageA],
      maskDraft: null,
      maskEditorImageId: null,
    }
    const galleryDraft = saveGalleryInputDraft({ ...state, appMode: 'gallery' })

    expect(galleryDraft).toMatchObject({ prompt: '画廊草稿', inputImages: [imageA], updatedAt: 100 })
    expect(restoreGalleryInputDraftState(galleryDraft)).toMatchObject({ prompt: '画廊草稿', inputImages: [imageA] })
    expect(restoreGalleryInputDraftState(null)).toEqual({
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
    })

    // 非画廊模式（engine）不覆盖已保存的画廊草稿。
    expect(saveGalleryInputDraft({
      ...state,
      appMode: 'engine',
      galleryInputDraft: galleryDraft,
      prompt: '引擎输入',
    })).toBe(galleryDraft)
  })

  it('syncs only the gallery draft in gallery mode and leaves other modes untouched', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const base = {
      galleryInputDraft: null,
      prompt: '',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
    }

    const gallery = syncActiveInputDraft({ ...base, appMode: 'gallery' }, { prompt: '画廊' })
    const engine = syncActiveInputDraft({ ...base, appMode: 'engine' }, { prompt: '引擎' })

    expect(gallery.galleryInputDraft).toMatchObject({ prompt: '画廊', updatedAt: 100 })
    expect(engine).not.toHaveProperty('galleryInputDraft')
    expect(engine.prompt).toBe('引擎')
  })
})

describe('input draft image and mention transforms', () => {
  it('renumbers retained image mentions and clears a mask whose target was removed', () => {
    const draft: AgentInputDraft = {
      prompt: `保留 ${getSelectedImageMentionLabel(1)}，删除 ${getSelectedImageMentionLabel(0)}`,
      inputImages: [imageA, imageB],
      maskDraft: {
        targetImageId: imageA.id,
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
      maskEditorImageId: imageA.id,
      updatedAt: 2,
    }

    expect({ ...draft, ...updateInputDraftImages(draft, [imageB]) }).toEqual({
      prompt: `保留 ${getSelectedImageMentionLabel(0)}，删除 @已移除图片`,
      inputImages: [imageB],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 2,
    })
  })

  it('preserves mention position when an image id is replaced by an equivalent image', () => {
    const draft: AgentInputDraft = {
      prompt: `修改 ${getSelectedImageMentionLabel(0)}`,
      inputImages: [imageA],
      maskDraft: null,
      maskEditorImageId: null,
    }

    expect(updateInputDraftImages(draft, [imageB], { equivalentImageIds: { [imageA.id]: imageB.id } })).toMatchObject({
      prompt: `修改 ${getSelectedImageMentionLabel(0)}`,
      inputImages: [imageB],
    })
  })
})
