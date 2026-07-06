import type { ReactNode } from 'react'
import { useImageComposer } from '../hooks/useImageComposer'
import { useMobileSheet } from '../hooks/useMobileSheet'

/**
 * 移动端二级参数 sheet（格式 / 透明 / 审核 / 精确尺寸）。
 * 从 MobileComposeSheet 的「+ 更多」打开，z-60 高于创作抽屉。
 */
export default function MobileMoreParamsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    params, setParams,
    transparentOutputEnabled, showTransparentOutputControl,
    exactSizeEnabled, exactSizeDisabled,
    moderationDisabled,
  } = useImageComposer()
  const sheet = useMobileSheet({ open, onClose })

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:hidden" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        ref={sheet.sheetRef}
        style={{ transform: `translateY(${sheet.dragTranslateY}px)`, paddingBottom: sheet.keyboardInset }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={sheet.onDragStart}
        onPointerMove={sheet.onDragMove}
        onPointerUp={sheet.onDragEnd}
        className="safe-area-bottom relative w-full max-h-[80vh] overflow-y-auto rounded-t-2xl bg-white p-4 dark:bg-[#1a1612]"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-300 dark:bg-stone-600" />
        <h3 className="mb-3 text-sm font-semibold text-stone-900 dark:text-stone-50">更多参数</h3>

        <Row label="格式">
          <Seg
            value={params.output_format}
            options={[['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP']]}
            onChange={(v) => setParams({ output_format: v as typeof params.output_format })}
          />
        </Row>

        {showTransparentOutputControl && (
          <Row label="透明背景">
            <Toggle on={transparentOutputEnabled} onClick={() => setParams({ transparent_output: !transparentOutputEnabled })} />
          </Row>
        )}

        {!moderationDisabled && (
          <Row label="审核">
            <Seg
              value={params.moderation}
              options={[['auto', '自动'], ['low', '宽松']]}
              onChange={(v) => setParams({ moderation: v as typeof params.moderation })}
            />
          </Row>
        )}

        {!exactSizeDisabled && (
          <Row label="精确尺寸">
            <Toggle on={exactSizeEnabled} onClick={() => setParams({ exact_size: !exactSizeEnabled })} />
          </Row>
        )}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-stone-100 py-3 dark:border-white/5">
      <span className="text-sm text-stone-700 dark:text-stone-200">{label}</span>
      {children}
    </div>
  )
}
function Seg({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1 rounded-lg bg-stone-100 p-0.5 dark:bg-white/5">
      {options.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)} className={`rounded-md px-3 py-1 text-xs ${value === v ? 'bg-white text-stone-900 shadow dark:bg-white/15 dark:text-stone-50' : 'text-stone-500'}`}>{l}</button>
      ))}
    </div>
  )
}
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`relative h-6 w-11 rounded-full transition ${on ? 'bg-[#df7b57]' : 'bg-stone-300 dark:bg-stone-600'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${on ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  )
}
