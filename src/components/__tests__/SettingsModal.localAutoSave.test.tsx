// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import SettingsModal from '../SettingsModal'
import { useStore } from '../../store'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'
import type { AppSettings } from '../../types'

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

describe('SettingsModal local auto-save settings', () => {
  const originalSelectLocalAutoSaveDirectory = useStore.getState().selectLocalAutoSaveDirectory

  beforeEach(() => {
    setDesktopDirectoryPickerSupport()
    useStore.setState({
      showSettings: true,
      settingsTabRequest: 'data',
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        localAutoSave: {
          enabled: false,
          directoryName: null,
          lastSavedAt: null,
          lastSavedFolderName: null,
        },
      }),
      tasks: [],
      showToast: vi.fn(),
      selectLocalAutoSaveDirectory: originalSelectLocalAutoSaveDirectory,
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

  it('keeps local auto-save enabled after closing and reopening settings', async () => {
    render(<SettingsModal />)

    fireEvent.click(screen.getByRole('button', { name: '数据管理' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: '关闭' }))

    await waitFor(() => {
      expect(useStore.getState().settings.localAutoSave.enabled).toBe(true)
    })

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    await waitFor(() => {
      expect(useStore.getState().showSettings).toBe(false)
      expect(useStore.getState().settings.localAutoSave.enabled).toBe(true)
    })

    act(() => {
      useStore.getState().setShowSettings(true, 'data')
    })

    const checkbox = await screen.findByRole('checkbox', { name: '开启' })
    expect((checkbox as HTMLInputElement).checked).toBe(true)
    expect(useStore.getState().settings.localAutoSave.enabled).toBe(true)
  }, 15_000)

  it('reflects the chosen directory after clicking the select-folder button', async () => {
    const selectLocalAutoSaveDirectory = vi.fn(async () => {
      useStore.getState().setSettings({
        localAutoSave: {
          enabled: true,
          directoryName: 'Desktop Archive',
        },
      } as unknown as Partial<AppSettings>)
    })
    useStore.setState({ selectLocalAutoSaveDirectory })

    render(<SettingsModal />)

    fireEvent.click(screen.getByRole('button', { name: '数据管理' }))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))

    await waitFor(() => {
      expect(selectLocalAutoSaveDirectory).toHaveBeenCalledTimes(1)
      expect(screen.getByText('保存位置：Desktop Archive')).toBeTruthy()
      expect(useStore.getState().settings.localAutoSave).toMatchObject({
        enabled: true,
        directoryName: 'Desktop Archive',
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    await waitFor(() => {
      expect(useStore.getState().settings.localAutoSave).toMatchObject({
        enabled: true,
        directoryName: 'Desktop Archive',
      })
    })
  }, 15_000)

  it('does not overwrite local auto-save metadata updated while settings are open', async () => {
    render(<SettingsModal />)

    fireEvent.click(screen.getByRole('button', { name: '数据管理' }))

    useStore.getState().setSettings({
      localAutoSave: {
        lastSavedAt: 1_788_888_888,
        lastSavedFolderName: '20260708_2160x3840_城市夜晚人像',
      },
    } as unknown as Partial<ReturnType<typeof useStore.getState>['settings']>)

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    await waitFor(() => {
      expect(useStore.getState().settings.localAutoSave.lastSavedAt).toBe(1_788_888_888)
      expect(useStore.getState().settings.localAutoSave.lastSavedFolderName).toBe('20260708_2160x3840_城市夜晚人像')
    })
  }, 15_000)
})
