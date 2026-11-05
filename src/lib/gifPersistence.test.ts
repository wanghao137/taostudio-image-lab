import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'
import { DEFAULT_GIF_OPTIONS } from './gif'
import { ANIMATED_GIF } from './__fixtures__/gif'

vi.mock('./db', async (original) => ({ ...await original<typeof import('./db')>(), storeImageWithSize: vi.fn(async () => ({ id: 'gif-output', width: 2, height: 2 })) }))
vi.mock('./exactImageSize', async (original) => ({ ...await original<typeof import('./exactImageSize')>(), resizeImageDataUrlToExactSize: vi.fn() }))
vi.mock('./transparentImage', async (original) => ({ ...await original<typeof import('./transparentImage')>(), removeKeyedBackgroundFromDataUrl: vi.fn() }))
import { storeImageWithSize } from './db'
import { resizeImageDataUrlToExactSize } from './exactImageSize'
import { removeKeyedBackgroundFromDataUrl } from './transparentImage'
import { storeTaskOutputImages } from './taskOutputPersistence'

describe('GIF 原件保存', () => {
  it('SVG 也绕过静态精确尺寸、比例校正与去底，不丢失矢量原件', async () => {
    const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>')}`
    const task = { params: { ...DEFAULT_PARAMS, output_format: 'svg', exact_size: true, size: '4096x4096' }, transparentOutput: true } as TaskRecord
    const result = await storeTaskOutputImages(task, [svg], undefined, { ratioAutoCorrect: true })
    expect(result.outputDataUrls).toEqual([svg])
    expect(resizeImageDataUrlToExactSize).not.toHaveBeenCalled()
    expect(removeKeyedBackgroundFromDataUrl).not.toHaveBeenCalled()
  })
  it('即使继承了尺寸校正和去底标记，也保留原始帧字节', async () => {
    const task = { params: { ...DEFAULT_PARAMS, output_format: 'gif', gif: DEFAULT_GIF_OPTIONS, exact_size: true, size: '1024x1024' }, transparentOutput: true } as TaskRecord
    const result = await storeTaskOutputImages(task, [ANIMATED_GIF], undefined, { ratioAutoCorrect: true })
    expect(result.outputDataUrls).toEqual([ANIMATED_GIF])
    expect(storeImageWithSize).toHaveBeenCalledWith(ANIMATED_GIF, 'generated')
    expect(resizeImageDataUrlToExactSize).not.toHaveBeenCalled()
    expect(removeKeyedBackgroundFromDataUrl).not.toHaveBeenCalled()
  })
})
