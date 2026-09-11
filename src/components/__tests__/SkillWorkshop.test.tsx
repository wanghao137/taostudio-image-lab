// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SkillWorkshop } from '../SkillWorkshop'
import { useStore, makeSkillExpansionState } from '../../store'
import { DEFAULT_SETTINGS, createDefaultOpenAIProfile, normalizeSettings } from '../../lib/apiProfiles'
import type { SkillSummary, TaskRecord } from '../../types'

const SKILL_A: SkillSummary = {
  id: 'vibeshot',
  name: 'Vibeshot 抓拍',
  title: '生活感随手抓拍写真',
  description: '生活感人像抓拍风格',
  source: 'builtin',
  body: '# 正文 A',
}
const SKILL_B: SkillSummary = {
  id: 'voyeur',
  name: 'Voyeur 风格',
  description: '偷窥视角摄影风格',
  source: 'builtin',
  body: '# 正文 B',
}
const SKILL_LOCAL: SkillSummary = {
  id: 'my-skill',
  name: '我的本地 Skill',
  description: '本地导入的风格',
  source: 'local',
  body: '# 正文 C',
}

const IMAGE_PROFILE = createDefaultOpenAIProfile({ id: 'image-a', name: '生图配置A' })
const TEXT_PROFILE = createDefaultOpenAIProfile({ id: 'text-c', name: '文本配置C', apiMode: 'responses', model: 'gpt-test-text' })

function buildSettings(withTextProfile: boolean) {
  const profiles = withTextProfile ? [IMAGE_PROFILE, TEXT_PROFILE] : [IMAGE_PROFILE]
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles,
    activeProfileId: IMAGE_PROFILE.id,
    activeScene: 'skill',
  })
}

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

function seedStore(options: { withTextProfile?: boolean } = {}) {
  useStore.setState({
    settings: buildSettings(options.withTextProfile ?? true),
    skills: {
      builtin: [SKILL_A, SKILL_B],
      builtinLoading: false,
      local: [SKILL_LOCAL],
      localRootName: 'my-skills',
      scanning: false,
    },
    activeSkillId: SKILL_A.id,
    skillInputDraft: '主题：夜市人像',
    skillExpansion: makeSkillExpansionState({
      entries: [
        { id: 'e1', text: '提示词一', enabled: true },
        { id: 'e2', text: '提示词二', enabled: true },
      ],
    }),
    tasks: [
      buildTask('skill-1', 3000, 'skill'),
      buildTask('general-1', 2500, 'general'),
      buildTask('skill-2', 2000, 'skill'),
    ],
  })
}

