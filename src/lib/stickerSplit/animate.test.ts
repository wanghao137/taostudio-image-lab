import { describe, expect, it } from 'vitest'
import { ANIM_FRAME_MS, buildTimeline, motionAt, timelineTotalMs, type SequenceConfig } from './animate'

function config(patch: Partial<SequenceConfig> = {}): SequenceConfig {
  return { poses: [1, 2, 3], pingPong: true, crossfade: false, poseMs: 160, motionPreset: 'bounce', ...patch }
}

describe('motionAt 刚体预设', () => {
  it('none 恒为恒等变换', () => {
    for (const t of [0, 0.25, 0.5, 0.9]) {
      expect(motionAt('none', t)).toEqual({ dx: 0, dy: 0, rotate: 0, scaleX: 1, scaleY: 1 })
    }
  })

  it('bounce 落地压扁、腾空上移', () => {
    const land = motionAt('bounce', 0)
    expect(land.dy).toBeCloseTo(0)
    expect(land.scaleY).toBeLessThan(1)
    expect(land.scaleX).toBeGreaterThan(1)
    const air = motionAt('bounce', 0.25)
    expect(air.dy).toBeLessThan(0)
    expect(air.scaleY).toBeCloseTo(1, 5)
  })

  it('heartbeat 在脉搏点放大、周期首尾回 1', () => {
    expect(motionAt('heartbeat', 0.12).scaleX).toBeGreaterThan(1.03)
    expect(motionAt('heartbeat', 0.9).scaleX).toBeCloseTo(1, 3)
  })

  it('sway/float/shake 位移有界不出画', () => {
    for (const preset of ['sway', 'float', 'shake'] as const) {
      for (const t of [0, 0.2, 0.5, 0.8]) {
        const m = motionAt(preset, t)
        expect(Math.abs(m.dx)).toBeLessThan(0.05)
        expect(Math.abs(m.dy)).toBeLessThan(0.05)
      }
    }
  })
})

describe('buildTimeline 帧序列调度', () => {
  it('ping-pong 展开为往返顺序', () => {
    const steps = buildTimeline(config())
    expect(steps[0].pose).toBe(1)
    expect(steps[steps.length - 1].pose).toBe(2) // [1,2,3] → 往返 [1,2,3,2]
  })

  it('160ms 姿势按 80ms 网格细分为 2 帧，动效相位跨姿势连续', () => {
    const steps = buildTimeline(config())
    // 4 个停留 × 2 帧 = 8 帧
    expect(steps).toHaveLength(8)
    for (const step of steps) expect(step.delayMs).toBe(80)
    // motionT 全程单调连续：0/8, 1/8, ...
    expect(steps.map((s) => s.motionT)).toEqual([0, 1 / 8, 2 / 8, 3 / 8, 4 / 8, 5 / 8, 6 / 8, 7 / 8])
  })

  it('溶解：每转场末尾一帧 50/50 混合', () => {
    const steps = buildTimeline(config({ crossfade: true }))
    const blends = steps.filter((s) => s.blend > 0)
    expect(blends).toHaveLength(3)
    for (const blend of blends) {
      expect(blend.blend).toBe(0.5)
      expect(blend.poseB).not.toBe(blend.pose)
    }
  })

  it('无动效：每姿势一帧不细分', () => {
    const steps = buildTimeline(config({ motionPreset: 'none' }))
    expect(steps).toHaveLength(4)
    for (const step of steps) {
      expect(step.delayMs).toBe(160)
      expect(step.blend).toBe(0)
    }
  })

  it('单张模式：固定 12 帧完整动作周期，无转场', () => {
    const steps = buildTimeline(config({ poses: [5], motionPreset: 'shake', crossfade: true }))
    expect(steps).toHaveLength(12)
    expect(steps.every((s) => s.pose === 5 && s.blend === 0)).toBe(true)
    for (const step of steps) expect(step.delayMs).toBe(ANIM_FRAME_MS)
  })

  it('开环（非 ping-pong）末位不溶解，避免尾首闪变', () => {
    const steps = buildTimeline(config({ pingPong: false, crossfade: true }))
    expect(steps[steps.length - 1].blend).toBe(0)
  })

  it('总时长 = 帧数 × 帧距', () => {
    const steps = buildTimeline(config({ motionPreset: 'bounce', crossfade: true }))
    expect(timelineTotalMs(steps)).toBeCloseTo(steps.length * 80, 10)
  })
})
