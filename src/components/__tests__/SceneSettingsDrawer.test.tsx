// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SceneSettingsDrawer } from '../SceneSettingsDrawer'
import { useStore } from '../../store'
import { DEFAULT_SETTINGS, createDefaultOpenAIProfile, normalizeSettings } from '../../lib/apiProfiles'

const IMAGE_PROFILE_A = createDefaultOpenAIProfile({ id: 'image-a', name: '生图配置A' })
const IMAGE_PROFILE_B = createDefaultOpenAIProfile({ id: 'image-b', name: '生图配置B' })
const TEXT_PROFILE_C = createDefaultOpenAIProfile({ id: 'text-c', name: '文本配置C', apiMode: 'responses', model: 'gpt-test-text' })

function buildSettings(profiles: typeof IMAGE_PROFILE_A[]) {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles,
    activeProfileId: profiles[0].id,
    activeScene: 'general',
  })
}

function setDesktopDirectoryPickerSupport() {
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(window.navigator, 'userAgentData', {
    configurable: true,
    value: {
      mobile: false,
      brands: [{ brand: 'Google Chrome', version: '126' }],
    },
  })
}

function clickSelectOption(optionValue: string) {
  const option = document.querySelector(`[data-option-value="${optionValue}"]`)
  if (!option) throw new Error(`Select option not found: ${optionValue}`)
  fireEvent.click(option)
}

describe('SceneSettingsDrawer', () => {
  beforeEach(() => {
    useStore.setState({
      settings: buildSettings([IMAGE_PROFILE_A, IMAGE_PROFILE_B, TEXT_PROFILE_C]),
    })
  })

  afterEach(() => {
    cleanup()
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(window.navigator, 'userAgentData', {
      configurable: true,
      value: undefined,
    })
  })

  it('renders the scene title and follow-global image option with the active profile name', () => {
    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    expect(screen.getByText('通用创作 · 场景设置')).toBeTruthy()
    expect(screen.getByText('跟随全局（当前：生图配置A）')).toBeTruthy()
    expect(screen.getByText('跟随全局文本路由')).toBeTruthy()
    // 比例与档位两个默认参数 Select 都有「跟随当前选择」
    expect(screen.getAllByText('跟随当前选择').length).toBe(2)
  })

  it('binds the scene image profile Select to setSceneImageProfileId', () => {
    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    fireEvent.click(screen.getByText('跟随全局（当前：生图配置A）'))
    clickSelectOption('image-b')

    expect(useStore.getState().settings.scenes.general.imageProfileId).toBe('image-b')
  })

  it('shows the disabled hint for local auto-save and the master switch enables it', async () => {
    setDesktopDirectoryPickerSupport()
    useStore.setState({
      settings: {
        ...buildSettings([IMAGE_PROFILE_A, IMAGE_PROFILE_B, TEXT_PROFILE_C]),
        localAutoSave: {
          enabled: false,
          directoryName: 'Desktop Archive',
          lastSavedAt: null,
          lastSavedFolderName: null,
        },
      },
    })

    render(<SceneSettingsDrawer scene="sticker" onClose={() => {}} />)

    expect(screen.getByText(/已停用本地自动保存/)).toBeTruthy()
    expect(screen.queryByText('选择独立目录')).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: '关闭' }))

    await waitFor(() => {
      expect(useStore.getState().settings.localAutoSave.enabled).toBe(true)
    })
    expect(screen.getByText('选择独立目录')).toBeTruthy()
    expect(screen.getByText('场景保存目录：跟随全局目录')).toBeTruthy()
    expect(screen.getByText('全局目录：Desktop Archive')).toBeTruthy()
  })

  it('shows text-model guidance when no Responses profile resolves', () => {
    useStore.setState({
      settings: buildSettings([IMAGE_PROFILE_A, IMAGE_PROFILE_B]),
    })

    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    expect(screen.getByText('未找到可用的文本模型配置（需 Responses 类型），可在设置→API 中添加')).toBeTruthy()
  })
})
