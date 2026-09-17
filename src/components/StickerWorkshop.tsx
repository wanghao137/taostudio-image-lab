import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Settings2, Sparkles, X } from 'lucide-react'
import { submitTask, useStore } from '../store'
import { getSceneImageApiProfile, validateApiProfile } from '../lib/apiProfiles'
import { SPRITE_MOTION_PRESETS } from '../lib/stickerSplit/spriteSheet'
import type { SpriteExportSize } from '../lib/stickerSplit/spriteExport'
import { DEFAULT_FAL_IMAGE_SIZE } from '../lib/paramCompatibility'
import { normalizeCodexCliImageSize, normalizeImageSize } from '../lib/size'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../lib/imageCache'
import type { TaskRecord } from '../types'

const SizePickerModal = lazy(() => import('./SizePickerModal'))

// 样式常量与 SkillWorkshop 同款（按任务书约定复制不提取，保持两工坊独立演进）
const CARD_CLASS_NAME = 'mt-4 overflow-hidden rounded-2xl border border-stone-200/80 bg-white/70 shadow-[0_18px_50px_rgba(72,54,35,0.08)] ring-1 ring-white/70 backdrop-blur-xl dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-[0_18px_60px_rgba(0,0,0,0.28)] dark:ring-white/[0.04]'
const SECTION_TITLE_CLASS_NAME = 'text-xs font-semibold text-stone-500 dark:text-stone-400'
const HINT_CLASS_NAME = 'text-[11px] leading-relaxed text-stone-400 dark:text-stone-500'

const PRIMARY_BUTTON_CLASS_NAME = 'inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#df7b57] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#c96a49] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[#df7b57] dark:hover:bg-[#e88a68] dark:disabled:hover:bg-[#df7b57]'
const SECONDARY_BUTTON_CLASS_NAME = 'inline-flex items-center justify-center gap-1.5 rounded-xl bg-stone-100/80 px-4 py-2.5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-200 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-stone-100/80 disabled:hover:text-stone-700 dark:bg-white/[0.06] dark:text-stone-300 dark:hover:bg-white/[0.1] dark:hover:text-white'

const ANCHOR_TEXTAREA_CLASS_NAME = 'mt-1.5 w-full resize-y rounded-xl border border-stone-200/80 bg-white/60 px-3 py-2.5 text-sm leading-relaxed text-stone-700 outline-none transition focus:border-[#df7b57]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-stone-200 dark:focus:border-[#ffb096]/40'

const CHIP_CLASS_NAME = 'rounded-full border border-stone-200/80 bg-white/60 px-2.5 py-1 text-xs text-stone-600 transition-colors hover:border-[#df7b57]/40 hover:text-[#b4552f] disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-stone-300 dark:hover:border-[#ffb096]/40 dark:hover:text-[#ffb096]'
const CHIP_ACTIVE_CLASS_NAME = CHIP_CLASS_NAME + ' border-[#df7b57]/60 bg-[#df7b57]/10 text-[#b4552f] hover:border-[#df7b57]/60 hover:text-[#b4552f] dark:border-[#ffb096]/50 dark:bg-[#df7b57]/15 dark:text-[#ffb096] dark:hover:border-[#ffb096]/50 dark:hover:text-[#ffb096]'

/** 静态表情快捷 chips：点击填入描述框 */
const STICKER_EXPRESSION_CHIPS = ['开心大笑', '生气鼓脸', '委屈巴巴', '比心', '惊讶', '睡觉', '吃饭', '打工人'] as const

/** 网格规格：2×2/3×3/4×4（默认 4×4） */
const SPRITE_GRID_OPTIONS = [2, 3, 4] as const

const SPRITE_EXPORT_SIZE_OPTIONS: Array<{ value: SpriteExportSize; label: string }> = [
  { value: 256, label: '256' },
  { value: 512, label: '512' },
  { value: 'original', label: '原尺寸' },
]

/**
 * 表情与头像工作台（sticker 场景专属视图，镜像 SkillWorkshop 模式）：
 * 分区 A 静态表情/头像快捷生成（submitTask 走画廊任务系统，sceneId=sticker）；
 * 分区 B 战斗动图工坊（Sprite GIF）：生成 → 去底 → 切帧 → 对齐 → 预览/导出，
 * 编排见 store.spriteGif，本组件只做展示与接线。
 */
