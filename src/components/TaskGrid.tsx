import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask } from '../store'
import { filterAndSortTasks } from '../lib/taskFilters'
import TaskCard from './TaskCard'
import type { TaskRecord } from '../types'

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const defaultFavoriteCollectionId = useStore((s) => s.defaultFavoriteCollectionId)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  // 增量渲染：初始 60 张 + 滚动哨兵每次追加 60——500+ 任务的画廊不再全量
  // 渲染 DOM；配合卡片 content-visibility 让屏幕外内容跳过 layout/paint。
  const RENDER_BATCH = 60
  const [renderLimit, setRenderLimit] = useState(RENDER_BATCH)
  const sentinelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    setRenderLimit(RENDER_BATCH)
  }, [searchQuery, filterStatus, filterFavorite, activeFavoriteCollectionId])
  const [selectionBox, setSelectionBox] = useState<{ startPageX: number; startPageY: number; currentPageX: number; currentPageY: number } | null>(null)
  const dragStart = useRef<{ pageX: number; pageY: number } | null>(null)
  const lastClientPoint = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const isDragging = useRef(false)
  const dragScrollIntervalRef = useRef<number | null>(null)
  const dragScrollDirectionRef = useRef<-1 | 1 | null>(null)
  const lastToastTimeRef = useRef(0)
  const suppressClickUntil = useRef(0)
  const startedOnCard = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  const filteredTasks = useMemo(() => filterAndSortTasks(tasks, {
    searchQuery,
    filterStatus,
    filterFavorite,
    activeFavoriteCollectionId,
    defaultFavoriteCollectionId,
  }), [tasks, searchQuery, filterStatus, filterFavorite, activeFavoriteCollectionId, defaultFavoriteCollectionId])

  // 哨兵是否还需挂载（还有未渲染的卡片）
  const hasMoreToRender = filteredTasks.length > renderLimit
  // 哨兵条件渲染（还有更多时才挂载），effect 必须随其出现/重挂重连观察器——
  // 空依赖会在 filter 切换后观察已卸载的旧哨兵，无限滚动静默失效。
  useEffect(() => {
    if (!hasMoreToRender) return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setRenderLimit((limit) => limit + RENDER_BATCH)
      }
    }, { rootMargin: '800px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMoreToRender, renderLimit])

  const handleDelete = useCallback((task: typeof tasks[0]) => {
    setConfirmDialog({
      title: '删除任务',
      message: '确定要删除这个任务吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => removeTask(task),
    })
  }, [setConfirmDialog])

  // 稳定回调：TaskCard 已 memo 化，这里必须提供引用稳定的 props，
  // 否则每次 TaskGrid 渲染都生成新闭包让 memo 失效。
  const handleCardClick = useCallback((task: TaskRecord) => (e: React.MouseEvent | React.TouchEvent) => {
    if (Date.now() < suppressClickUntil.current) {
      e.preventDefault()
      return
    }
    suppressClickUntil.current = 0
    const isCtrl = isMac ? (e as React.MouseEvent).metaKey : (e as React.MouseEvent).ctrlKey
    if (isCtrl) {
      useStore.getState().toggleTaskSelection(task.id)
      return
    }
    setDetailTaskId(task.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMac, setDetailTaskId])

  // 每张卡一个 memo 化的 handler（keyed by task 引用），避免内联箭头函数破坏 TaskCard 的 memo
  const cardClickCache = useRef(new WeakMap<TaskRecord, (e: React.MouseEvent | React.TouchEvent) => void>())
  const getCardClick = useCallback((task: TaskRecord) => {
    let handler = cardClickCache.current.get(task)
    if (!handler) {
      handler = handleCardClick(task)
      cardClickCache.current.set(task, handler)
    }
    return handler
  }, [handleCardClick])
  const cardActionCaches = useRef({
    reuse: new WeakMap<TaskRecord, () => void>(),
    editOutputs: new WeakMap<TaskRecord, () => void>(),
    delete: new WeakMap<TaskRecord, () => void>(),
  })
  const getCardAction = useCallback((
    kind: keyof typeof cardActionCaches.current,
    task: TaskRecord,
    invoke: (t: TaskRecord) => void,
  ) => {
    const cache = cardActionCaches.current[kind]
    let handler = cache.get(task)
    if (!handler) {
      handler = () => invoke(task)
      cache.set(task, handler)
    }
    return handler
  }, [])

  const handleReuse = useCallback((task: TaskRecord) => {
    reuseConfig(task)
  }, [])

  const handleEditOutputs = useCallback((task: TaskRecord) => {
    editOutputs(task)
  }, [])

  const handleCardDelete = useCallback((task: TaskRecord) => {
    handleDelete(task)
  }, [handleDelete])

  const getPagePoint = (clientX: number, clientY: number) => ({
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
  })

  const beginSelection = (target: HTMLElement, clientX: number, clientY: number, isCtrl: boolean) => {
    const point = getPagePoint(clientX, clientY)

    startedOnCard.current = Boolean(target.closest('.task-card-wrapper'))
    startedWithCtrl.current = isCtrl
    initialSelection.current = [...useStore.getState().selectedTaskIds]

    isDragging.current = true
    hasDragged.current = false
    dragStart.current = point
    lastClientPoint.current = { x: clientX, y: clientY }
    document.body.classList.add('select-none')
    document.body.classList.add('drag-selecting')
    setSelectionBox({
      startPageX: point.pageX,
      startPageY: point.pageY,
      currentPageX: point.pageX,
      currentPageY: point.pageY,
    })
  }

  const updateSelectionFromPoint = (pageX: number, pageY: number) => {
    const start = dragStart.current
    if (!start || !gridRef.current) return

    const minX = Math.min(start.pageX, pageX)
    const maxX = Math.max(start.pageX, pageX)
    const minY = Math.min(start.pageY, pageY)
    const maxY = Math.max(start.pageY, pageY)

    const cards = gridRef.current.querySelectorAll('.task-card-wrapper')
    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect()
      const taskId = card.getAttribute('data-task-id')
      if (!taskId) return

      const cardLeft = rect.left + window.scrollX
      const cardRight = rect.right + window.scrollX
      const cardTop = rect.top + window.scrollY
      const cardBottom = rect.bottom + window.scrollY

      const isIntersecting =
        minX < cardRight && maxX > cardLeft && minY < cardBottom && maxY > cardTop

      if (isIntersecting) {
        if (initialSelected.has(taskId)) {
          newSelected.delete(taskId)
        } else {
          newSelected.add(taskId)
        }
      } else if (!initialSelected.has(taskId)) {
        newSelected.delete(taskId)
      }
    })

    setSelectedTaskIds(Array.from(newSelected))
  }

  useEffect(() => {
    const stopDragScroll = () => {
      if (dragScrollIntervalRef.current) {
        clearInterval(dragScrollIntervalRef.current)
        dragScrollIntervalRef.current = null
      }
      dragScrollDirectionRef.current = null
    }

    const startDragScroll = (direction: -1 | 1) => {
      if (dragScrollIntervalRef.current && dragScrollDirectionRef.current === direction) return
      stopDragScroll()
      dragScrollDirectionRef.current = direction
      dragScrollIntervalRef.current = window.setInterval(() => {
        window.scrollBy({ top: direction * 15, behavior: 'instant' })
      }, 16)
    }

    const endSelection = (clearEmptySurfaceClick = false, suppressClick = false) => {
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      if (isDragging.current && clearEmptySurfaceClick && !hasDragged.current && !startedOnCard.current && !startedWithCtrl.current) {
        clearSelection()
      }
      if (isDragging.current && suppressClick && hasDragged.current) {
        suppressClickUntil.current = Date.now() + 250
      }
      stopDragScroll()
      isDragging.current = false
      dragStart.current = null
      lastClientPoint.current = null
      setSelectionBox(null)
    }

    const getEventElement = (e: MouseEvent) => {
      if (e.target instanceof Element) return e.target
      return document.elementFromPoint(e.clientX, e.clientY)
    }

    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const target = getEventElement(e)
      if (!target) return
      if (!target.closest('[data-drag-select-surface]')) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select], [data-lightbox-root]')) return
      if (target.closest('button, a, input, textarea, select')) return

      const isCtrl = isMac ? e.metaKey : e.ctrlKey
      beginSelection(target as HTMLElement, e.clientX, e.clientY, isCtrl)
      e.preventDefault()
    }

    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStart.current) return

      const start = dragStart.current
      const point = getPagePoint(e.clientX, e.clientY)
      lastClientPoint.current = { x: e.clientX, y: e.clientY }
      const distance = Math.hypot(point.pageX - start.pageX, point.pageY - start.pageY)
      if (distance < 6 && !hasDragged.current) return

      hasDragged.current = true
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
      e.preventDefault()

      const scrollThreshold = 40
      if (e.clientY < scrollThreshold) {
        startDragScroll(-1)
      } else if (e.clientY > window.innerHeight - scrollThreshold) {
        startDragScroll(1)
      } else {
        stopDragScroll()
      }
    }

    const handleDocumentScroll = () => {
      if (!isDragging.current || !dragStart.current || !lastClientPoint.current || !hasDragged.current) return

      const point = getPagePoint(lastClientPoint.current.x, lastClientPoint.current.y)
      const start = dragStart.current
      setSelectionBox({
        startPageX: start.pageX,
        startPageY: start.pageY,
        currentPageX: point.pageX,
        currentPageY: point.pageY,
      })
      updateSelectionFromPoint(point.pageX, point.pageY)
    }

    const handleDocumentWheel = (e: WheelEvent) => {
      if (!isDragging.current) return
      if ((e.buttons & 1) === 0) {
        endSelection()
        return
      }
      if (!hasDragged.current) return
      if (!e.ctrlKey && !e.metaKey) return

      e.preventDefault()
      const now = Date.now()
      if (now - lastToastTimeRef.current > 3000) {
        lastToastTimeRef.current = now
        const keyName = isMac ? '⌘' : 'Ctrl'
        useStore.getState().showToast(`松开 ${keyName} 键使用滚轮，或拖至边缘自动滚动`, 'info')
      }
    }

    const handleDocumentMouseUp = () => {
      endSelection(true, true)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown, true)
    document.addEventListener('mousemove', handleDocumentMouseMove, true)
    document.addEventListener('mouseup', handleDocumentMouseUp, true)
    document.addEventListener('wheel', handleDocumentWheel, { capture: true, passive: false })
    window.addEventListener('scroll', handleDocumentScroll, true)
    return () => {
      stopDragScroll()
      document.removeEventListener('mousedown', handleDocumentMouseDown, true)
      document.removeEventListener('mousemove', handleDocumentMouseMove, true)
      document.removeEventListener('mouseup', handleDocumentMouseUp, true)
      document.removeEventListener('wheel', handleDocumentWheel, true)
      window.removeEventListener('scroll', handleDocumentScroll, true)
    }
  }, [clearSelection, isMac])

  if (!filteredTasks.length) {
    return (
      <div className="relative min-h-[220px] overflow-hidden rounded-xl border border-dashed border-stone-300/80 bg-white/45 px-4 py-8 text-center shadow-inner dark:border-white/[0.1] dark:bg-white/[0.025] sm:min-h-[46vh] sm:py-16">
        <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-[#df7b57]/50 to-transparent" />
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-stone-200 bg-white text-[#356c82] shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-[#8ec5d7] sm:h-16 sm:w-16 sm:rounded-2xl">
          <svg className="h-6 w-6 sm:h-8 sm:w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.4}
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        </div>
        <div className="mx-auto mt-3 max-w-md sm:mt-5">
          <h3 className="text-sm font-semibold text-stone-800 dark:text-stone-100">
            {searchQuery || filterFavorite ? '没有匹配的任务' : '准备生成新图片'}
          </h3>
          <p className="mt-2 hidden text-sm leading-6 text-stone-500 dark:text-stone-400 sm:block">
            {searchQuery || filterFavorite ? '当前筛选条件下没有可显示的任务。' : '当前画布还没有生成结果。'}
          </p>
        </div>
        <div className="mx-auto mt-6 hidden max-w-sm grid-cols-3 gap-2 text-left sm:grid">
          {['提示词', '参数', '输出'].map((label) => (
            <div key={label} className="rounded-lg border border-stone-200/80 bg-stone-50/80 px-3 py-2 dark:border-white/[0.08] dark:bg-black/18">
              <div className="h-1.5 w-8 rounded-full bg-[#df7b57]/70" />
              <div className="mt-2 text-[11px] font-medium text-stone-500 dark:text-stone-400">{label}</div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div 
      ref={rootRef}
      data-task-grid-root
      className="relative min-h-[50vh]"
    >
      <div ref={gridRef} className="grid grid-cols-1 gap-3 pb-10 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:gap-5">
        {filteredTasks.slice(0, renderLimit).map((task) => (
          <div
            key={task.id}
            className="task-card-wrapper [content-visibility:auto] [contain-intrinsic-size:auto_162px]"
            data-task-id={task.id}
          >
            <TaskCard
              task={task}
              onClick={getCardClick(task)}
              onReuse={getCardAction('reuse', task, handleReuse)}
              onEditOutputs={getCardAction('editOutputs', task, handleEditOutputs)}
              onDelete={getCardAction('delete', task, handleCardDelete)}
              isSelected={selectedTaskIds.includes(task.id)}
            />
          </div>
        ))}
      </div>
      {hasMoreToRender && (
        <button
          type="button"
          ref={sentinelRef}
          onClick={() => setRenderLimit((limit) => limit + RENDER_BATCH)}
          className="w-full py-6 text-center text-xs text-stone-400 transition-colors hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
        >
          加载更早任务…（{renderLimit} / {filteredTasks.length}）
        </button>
      )}
      {selectionBox && (
        <div
          className="fixed bg-blue-500/20 border border-blue-500/50 pointer-events-none z-[30]"
          style={{
            left: Math.min(selectionBox.startPageX, selectionBox.currentPageX) - window.scrollX,
            top: Math.min(selectionBox.startPageY, selectionBox.currentPageY) - window.scrollY,
            width: Math.abs(selectionBox.currentPageX - selectionBox.startPageX),
            height: Math.abs(selectionBox.currentPageY - selectionBox.startPageY),
          }}
        />
      )}
    </div>
  )
}
