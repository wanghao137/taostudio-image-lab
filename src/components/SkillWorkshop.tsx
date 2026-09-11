import { useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, Settings2, Sparkles, Trash2, Upload } from 'lucide-react'
import { useStore } from '../store'
import { getSceneTextApiProfileResolution } from '../lib/apiProfiles'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../lib/imageCache'
import { Checkbox } from './Checkbox'
import type { SkillSummary, TaskRecord } from '../types'

const CARD_CLASS_NAME = 'mt-4 overflow-hidden rounded-2xl border border-stone-200/80 bg-white/70 shadow-[0_18px_50px_rgba(72,54,35,0.08)] ring-1 ring-white/70 backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-[0_18px_60px_rgba(0,0,0,0.28)] dark:ring-white/[0.04]'
const SECTION_TITLE_CLASS_NAME = 'text-xs font-semibold text-stone-500 dark:text-stone-400'
const HINT_CLASS_NAME = 'text-[11px] leading-relaxed text-stone-400 dark:text-stone-500'

const PRIMARY_BUTTON_CLASS_NAME = 'inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#df7b57] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#c96a49] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[#df7b57] dark:hover:bg-[#e88a68] dark:disabled:hover:bg-[#df7b57]'
const SECONDARY_BUTTON_CLASS_NAME = 'inline-flex items-center justify-center gap-1.5 rounded-xl bg-stone-100/80 px-4 py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-200 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-stone-100/80 disabled:hover:text-stone-700 dark:bg-white/[0.06] dark:text-stone-300 dark:hover:bg-white/[0.1] dark:hover:text-white'

const ANCHOR_TEXTAREA_CLASS_NAME = 'mt-1.5 w-full resize-y rounded-xl border border-stone-200/80 bg-white/60 px-3 py-2.5 text-sm leading-relaxed text-stone-700 outline-none transition focus:border-[#df7b57]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-stone-200 dark:focus:border-[#ffb096]/40'
const ENTRY_TEXTAREA_CLASS_NAME = 'min-w-0 flex-1 resize-y rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-[13px] leading-relaxed text-stone-700 outline-none transition focus:border-stone-300 dark:text-stone-200 dark:focus:border-white/[0.15]'

/**
 * Skill 工坊（第 4 场景）：左列内置/本地 skill 列表，右列锚点输入 → 文本模型
 * 扩写 → 逐条编辑/勾选 → 批量生成，底部最近生成缩略条（sceneId=skill）。
 * 状态全部来自 store（Task 4 状态机），本组件只做展示与接线。
 */
