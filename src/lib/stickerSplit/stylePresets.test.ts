import { describe, expect, it } from 'vitest'
import { COMMON_STICKER_STYLE_IDS, STICKER_STYLE_PRESETS, STYLE_GROUPS, buildStickerSheetPrompt, getStickerStyle } from './stylePresets'

describe('贴纸风格预设（da-motion-sticker-skill 36 种全量）', () => {
  it('36 种预设，id 唯一且带英文风格片段与分组', () => {
    expect(STICKER_STYLE_PRESETS).toHaveLength(36)
    expect(new Set(STICKER_STYLE_PRESETS.map((s) => s.id)).size).toBe(36)
    const groupIds = new Set(STYLE_GROUPS.map((g) => g.id))
    for (const preset of STICKER_STYLE_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0)
      expect(preset.stylePrompt).toMatch(/[a-zA-Z]/)
      expect(groupIds.has(preset.group)).toBe(true)
    }
    for (const group of STYLE_GROUPS) {
      expect(STICKER_STYLE_PRESETS.filter((s) => s.group === group.id).length).toBeGreaterThan(0)
    }
  })

  it('常用子集全部可解析且数量适中', () => {
    expect(COMMON_STICKER_STYLE_IDS.length).toBeLessThanOrEqual(10)
    for (const id of COMMON_STICKER_STYLE_IDS) {
      expect(getStickerStyle(id)).toBeDefined()
    }
  })

  it('提示词包含九宫格结构、风格片段与透明约束', () => {
    const prompt = buildStickerSheetPrompt('big-head-chibi')
    expect(prompt).toContain('3×3')
    expect(prompt).toContain('9 个不同表情')
    expect(prompt).toContain('big-head chibi character design')
    expect(prompt).toContain('透明背景')
    expect(prompt).toContain('无文字')
  })

  it('角色描述注入到提示词开头', () => {
    const prompt = buildStickerSheetPrompt('ink-wash-meme', '戴眼镜的橘猫')
    expect(prompt).toContain('角色：戴眼镜的橘猫。')
    expect(prompt).toContain('ink-wash')
  })

  it('未知风格报错', () => {
    expect(() => buildStickerSheetPrompt('nope')).toThrow()
    expect(getStickerStyle('nope')).toBeUndefined()
    expect(getStickerStyle('pixel-art')?.label).toBe('像素 Pixel Art')
  })
})
