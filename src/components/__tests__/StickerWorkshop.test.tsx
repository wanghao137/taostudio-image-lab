// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StickerWorkshop } from '../StickerWorkshop'
import { submitTask, useStore, makeSpriteGifState } from '../../store'
import { DEFAULT_SETTINGS, createDefaultOpenAIProfile, normalizeSettings } from '../../lib/apiProfiles'
import { DEFAULT_PARAMS } from '../../types'
import type { TaskRecord } from '../../types'

// 分区 A 的「一键生成」直接调模块级 submitTask（SkillWorkshop 同模式）：partial mock
// 让提交动作可断言，其余 store 能力保持真实实现
vi.mock('../../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store')>()
  return { ...actual, submitTask: vi.fn(async () => {}) }
})

const IMAGE_PROFILE = createDefaultOpenAIProfile({
  id: 'image-a',
  name: '生图配置A',
  apiKey: 'sk-test',
  baseUrl: 'https://api.example.com',
})

function buildTask(id: string, createdAt: number, sceneId?: TaskRecord['sceneId']): TaskRecord {
  return {
    id,
    prompt: `任务 ${id}`,
    params: {},
    status: 'done',
    outputImages: [`img-${id}`],
    createdAt,
    sceneId,
  } as unknown as TaskRecord
}

// zustand setState 是重载类型，Parameters<> 会取到最后一个「整状态替换」重载；
// 覆盖块用 Partial<State> 表达
type StorePatch = Partial<ReturnType<typeof useStore.getState>>

function seedStore(overrides: StorePatch = {}) {
  useStore.setState({
    settings: normalizeSettings({
      ...DEFAULT_SETTINGS,
      profiles: [IMAGE_PROFILE],
      activeProfileId: IMAGE_PROFILE.id,
      activeScene: 'sticker',
    }),
    params: { ...DEFAULT_PARAMS, size: '1024x1024' },
    spriteGif: makeSpriteGifState(),
    toast: null,
    ...overrides,
  })
}