export function StickerWorkshop({ onOpenSceneSettings }: { onOpenSceneSettings: () => void }) {
  const spriteGif = useStore((s) => s.spriteGif)
  const settings = useStore((s) => s.settings)
  const params = useStore((s) => s.params)
  const tasks = useStore((s) => s.tasks)
  const setParams = useStore((s) => s.setParams)
  const setPrompt = useStore((s) => s.setPrompt)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const clearMaskDraft = useStore((s) => s.clearMaskDraft)
  const showToast = useStore((s) => s.showToast)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setSpriteGifDraft = useStore((s) => s.setSpriteGifDraft)
  const generateSpriteGif = useStore((s) => s.generateSpriteGif)
  const toggleSpriteFrame = useStore((s) => s.toggleSpriteFrame)
  const removeSpriteFrame = useStore((s) => s.removeSpriteFrame)
  const setSpriteFrameMs = useStore((s) => s.setSpriteFrameMs)
  const exportSpriteGif = useStore((s) => s.exportSpriteGif)
  const exportSpriteApng = useStore((s) => s.exportSpriteApng)
  const exportSpriteFramesZip = useStore((s) => s.exportSpriteFramesZip)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)

  // 分区 A 本地态：描述草稿 + 尺寸弹层（随 sticker 场景 params 持久隔离）
  const [staticDraft, setStaticDraft] = useState('')
  const [showSizePicker, setShowSizePicker] = useState(false)
  // 分区 B 本地态：导出尺寸 + 导出进行中标记
  const [exportSize, setExportSize] = useState<SpriteExportSize>(512)
  const [exportBusy, setExportBusy] = useState<'gif' | 'apng' | 'zip' | null>(null)

  const generating = spriteGif.status === 'generating'
  const busy = generating || exportBusy !== null

  const recentStickerTasks = useMemo(
    () => tasks.filter((task) => task.sceneId === 'sticker' && task.status === 'done' && task.outputImages.length > 0).slice(0, 12),
    [tasks],
  )

  // 场景图像档案与尺寸显示：与 SkillWorkshop 同规则（fal 不允许 auto，codexCli 规整）
  const imageProfile = useMemo(() => getSceneImageApiProfile(settings), [settings])
  const imageProfileError = validateApiProfile(imageProfile)
  const isFalImage = imageProfile.provider === 'fal'
  const displaySize = isFalImage && params.size === 'auto'
    ? DEFAULT_FAL_IMAGE_SIZE
    : (imageProfile.codexCli ? normalizeCodexCliImageSize(params.size) : normalizeImageSize(params.size)) || params.size

  // 分区 A：一键生成（纯文生图语义，submitTask 自带守卫与 toast）
  const submitStaticGeneration = async () => {
    const text = staticDraft.trim()
    if (!text) {
      showToast('请先描述想要的表情或头像（可点击表情快捷填入）', 'error')
      return
    }
    // 与 Skill 工坊同语义：静态快捷生成为纯文生图，清掉本场景遗留的参考图/遮罩，
    // 避免静默携带输入图变成计费编辑请求
    clearInputImages()
    clearMaskDraft()
    setPrompt(text)
    await submitTask()
  }

  const runExport = async (kind: 'gif' | 'apng' | 'zip') => {
    if (busy) return
    setExportBusy(kind)
    try {
      if (kind === 'gif') await exportSpriteGif(exportSize)
      else if (kind === 'apng') await exportSpriteApng(exportSize)
      else await exportSpriteFramesZip()
    } finally {
      setExportBusy(null)
    }
  }

  const enabledFrames = useMemo(() => spriteGif.frames.filter((frame) => frame.enabled), [spriteGif.frames])

  // 循环预览：按 frameMs 步进 enabled 帧（帧集/帧率变化时重置）
  const [previewIndex, setPreviewIndex] = useState(0)
  useEffect(() => {
    setPreviewIndex(0)
  }, [spriteGif.frameMs, enabledFrames.length])
  useEffect(() => {
    if (!enabledFrames.length) return
    const timer = setInterval(() => {
      setPreviewIndex((index) => (index + 1) % enabledFrames.length)
    }, spriteGif.frameMs)
    return () => clearInterval(timer)
  }, [enabledFrames, spriteGif.frameMs])
  const previewFrame = enabledFrames.length ? enabledFrames[previewIndex % enabledFrames.length] : null

  return (
    <section data-no-drag-select data-ui-summary className={CARD_CLASS_NAME}>
      {/* 弹层 portal 到 body：同 SkillWorkshop（卡片 overflow-hidden 会裁剪 fixed 后代） */}
      {showSizePicker && createPortal(
        <Suspense fallback={null}>
          <SizePickerModal
            currentSize={params.size}
            onSelect={(size) => setParams({ size })}
            onClose={() => setShowSizePicker(false)}
            allowAuto={!isFalImage}
            codexCli={imageProfile.codexCli}
          />
        </Suspense>,
        document.body,
      )}
      {/* 标题栏 + 场景设置入口 */}
      <div className="flex items-center justify-between gap-3 border-b border-stone-200/70 px-4 py-3 dark:border-white/[0.06]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-[#df7b57] shadow-[0_0_0_4px_rgba(223,123,87,0.14)]" />
          <h2 className="truncate text-sm font-semibold text-stone-900 dark:text-stone-50">表情与头像工作台</h2>
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

      <div className="space-y-4 p-4">
        {/* 分区 A：静态表情/头像快捷生成 */}
        <section className="space-y-3 rounded-2xl border border-stone-200/70 bg-white/50 p-3.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <h3 className="text-base font-bold text-stone-900 dark:text-stone-50">静态表情 / 头像快捷生成</h3>
          <div>
            <span className={SECTION_TITLE_CLASS_NAME}>描述想要的表情或头像</span>
            <textarea
              aria-label="描述想要的表情或头像"
              value={staticDraft}
              onChange={(event) => setStaticDraft(event.target.value)}
              rows={2}
              placeholder="例如：圆脸橘猫开心大笑的表情包，简洁背景"
              className={ANCHOR_TEXTAREA_CLASS_NAME}
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className={HINT_CLASS_NAME}>表情：</span>
              {STICKER_EXPRESSION_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => setStaticDraft(chip)}
                  disabled={generating}
                  className={CHIP_CLASS_NAME}
                >
                  {chip}
                </button>
              ))}
            </div>
            <p className={`${HINT_CLASS_NAME} mt-1`}>点击表情快速填入；生成的任务进入本场景画廊（可在设置切换查看全部场景）。</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className={SECTION_TITLE_CLASS_NAME}>图片尺寸</span>
              <button
                type="button"
                onClick={() => setShowSizePicker(true)}
                title="选择尺寸；保存在表情与头像工作台，不被其他场景影响（跨刷新保留需开启「刷新保留输入」）"
                className="rounded-xl border border-stone-200/80 bg-white/60 px-3 py-1.5 text-left font-mono text-xs text-stone-700 shadow-sm transition-all duration-200 hover:bg-white dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-stone-200 dark:hover:bg-white/[0.06]"
              >
                {displaySize}
              </button>
            </div>
            <button
              type="button"
              onClick={() => { void submitStaticGeneration() }}
              disabled={busy || !staticDraft.trim()}
              className={PRIMARY_BUTTON_CLASS_NAME}
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              一键生成
            </button>
          </div>
          {recentStickerTasks.length > 0 && (
            <div className="space-y-2">
              <span className={SECTION_TITLE_CLASS_NAME}>最近生成</span>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {recentStickerTasks.map((task) => (
                  <RecentTaskThumb key={task.id} task={task} onOpen={() => setDetailTaskId(task.id)} />
                ))}
              </div>
            </div>
          )}
        </section>

        {/* 分区 B：战斗动图工坊（Sprite GIF） */}
        <section className="space-y-3 rounded-2xl border border-stone-200/70 bg-white/50 p-3.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <div>
            <h3 className="text-base font-bold text-stone-900 dark:text-stone-50">战斗动图工坊（Sprite GIF）</h3>
            <p className={`${HINT_CLASS_NAME} mt-0.5`}>一次生成 N×N 战斗动作精灵图 → 自动绿幕去底 → 切帧 → 帧间对齐 → 导出 GIF / APNG / 帧序列。</p>
          </div>

          <div>
            <span className={SECTION_TITLE_CLASS_NAME}>动作预设</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {SPRITE_MOTION_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setSpriteGifDraft({ motionId: preset.id })}
                  disabled={generating}
                  aria-pressed={spriteGif.motionId === preset.id}
                  className={spriteGif.motionId === preset.id ? CHIP_ACTIVE_CLASS_NAME : CHIP_CLASS_NAME}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className={SECTION_TITLE_CLASS_NAME}>角色描述（可选，无参考图时定义角色）</span>
            <textarea
              aria-label="角色补充描述"
              value={spriteGif.characterNote}
              onChange={(event) => setSpriteGifDraft({ characterNote: event.target.value })}
              rows={2}
              placeholder="例如：银发红瞳的女剑士，奇幻冒险风"
              className={ANCHOR_TEXTAREA_CLASS_NAME}
            />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-2">
              <span className={SECTION_TITLE_CLASS_NAME}>网格</span>
              <div className="flex overflow-hidden rounded-lg border border-stone-200/80 dark:border-white/[0.08]">
                {SPRITE_GRID_OPTIONS.map((grid) => (
                  <button
                    key={grid}
                    type="button"
                    onClick={() => setSpriteGifDraft({ rows: grid, cols: grid })}
                    disabled={generating}
                    aria-pressed={spriteGif.rows === grid && spriteGif.cols === grid}
                    className={`px-2.5 py-1.5 text-xs transition-colors ${
                      spriteGif.rows === grid && spriteGif.cols === grid
                        ? 'bg-[#df7b57] font-medium text-white'
                        : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/[0.06]'
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    {grid}×{grid}
                  </button>
                ))}
              </div>
            </div>
            {imageProfileError ? (
              <span className="text-xs text-amber-600 dark:text-amber-400">请先完善 API 配置：{imageProfileError}</span>
            ) : null}
          </div>

          {imageProfileError ? (
            // 无可用图像档案：与 Skill 工坊 noProfile 同款引导（文案与 store 校验错误一致）
            <div className="rounded-xl border border-yellow-200/70 bg-yellow-50 px-3 py-2.5 text-xs leading-relaxed text-yellow-700 dark:border-yellow-500/20 dark:bg-yellow-500/10 dark:text-yellow-200">
              <p>未找到可用的生图 API 配置，可在设置→API 中添加</p>
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="mt-2 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
              >
                打开设置
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { void generateSpriteGif() }}
              disabled={generating}
              className={PRIMARY_BUTTON_CLASS_NAME}
            >
              {generating
                ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                : <Sparkles className="h-4 w-4" aria-hidden />}
              {generating
                ? (spriteGif.phase === 'processing' ? '切分对齐中…' : '生成精灵图中…')
                : spriteGif.status === 'ready' ? '重新生成动图' : '生成战斗动图'}
            </button>
          )}

          {spriteGif.error && (
            <p className="text-xs leading-relaxed text-red-500 dark:text-red-300">生成失败：{spriteGif.error}</p>
          )}

          {spriteGif.frames.length > 0 && (
            <div className="space-y-2">
              <span className={SECTION_TITLE_CLASS_NAME}>
                帧条（{enabledFrames.length}/{spriteGif.frames.length} 帧参与播放与导出，点击缩略图停用/启用）
              </span>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                {spriteGif.frames.map((frame, index) => (
                  <div key={frame.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => toggleSpriteFrame(frame.id)}
                      disabled={busy}
                      aria-label={`切换帧 ${index + 1}`}
                      aria-pressed={frame.enabled}
                      title={frame.enabled ? `停用第 ${index + 1} 帧` : `启用第 ${index + 1} 帧`}
                      className={`block w-full overflow-hidden rounded-lg border bg-stone-100/80 transition-colors dark:bg-white/[0.04] ${
                        frame.enabled
                          ? 'border-[#df7b57]/50 hover:border-[#df7b57]'
                          : 'border-dashed border-stone-300 opacity-40 hover:opacity-70 dark:border-white/[0.12]'
                      } disabled:cursor-not-allowed`}
                    >
                      <img src={frame.dataUrl} alt="" loading="lazy" className="aspect-square w-full object-contain" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeSpriteFrame(frame.id)}
                      disabled={busy}
                      aria-label={`删除帧 ${index + 1}`}
                      title="删除"
                      className="absolute right-0.5 top-0.5 rounded-full bg-black/45 p-0.5 text-white opacity-0 transition-opacity hover:bg-red-500 disabled:cursor-not-allowed group-hover:opacity-100 dark:bg-black/60"
                    >
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {spriteGif.warnings.length > 0 && (
            <div className="rounded-xl border border-yellow-200/70 bg-yellow-50 px-3 py-2.5 text-xs leading-relaxed text-yellow-700 dark:border-yellow-500/20 dark:bg-yellow-500/10 dark:text-yellow-200">
              {spriteGif.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          )}

          {spriteGif.sheetDataUrl && (
            <details className="group">
              <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-xs text-stone-500 transition-colors hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200 [&::-webkit-details-marker]:hidden">
                查看原始精灵图（去底前 {spriteGif.rows}×{spriteGif.cols}）
              </summary>
              <img
                src={spriteGif.sheetDataUrl}
                alt="原始精灵图"
                className="mt-2 max-h-96 w-auto rounded-xl border border-stone-200/80 object-contain dark:border-white/[0.08]"
              />
            </details>
          )}

          {spriteGif.frames.length > 0 && (
            <div className="space-y-3 rounded-xl border border-stone-200/70 bg-white/60 p-3 dark:border-white/[0.06] dark:bg-white/[0.03]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={SECTION_TITLE_CLASS_NAME}>预览与导出</span>
                <span className={HINT_CLASS_NAME}>
                  {enabledFrames.length ? `${enabledFrames.length} 帧 · ${(1000 / spriteGif.frameMs).toFixed(1)}fps` : '没有启用帧'}
                </span>
              </div>
              <div className="flex flex-wrap items-start gap-4">
                <div className="relative flex h-40 w-40 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-stone-100 ring-1 ring-stone-200/70 dark:bg-white/[0.04] dark:ring-white/[0.06]">
                  {previewFrame ? (
                    <img
                      src={previewFrame.dataUrl}
                      alt="动图预览"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <span className={HINT_CLASS_NAME}>启用至少一帧后可预览</span>
                  )}
                  {generating && (
                    <span className="absolute inset-0 flex items-center justify-center bg-white/50 text-xs text-stone-500 backdrop-blur-[1px] dark:bg-black/40 dark:text-stone-300">
                      生成中…
                    </span>
                  )}
                </div>
                <div className="min-w-[220px] flex-1 space-y-3">
                  <label className="block">
                    <span className={SECTION_TITLE_CLASS_NAME}>
                      帧率：{spriteGif.frameMs}ms / 帧（{(1000 / spriteGif.frameMs).toFixed(1)}fps）
                    </span>
                    <input
                      type="range"
                      min={40}
                      max={300}
                      step={5}
                      value={spriteGif.frameMs}
                      onChange={(event) => setSpriteFrameMs(Number(event.target.value))}
                      disabled={busy}
                      aria-label="帧间隔（毫秒）"
                      className="mt-1.5 w-full accent-[#df7b57] disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </label>
                  <label className="flex items-center gap-2">
                    <span className={SECTION_TITLE_CLASS_NAME}>导出尺寸</span>
                    <select
                      value={String(exportSize)}
                      onChange={(event) => setExportSize(event.target.value === 'original' ? 'original' : Number(event.target.value) === 256 ? 256 : 512)}
                      disabled={busy}
                      aria-label="导出尺寸"
                      className="rounded-lg border border-stone-200/80 bg-white/60 px-2 py-1.5 text-xs text-stone-700 outline-none transition disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-stone-200"
                    >
                      {SPRITE_EXPORT_SIZE_OPTIONS.map((option) => (
                        <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { void runExport('gif') }}
                      disabled={busy || !enabledFrames.length}
                      className={PRIMARY_BUTTON_CLASS_NAME + ' px-3.5 py-2 text-xs'}
                    >
                      {exportBusy === 'gif' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                      导出 GIF
                    </button>
                    <button
                      type="button"
                      onClick={() => { void runExport('apng') }}
                      disabled={busy || !enabledFrames.length}
                      className={SECONDARY_BUTTON_CLASS_NAME + ' px-3.5 py-2 text-xs'}
                    >
                      {exportBusy === 'apng' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                      导出 APNG
                    </button>
                    <button
                      type="button"
                      onClick={() => { void runExport('zip') }}
                      disabled={busy || !enabledFrames.length}
                      className={SECONDARY_BUTTON_CLASS_NAME + ' px-3.5 py-2 text-xs'}
                    >
                      {exportBusy === 'zip' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                      帧 ZIP（原尺寸 PNG）
                    </button>
                  </div>
                  <p className={HINT_CLASS_NAME}>GIF 适配微信等聊天软件（1-bit 透明）；APNG 保留完整半透明；帧 ZIP 为原始尺寸 PNG 序列。</p>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  )
}

/** 最近生成缩略块：与 SkillWorkshop.RecentTaskThumb 同模式（复制；点击打开任务详情） */
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

export default StickerWorkshop
