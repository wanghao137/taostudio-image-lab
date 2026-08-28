import { describe, expect, it } from 'vitest'
import { ANIM_FRAME_MS, buildTimeline, performanceAt, timelineTotalMs, type MotionPreset, type SequenceConfig } from './animate'

function config(patch: Partial<SequenceConfig> = {}): SequenceConfig {
  return { poses: [1, 2, 3], pingPong: true, crossfade: false, poseMs: 160, motionPreset: 'bounce', ...patch }
}

describe('performanceAt 演出预设', () => {
  it('none 恒为恒等变换（含 bend 与 fx 为空）', () => {
    for (const t of [0, 0.25, 0.5, 0.9]) {
      const s = performanceAt('none', t)
      expect(s).toMatchObject({ dx: 0, dy: 0, rotate: 0, scaleX: 1, scaleY: 1, bend: 0 })
      expect(s.fx).toEqual({})
    }
  })

  it('全部预设首尾帧无缝循环（t=0 与 t→1 的变换严格接近）', () => {
    for (const preset of ['bounce', 'jelly', 'sway', 'heartbeat', 'float', 'shake'] as MotionPreset[]) {
      const head = performanceAt(preset, 0)
      const tail = performanceAt(preset, 0.999999)
      for (const key of ['dx', 'dy', 'rotate', 'scaleX', 'scaleY', 'bend'] as const) {
        expect(Math.abs(head[key] - tail[key]), `${preset}.${key}`).toBeLessThan(0.02)
      }
    }
  })

  it('bounce 腾空上移且带落地影子', () => {
    const air = performanceAt('bounce', 0.22)
    expect(air.dy).toBeLessThan(-0.03)
    expect(air.fx.shadow).toBeTruthy()
    const grounded = performanceAt('bounce', 0.6)
    expect(grounded.fx.shadow!.scale).toBeGreaterThan(air.fx.shadow!.scale)
  })

  it('jelly 带弯折形变（非刚体）', () => {
    let bent = false
    for (let i = 0; i < 12; i++) {
      if (Math.abs(performanceAt('jelly', i / 12).bend) > 0.01) bent = true
    }
    expect(bent).toBe(true)
  })

  it('shake 怒抖带怒气青筋，heartbeat 心跳带星星与微闪', () => {
    expect(performanceAt('shake', 0.3).fx.anger).toBeGreaterThan(0.2)
    const beat = performanceAt('heartbeat', 0.3)
    expect(beat.fx.stars?.length).toBeGreaterThanOrEqual(2)
    expect(beat.fx.flash).toBeGreaterThan(0)
  })

  it('所有预设位移/形变有界不出画', () => {
    for (const preset of ['bounce', 'jelly', 'sway', 'heartbeat', 'float', 'shake'] as MotionPreset[]) {
      for (let i = 0; i < 16; i++) {
        const s = performanceAt(preset, i / 16)
        expect(Math.abs(s.dx)).toBeLessThan(0.06)
        expect(Math.abs(s.dy)).toBeLessThan(0.14)
        expect(Math.abs(s.bend)).toBeLessThan(0.12)
        expect(s.scaleX).toBeGreaterThan(0.7)
        expect(s.scaleX).toBeLessThan(1.3)
        expect(s.scaleY).toBeGreaterThan(0.7)
        expect(s.scaleY).toBeLessThan(1.3)
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
