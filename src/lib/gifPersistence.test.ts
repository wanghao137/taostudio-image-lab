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
  it('即使继承了尺寸校正和去底标记，也保留原始帧字节', async () => {
    const task = { params: { ...DEFAULT_PARAMS, output_format: 'gif', gif: DEFAULT_GIF_OPTIONS, exact_size: true, size: '1024x1024' }, transparentOutput: true } as TaskRecord
    const result = await storeTaskOutputImages(task, [ANIMATED_GIF], undefined, { ratioAutoCorrect: true })
    expect(result.outputDataUrls).toEqual([ANIMATED_GIF])
    expect(storeImageWithSize).toHaveBeenCalledWith(ANIMATED_GIF, 'generated')
    expect(resizeImageDataUrlToExactSize).not.toHaveBeenCalled()
    expect(removeKeyedBackgroundFromDataUrl).not.toHaveBeenCalled()
  })
})
