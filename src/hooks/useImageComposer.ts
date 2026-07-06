import { useCallback } from 'react'
import { useHintTooltip } from './useHintTooltip'

/**
 * 图像创作 hook（从 InputBar 提取）。
 * 本版本是种子：只含 n-limit hint 子系统的基础部分。
 * 后续任务会扩展 prompt/params/profile/4K 等逻辑。
 */
export function useImageComposer() {
  const nLimitHint = useHintTooltip({ autoHideMs: 2000 })

  const showNLimitHint = useCallback(() => {
    nLimitHint.show()
  }, [nLimitHint])

  const hideNLimitHint = useCallback(() => {
    nLimitHint.hide()
  }, [nLimitHint])

  const clearAgentNHintTouchTimer = useCallback(() => {
    nLimitHint.clearTimer()
  }, [nLimitHint])

  return {
    nLimitHint,
    showNLimitHint,
    hideNLimitHint,
    clearAgentNHintTouchTimer,
  }
}
