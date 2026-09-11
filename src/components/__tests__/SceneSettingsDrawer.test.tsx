// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SceneSettingsDrawer } from '../SceneSettingsDrawer'
import { useStore } from '../../store'
import { DEFAULT_SETTINGS, createDefaultOpenAIProfile, importCustomProviderDefinitionFromJson, normalizeSettings, switchApiProfileProvider } from '../../lib/apiProfiles'

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

describe('SceneSettingsDrawer 生图模型覆盖（Fix C）', () => {
  const CHATGPT2API_PROVIDER = importCustomProviderDefinitionFromJson(JSON.stringify({
    id: 'custom-chatgpt2api',
    name: 'chatgpt2api 网关',
    submit: { path: 'images/generations' },
  }))

  /** openai 当前 + chatgpt2api 草稿（全局切换过的真实形态） */
  function buildProfileWithDraft() {
    let onCustom = switchApiProfileProvider(IMAGE_PROFILE_A, CHATGPT2API_PROVIDER.id, CHATGPT2API_PROVIDER)
    onCustom = { ...onCustom, baseUrl: 'https://chatgpt2api.example.com/v1', apiKey: 'cg-key', model: 'cg-model' }
    return switchApiProfileProvider(onCustom, 'openai')
  }

  function buildSceneReferencingSettings(profiles: typeof IMAGE_PROFILE_A[], scenePatch: Record<string, unknown> = {}) {
    return normalizeSettings({
      ...DEFAULT_SETTINGS,
      customProviders: [CHATGPT2API_PROVIDER],
      profiles,
      activeProfileId: profiles[0].id,
      activeScene: 'general',
      scenes: { general: { imageProfileId: profiles[0].id, ...scenePatch } },
    })
  }

  afterEach(cleanup)

  it('未选具体配置时显示覆盖引导 hint，不渲染服务商/模型覆盖控件', () => {
    useStore.setState({ settings: buildSettings([IMAGE_PROFILE_A]) })

    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    expect(screen.getByText('选择具体配置后可覆盖服务商与模型。')).toBeTruthy()
    expect(screen.queryByText('服务商')).toBeNull()
    expect(screen.queryByLabelText('模型 ID')).toBeNull()
  })

  it('服务商 Select 只列草稿 provider（排除当前 provider 与无草稿项），选择后写入 imageProviderId，摘要行显示实际生效', () => {
    const profile = buildProfileWithDraft()
    useStore.setState({ settings: buildSceneReferencingSettings([profile]) })

    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    // 跟随选项显示该配置当前 provider 标签
    const providerTrigger = screen.getByText('跟随该配置当前（OpenAI）')
    fireEvent.click(providerTrigger)

    // 只列 chatgpt2api 草稿；不列当前 provider（openai）、不列无草稿的 fal / 别的 profile
    expect(document.querySelector('[data-option-value="custom-chatgpt2api"]')).toBeTruthy()
    expect(document.querySelector('[data-option-value="openai"]')).toBeNull()
    expect(document.querySelector('[data-option-value="fal"]')).toBeNull()
    expect(document.querySelector('[data-option-value="sb2api-async"]')).toBeNull()

    clickSelectOption('custom-chatgpt2api')
    expect(useStore.getState().settings.scenes.general.imageProviderId).toBe('custom-chatgpt2api')

    // 摘要行：provider 标签 · apiMode · 模型（来自 provider 草稿叠加后的解析链）
    expect(screen.getByText('实际生效：chatgpt2api 网关 · images · 模型 cg-model')).toBeTruthy()
  })

  it('images 模式不显示图像生成模型输入；responses 解析时显示并可提交覆盖', () => {
    const imagesProfile = buildProfileWithDraft()
    useStore.setState({ settings: buildSceneReferencingSettings([imagesProfile]) })
    const { unmount } = render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)
    expect(screen.queryByLabelText('图像生成模型')).toBeNull()
    unmount()

    const responsesProfile = {
      ...createDefaultOpenAIProfile({
        id: 'image-resp', name: '生图Responses',
        apiMode: 'responses', model: 'gpt-5.6-sol', imageGenerationModel: 'gpt-image-2.5',
      }),
    }
    useStore.setState({ settings: buildSceneReferencingSettings([responsesProfile]) })
    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    expect(screen.getByText('实际生效：OpenAI · responses · 模型 gpt-5.6-sol · 生图 gpt-image-2.5')).toBeTruthy()

    const igmInput = screen.getByLabelText('图像生成模型') as HTMLInputElement
    expect(igmInput.placeholder).toBe('gpt-image-2.5')
    fireEvent.change(igmInput, { target: { value: '  scene-igm  ' } })
    fireEvent.blur(igmInput)
    expect(useStore.getState().settings.scenes.general.imageGenerationModelOverride).toBe('scene-igm')
    // 摘要行反映覆盖后的解析值
    expect(screen.getByText('实际生效：OpenAI · responses · 模型 gpt-5.6-sol · 生图 scene-igm')).toBeTruthy()
  })

  it('模型 ID 输入 onBlur 提交（trim，空→null），placeholder 为当前解析值', () => {
    const profile = buildProfileWithDraft()
    useStore.setState({ settings: buildSceneReferencingSettings([profile]) })

    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    const modelInput = screen.getByLabelText('模型 ID') as HTMLInputElement
    expect(modelInput.placeholder).toBe(IMAGE_PROFILE_A.model)
    fireEvent.change(modelInput, { target: { value: '  scene-model  ' } })
    fireEvent.blur(modelInput)
    expect(useStore.getState().settings.scenes.general.imageModelOverride).toBe('scene-model')
    expect((screen.getByLabelText('模型 ID') as HTMLInputElement).placeholder).toBe('scene-model')

    // 清空 → null（跟随）
    const input = screen.getByLabelText('模型 ID') as HTMLInputElement
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.blur(input)
    expect(useStore.getState().settings.scenes.general.imageModelOverride).toBeNull()
  })

  it('切换场景生图配置时清除三项覆盖（避免旧 provider 引用漂移到新配置）', () => {
    const profile = buildProfileWithDraft()
    useStore.setState({
      settings: buildSceneReferencingSettings([profile, IMAGE_PROFILE_B], {
        imageProviderId: CHATGPT2API_PROVIDER.id,
        imageModelOverride: 'stale-model',
        imageGenerationModelOverride: 'stale-igm',
      }),
    })

    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    fireEvent.click(screen.getByText(/生图配置A/))
    clickSelectOption('image-b')

    const scene = useStore.getState().settings.scenes.general
    expect(scene.imageProfileId).toBe('image-b')
    expect(scene.imageProviderId).toBeNull()
    expect(scene.imageModelOverride).toBeNull()
    expect(scene.imageGenerationModelOverride).toBeNull()
  })

  it('Minor 1：全局切到与场景覆盖相同 provider 后，服务商 Select 补兜底选项而非显示裸 id', () => {
    // 全局把该配置切到 custom-chatgpt2api（草稿被消费，只剩 openai 草稿）；
    // 场景内存里的 imageProviderId 仍是 custom-chatgpt2api（未归一化折叠的残留值）。
    let onCustom = switchApiProfileProvider(IMAGE_PROFILE_A, CHATGPT2API_PROVIDER.id, CHATGPT2API_PROVIDER)
    onCustom = { ...onCustom, baseUrl: 'https://chatgpt2api.example.com/v1', apiKey: 'cg-key', model: 'cg-model' }
    const settings = buildSceneReferencingSettings([onCustom])
    const scene = settings.scenes.general
    useStore.setState({
      settings: {
        ...settings,
        scenes: { ...settings.scenes, general: { ...scene, imageProviderId: CHATGPT2API_PROVIDER.id } },
      },
    })

    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    // 触发器显示该 provider 的 label（兜底选项命中），而不是裸 id
    expect(screen.getByText('chatgpt2api 网关')).toBeTruthy()
    expect(screen.queryByText(CHATGPT2API_PROVIDER.id)).toBeNull()

    // 打开下拉：兜底选项存在，仍可选「跟随」清掉残留覆盖
    fireEvent.click(screen.getByText('chatgpt2api 网关'))
    expect(document.querySelector(`[data-option-value="${CHATGPT2API_PROVIDER.id}"]`)).toBeTruthy()
    clickSelectOption('')
    expect(useStore.getState().settings.scenes.general.imageProviderId).toBeNull()
  })

  it('Minor 2：onBlur trim 后与已存值相同时跳过提交，但输入框回写 trim 后文本', () => {
    const profile = buildProfileWithDraft()
    useStore.setState({
      settings: buildSceneReferencingSettings([profile], { imageModelOverride: 'scene-model' }),
    })

    render(<SceneSettingsDrawer scene="general" onClose={() => {}} />)

    const modelInput = screen.getByLabelText('模型 ID') as HTMLInputElement
    expect(modelInput.value).toBe('scene-model')
    // 输入同值但带空白：blur 后不重复提交，且输入框不留残留空白
    fireEvent.change(modelInput, { target: { value: '  scene-model  ' } })
    fireEvent.blur(modelInput)
    expect((screen.getByLabelText('模型 ID') as HTMLInputElement).value).toBe('scene-model')
    expect(useStore.getState().settings.scenes.general.imageModelOverride).toBe('scene-model')
  })
})
