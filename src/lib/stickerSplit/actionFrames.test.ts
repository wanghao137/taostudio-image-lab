import { describe, expect, it } from 'vitest'
import {
  ACTION_TEMPLATES,
  FRAME_AREA_MAX_RATIO,
  FRAME_AREA_MIN_RATIO,
  POSE_DIFF_MAX_ANY,
  POSE_DIFF_MIN,
  getActionTemplate,
  isFrameAreaAcceptable,
} from './actionFrames'

describe('帧主体面积 QC 门', () => {
  it('基准帧 0.45~2.2 倍内的面积放行', () => {
    expect(isFrameAreaAcceptable(1000, 1000)).toBe(true)
    expect(isFrameAreaAcceptable(FRAME_AREA_MIN_RATIO * 1000, 1000)).toBe(true)
    expect(isFrameAreaAcceptable(FRAME_AREA_MAX_RATIO * 1000, 1000)).toBe(true)
    expect(isFrameAreaAcceptable(700, 1000)).toBe(true)
  })

  it('面积异常帧拒绝(疑似多主体/坏帧 → 按纪律重生一次后扣留)', () => {
    expect(isFrameAreaAcceptable(100, 1000)).toBe(false)       // 主体过小(空帧/退化)
    expect(isFrameAreaAcceptable(3000, 1000)).toBe(false)      // 主体过大(多主体拼贴)
    expect(isFrameAreaAcceptable(0, 1000)).toBe(false)
    expect(isFrameAreaAcceptable(1000, 0)).toBe(false)
  })

  it('阈值边界可导入且在合理区间', () => {
    expect(FRAME_AREA_MIN_RATIO).toBeGreaterThan(0.2)
    expect(FRAME_AREA_MAX_RATIO).toBeLessThan(4)
  })
})

describe('Skill A 路线（2×2 姿势表）动作模板', () => {
  it('动作模板：小幅局部动作语义，id 唯一', () => {
    expect(ACTION_TEMPLATES.length).toBeGreaterThanOrEqual(5)
    expect(new Set(ACTION_TEMPLATES.map((t) => t.id)).size).toBe(ACTION_TEMPLATES.length)
    for (const t of ACTION_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.motion.length).toBeGreaterThan(6)
    }
  })

  it('getActionTemplate 正常解析与未命中', () => {
    expect(getActionTemplate('nod')?.label).toBe('点头')
    expect(getActionTemplate('nope')).toBeUndefined()
  })

  it('姿势差 QC 门阈值对齐 Skill prepare_keyposes（峰值≥0.02 / 任一≥0.025）', () => {
    expect(POSE_DIFF_MIN).toBe(0.02)
    expect(POSE_DIFF_MAX_ANY).toBe(0.025)
    expect(POSE_DIFF_MAX_ANY).toBeGreaterThanOrEqual(POSE_DIFF_MIN)
  })
})
