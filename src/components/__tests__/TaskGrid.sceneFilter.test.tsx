// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import TaskGrid from '../TaskGrid'
import { useStore } from '../../store'
import type { TaskRecord } from '../../types'

function buildTask(id: string, prompt: string, createdAt: number, sceneId?: TaskRecord['sceneId']): TaskRecord {
  return {
    id,
    prompt,
    params: {},
    status: 'done',
    outputImages: [],
    createdAt,
    sceneId,
  } as unknown as TaskRecord
}

const TASKS: TaskRecord[] = [
  buildTask('portrait-1', '人像写真任务甲', 3000, 'portrait'),
  buildTask('general-1', '通用创作任务乙', 2000, 'general'),
  // 旧任务无 sceneId，应视为 general
  buildTask('legacy-1', '旧版无场景任务丙', 1000),
]

describe('TaskGrid 场景过滤（回归：选择器必须返回稳定引用）', () => {
  let consoleErrors: string[]

  beforeEach(() => {
    // jsdom 无 IntersectionObserver；TaskGrid 滚动哨兵需要它
    class IntersectionObserverStub {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)

    // 回归防线：不稳定的选择器会让 React 19 报
    // “The result of getSnapshot should be cached to avoid an infinite loop”
    // 并升级为 Maximum update depth exceeded。jsdom 下可能只表现为 console error，
    // 因此断言该错误不出现。
    consoleErrors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '))
    })

    useStore.setState({
      tasks: TASKS,
      gallerySceneFilter: 'all',
      searchQuery: '',
      filterStatus: 'all',
      filterFavorite: false,
      selectedTaskIds: [],
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('gallerySceneFilter=all 时渲染全部任务', () => {
    render(<TaskGrid />)

    expect(screen.getByText('人像写真任务甲')).toBeTruthy()
    expect(screen.getByText('通用创作任务乙')).toBeTruthy()
    expect(screen.getByText('旧版无场景任务丙')).toBeTruthy()
  })

  it('设置 gallerySceneFilter=portrait 后只显示对应场景任务且不触发无限渲染', async () => {
    render(<TaskGrid />)

    await act(async () => {
      useStore.getState().setGallerySceneFilter('portrait')
    })

    await waitFor(() => {
      expect(screen.getByText('人像写真任务甲')).toBeTruthy()
    })
    expect(screen.queryByText('通用创作任务乙')).toBeNull()
    expect(screen.queryByText('旧版无场景任务丙')).toBeNull()

    const forbidden = consoleErrors.filter((m) =>
      m.includes('Maximum update depth') || m.includes('getSnapshot should be cached'))
    expect(forbidden).toEqual([])
  })

  it('旧任务无 sceneId 时归入 general 场景', async () => {
    render(<TaskGrid />)

    await act(async () => {
      useStore.getState().setGallerySceneFilter('general')
    })

    await waitFor(() => {
      expect(screen.getByText('通用创作任务乙')).toBeTruthy()
    })
    expect(screen.getByText('旧版无场景任务丙')).toBeTruthy()
    expect(screen.queryByText('人像写真任务甲')).toBeNull()

    const forbidden = consoleErrors.filter((m) =>
      m.includes('Maximum update depth') || m.includes('getSnapshot should be cached'))
    expect(forbidden).toEqual([])
  })
})
