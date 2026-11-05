// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StickerWorkshop } from '../StickerWorkshop'
import { submitTask, useStore } from '../../store'
import { DEFAULT_SETTINGS, createDefaultOpenAIProfile, normalizeSettings } from '../../lib/apiProfiles'
import { DEFAULT_PARAMS, type TaskRecord } from '../../types'
import { DEFAULT_GIF_OPTIONS, readGifMetadata } from '../../lib/gif'
import { ANIMATED_GIF } from '../../lib/__fixtures__/gif'
import { downloadImageIds } from '../../lib/downloadImages'
import { createPrivacyModeState } from '../../lib/privacyMode'

vi.mock('../../store', async (original) => ({ ...await original<typeof import('../../store')>(), submitTask: vi.fn(async () => []) }))
vi.mock('../../lib/imageCache', async (original) => ({ ...await original<typeof import('../../lib/imageCache')>(), ensureImageCached: vi.fn(async () => ANIMATED_GIF), ensureImageThumbnailCached: vi.fn(async () => ({ src: 'data:image/png;base64,poster' })) }))
vi.mock('../../lib/downloadImages', async (original) => ({ ...await original<typeof import('../../lib/downloadImages')>(), downloadImageIds: vi.fn(async () => ({ successCount: 1, failCount: 0 })) }))
vi.mock('../../lib/dbWeb', async (original) => ({ ...await original<typeof import('../../lib/dbWeb')>(), safeCreateImageThumbnail: vi.fn(async () => ({ thumbnailDataUrl: 'data:image/png;base64,poster' })) }))
const profile = createDefaultOpenAIProfile({ id: 'image-a', name: '生图配置 A', apiKey: 'test-only', baseUrl: 'https://example.test', apiMode: 'responses', streamImages: true })
function seed(tasks: TaskRecord[] = []) {
  localStorage.removeItem('gif-workbench-v1')
  useStore.setState({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id, activeScene: 'sticker' }), params: { ...DEFAULT_PARAMS }, prompt: '', tasks, toast: null, showSettings: false, inputImages: [{ id: 'old-image', dataUrl: 'data:image/png;base64,old' }] })
}
const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({ id: 'gif-a', prompt: '纸灯笼摇晃', params: { ...DEFAULT_PARAMS, output_format: 'gif', gif: DEFAULT_GIF_OPTIONS }, inputImageIds: [], outputImages: ['output-a'], maskImageId: null, maskTargetImageId: null, status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1, animation: readGifMetadata(ANIMATED_GIF), ...overrides })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('通用 GIF 工作台', () => {
  it('移除静态快捷区和战斗精灵图，提供通用描述与时序', () => {
    seed(); render(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    expect(screen.getByRole('heading', { name: 'GIF 工作台' })).toBeTruthy()
    expect(screen.queryByText('静态表情 / 头像快捷生成')).toBeNull()
    expect(screen.queryByText(/战斗动图工坊/)).toBeNull()
    expect(screen.getByText('1.80 秒 / 周期')).toBeTruthy()
    expect((screen.getByRole('button', { name: '生成 GIF' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('提交独立 GIF 参数，不清除或重写其他场景的参考图与参数', async () => {
    seed(); render(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    fireEvent.change(screen.getByLabelText('动画描述'), { target: { value: '产品慢慢旋转，首尾衔接' } })
    fireEvent.change(screen.getByLabelText('GIF 帧数'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('GIF 每帧时长'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('GIF 生成模型'), { target: { value: 'gpt-image-2.6-sunburst' } })
    fireEvent.click(screen.getByRole('button', { name: '生成 GIF' }))
    await waitFor(() => expect(submitTask).toHaveBeenCalledTimes(1))
    expect(submitTask).toHaveBeenCalledWith(expect.objectContaining({ gif: { prompt: '产品慢慢旋转，首尾衔接', params: expect.objectContaining({ output_format: 'gif', exact_size: false, size: 'auto', gif: { model: 'gpt-image-2.6-sunburst', frame_count: 12, frame_duration_ms: 100, complexity: 'high' } }) } }))
    expect(useStore.getState().inputImages[0].id).toBe('old-image')
    expect(useStore.getState().params.output_format).toBe('png')
    expect(profile.apiMode).toBe('responses')
  })
  it('参数错误阻止提交，运行中保留明确状态', () => {
    seed([task({ status: 'running', outputImages: [] })]); render(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    expect(screen.getByText('正在生成动画')).toBeTruthy()
    expect((screen.getByRole('button', { name: '生成中…' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('GIF 帧数'), { target: { value: '65' } })
    expect(screen.getByText('GIF 帧数须为 2–64 的整数')).toBeTruthy()
  })
  it('从持久任务预览、停止播放并下载 GIF 原件', async () => {
    seed([task(), task({ id: 'static-old', params: DEFAULT_PARAMS })]); render(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    await screen.findByAltText('生成的 GIF 动画')
    expect(screen.getByText('1 个任务')).toBeTruthy()
    expect(screen.getByText(/2 × 2 · 2 帧 · 0.40 秒/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '停止预览' }))
    expect(screen.getByAltText('GIF 静态封面')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下载 GIF 原件' }))
    await waitFor(() => expect(downloadImageIds).toHaveBeenCalledWith(['output-a'], 'gif-gif-a'))
  })
  it('展示生成失败与缺失配置，不伪装成功', () => {
    seed([task({ status: 'error', outputImages: [], error: '当前配置未开通 GIF' })])
    useStore.setState({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, activeScene: 'sticker' }) })
    render(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    expect(screen.getByText('当前配置未开通 GIF')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开 API 设置' }))
    expect(useStore.getState().showSettings).toBe(true)
  })
  it('显示服务商忽略时序或尺寸、另附静态图的事实', async () => {
    seed([task({ params: { ...DEFAULT_PARAMS, output_format: 'gif', gif: DEFAULT_GIF_OPTIONS, size: '512x512' }, gifCompanionCount: 1 })])
    render(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    await screen.findByAltText('生成的 GIF 动画')
    expect(screen.getByText(/返回的帧数或时长与请求不同/)).toBeTruthy()
    expect(screen.getByText(/请求尺寸 512x512，实际返回 2 × 2/)).toBeTruthy()
    expect(screen.getByText(/服务商另附 1 张静态辅助图/)).toBeTruthy()
  })
  it('完整参数配置可恢复，多个输出分别预览和下载', async () => {
    seed([task({ params: { ...DEFAULT_PARAMS, output_format: 'gif', gif: DEFAULT_GIF_OPTIONS, n: 2 }, outputImages: ['output-a', 'output-b'], animations: [readGifMetadata(ANIMATED_GIF), readGifMetadata(ANIMATED_GIF)] })])
    const { unmount } = render(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    fireEvent.change(screen.getByLabelText('GIF 帧数'), { target: { value: '64' } })
    fireEvent.change(screen.getByLabelText('GIF 每帧尺寸'), { target: { value: '512x512' } })
    fireEvent.change(screen.getByLabelText('GIF 画质'), { target: { value: 'max' } })
    fireEvent.change(screen.getByLabelText('GIF 生成数量'), { target: { value: '2' } })
    unmount()
    render(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    expect((screen.getByLabelText('GIF 帧数') as HTMLInputElement).value).toBe('64')
    expect((screen.getByLabelText('GIF 每帧尺寸') as HTMLInputElement).value).toBe('512x512')
    expect((screen.getByLabelText('GIF 画质') as HTMLSelectElement).value).toBe('max')
    fireEvent.click(screen.getByRole('button', { name: /^动画 2$/ }))
    await screen.findByAltText('生成的 GIF 动画')
    fireEvent.click(screen.getByRole('button', { name: '下载 GIF 原件' }))
    await waitFor(() => expect(downloadImageIds).toHaveBeenCalledWith(['output-b'], 'gif-gif-a-2'))
  })
  it('隐私模式隐藏进入前已存在的 GIF 任务，新任务仍可见', () => {
    const hidden = task({ id: 'gif-hidden', createdAt: 1 })
    const fresh = task({ id: 'gif-new', createdAt: 9_999 })
    seed([hidden])
    // 进入隐私模式时把既有任务标记为隐藏（复用真实 createPrivacyModeState 语义）
    const privacy = createPrivacyModeState({ ...useStore.getState(), tasks: [hidden], batchProgress: null } as unknown as Parameters<typeof createPrivacyModeState>[0], 5_000)
    useStore.setState({ privacyMode: privacy, tasks: [hidden, fresh] })
    render(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    expect(screen.getByText('1 个任务')).toBeTruthy()
  })
})
