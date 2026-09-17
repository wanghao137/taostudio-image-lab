import { describe, expect, it } from 'vitest'
import {
  SPRITE_MOTION_PRESETS,
  SPRITE_AREA_MAX_RATIO,
  SPRITE_AREA_MIN_RATIO,
  bandCoords,
  buildSpriteSheetPrompt,
  detectTransparentBands,
  evenCoords,
  getSpriteMotionPreset,
  isSpriteAreaAcceptable,
  planSpriteCellGrid,
  type SpriteAnimationResult,
} from './spriteSheet'

describe('战斗动作预设', () => {
  it('预设数量与唯一性，语义为大幅连续动作', () => {
    expect(SPRITE_MOTION_PRESETS.length).toBeGreaterThanOrEqual(8)
    expect(new Set(SPRITE_MOTION_PRESETS.map((p) => p.id)).size).toBe(SPRITE_MOTION_PRESETS.length)
    for (const p of SPRITE_MOTION_PRESETS) {
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.motion).toMatch(/循环/)
    }
  })

  it('getSpriteMotionPreset 命中与未命中', () => {
    expect(getSpriteMotionPreset('sword-slash')?.label).toBe('挥剑连斩')
    expect(getSpriteMotionPreset('nope')).toBeUndefined()
  })
})

describe('sprite sheet 提示词', () => {
  it('默认 4×4、含帧序/循环/绿幕/一致性约束', () => {
    const p = buildSpriteSheetPrompt({ motionId: 'sword-slash' })
    expect(p).toContain('4×4 网格')
    expect(p).toContain('共 16 个格子')
    expect(p).toContain('从左到右、从上到下')
    expect(p).toContain('无缝循环')
    expect(p).toContain('#00FF00')
    expect(p).toContain('完全相同的同一个角色')
  })

  it('参考图模式与角色补充描述', () => {
    const withRef = buildSpriteSheetPrompt({ motionId: 'run-cycle', hasReference: true })
    expect(withRef).toContain('严格保持参考图中的角色不变')
    const noRef = buildSpriteSheetPrompt({ motionId: 'run-cycle', characterNote: '银发红瞳的女剑士' })
    expect(noRef).toContain('银发红瞳的女剑士')
    const refAndNote = buildSpriteSheetPrompt({ motionId: 'run-cycle', hasReference: true, characterNote: '镜头略微拉远' })
    expect(refAndNote).toContain('镜头略微拉远')
  })

  it('网格行列收口在 2-6，未知 motionId 时原样作为动作描述', () => {
    expect(buildSpriteSheetPrompt({ motionId: 'x', rows: 9, cols: 9 })).toContain('6×6')
    expect(buildSpriteSheetPrompt({ motionId: 'x', rows: 1, cols: 1 })).toContain('2×2')
    expect(buildSpriteSheetPrompt({ motionId: '自定义挥手动作' })).toContain('自定义挥手动作')
  })
})

describe('透明沟槽带检测', () => {
  it('识别内部透明带，忽略贴边留白', () => {
    // 0-9 实体，10-14 透明带，15-24 实体，25-29 透明（贴边，应被忽略）
    const t = (i: number) => (i >= 10 && i <= 14 ? 1 : i >= 25 ? 1 : 0)
    expect(detectTransparentBands(t, 30)).toEqual([[10, 14]])
  })

  it('无透明带返回空数组', () => {
    expect(detectTransparentBands(() => 0, 30)).toEqual([])
  })

  it('多条内部带全部识别', () => {
    // 实体 0-9 / 带 10-11 / 实体 12-19 / 带 20-21 / 实体 22-29
    const t = (i: number) => ((i >= 10 && i <= 11) || (i >= 20 && i <= 21) ? 1 : 0)
    expect(detectTransparentBands(t, 30)).toEqual([[10, 11], [20, 21]])
  })
})

describe('切格坐标', () => {
  it('bandCoords：带数匹配时切分含端点无缝覆盖', () => {
    const edges = bandCoords([[10, 14]], 30, 2)!
    expect(edges).toEqual([[0, 9], [15, 29]])
    expect(bandCoords([], 30, 2)).toBeNull()
    expect(bandCoords([[1, 2], [5, 6]], 30, 2)).toBeNull()
  })

  it('evenCoords：几何等分全范围覆盖', () => {
    const edges = evenCoords(1024, 4)
    expect(edges.length).toBe(4)
    expect(edges[0][0]).toBe(0)
    expect(edges[3][1]).toBe(1023)
    for (let i = 1; i < edges.length; i++) expect(edges[i][0]).toBe(edges[i - 1][1] + 1)
  })

  it('planSpriteCellGrid：沟槽检测成功走带切，失败退化等分', () => {
    // 4×4：3 条行带 + 3 条列带
    const rowT = (y: number) => (y >= 250 && y <= 254) || (y >= 505 && y <= 509) || (y >= 760 && y <= 764) ? 1 : 0
    const colT = (x: number) => (x >= 250 && x <= 254) || (x >= 505 && x <= 509) || (x >= 760 && x <= 764) ? 1 : 0
    const grid = planSpriteCellGrid(rowT, colT, 1024, 1024, 4, 4)
    expect(grid.byTroughs).toBe(true)
    expect(grid.cells.length).toBe(16)
    expect(grid.cells[0]).toEqual([0, 0, 249, 249])
    expect(grid.cells[15]).toEqual([765, 765, 1023, 1023])

    const gridEven = planSpriteCellGrid(() => 0, () => 0, 1024, 1024, 4, 4)
    expect(gridEven.byTroughs).toBe(false)
    expect(gridEven.cells.length).toBe(16)
  })
})

describe('帧面积 QC 门（战斗动作放宽档）', () => {
  it('0.3~3.0 倍中位面积放行', () => {
    expect(isSpriteAreaAcceptable(1000, 1000)).toBe(true)
    expect(isSpriteAreaAcceptable(SPRITE_AREA_MIN_RATIO * 1000, 1000)).toBe(true)
    expect(isSpriteAreaAcceptable(SPRITE_AREA_MAX_RATIO * 1000, 1000)).toBe(true)
    expect(isSpriteAreaAcceptable(200, 1000)).toBe(false)
    expect(isSpriteAreaAcceptable(4000, 1000)).toBe(false)
    expect(isSpriteAreaAcceptable(0, 1000)).toBe(false)
    expect(isSpriteAreaAcceptable(1000, 0)).toBe(false)
  })

  it('阈值较 2×2 姿势表更宽（大幅动作帧面积变化大）', () => {
    expect(SPRITE_AREA_MIN_RATIO).toBeLessThan(0.45)
    expect(SPRITE_AREA_MAX_RATIO).toBeGreaterThan(2.2)
  })
})

describe('SpriteAnimationResult 契约', () => {
  it('结果携带原始 sheetDataUrl（工坊查看/重切入口依赖；processSpriteSheet 透传入参）', () => {
    // 类型契约级断言：完整管线依赖 canvas（jsdom/node 不可用），字段存在性由
    // 编译 + 该构造约束锁定——移除字段会让对象字面量编译失败。
    const result: SpriteAnimationResult = {
      frames: ['data:image/png;base64,frame-1'],
      sheetDataUrl: 'data:image/png;base64,sheet',
      diagnostics: [{ index: 0, areaRatio: 1, dropped: false }],
      gridMode: 'troughs',
      byTroughs: true,
      warnings: [],
    }
    expect(result.sheetDataUrl).toBe('data:image/png;base64,sheet')
    expect(result.frames).toHaveLength(1)
  })
})
