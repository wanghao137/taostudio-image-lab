import { useEffect, useState } from 'react'

const MOBILE_BREAKPOINT = 640

/**
 * 移动端断点判断。与 Tailwind `sm` (640px) 一致：
 * innerWidth < 640 视为移动端。
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT,
  )
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}
