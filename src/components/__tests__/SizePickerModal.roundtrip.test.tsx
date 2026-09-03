// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SizePickerModal from '../SizePickerModal'
import { calculateImageSize, normalizeImageSize } from '../../lib/size'

// 预设表里有 5 个档位不是 16 的倍数（4K 4:5/5:4、21:9 全档）。
// applySize 存的是 normalizeImageSize 后的值，重开弹窗必须能反查回同一个
// 比例档位，而不是落到「自定义宽高」。
function renderPicker(currentSize: string) {
  return render(
    <SizePickerModal
      currentSize={currentSize}
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

function expectRatioModeActive() {
  expect(screen.queryByText('图像比例')).not.toBeNull()
  expect(screen.queryByText('输入具体像素值')).toBeNull()
}

function expectActiveButton(label: string) {
  const button = screen.getByText(label).closest('button')
  expect(button).not.toBeNull()
  expect(button?.className).toContain('border-blue-400')
}

afterEach(() => {
  cleanup()
})

describe('SizePickerModal 尺寸反查往返', () => {
  it.each([
    ['4K', '4:5'],
    ['4K', '5:4'],
    ['1K', '21:9'],
    ['2K', '21:9'],
    ['4K', '21:9'],
  ] as const)('重开 %s %s 的已存尺寸时停留在按比例模式', (tier, ratio) => {
    const storedSize = normalizeImageSize(calculateImageSize(tier, ratio) ?? '')
    expect(storedSize).not.toBe(calculateImageSize(tier, ratio))

    renderPicker(storedSize)
    expectRatioModeActive()
    expectActiveButton(tier)
    expectActiveButton(ratio)
  })

  it('重开 4K 资产预设写入的原始尺寸（如 2400x3000）也回到比例模式', () => {
    renderPicker('2400x3000')
    expectRatioModeActive()
    expectActiveButton('4K')
    expectActiveButton('4:5')
  })

  it('非预设的自定义尺寸仍停留在自定义宽高模式', () => {
    renderPicker('1000x1000')
    expect(screen.queryByText('输入具体像素值')).not.toBeNull()
    expect(screen.queryByText('图像比例')).toBeNull()
  })
})