describe('StickerWorkshop', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('渲染两分区与 8 个动作预设 chips，点击切换 motionId（单选高亮）', () => {
    seedStore()
    render(<StickerWorkshop onOpenSceneSettings={() => {}} />)

    expect(screen.getByRole('heading', { name: '表情与头像工作台' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '静态表情 / 头像快捷生成' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '战斗动图工坊（Sprite GIF）' })).toBeTruthy()
    // 8 个动作预设全部渲染，默认 sword-slash 高亮
    const slash = screen.getByRole('button', { name: '挥剑连斩' })
    expect(slash.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getAllByRole('button', { name: /连斩|连击|施法|奔跑|受击|待机|劈砍|射击/ })).toHaveLength(8)

    fireEvent.click(screen.getByRole('button', { name: '出拳连击' }))
    expect(useStore.getState().spriteGif.motionId).toBe('punch-combo')
    expect(screen.getByRole('button', { name: '出拳连击' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '挥剑连斩' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('generating 中按钮禁用并按细阶段显示文案，动作 chips 同步禁用', () => {
    seedStore({
      spriteGif: makeSpriteGifState({ status: 'generating', phase: 'fetching' }),
    })
    const { rerender } = render(<StickerWorkshop onOpenSceneSettings={() => {}} />)

    const generate = screen.getByRole('button', { name: '生成精灵图中…' })
    expect((generate as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '出拳连击' }) as HTMLButtonElement).disabled).toBe(true)

    useStore.setState({ spriteGif: makeSpriteGifState({ status: 'generating', phase: 'processing' }) })
    rerender(<StickerWorkshop onOpenSceneSettings={() => {}} />)
    expect(screen.getByRole('button', { name: '切分对齐中…' })).toBeTruthy()
  })

  it('ready 后渲染帧条：缩略图、切换勾选、删除与警告黄条', () => {
    seedStore({
      spriteGif: makeSpriteGifState({
        status: 'ready',
        frames: [
          { id: 'f1', dataUrl: 'data:image/png;base64,1', enabled: true },
          { id: 'f2', dataUrl: 'data:image/png;base64,2', enabled: true },
          { id: 'f3', dataUrl: 'data:image/png;base64,3', enabled: true },
        ],
        warnings: ['第 3 格为空格，已剔除'],
        sheetDataUrl: 'data:image/png;base64,sheet',
      }),
    })
    render(<StickerWorkshop onOpenSceneSettings={() => {}} />)

    // 预览区渲染 + 帧条 3 帧缩略 + 警告黄条 + sheet 折叠入口
    expect(screen.getByAltText('动图预览')).toBeTruthy()
    expect(screen.getByLabelText('切换帧 1')).toBeTruthy()
    expect(screen.getByText('第 3 格为空格，已剔除')).toBeTruthy()
    expect(screen.getByText(/查看原始精灵图/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '导出 GIF' })).toBeTruthy()

    fireEvent.click(screen.getByLabelText('切换帧 2'))
    expect(useStore.getState().spriteGif.frames[1].enabled).toBe(false)
    fireEvent.click(screen.getByLabelText('删除帧 3'))
    expect(useStore.getState().spriteGif.frames.map((frame) => frame.id)).toEqual(['f1', 'f2'])
  })

  it('帧率滑杆绑定 frameMs 并显示 fps', () => {
    seedStore({
      spriteGif: makeSpriteGifState({
        status: 'ready',
        frames: [{ id: 'f1', dataUrl: 'data:image/png;base64,1', enabled: true }],
      }),
    })
    render(<StickerWorkshop onOpenSceneSettings={() => {}} />)

    // 默认 80ms（12.5fps）
    expect(screen.getByText(/80ms \/ 帧（12\.5fps）/)).toBeTruthy()
    const slider = screen.getByLabelText('帧间隔（毫秒）') as HTMLInputElement
    expect(slider.value).toBe('80')
    fireEvent.change(slider, { target: { value: '120' } })
    expect(useStore.getState().spriteGif.frameMs).toBe(120)
    expect(screen.getByText(/120ms \/ 帧（8\.3fps）/)).toBeTruthy()
  })

  it('静态快捷生成：表情 chip 填入 + 一键生成走 setPrompt+submitTask（纯文生图先清输入图）', async () => {
    seedStore({
      tasks: [
        buildTask('sticker-1', 3000, 'sticker'),
        buildTask('general-1', 2500, 'general'),
        buildTask('sticker-2', 2000, 'sticker'),
      ],
    })
    const clearInputImages = vi.spyOn(useStore.getState(), 'clearInputImages')
    render(<StickerWorkshop onOpenSceneSettings={() => {}} />)

    // 最近生成 strip：只显示 sceneId=sticker 的 2 个任务
    expect(screen.getByText('最近生成')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '查看任务详情' })).toHaveLength(2)

    // 空描述时按钮禁用；chip 点击填入后可用
    const generate = screen.getByRole('button', { name: '一键生成' }) as HTMLButtonElement
    expect(generate.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '开心大笑' }))
    expect((screen.getByLabelText('描述想要的表情或头像') as HTMLTextAreaElement).value).toBe('开心大笑')
    expect((screen.getByRole('button', { name: '一键生成' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '一键生成' }))
    expect(clearInputImages).toHaveBeenCalled()
    expect(useStore.getState().prompt).toBe('开心大笑')
    expect(submitTask).toHaveBeenCalledTimes(1)
  })

  it('无可用生图档案时显示 noProfile 引导与「打开设置」', () => {
    seedStore({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, activeScene: 'sticker' }),
    })
    render(<StickerWorkshop onOpenSceneSettings={() => {}} />)

    expect(screen.getByText('未找到可用的生图 API 配置，可在设置→API 中添加')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '生成战斗动图' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
    expect(useStore.getState().showSettings).toBe(true)
  })
})
