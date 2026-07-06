import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore, submitTask, submitAgentMessage, stopAgentResponse, addImageFromFile } from '../store'
import { DEFAULT_PARAMS } from '../types'
import { getActiveApiProfile, normalizeSettings } from '../lib/apiProfiles'
import { DEFAULT_FAL_IMAGE_SIZE, getChangedParams, getOutputImageLimitForSettings, normalizeParamsForSettings } from '../lib/paramCompatibility'
import { normalizeImageSize } from '../lib/size'
import { useHintTooltip } from './useHintTooltip'

/** API 支持的最大参考图数量 */
const API_MAX_IMAGES = 16

/**
 * 图像创作 hook（从 InputBar 提取）。
 * 包含核心逻辑：store 选择器、profile 派生、capability flags、
 * 参数镜像、同步 effect、提交回调、n-limit 子系统与 handleFiles。
 */
export function useImageComposer() {
  // --- n-limit hint 子系统（seed） ---
  const nLimitHint = useHintTooltip({ autoHideMs: 2000 })

  // --- Store 选择器 ---
  const prompt = useStore((s) => s.prompt)
  const appMode = useStore((s) => s.appMode)
  const setPrompt = useStore((s) => s.setPrompt)
  const inputImages = useStore((s) => s.inputImages)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const settings = useStore((s) => s.settings)
  const reusedTaskApiProfileId = useStore((s) => s.reusedTaskApiProfileId)
  const showToast = useStore((s) => s.showToast)
  const agentConversations = useStore((s) => s.agentConversations)
  const activeAgentConversationId = useStore((s) => s.activeAgentConversationId)
  const maskDraft = useStore((s) => s.maskDraft)

  // --- Local input mirrors ---
  const [outputCompressionInput, setOutputCompressionInput] = useState(
    params.output_compression == null ? '' : String(params.output_compression),
  )
  const [nInput, setNInput] = useState(String(params.n))
  const [nInputFocused, setNInputFocused] = useState(false)

  // --- Profile 派生 ---
  const currentActiveProfile = useMemo(() => getActiveApiProfile(settings), [settings])
  const activeProfile = useMemo(() => (
    settings.reuseTaskApiProfileTemporarily && reusedTaskApiProfileId
      ? settings.profiles.find((profile) => profile.id === reusedTaskApiProfileId) ?? currentActiveProfile
      : currentActiveProfile
  ), [currentActiveProfile, reusedTaskApiProfileId, settings])
  const activeAgentConversation = appMode === 'agent'
    ? agentConversations.find((conversation) => conversation.id === activeAgentConversationId) ?? null
    : null
  const activeAgentIsRunning = Boolean(activeAgentConversation?.rounds.some((round) => round.status === 'running'))
  const effectiveSettings = useMemo(() => (
    activeProfile.id === currentActiveProfile.id
      ? settings
      : normalizeSettings({ ...settings, activeProfileId: activeProfile.id })
  ), [activeProfile.id, currentActiveProfile.id, settings])
  const hasSubmitApiConfig = Boolean(activeProfile.apiKey)
  const canSubmit = Boolean(prompt.trim() && hasSubmitApiConfig && !activeAgentIsRunning)
  const submitButtonAriaLabel = activeAgentIsRunning
    ? '停止生成'
    : hasSubmitApiConfig
    ? maskDraft ? '遮罩编辑' : '生成图像'
    : '请先配置 API'
  const submitTooltipText = activeAgentIsRunning ? '停止生成' : '尚未完成 API 配置，请在右上角设置中进行'
  const promptPlaceholder = '描述你想生成的图片，可输入 @ 来指定参考图...'
  const submitCurrentMode = useCallback(() => {
    if (appMode === 'agent') {
      void submitAgentMessage()
    } else {
      void submitTask()
    }
  }, [appMode])
  const stopActiveAgentResponse = useCallback(() => {
    stopAgentResponse(activeAgentConversationId)
  }, [activeAgentConversationId])
  const activeProvider = activeProfile.provider
  const isFalProvider = activeProvider === 'fal'
  const agentAutoImageCount = appMode === 'agent' && activeProfile.provider === 'openai' && activeProfile.apiMode === 'responses'

  // --- Capability flags ---
  const moderationDisabled = isFalProvider
  const transparentOutputAvailable = appMode === 'gallery'
  const showTransparentOutputControl = transparentOutputAvailable && params.output_format === 'png'
  const transparentOutputEnabled = showTransparentOutputControl && params.transparent_output
  const compressionDisabled = params.output_format === 'png' || isFalProvider
  const outputImageLimit = getOutputImageLimitForSettings(effectiveSettings)
  const isFalTextToImage = isFalProvider && inputImages.length === 0
  const nDraftValue = Number(nInput)
  const effectiveNValue = Number.isNaN(nDraftValue) ? params.n : nDraftValue
  const streamConcurrentByN = activeProfile.provider === 'openai' && activeProfile.streamImages === true && !agentAutoImageCount && effectiveNValue > 1
  const nLimitHintText = agentAutoImageCount
    ? 'Agent 模式下数量由模型根据提示词自动决定'
    : isFalProvider
    ? `fal.ai 最大请求数量为 ${outputImageLimit}`
    : `OpenAI 最大请求数量为 ${outputImageLimit}`
  const displaySize = isFalTextToImage && params.size === 'auto'
    ? DEFAULT_FAL_IMAGE_SIZE
    : normalizeImageSize(params.size) || DEFAULT_PARAMS.size
  const exactSizeDisabled = params.size === 'auto'
  const exactSizeEnabled = !exactSizeDisabled && params.exact_size

  // --- atImageLimit / uploadImageTooltipText ---
  const atImageLimit = inputImages.length >= API_MAX_IMAGES
  const uploadImageTooltipText = atImageLimit ? `参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加` : '上传图片'

  // --- maskTargetImage, referenceImages（依赖 maskDraft） ---
  const maskTargetImage = maskDraft
    ? inputImages.find((img) => img.id === maskDraft.targetImageId) ?? null
    : null
  const referenceImages = maskTargetImage
    ? inputImages.filter((img) => img.id !== maskTargetImage.id)
    : inputImages

  // --- Sync effects ---
  useEffect(() => {
    setOutputCompressionInput(
      params.output_compression == null ? '' : String(params.output_compression),
    )
  }, [params.output_compression])

  useEffect(() => {
    setNInput(agentAutoImageCount ? 'auto' : String(params.n))
  }, [agentAutoImageCount, params.n])

  useEffect(() => {
    const normalizedParams = normalizeParamsForSettings(params, effectiveSettings, { hasInputImages: inputImages.length > 0 })
    const patch = getChangedParams(params, normalizedParams)
    if (Object.keys(patch).length) {
      setParams(patch)
    }
  }, [inputImages.length, params, effectiveSettings, setParams])

  // --- Commit callbacks ---
  const commitOutputCompression = useCallback(() => {
    if (outputCompressionInput.trim() === '') {
      setOutputCompressionInput('')
      setParams({ output_compression: null })
      return
    }

    const nextValue = Number(outputCompressionInput)
    if (Number.isNaN(nextValue)) {
      setOutputCompressionInput(params.output_compression == null ? '' : String(params.output_compression))
      return
    }

    setOutputCompressionInput(String(nextValue))
    setParams({ output_compression: nextValue })
  }, [outputCompressionInput, params.output_compression, setParams])

  const commitN = useCallback(() => {
    nLimitHint.hide()
    if (agentAutoImageCount) {
      setNInput('auto')
      return
    }
    const nextValue = Number(nInput)
    const normalizedValue =
      nInput.trim() === '' ? DEFAULT_PARAMS.n : Number.isNaN(nextValue) ? params.n : nextValue
    const clampedValue = Math.min(outputImageLimit, Math.max(1, normalizedValue))
    setNInput(String(clampedValue))
    setParams({ n: clampedValue })
  }, [agentAutoImageCount, nInput, nLimitHint, outputImageLimit, params.n, setParams])

  // --- n-limit wrappers（依赖已全部在 hook 内） ---
  const showNLimitHint = useCallback(() => {
    nLimitHint.show()
  }, [nLimitHint])

  const hideNLimitHint = useCallback(() => {
    nLimitHint.hide()
  }, [nLimitHint])

  const clearAgentNHintTouchTimer = useCallback(() => {
    nLimitHint.clearTimer()
  }, [nLimitHint])

  const showAgentNHint = useCallback(() => {
    if (agentAutoImageCount) showNLimitHint()
  }, [agentAutoImageCount, showNLimitHint])

  const startAgentNHintTouch = useCallback(() => {
    if (!agentAutoImageCount) return
    nLimitHint.startTouch()
  }, [agentAutoImageCount, nLimitHint])

  const handleNInputChange = useCallback((value: string) => {
    if (agentAutoImageCount) {
      setNInput('auto')
      return
    }
    setNInput(value)
    const nextValue = Number(value)
    if (!Number.isNaN(nextValue) && nextValue > outputImageLimit) {
      showNLimitHint()
    } else {
      hideNLimitHint()
    }
  }, [agentAutoImageCount, hideNLimitHint, outputImageLimit, showNLimitHint])

  const handleNLimitIncreaseAttempt = useCallback((preventDefault: () => void) => {
    if (agentAutoImageCount) {
      preventDefault()
      showNLimitHint()
      return
    }
    const currentValue = Number(nInput)
    const effectiveValue = Number.isNaN(currentValue) ? params.n : currentValue
    if (!nInputFocused || effectiveValue < outputImageLimit) return

    preventDefault()
    showNLimitHint()
  }, [agentAutoImageCount, nInput, nInputFocused, outputImageLimit, params.n, showNLimitHint])

  // --- handleFiles ---
  const handleFiles = async (files: FileList | File[]) => {
    try {
      const currentCount = useStore.getState().inputImages.length
      if (currentCount >= API_MAX_IMAGES) {
        useStore.getState().showToast(
          `参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`,
          'error',
        )
        return
      }

      const remaining = API_MAX_IMAGES - currentCount
      const accepted = Array.from(files).filter((f) => f.type.startsWith('image/'))
      const toAdd = accepted.slice(0, remaining)
      const discarded = accepted.length - toAdd.length

      for (const file of toAdd) {
        await addImageFromFile(file)
      }

      if (discarded > 0) {
        useStore.getState().showToast(
          `已达上限 ${API_MAX_IMAGES} 张，${discarded} 张图片被丢弃`,
          'error',
        )
      }
    } catch (err) {
      useStore.getState().showToast(
        `图片添加失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  return {
    // store selectors
    prompt,
    setPrompt,
    inputImages,
    params,
    setParams,
    settings,
    showToast,
    maskDraft,
    // mirrors
    outputCompressionInput,
    setOutputCompressionInput,
    nInput,
    setNInput,
    setNInputFocused,
    // profile derivation
    activeProfile,
    activeAgentConversation,
    activeAgentIsRunning,
    hasSubmitApiConfig,
    canSubmit,
    submitButtonAriaLabel,
    submitTooltipText,
    promptPlaceholder,
    submitCurrentMode,
    stopActiveAgentResponse,
    isFalProvider,
    agentAutoImageCount,
    // capability flags
    moderationDisabled,
    transparentOutputAvailable,
    showTransparentOutputControl,
    transparentOutputEnabled,
    compressionDisabled,
    outputImageLimit,
    isFalTextToImage,
    streamConcurrentByN,
    nLimitHintText,
    displaySize,
    exactSizeDisabled,
    exactSizeEnabled,
    atImageLimit,
    uploadImageTooltipText,
    // mask targets
    maskTargetImage,
    referenceImages,
    // commit callbacks
    commitOutputCompression,
    commitN,
    // n-limit subsystem
    nLimitHint,
    hideNLimitHint,
    clearAgentNHintTouchTimer,
    showAgentNHint,
    startAgentNHintTouch,
    handleNInputChange,
    handleNLimitIncreaseAttempt,
    // files
    handleFiles,
  }
}
