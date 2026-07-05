import { parseImageSize } from './size'

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x || 1
}

export function createTargetAspectPromptHint(size: string): string | null {
  const parsed = parseImageSize(size)
  if (!parsed) return null

  const divisor = gcd(parsed.width, parsed.height)
  const ratioWidth = parsed.width / divisor
  const ratioHeight = parsed.height / divisor
  const orientation = ratioWidth === ratioHeight
    ? 'square'
    : ratioWidth > ratioHeight ? 'horizontal' : 'vertical'

  return `Target frame: ${orientation} ${ratioWidth}:${ratioHeight} composition. Compose the scene to naturally fill this aspect ratio.`
}

export function appendTargetAspectPromptHint(prompt: string, size: string): string {
  const hint = createTargetAspectPromptHint(size)
  if (!hint) return prompt
  const trimmed = prompt.trim()
  if (!trimmed) return hint
  if (trimmed.includes(hint)) return trimmed
  return `${trimmed}\n\n${hint}`
}
