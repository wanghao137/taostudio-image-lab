import { describe, expect, it, vi } from 'vitest'
import { LocalAutoSavePermissionError, writeLocalAutoSaveArchive, type WritableDirectoryHandle } from './localAutoSaveWriter'

class FakeWritable {
  chunks: unknown[] = []
  closeError: unknown = null
  writeError: unknown = null

  async write(chunk: unknown) {
    if (this.writeError) throw this.writeError
    this.chunks.push(chunk)
  }

  async close() {
    if (this.closeError) throw this.closeError
    return undefined
  }
}

class FakeFileHandle {
  writable = new FakeWritable()
  createWritableError: unknown = null

  async createWritable() {
    if (this.createWritableError) throw this.createWritableError
    return this.writable
  }
}

class FakeDirectoryHandle {
  name = 'Archive'
  permission: PermissionState = 'granted'
  directories = new Map<string, FakeDirectoryHandle>()
  files = new Map<string, FakeFileHandle>()

  async queryPermission() {
    return this.permission
  }

  async requestPermission() {
    return this.permission
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
    const existing = this.directories.get(name)
    if (existing) return existing
    if (!options.create) throw new DOMException('not found', 'NotFoundError')
    const next = new FakeDirectoryHandle()
    next.name = name
    this.directories.set(name, next)
    return next
  }

  async getFileHandle(name: string) {
    const file = new FakeFileHandle()
    this.files.set(name, file)
    return file
  }
}

describe('local auto-save writer', () => {
  it('writes all files into a generated folder', async () => {
    const root = new FakeDirectoryHandle()

    const result = await writeLocalAutoSaveArchive({
      rootHandle: root as unknown as WritableDirectoryHandle,
      folderName: '2026-07-07_13-35-12_2160x3840_城市夜晚人像',
      files: [
        { name: 'image-1.png', data: new Uint8Array([1, 2, 3]), type: 'image/png' },
        { name: 'prompt.txt', data: '提示词：城市夜晚人像\n', type: 'text/plain;charset=utf-8' },
        { name: 'metadata.json', data: '{"version":1}\n', type: 'application/json;charset=utf-8' },
      ],
    })

    const folder = root.directories.get('2026-07-07_13-35-12_2160x3840_城市夜晚人像')
    expect(result).toEqual({
      folderName: '2026-07-07_13-35-12_2160x3840_城市夜晚人像',
      files: ['image-1.png', 'prompt.txt', 'metadata.json'],
    })
    expect(folder?.files.has('image-1.png')).toBe(true)
    expect(folder?.files.has('prompt.txt')).toBe(true)
    expect(folder?.files.has('metadata.json')).toBe(true)
  })

  it('returns needs_permission when readwrite permission is denied', async () => {
    const root = new FakeDirectoryHandle()
    root.permission = 'denied'

    await expect(writeLocalAutoSaveArchive({
      rootHandle: root as unknown as WritableDirectoryHandle,
      folderName: 'folder',
      files: [{ name: 'prompt.txt', data: 'prompt', type: 'text/plain;charset=utf-8' }],
    })).rejects.toMatchObject({ name: 'LocalAutoSavePermissionError' })
  })

  it('creates a suffixed folder instead of writing into an existing folder', async () => {
    const root = new FakeDirectoryHandle()
    const existingBase = new FakeDirectoryHandle()
    const existingSuffix = new FakeDirectoryHandle()
    const existingFile = new FakeFileHandle()
    existingBase.name = 'folder'
    existingSuffix.name = 'folder-2'
    existingBase.files.set('prompt.txt', existingFile)
    root.directories.set('folder', existingBase)
    root.directories.set('folder-2', existingSuffix)

    const result = await writeLocalAutoSaveArchive({
      rootHandle: root as unknown as WritableDirectoryHandle,
      folderName: 'folder',
      files: [{ name: 'prompt.txt', data: 'new prompt', type: 'text/plain;charset=utf-8' }],
    })

    expect(result).toEqual({
      folderName: 'folder-3',
      files: ['prompt.txt'],
    })
    expect(existingBase.files.get('prompt.txt')).toBe(existingFile)
    expect(root.directories.get('folder-3')?.files.has('prompt.txt')).toBe(true)
  })

  it.each(['NotAllowedError', 'SecurityError'])(
    'preserves permission-like errors from getDirectoryHandle as LocalAutoSavePermissionError: %s',
    async (errorName) => {
      const root = new FakeDirectoryHandle()
      vi.spyOn(root, 'getDirectoryHandle').mockRejectedValueOnce(new DOMException('denied', errorName))

      await expect(writeLocalAutoSaveArchive({
        rootHandle: root as unknown as WritableDirectoryHandle,
        folderName: 'folder',
        files: [{ name: 'prompt.txt', data: 'prompt', type: 'text/plain;charset=utf-8' }],
      })).rejects.toBeInstanceOf(LocalAutoSavePermissionError)
    },
  )

  it.each([
    'getFileHandle',
    'createWritable',
    'write',
    'close',
  ])(
    'preserves permission-like errors from %s as LocalAutoSavePermissionError',
    async (operation) => {
      const root = new FakeDirectoryHandle()
      const folder = new FakeDirectoryHandle()
      const file = new FakeFileHandle()
      vi.spyOn(root, 'getDirectoryHandle').mockImplementation(async (_name, options) => {
        if (options?.create === false) throw new DOMException('not found', 'NotFoundError')
        return folder
      })
      if (operation === 'getFileHandle') {
        vi.spyOn(folder, 'getFileHandle').mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
      } else {
        vi.spyOn(folder, 'getFileHandle').mockResolvedValueOnce(file)
      }
      if (operation === 'createWritable') file.createWritableError = new DOMException('denied', 'SecurityError')
      if (operation === 'write') file.writable.writeError = new DOMException('denied', 'NotAllowedError')
      if (operation === 'close') file.writable.closeError = new DOMException('denied', 'SecurityError')

      await expect(writeLocalAutoSaveArchive({
        rootHandle: root as unknown as WritableDirectoryHandle,
        folderName: 'folder',
        files: [{ name: 'prompt.txt', data: 'prompt', type: 'text/plain;charset=utf-8' }],
      })).rejects.toBeInstanceOf(LocalAutoSavePermissionError)
    },
  )

  it('wraps write failures with a user-facing message', async () => {
    const root = new FakeDirectoryHandle()
    vi.spyOn(root, 'getDirectoryHandle').mockRejectedValueOnce(new Error('disk full'))

    await expect(writeLocalAutoSaveArchive({
      rootHandle: root as unknown as WritableDirectoryHandle,
      folderName: 'folder',
      files: [{ name: 'prompt.txt', data: 'prompt', type: 'text/plain;charset=utf-8' }],
    })).rejects.toThrow('本地自动保存失败：disk full')
  })
})
