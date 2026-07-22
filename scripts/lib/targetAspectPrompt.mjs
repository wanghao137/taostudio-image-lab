// Node mirror of src/lib/targetAspectPrompt.ts.
// Appends a target-aspect hint to the prompt so the provider composes for the
// requested ratio — the same hint the production UI injects before sending.
//
// Source of truth: src/lib/targetAspectPrompt.ts. Keep in sync on change.

function gcd(a, b) {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x || 1
}

export function createTargetAspectPromptHint(size) {
  const match = size.trim().match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null

  const divisor = gcd(width, height)
  const ratioWidth = width / divisor
  const ratioHeight = height / divisor
  const orientation = ratioWidth === ratioHeight
    ? 'square'
    : ratioWidth > ratioHeight ? 'horizontal' : 'vertical'

  return `Target frame: ${orientation} ${ratioWidth}:${ratioHeight} composition. Compose the scene to naturally fill this aspect ratio.`
}

export function appendTargetAspectPromptHint(prompt, size) {
  const hint = createTargetAspectPromptHint(size)
  if (!hint) return prompt
  const trimmed = prompt.trim()
  if (!trimmed) return hint
  if (trimmed.includes(hint)) return trimmed
  return `${trimmed}\n\n${hint}`
}

// Strip Midjourney-style parameter suffixes (--ar/--v/--s/--n ...) that some
// gateways route to an HTML fallback page instead of the image endpoint.
export function stripMidjourneySuffix(prompt) {
  return prompt.replace(/\s+--[a-z]+\s+[^\s-]+(\s+--[a-z]+\s+[^\s-]+)*\s*$/i, '').trim()
}
