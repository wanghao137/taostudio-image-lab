import { describe, expect, it } from 'vitest'
import { encodeGif } from './gifEncode'

function solidFrame(w: number, h: number, fill: [number, number, number, number], delayMs: number) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let p = 0; p < data.length; p += 4) {
    data[p] = fill[0]
    data[p + 1] = fill[1]
    data[p + 2] = fill[2]
    data[p + 3] = fill[3]
  }
  return { data, width: w, height: h, delayMs }
}

describe('encodeGif gifenc 封装', () => {
  it('两帧带透明：输出 GIF89a 头 + 0x3B 结尾，逻辑屏幕尺寸正确', async () => {
    const blob = encodeGif([
      solidFrame(8, 8, [255, 0, 0, 255], 100),
      solidFrame(8, 8, [0, 255, 0, 128], 100), // alpha 128 → 不透明
    ])
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(bytes[0]).toBe(0x47) // G
    expect(bytes[1]).toBe(0x49) // I
    expect(bytes[2]).toBe(0x46) // F
    expect(String.fromCharCode(bytes[3], bytes[4], bytes[5])).toBe('89a')
    expect(bytes[6]).toBe(8) // 逻辑屏幕宽
    expect(bytes[8]).toBe(8) // 高
    expect(bytes[bytes.length - 1]).toBe(0x3b) // trailer
    expect(bytes.length).toBeGreaterThan(100)
  })

  it('alpha<128 的像素进透明通道：GIF 图形控制扩展带透明标志', async () => {
    const blob = encodeGif([solidFrame(4, 4, [200, 100, 50, 0], 120)])
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // 找 Graphic Control Extension (0x21 0xF9 0x04)，其首字节的 bit0 是透明色标志
    let gce = -1
    for (let i = 6; i < bytes.length - 5; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
        gce = i
        break
      }
    }
    expect(gce).toBeGreaterThanOrEqual(0)
    expect(bytes[gce + 3] & 0x01).toBe(1)
  })

  it('空帧列表报错', () => {
    expect(() => encodeGif([])).toThrow()
  })
})
