import { describe, expect, it } from 'vitest'
import { STICKER_STYLE_PRESETS, buildStickerSheetPrompt, getStickerStyle } from './stylePresets'

describe('贴纸风格预设', () => {
  it('8 种预设，id 唯一且带英文风格片段', () => {
    expect(STICKER_STYLE_PRESETS).toHaveLength(8)
    expect(new Set(STICKER_STYLE_PRESETS.map((s) => s.id)).size).toBe(8)
    for (const preset of STICKER_STYLE_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0)
      expect(preset.stylePrompt).toMatch(/[a-zA-Z]/)
    }
  })

  it('提示词包含九宫格结构、风格片段与透明约束', () => {
    const prompt = buildStickerSheetPrompt('3d')
    expect(prompt).toContain('3×3')
    expect(prompt).toContain('9 个不同表情')
    expect(prompt).toContain('polished 3D cartoon rendering')
    expect(prompt).toContain('透明背景')
    expect(prompt).toContain('无文字')
  })

  it('角色描述注入到提示词开头', () => {
    const prompt = buildStickerSheetPrompt('chibi', '戴眼镜的橘猫')
    expect(prompt).toContain('角色：戴眼镜的橘猫。')
    expect(prompt).toContain('chibi')
  })

  it('未知风格报错', () => {
    expect(() => buildStickerSheetPrompt('nope')).toThrow()
    expect(getStickerStyle('nope')).toBeUndefined()
    expect(getStickerStyle('pixel-art')?.label).toBe('像素')
  })
})
