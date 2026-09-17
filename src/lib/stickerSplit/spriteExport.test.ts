import { describe, expect, it } from 'vitest'
import { spriteFramesZipEntries } from './spriteExport'

// 画布相关导出（GIF/APNG 帧构建）依赖浏览器 canvas，由 store 测试整体 mock；
// 这里只覆盖纯 JS 部分（ZIP 条目命名与 base64 解码，Node 可测）。
describe('spriteExport 纯函数', () => {
  it('spriteFramesZipEntries：帧 dataUrl → PNG 条目，命名 frame-01 起，字节与载荷一致', () => {
    const payload = 'fake-png-bytes'
    const base64 = Buffer.from(payload).toString('base64')
    const files = spriteFramesZipEntries([`data:image/png;base64,${base64}`, `data:image/png;base64,${base64}`])

    expect(Object.keys(files)).toEqual(['frame-01.png', 'frame-02.png'])
    expect(Buffer.from(files['frame-01.png']).toString()).toBe(payload)
    expect(Buffer.from(files['frame-02.png']).toString()).toBe(payload)
  })

  it('空帧列表返回空对象（downloadSpriteFramesZip 的 0 帧守卫依据）', () => {
    expect(Object.keys(spriteFramesZipEntries([]))).toHaveLength(0)
  })
})
