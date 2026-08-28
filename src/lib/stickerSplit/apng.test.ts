import { describe, expect, it } from 'vitest'
import { deflateSync } from 'node:zlib'
import { buildApng, crc32, parsePngChunks } from './apng'

/** 构造最小合法 RGBA PNG（node:zlib 压缩 IDAT），用于结构测试。 */
function makeTestPng(width: number, height: number, fill: [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4)
    raw[row] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4
      raw[p] = fill[0]
      raw[p + 1] = fill[1]
      raw[p + 2] = fill[2]
      raw[p + 3] = fill[3]
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const idat = new Uint8Array(deflateSync(raw))

  const out: Uint8Array[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const writeChunk = (type: string, data: Uint8Array) => {
    const head = new Uint8Array(8)
    new DataView(head.buffer).setUint32(0, data.length)
    for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i)
    const crcInput = new Uint8Array(4 + data.length)
    crcInput.set(head.subarray(4))
    crcInput.set(data, 4)
    const crc = new Uint8Array(4)
    new DataView(crc.buffer).setUint32(0, crc32(crcInput))
    out.push(head, data, crc)
  }
  writeChunk('IHDR', ihdr)
  writeChunk('IDAT', idat)
  writeChunk('IEND', new Uint8Array(0))

  const total = out.reduce((s, p) => s + p.length, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of out) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

describe('buildApng 结构', () => {
  it('crc32 标准向量', () => {
    const digits = new TextEncoder().encode('123456789')
    expect(crc32(digits)).toBe(0xcbf43926)
  })

  it('两帧重组：acTL/fcTL/fdAT 序列号与数据回环', () => {
    const png1 = makeTestPng(4, 4, [255, 0, 0, 255])
    const png2 = makeTestPng(4, 4, [0, 0, 255, 128])
    const apng = buildApng([png1, png2], [100, 250])
    expect(apng[0]).toBe(0x89)

    const chunks = parsePngChunks(apng)
    const types = chunks.map((c) => c.type)
    expect(types).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND'])

    const actl = new DataView(chunks[1].data.buffer, chunks[1].data.byteOffset)
    expect(actl.getUint32(0)).toBe(2) // 帧数
    expect(actl.getUint32(4)).toBe(0) // 无限循环

    const fc0 = new DataView(chunks[2].data.buffer, chunks[2].data.byteOffset)
    expect(fc0.getUint32(0)).toBe(0) // sequence
    expect(fc0.getUint32(4)).toBe(4) // width
    expect(fc0.getUint16(20)).toBe(100)
    expect(fc0.getUint16(22)).toBe(1000)

    const fc1 = new DataView(chunks[4].data.buffer, chunks[4].data.byteOffset)
    expect(fc1.getUint32(0)).toBe(1)
    expect(fc1.getUint16(20)).toBe(250)

    const fd = new DataView(chunks[5].data.buffer, chunks[5].data.byteOffset)
    expect(fd.getUint32(0)).toBe(2) // fdAT 序列号接在两个 fcTL 之后

    // fdAT 去掉 4 字节序列号后应与第二帧的 IDAT 完全一致
    const idat2 = parsePngChunks(png2).find((c) => c.type === 'IDAT')!
    expect(chunks[5].data.subarray(4)).toEqual(idat2.data)

    // 第一帧 IDAT 原样保留
    const idat1 = parsePngChunks(png1).find((c) => c.type === 'IDAT')!
    expect(chunks[3].data).toEqual(idat1.data)
  })

  it('空帧列表报错', () => {
    expect(() => buildApng([], [])).toThrow()
  })

  it('多 IDAT 帧全部转写为 fdAT', () => {
    const png1 = makeTestPng(3, 3, [10, 20, 30, 255])
    const png2 = makeTestPng(3, 3, [40, 50, 60, 255])
    const apng = buildApng([png1, png2, png2], [80, 80, 80])
    const chunks = parsePngChunks(apng)
    expect(chunks.filter((c) => c.type === 'IDAT')).toHaveLength(1)
    expect(chunks.filter((c) => c.type === 'fdAT')).toHaveLength(2)
    expect(chunks.filter((c) => c.type === 'fcTL')).toHaveLength(3)
    // 序列号全局单调：3 个 fcTL(0,1,2) + 2 个 fdAT(3,4)
    const seqs: number[] = []
    for (const c of chunks) {
      if (c.type === 'fcTL' || c.type === 'fdAT') seqs.push(new DataView(c.data.buffer, c.data.byteOffset).getUint32(0))
    }
    expect(seqs).toEqual([0, 1, 2, 3, 4])
  })
})
