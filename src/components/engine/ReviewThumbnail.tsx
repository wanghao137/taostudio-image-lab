import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Maximize2 } from 'lucide-react'
import {
  getImageAssetBlob,
  getImageAssetPreviewBlob,
  getImageAssetThumbnailBlob,
  type ImageTaskApiConfig,
} from '../../lib/imageTaskApi'
import EngineAssetLightbox from './EngineAssetLightbox'

/**
 * 引擎审查缩略图：IntersectionObserver 延迟加载 blob 缩略图，点击后拉取
 * 原图并打开 EngineAssetLightbox。从 EngineWorkspace.tsx 提取（#24）。
 */
export default function ReviewThumbnail({
  config,
  assetId,
  label,
  interactive = true,
}: {
  config: ImageTaskApiConfig
  assetId: string | null
  label: string
  interactive?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [fullUrl, setFullUrl] = useState<string | null>(null)
  const [fullState, setFullState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => {
    if (fullUrl) URL.revokeObjectURL(fullUrl)
  }, [fullUrl])

  useEffect(() => {
    setFullUrl(null)
    setFullState('idle')
    setLightboxOpen(false)
  }, [assetId])

  useEffect(() => {
    if (!assetId) {
      setUrl(null)
      setVisible(false)
      return
    }
    setUrl(null)
    const element = containerRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '160px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [assetId])

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    if (!assetId || !visible) return
    void getImageAssetThumbnailBlob(config, assetId)
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (active) setUrl(null)
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [assetId, config, visible])

  const openFullPreview = async () => {
    if (!assetId || fullState === 'loading') return
    if (fullUrl) {
      setLightboxOpen(true)
      return
    }
    setFullState('loading')
    // Progressive two-stage load: open the lightbox with the server-rendered
    // ~1920px webp (~hundreds of KB, ~1s) so the click responds immediately,
    // then upgrade to the full-resolution original in the background — the
    // lightbox supports up to 4x zoom and review needs the real 4K detail.
    // The [fullUrl] cleanup effect revokes the preview URL on replacement.
    let opened = false
    try {
      const previewBlob = await getImageAssetPreviewBlob(config, assetId)
      setFullUrl(URL.createObjectURL(previewBlob))
      setFullState('idle')
      setLightboxOpen(true)
      opened = true
    } catch { /* fall through to the original */ }
    void getImageAssetBlob(config, assetId)
      .then((blob) => {
        setFullUrl(URL.createObjectURL(blob))
        setFullState('idle')
        if (!opened) setLightboxOpen(true)
      })
      .catch(() => {
        if (!opened) setFullState('error')
      })
  }

  return (
    <div ref={containerRef} className="relative h-full w-full bg-stone-100 dark:bg-white/[0.04]">
      {interactive ? (
        <button
          type="button"
          onClick={() => void openFullPreview()}
          disabled={!assetId || fullState === 'loading'}
          className="group relative flex h-full w-full items-center justify-center overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#356c82] disabled:cursor-wait"
          aria-label={assetId ? `放大查看 ${label}` : label}
          title={assetId ? '点击查看大图' : undefined}
        >
          {url
            ? <img src={url} alt={label} className="h-full w-full object-cover" loading="lazy" />
            : <span className="text-[10px] text-stone-400">{visible ? '无预览' : '加载预览'}</span>}
          {url && fullState !== 'loading' && (
            <span className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true">
              <Maximize2 className="h-3.5 w-3.5" />
            </span>
          )}
          {fullState === 'loading' && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white" aria-live="polite">
              <LoaderCircle className="h-4 w-4 animate-spin" />
            </span>
          )}
        </button>
      ) : (
        <div className="flex h-full w-full items-center justify-center overflow-hidden" aria-hidden="true">
          {url
            ? <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
            : <span className="text-[9px] text-stone-400">{visible ? '无预览' : '加载'}</span>}
        </div>
      )}
      {fullState === 'error' && (
        <p className="absolute inset-x-1 bottom-1 rounded bg-red-900/80 px-1 py-0.5 text-center text-[9px] text-white" role="alert">
          大图加载失败，点击重试
        </p>
      )}
      {lightboxOpen && fullUrl && (
        <EngineAssetLightbox
          initialMode="final"
          sourceUrl={null}
          finalUrl={fullUrl}
          onClose={() => {
            setLightboxOpen(false)
            setFullUrl(null)
          }}
        />
      )}
    </div>
  )
}