describe('SkillWorkshop', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('渲染 skill 列表（内置/本地分区）、激活 skill 详情与锚点输入', () => {
    seedStore()
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    // 左列：分区标题与计数、三个 skill 条目（激活 skill 的 title 在左列与右列各出现一次，name 以副行保留）
    expect(screen.getByText('内置 (2)')).toBeTruthy()
    expect(screen.getByText('本地 (1)')).toBeTruthy()
    expect(screen.getAllByText('生活感随手抓拍写真')).toHaveLength(2)
    expect(screen.getAllByText('生活感人像抓拍风格')).toHaveLength(2)
    expect(screen.getByText('Vibeshot 抓拍')).toBeTruthy()
    expect(screen.getByText('Voyeur 风格')).toBeTruthy()
    expect(screen.getByText('我的本地 Skill')).toBeTruthy()
    expect(screen.getByText('导入目录')).toBeTruthy()
    expect(screen.getByText('重新扫描')).toBeTruthy()
    const anchor = screen.getByLabelText('锚点输入') as HTMLTextAreaElement
    expect(anchor.value).toBe('主题：夜市人像')

    // 扩写结果条目与生成按钮计数（2 条全部启用）
    expect(screen.getByLabelText('条目 1 提示词')).toBeTruthy()
    expect(screen.getByLabelText('条目 2 提示词')).toBeTruthy()
    expect(screen.getByRole('button', { name: '生成 2 张图片' })).toBeTruthy()
  })

  it('skill 含 title 时主显 title 且保留 name 副行；无 title 时回落 name', () => {
    seedStore()
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    // 有 title：左列列表项与右侧详情主标题均主显中文 title
    expect(screen.getAllByText('生活感随手抓拍写真')).toHaveLength(2)
    // 右侧详情在 title 下方以小字等宽保留英文 name，可追溯
    expect(screen.getByText('Vibeshot 抓拍')).toBeTruthy()
    // 无 title 的 skill（内置 B / 本地）主行回落 name，不渲染重复副行
    expect(screen.getByText('Voyeur 风格')).toBeTruthy()
    expect(screen.getByText('我的本地 Skill')).toBeTruthy()
  })

  it('严格模式/条数控件、扩写模型透明化与单条重写按钮', () => {
    seedStore()
    const rerollSkillEntry = vi.spyOn(useStore.getState(), 'rerollSkillEntry').mockResolvedValue(undefined)
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    // E. 扩写模型透明化：小字展示生效的文本档案名与模型
    expect(screen.getByText('扩写模型：文本配置C · gpt-test-text')).toBeTruthy()

    // B. 严格模式开关（默认开）与条数选择（1-10，默认 5），联动 store 偏好
    const strictToggle = screen.getByLabelText('严格模式') as HTMLInputElement
    expect(strictToggle.checked).toBe(true)
    fireEvent.click(strictToggle)
    expect(useStore.getState().skillExpansion.strictMode).toBe(false)
    const countSelect = screen.getByLabelText('扩写条数') as HTMLSelectElement
    expect(countSelect.value).toBe('5')
    fireEvent.change(countSelect, { target: { value: '3' } })
    expect(useStore.getState().skillExpansion.entryCount).toBe(3)

    // D. 单条重写：点击调用 rerollSkillEntry(下标)
    fireEvent.click(screen.getByRole('button', { name: '重写条目 2' }))
    expect(rerollSkillEntry).toHaveBeenCalledWith(1)
  })

  it('扩写运行中按阶段显示按钮文案，warning 黄条独立于 error 红色文案', () => {
    seedStore()
    useStore.setState({
      skillExpansion: makeSkillExpansionState({
        status: 'running',
        phase: 'extracting',
        entries: [{ id: 'e1', text: '提示词一', enabled: true }],
      }),
    })
    const { rerender } = render(<SkillWorkshop onOpenSceneSettings={() => {}} />)
    expect(screen.getByRole('button', { name: '抽取变量中…' })).toBeTruthy()

    // 成文阶段 + 警告级消息（降级提示）以黄条展示
    useStore.setState({
      skillExpansion: makeSkillExpansionState({
        status: 'running',
        phase: 'composing',
        degraded: true,
        warning: '严格模式变量抽取解析失败，已回退单轮扩写',
        entries: [{ id: 'e1', text: '提示词一', enabled: true }],
      }),
    })
    rerender(<SkillWorkshop onOpenSceneSettings={() => {}} />)
    expect(screen.getByRole('button', { name: '扩写中…' })).toBeTruthy()
    expect(screen.getByText('严格模式变量抽取解析失败，已回退单轮扩写')).toBeTruthy()
  })

  it('最近生成条只显示 sceneId=skill 的任务且点击打开详情', () => {
    seedStore()
    const setDetailTaskId = vi.spyOn(useStore.getState(), 'setDetailTaskId').mockImplementation(() => {})
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    expect(screen.getByText('最近生成')).toBeTruthy()
    const thumbs = screen.getAllByRole('button', { name: '查看任务详情' })
    expect(thumbs).toHaveLength(2)

    fireEvent.click(thumbs[0])
    expect(setDetailTaskId).toHaveBeenCalledWith('skill-1')
  })

  it('勾掉一条扩写条目后生成按钮计数变化且 store 同步', () => {
    seedStore()
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    fireEvent.click(screen.getByRole('checkbox', { name: '启用条目 1' }))

    expect(screen.getByRole('button', { name: '生成 1 张图片' })).toBeTruthy()
    expect(useStore.getState().skillExpansion.entries[0].enabled).toBe(false)
  })

  it('扩写进行中左列点击不切换 skill（防误触中断在飞请求）', () => {
    seedStore()
    useStore.setState({
      skillExpansion: makeSkillExpansionState({
        status: 'running',
        phase: 'composing',
        entries: [{ id: 'e1', text: '提示词一', enabled: true }],
      }),
    })
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: /Voyeur 风格/ }))

    expect(useStore.getState().activeSkillId).toBe(SKILL_A.id)
  })

  it('无可用文本模型时扩写按钮位置显示引导与「打开设置」', () => {
    seedStore({ withTextProfile: false })
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    expect(screen.queryByRole('button', { name: '扩写提示词' })).toBeNull()
    expect(screen.getByText('未找到可用的文本模型配置（需 Responses 类型），可在设置→API 中添加')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
    expect(useStore.getState().showSettings).toBe(true)
  })

  it('内置 skill 为空时显示加载失败引导，点击重试调用 loadBuiltinSkills', () => {
    seedStore()
    useStore.setState({
      skills: {
        builtin: [],
        builtinLoading: false,
        local: [],
        localRootName: null,
        scanning: false,
      },
    })
    const loadBuiltinSkills = vi.spyOn(useStore.getState(), 'loadBuiltinSkills').mockResolvedValue(undefined)
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    fireEvent.click(screen.getByText('内置 skill 加载失败，点击重试'))
    expect(loadBuiltinSkills).toHaveBeenCalled()
  })

  it('未绑定本地目录时不显示「清除」按钮', () => {
    seedStore()
    useStore.setState({ skills: { ...useStore.getState().skills, localRootName: null } })
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    expect(screen.queryByRole('button', { name: '清除已绑定的本地 skills 目录' })).toBeNull()
  })

  it('已绑定本地目录时显示「清除」，点击调用解绑并断言 store 状态清空', async () => {
    seedStore()
    // jsdom 无 IndexedDB：mock action 复刻 store 真实行为（清 local 列表 + localRootName）
    const clearSkillsRootDirectory = vi
      .spyOn(useStore.getState(), 'clearSkillsRootDirectory')
      .mockImplementation(async () => {
        useStore.setState((state) => ({ skills: { ...state.skills, local: [], localRootName: null } }))
      })
    render(<SkillWorkshop onOpenSceneSettings={() => {}} />)

    const clearButton = screen.getByRole('button', { name: '清除已绑定的本地 skills 目录' })
    expect(clearButton.getAttribute('title')).toBe('解绑本地 skills 目录，并清空已导入的本地列表')

    fireEvent.click(clearButton)
    await waitFor(() => expect(clearSkillsRootDirectory).toHaveBeenCalled())

    expect(useStore.getState().skills.local).toEqual([])
    expect(useStore.getState().skills.localRootName).toBeNull()
    // localRootName 清空后按钮随之消失
    await waitFor(() => expect(screen.queryByRole('button', { name: '清除已绑定的本地 skills 目录' })).toBeNull())
  })
})
