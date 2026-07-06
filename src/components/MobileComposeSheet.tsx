import { lazy, Suspense, useState } from 'react'
import { ImageUp, Sparkles, ChevronDown } from 'lucide-react'
import { useImageComposer } from '../hooks/useImageComposer'
import { useMobileSheet } from '../hooks/useMobileSheet'
import { useStore } from '../store'
import { DEFAULT_FAL_IMAGE_SIZE } from '../lib/paramCompatibility'
import MobileMoreParamsSheet from './MobileMoreParamsSheet'

// SizePickerModal 已是独立组件；懒加载以匹配桌面 InputBar 的用法。
const SizePickerModal = lazy(() => import('./SizePickerModal'))

/**
 * 移动端主力交互：从底部滑出的全屏创作抽屉。
 * 复用 useImageComposer（与桌面 InputBar 共享逻辑）。
 * 参数降级：尺寸/质量/数量/4K 常驻为胶囊，格式/透明/审核/精确尺寸 收进「+ 更多」二级 sheet。
 */
export default function MobileComposeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const composer = useImageComposer()
  const {
    prompt, setPrompt, inputImages,
    params, setParams, nInput, setNInput,
    submitCurrentMode, hasSubmitApiConfig, canSubmit, activeAgentIsRunning, stopActiveAgentResponse,
    commitN,
    handleFiles, atImageLimit, uploadImageTooltipText,
    applyAsset4KOriginalRatioPreset,
    isFalTextToImage,
  } = composer
  const removeInputImage = useStore((s) => s.removeInputImage)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const sheet = useMobileSheet({ open, onClose })
  const [moreOpen, setMoreOpen] = useState(false)
  const [sizePickerOpen, setSizePickerOpen] = useState(false)

  if (!open) return null

  const onSubmit = () => {
    if (activeAgentIsRunning) return stopActiveAgentResponse()
    if (hasSubmitApiConfig) return submitCurrentMode()
    setShowSettings(true)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:hidden">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={sheet.sheetRef}
        style={{ transform: `translateY(${sheet.dragTranslateY}px)`, paddingBottom: sheet.keyboardInset }}
        className="safe-area-bottom relative flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-[#f7f2ec] dark:bg-[#13100d]"
      >
        {/* 抓手 */}
        <div
          className="flex shrink-0 cursor-grab items-center justify-center py-2 active:cursor-grabbing"
          onPointerDown={sheet.onDragStart}
          onPointerMove={sheet.onDragMove}
          onPointerUp={sheet.onDragEnd}
        >
          <div className="h-1 w-10 rounded-full bg-stone-300 dark:bg-stone-600" />
        </div>

        {/* 可滚动内容 */}
        <div className="flex-1 overflow-y-auto px-4 pb-2">
          {/* 大输入框 */}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="描述你想生成的图片，可输入 @ 来指定参考图..."
            rows={4}
            className="w-full resize-none rounded-xl border border-stone-200 bg-white p-3 text-base text-stone-900 placeholder:text-stone-400 focus:border-[#df7b57] focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-stone-50"
          />

          {/* 上传 + 已挂图预览 */}
          <div className="mt-3 flex items-center gap-2">
            <label className={`flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700 dark:border-white/10 dark:bg-white/5 dark:text-stone-200 ${atImageLimit ? 'opacity-50' : ''}`}>
              <ImageUp className="h-4 w-4" />
              上传图片
              <input type="file" accept="image/*" multiple className="hidden" disabled={atImageLimit}
                onChange={(e) => e.target.files && handleFiles(e.target.files)} />
            </label>
            <span className="text-xs text-stone-400">{uploadImageTooltipText}</span>
          </div>
          {inputImages.length > 0 && (
            <div className="mt-2 flex gap-2 overflow-x-auto">
              {inputImages.map((img, i) => (
                <div key={img.id} className="relative shrink-0">
                  <img src={img.dataUrl} alt="" className="h-14 w-14 rounded-lg object-cover" />
                  <button onClick={() => removeInputImage(i)} className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-stone-800 text-xs text-white">×</button>
                </div>
              ))}
            </div>
          )}

          {/* 一行胶囊：尺寸 / 质量 / 数量 / 4K / 更多 */}
          <div className="mt-3 flex flex-wrap gap-2">
            <Chip label="尺寸" value={params.size === 'auto' ? '自动' : params.size} onClick={() => setSizePickerOpen(true)} />
            <Chip label="质量" value={params.quality === 'auto' ? '自动' : params.quality} onClick={() => {
              const next = params.quality === 'auto' ? 'high' : params.quality === 'high' ? 'medium' : params.quality === 'medium' ? 'low' : 'auto'
              setParams({ quality: next as typeof params.quality })
            }} />
            <Chip label="数量" value={`×${nInput || params.n}`} onClick={() => {
              const next = Math.min(4, (parseInt(nInput) || params.n) + 1)
              setNInput(String(next))
              commitN()
            }} />
            <button onClick={applyAsset4KOriginalRatioPreset} className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-600 dark:border-white/10 dark:bg-white/5 dark:text-stone-300">
              4K
            </button>
            <button onClick={() => setMoreOpen(true)} className="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-600 dark:border-white/10 dark:bg-white/5 dark:text-stone-300">
              + 更多
            </button>
          </div>
        </div>

        {/* 主按钮（底部固定） */}
        <div className="shrink-0 border-t border-stone-200/60 p-3 dark:border-white/5">
          <button
            onClick={onSubmit}
            disabled={activeAgentIsRunning ? false : hasSubmitApiConfig ? !canSubmit : false}
            className={`flex w-full items-center justify-center gap-2 rounded-xl bg-[#df7b57] py-3 text-base font-semibold text-white ${(activeAgentIsRunning ? false : hasSubmitApiConfig ? !canSubmit : false) ? 'opacity-50' : 'active:scale-[0.99]'}`}
          >
            <Sparkles className="h-5 w-5" />
            {activeAgentIsRunning ? '停止' : '生成图像'}
          </button>
        </div>
      </div>

      <MobileMoreParamsSheet open={moreOpen} onClose={() => setMoreOpen(false)} />

      {sizePickerOpen && (
        <Suspense fallback={null}>
          <SizePickerModal
            currentSize={isFalTextToImage && params.size === 'auto' ? DEFAULT_FAL_IMAGE_SIZE : params.size}
            onSelect={(size) => setParams({ size })}
            onClose={() => setSizePickerOpen(false)}
            allowAuto={!isFalTextToImage}
          />
        </Suspense>
      )}
    </div>
  )
}

function Chip({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 dark:border-white/10 dark:bg-white/5 dark:text-stone-200">
      <span className="text-stone-400">{label}</span>
      <span className="font-medium">{value}</span>
      <ChevronDown className="h-3 w-3 text-stone-400" />
    </button>
  )
}
