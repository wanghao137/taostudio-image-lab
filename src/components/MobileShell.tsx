import { useState, type ComponentType, type ReactNode } from 'react'
import { Image as ImageIcon, Star, Sparkles, User, Moon, Sun } from 'lucide-react'
import { useStore } from '../store'

interface MobileShellProps {
  children: ReactNode
  onOpenCompose: () => void
}

const THEME_KEY = 'taostudio.imageLab.theme'

export default function MobileShell({ children, onOpenCompose }: MobileShellProps) {
  const appMode = useStore((s) => s.appMode)
  const setAppMode = useStore((s) => s.setAppMode)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const setFilterFavorite = useStore((s) => s.setFilterFavorite)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const [myOpen, setMyOpen] = useState(false)

  const goGallery = () => {
    setAppMode('gallery')
    setFilterFavorite(false)
  }
  const goFavorites = () => {
    setAppMode('gallery')
    setFilterFavorite(true)
  }

  // 当前激活 tab（用于高亮）
  const tab = appMode === 'agent' ? 'agent' : filterFavorite ? 'favorites' : 'gallery'

  return (
    <div className="max-sm:flex max-sm:min-h-screen max-sm:flex-col sm:hidden">
      {/* 极简顶栏 */}
      <header className="safe-area-top sticky top-0 z-30 flex items-center justify-between border-b border-stone-200/70 bg-[#f7f2ec]/90 px-4 py-2 backdrop-blur dark:border-white/[0.08] dark:bg-[#13100d]/90">
        <span className="text-[15px] font-bold tracking-tight text-stone-900 dark:text-stone-50">TaoStudio</span>
        <ThemeToggleButton />
      </header>

      {/* 内容区 */}
      <main className="flex-1 overflow-y-auto pb-24">{children}</main>

      {/* 右下角 FAB + 底部 Tab */}
      <div className="safe-area-bottom fixed inset-x-0 bottom-0 z-40 border-t border-stone-200/70 bg-white/95 backdrop-blur dark:border-white/[0.08] dark:bg-[#13100d]/95">
        <div className="relative flex items-center justify-around px-2 py-1.5">
          <TabButton icon={ImageIcon} label="画廊" active={tab === 'gallery'} onClick={goGallery} />
          <TabButton icon={Star} label="收藏" active={tab === 'favorites'} onClick={goFavorites} />
          <div className="w-14" /> {/* FAB 占位 */}
          <TabButton icon={User} label="我的" active={myOpen} onClick={() => setMyOpen(true)} />
        </div>
        {/* FAB */}
        <button
          onClick={onOpenCompose}
          aria-label="创作"
          className="absolute -top-7 left-1/2 -translate-x-1/2 flex h-14 w-14 items-center justify-center rounded-full bg-[#df7b57] text-white shadow-lg ring-4 ring-white dark:ring-[#13100d] active:scale-95 transition"
        >
          <Sparkles className="h-6 w-6" />
        </button>
      </div>

      {/* 「我的」面板（简化：列出设置入口；本任务只做骨架） */}
      {myOpen && <MyPanel onClose={() => setMyOpen(false)} onOpenSettings={() => setShowSettings(true)} />}
    </div>
  )
}

function TabButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1.5 ${
        active ? 'text-[#df7b57]' : 'text-stone-500 dark:text-stone-400'
      }`}
    >
      <Icon className="h-5 w-5" />
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  )
}

/**
 * 简化两态主题切换（light↔dark）。与 Header.tsx 共享同一 localStorage key，
 * 所以桌面设的主题移动端会读到，反之亦然。不复制 system 态（spec 未要求）。
 */
function ThemeToggleButton() {
  const [isDark, setIsDark] = useState(() => {
    const saved = window.localStorage.getItem(THEME_KEY)
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const dark = saved === 'dark' || (saved !== 'light' && prefersDark)
    document.documentElement.classList.toggle('dark', dark)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    return dark
  })
  const toggle = () => {
    const next = !isDark
    document.documentElement.classList.toggle('dark', next)
    document.documentElement.dataset.theme = next ? 'dark' : 'light'
    window.localStorage.setItem(THEME_KEY, next ? 'dark' : 'light')
    setIsDark(next)
  }
  return (
    <button onClick={toggle} aria-label="切换主题" className="rounded-lg p-2 text-stone-600 dark:text-stone-300">
      {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  )
}

function MyPanel({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="safe-area-bottom relative w-full rounded-t-2xl bg-white p-4 dark:bg-[#1a1612]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-stone-300 dark:bg-stone-600" />
        <h3 className="mb-3 text-sm font-semibold text-stone-900 dark:text-stone-50">我的</h3>
        <button
          onClick={() => { onOpenSettings(); onClose() }}
          className="block w-full rounded-lg px-3 py-3 text-left text-sm text-stone-700 active:bg-stone-100 dark:text-stone-200 dark:active:bg-white/5"
        >
          设置
        </button>
        {/* 其余入口（主题/安装/指南/历史/智能体）在后续任务补 */}
      </div>
    </div>
  )
}
