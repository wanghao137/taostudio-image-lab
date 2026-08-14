import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** 显示名，用于在错误文案中标注崩溃的面（如「画廊」「引擎工作台」）。 */
  sectionLabel?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 顶层渲染崩溃兜底：没有它，任何一个组件抛错都是整页白屏且无人知晓。
 * 故意不做成全局单例 reset —— 每个受保护的面独立恢复，一个面崩溃不影响其他面。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 本地可见；未来接错误上报时在这里挂 hook。
    console.error('[ErrorBoundary]', this.props.sectionLabel ?? 'app', error, info.componentStack)
  }

  private handleReset = () => {
    this.setState({ error: null })
  }

  render() {
    if (!this.state.error) return this.props.children

    const label = this.props.sectionLabel ?? '页面'
    return (
      <section className="safe-area-x mx-auto my-8 max-w-xl rounded-xl border border-red-200 bg-red-50/80 p-6 text-sm dark:border-red-900/60 dark:bg-red-950/30">
        <h2 className="text-base font-semibold text-red-700 dark:text-red-300">
          {label}渲染出错
        </h2>
        <p className="mt-2 break-all text-red-600/90 dark:text-red-300/80">
          {this.state.error.message || String(this.state.error)}
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:bg-red-950/60 dark:text-red-300 dark:hover:bg-red-900/40"
          >
            重试渲染
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 dark:border-white/10 dark:bg-white/5 dark:text-stone-300 dark:hover:bg-white/10"
          >
            刷新页面
          </button>
        </div>
        <p className="mt-3 text-xs text-red-500/80 dark:text-red-400/70">
          已生成并保存的图片不受影响；如持续出错请刷新页面或导出数据备份。
        </p>
      </section>
    )
  }
}
