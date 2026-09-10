// @vitest-environment jsdom
// I2：画廊工作台头部的「一键全部」切换 chip——当前场景过滤 ↔ 全部场景，文案随状态翻转。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GalleryWorkspaceHeader } from '../../App'
import { useStore } from '../../store'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'

describe('GalleryWorkspaceHeader 一键全部切换 chip', () => {
  beforeEach(() => {
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, activeScene: 'portrait' }),
      tasks: [],
      gallerySceneFilter: 'portrait',
    })
  })

  afterEach(() => cleanup())

  it('过滤跟随当前场景时显示「全部」，点击切换到 all 并翻转为「仅人像写真」，再点切回', () => {
    render(<GalleryWorkspaceHeader onOpenSceneSettings={() => {}} />)

    // filter === activeScene（portrait）→ 显示「全部」
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(useStore.getState().gallerySceneFilter).toBe('all')
    expect(screen.getByRole('button', { name: '仅人像写真' })).toBeTruthy()

    // filter === 'all' → 显示「仅人像写真」，点击切回当前场景
    fireEvent.click(screen.getByRole('button', { name: '仅人像写真' }))
    expect(useStore.getState().gallerySceneFilter).toBe('portrait')
    expect(screen.getByRole('button', { name: '全部' })).toBeTruthy()
  })

  it('过滤漂移到其他场景时也提供「全部」出口（不锁死在 all/activeScene 两态）', () => {
    useStore.setState({ gallerySceneFilter: 'sticker' })
    render(<GalleryWorkspaceHeader onOpenSceneSettings={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(useStore.getState().gallerySceneFilter).toBe('all')
  })
})