export function SkillWorkshop({ onOpenSceneSettings }: { onOpenSceneSettings: () => void }) {
  const skills = useStore((s) => s.skills)
  const activeSkillId = useStore((s) => s.activeSkillId)
  const skillInputDraft = useStore((s) => s.skillInputDraft)
  const skillExpansion = useStore((s) => s.skillExpansion)
  const settings = useStore((s) => s.settings)
  const tasks = useStore((s) => s.tasks)
  const loadBuiltinSkills = useStore((s) => s.loadBuiltinSkills)
  const importSkillsRootDirectory = useStore((s) => s.importSkillsRootDirectory)
  const refreshLocalSkills = useStore((s) => s.refreshLocalSkills)
  const clearSkillsRootDirectory = useStore((s) => s.clearSkillsRootDirectory)
  const setActiveSkill = useStore((s) => s.setActiveSkill)
  const setSkillInputDraft = useStore((s) => s.setSkillInputDraft)
  const runSkillExpansion = useStore((s) => s.runSkillExpansion)
  const abortSkillExpansion = useStore((s) => s.abortSkillExpansion)
  const updateSkillEntry = useStore((s) => s.updateSkillEntry)
  const removeSkillEntry = useStore((s) => s.removeSkillEntry)
  const generateFromSkillEntries = useStore((s) => s.generateFromSkillEntries)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setShowSettings = useStore((s) => s.setShowSettings)

  // 挂载时加载内置 skill：已有结果或在加载中则跳过（StrictMode 双调用安全）
  useEffect(() => {
    const state = useStore.getState()
    if (state.skills.builtin.length || state.skills.builtinLoading) return
    void state.loadBuiltinSkills()
  }, [])

  const activeSkill = useMemo(
    () => [...skills.builtin, ...skills.local].find((skill) => skill.id === activeSkillId) ?? null,
    [skills, activeSkillId],
  )

  // 派生过滤一律在组件内 useMemo（useStore 选择器只允许返回稳定引用）
  const recentSkillTasks = useMemo(
    () => tasks.filter((task) => task.sceneId === 'skill' && task.status === 'done' && task.outputImages.length > 0).slice(0, 12),
    [tasks],
  )

  const expansionRunning = skillExpansion.status === 'running'
  const enabledCount = useMemo(() => skillExpansion.entries.filter((entry) => entry.enabled).length, [skillExpansion.entries])
  const hasTextProfile = useMemo(() => getSceneTextApiProfileResolution(settings).profile !== null, [settings])

  return (
    <section data-no-drag-select data-ui-summary className={CARD_CLASS_NAME}>
      {/* 工坊标题栏 + 场景设置入口 */}
      <div className="flex items-center justify-between gap-3 border-b border-stone-200/70 px-4 py-3 dark:border-white/[0.06]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#df7b57] shadow-[0_0_0_4px_rgba(223,123,87,0.14)]" />
          <h2 className="truncate text-sm font-semibold text-stone-900 dark:text-stone-50">Skill 工坊</h2>
        </div>
        <button
          type="button"
          onClick={onOpenSceneSettings}
          aria-label="场景设置"
          title="场景设置"
          className="shrink-0 rounded-lg p-1.5 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 dark:text-stone-400 dark:hover:bg-white/[0.08] dark:hover:text-stone-100"
        >
          <Settings2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* 左列：内置 / 本地 skill 列表 */}
        <aside className="min-w-0 border-b border-stone-200/70 p-3 lg:border-b-0 lg:border-r dark:border-white/[0.06]">
          <div className="flex items-center justify-between gap-2 px-1">
            <span className={SECTION_TITLE_CLASS_NAME}>内置 ({skills.builtin.length})</span>
            {skills.builtinLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-stone-400" aria-hidden />}
          </div>
          <div className="mt-1.5 space-y-1">
            {skills.builtin.length ? (
              skills.builtin.map((skill) => (
                <SkillListItem
                  key={skill.id}
                  skill={skill}
                  active={skill.id === activeSkillId}
                  disabled={expansionRunning}
                  onSelect={() => setActiveSkill(skill.id)}
                />
              ))
            ) : !skills.builtinLoading ? (
              <button
                type="button"
                onClick={() => { void loadBuiltinSkills() }}
                className="w-full rounded-xl px-3 py-2 text-left text-xs text-amber-600 transition-colors hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-500/10"
              >
                内置 skill 加载失败，点击重试
              </button>
            ) : null}
          </div>

          <div className="mt-4">
            <span className={`${SECTION_TITLE_CLASS_NAME} px-1`}>本地 ({skills.local.length})</span>
            {skills.local.length ? (
              <div className="mt-1.5 space-y-1">
                {skills.local.map((skill) => (
                  <SkillListItem
                    key={skill.id}
                    skill={skill}
                    active={skill.id === activeSkillId}
                    disabled={expansionRunning}
                    onSelect={() => setActiveSkill(skill.id)}
                  />
                ))}
              </div>
            ) : (
              <p className={`${HINT_CLASS_NAME} mt-1.5 px-1`}>
                尚无本地 skill，点击「导入目录」选择包含 SKILL.md 子目录的文件夹即可使用自定义 skill。
              </p>
            )}
            {skills.localRootName && (
              <p className={`${HINT_CLASS_NAME} mt-1.5 truncate px-1`} title={skills.localRootName}>
                目录：{skills.localRootName}
              </p>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { void importSkillsRootDirectory() }}
                disabled={skills.scanning}
                className={SECONDARY_BUTTON_CLASS_NAME + ' px-2 py-2 text-xs'}
              >
                <Upload className="h-3.5 w-3.5" aria-hidden />
                导入目录
              </button>
              <button
                type="button"
                onClick={() => { void refreshLocalSkills() }}
                disabled={!skills.localRootName || skills.scanning}
                className={SECONDARY_BUTTON_CLASS_NAME + ' px-2 py-2 text-xs'}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${skills.scanning ? 'animate-spin' : ''}`} aria-hidden />
                重新扫描
              </button>
              {skills.localRootName && (
                <button
                  type="button"
                  onClick={() => { void clearSkillsRootDirectory() }}
                  disabled={skills.scanning}
                  aria-label="清除已绑定的本地 skills 目录"
                  title="解绑本地 skills 目录，并清空已导入的本地列表"
                  className={SECONDARY_BUTTON_CLASS_NAME + ' px-2 py-2 text-xs'}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  清除
                </button>
              )}
            </div>
          </div>
        </aside>

        {/* 右列：激活 skill 详情与扩写工作区 */}
        <div className="min-w-0 space-y-4 p-4">
          <div>
            <h3 className="text-base font-bold text-stone-900 dark:text-stone-50">
              {activeSkill ? (activeSkill.title ?? activeSkill.name) : '未选择 skill'}
            </h3>
            {activeSkill?.title && activeSkill.title !== activeSkill.name && (
              <p className="mt-0.5 truncate font-mono text-xs text-stone-400 dark:text-stone-500">{activeSkill.name}</p>
            )}
            {activeSkill?.description && (
              <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">{activeSkill.description}</p>
            )}
          </div>

          <div>
            <span className={SECTION_TITLE_CLASS_NAME}>锚点输入</span>
            <textarea
              aria-label="锚点输入"
              value={skillInputDraft}
              onChange={(event) => setSkillInputDraft(event.target.value)}
              rows={3}
              placeholder="输入角色名 / 主题 / 场景设定，例如：一位穿校服的少女在夜市散步"
              className={ANCHOR_TEXTAREA_CLASS_NAME}
            />
          </div>

          {!hasTextProfile ? (
            // 无可用文本模型：与反推 noProfile 同款引导（文案与 store 校验错误一致）
            <div className="rounded-xl border border-yellow-200/70 bg-yellow-50 px-3 py-2.5 text-xs leading-relaxed text-yellow-700 dark:border-yellow-500/20 dark:bg-yellow-500/10 dark:text-yellow-200">
              <p>未找到可用的文本模型配置（需 Responses 类型），可在设置→API 中添加</p>
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="mt-2 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
              >
                打开设置
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { void runSkillExpansion() }}
                disabled={expansionRunning || !activeSkill || !skillInputDraft.trim()}
                className={PRIMARY_BUTTON_CLASS_NAME}
              >
                {expansionRunning
                  ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  : <Sparkles className="h-4 w-4" aria-hidden />}
                {expansionRunning ? '扩写中…' : '扩写提示词'}
              </button>
              {expansionRunning && (
                <button type="button" onClick={abortSkillExpansion} className={SECONDARY_BUTTON_CLASS_NAME}>
                  停止
                </button>
              )}
            </div>
          )}

          {skillExpansion.error && (
            <p className="text-xs leading-relaxed text-red-500 dark:text-red-300">扩写失败：{skillExpansion.error}</p>
          )}

          {skillExpansion.entries.length > 0 && (
            <div className="space-y-2">
              <span className={SECTION_TITLE_CLASS_NAME}>
                扩写结果（{skillExpansion.entries.length} 条，勾选后参与生成）
              </span>
              {skillExpansion.entries.map((entry, index) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 rounded-xl border border-stone-200/70 bg-white/60 p-2.5 dark:border-white/[0.06] dark:bg-white/[0.03]"
                >
                  <Checkbox
                    checked={entry.enabled}
                    onChange={(checked) => updateSkillEntry(entry.id, { enabled: checked })}
                    aria-label={`启用条目 ${index + 1}`}
                    className="mt-1.5 shrink-0"
                  />
                  <textarea
                    aria-label={`条目 ${index + 1} 提示词`}
                    value={entry.text}
                    onChange={(event) => updateSkillEntry(entry.id, { text: event.target.value })}
                    rows={2}
                    className={ENTRY_TEXTAREA_CLASS_NAME}
                  />
                  <button
                    type="button"
                    onClick={() => removeSkillEntry(entry.id)}
                    aria-label={`删除条目 ${index + 1}`}
                    title="删除"
                    className="mt-1 shrink-0 rounded-lg p-1.5 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div>
            <button
              type="button"
              onClick={() => { void generateFromSkillEntries() }}
              disabled={enabledCount === 0}
              className={PRIMARY_BUTTON_CLASS_NAME}
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              生成 {enabledCount} 张图片
            </button>
            <p className={`${HINT_CLASS_NAME} mt-1.5`}>生成任务在后台执行，可继续编辑或切换其他场景查看进度。</p>
          </div>

          {recentSkillTasks.length > 0 && (
            <div className="space-y-2">
              <span className={SECTION_TITLE_CLASS_NAME}>最近生成</span>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {recentSkillTasks.map((task) => (
                  <RecentTaskThumb key={task.id} task={task} onOpen={() => setDetailTaskId(task.id)} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function SkillListItem({
  skill,
  active,
  disabled,
  onSelect,
}: {
  skill: SkillSummary
  active: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      title={disabled ? '扩写进行中，等待完成或点击「停止」后再切换' : skill.description}
      className={`block w-full rounded-xl border px-3 py-2 text-left transition-colors ${
        active
          ? 'border-[#df7b57]/40 bg-[#df7b57]/10'
          : 'border-transparent hover:bg-stone-100/80 dark:hover:bg-white/[0.05]'
      } ${disabled && !active ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <span className={`block truncate text-[13px] font-medium ${
        active ? 'text-[#b4552f] dark:text-[#ffb096]' : 'text-stone-700 dark:text-stone-200'
      }`}>
        {skill.title ?? skill.name}
      </span>
      <span className="mt-0.5 block truncate text-xs text-stone-400 dark:text-stone-500">{skill.description}</span>
    </button>
  )
}

/** 最近生成缩略块：取任务首图缩略（复用 TaskCard 的 imageCache 订阅模式），点击打开任务详情 */
function RecentTaskThumb({ task, onOpen }: { task: TaskRecord; onOpen: () => void }) {
  const [thumbSrc, setThumbSrc] = useState('')

  useEffect(() => {
    setThumbSrc('')
    let cancelled = false
    const imageId = task.outputImages?.[0]
    let unsubscribe: (() => void) | undefined

    if (imageId) {
      unsubscribe = subscribeImageThumbnail(imageId, (thumbnail) => {
        if (!cancelled) setThumbSrc(thumbnail.dataUrl)
      })
      ensureImageThumbnailCached(imageId)
        .then((thumbnail) => {
          if (!cancelled && thumbnail) setThumbSrc(thumbnail.dataUrl)
        })
        .catch(() => {
          if (!cancelled) setThumbSrc('')
        })
    }

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [task.outputImages])

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="查看任务详情"
      title={task.prompt}
      className="group relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-stone-200/80 bg-stone-100/80 transition-colors hover:border-[#df7b57]/50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:hover:border-[#ffb096]/40"
    >
      {thumbSrc ? (
        <img
          src={thumbSrc}
          data-image-id={task.outputImages[0]}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
        />
      ) : (
        <Sparkles className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-stone-300 dark:text-stone-600" aria-hidden />
      )}
    </button>
  )
}

export default SkillWorkshop
