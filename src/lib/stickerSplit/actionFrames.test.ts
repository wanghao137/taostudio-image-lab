import { describe, expect, it } from 'vitest'
import { FRAME_AREA_MAX_RATIO, FRAME_AREA_MIN_RATIO, isFrameAreaAcceptable } from './actionFrames'

describe('帧主体面积 QC 门', () => {
  it('基准帧 0.45~2.2 倍内的面积放行', () => {
    expect(isFrameAreaAcceptable(1000, 1000)).toBe(true)
    expect(isFrameAreaAcceptable(FRAME_AREA_MIN_RATIO * 1000, 1000)).toBe(true)
    expect(isFrameAreaAcceptable(FRAME_AREA_MAX_RATIO * 1000, 1000)).toBe(true)
    expect(isFrameAreaAcceptable(700, 1000)).toBe(true)
  })

  it('面积异常帧拒绝(疑似多主体/坏帧 → withheld 重试)', () => {
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
