import { describe, expect, it } from 'vitest'
import { appendTargetAspectPromptHint, createTargetAspectPromptHint } from './targetAspectPrompt'

describe('createTargetAspectPromptHint', () => {
  it('returns null for auto size', () => {
    expect(createTargetAspectPromptHint('auto')).toBeNull()
  })

  it('creates a vertical hint for 2160x3840', () => {
    expect(createTargetAspectPromptHint('2160x3840')).toBe(
      'Target frame: vertical 9:16 composition. Compose the scene to naturally fill this aspect ratio.',
    )
  })

  it('creates a horizontal hint for 3840x2160', () => {
    expect(createTargetAspectPromptHint('3840x2160')).toBe(
      'Target frame: horizontal 16:9 composition. Compose the scene to naturally fill this aspect ratio.',
    )
  })

  it('creates a square hint for 2880x2880', () => {
    expect(createTargetAspectPromptHint('2880x2880')).toBe(
      'Target frame: square 1:1 composition. Compose the scene to naturally fill this aspect ratio.',
    )
  })

  it('reduces arbitrary dimensions instead of using presets only', () => {
    expect(createTargetAspectPromptHint('3456x2304')).toContain('horizontal 3:2 composition')
  })
})

describe('appendTargetAspectPromptHint', () => {
  it('does not duplicate an existing hint', () => {
    const prompt = 'Poster'
    const withHint = appendTargetAspectPromptHint(prompt, '2160x3840')
    expect(appendTargetAspectPromptHint(withHint, '2160x3840')).toBe(withHint)
  })
})
