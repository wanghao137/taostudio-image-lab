import { describe, expect, it } from 'vitest'
import { scanLocalSkills } from './localSkills'

function fakeSkillDirectory(name: string, files: Record<string, string>) {
  return {
    kind: 'directory',
    name,
    getFileHandle: async (fileName: string) => {
      if (!(fileName in files)) throw new DOMException('NotFoundError', 'NotFoundError')
      return {
        kind: 'file',
        name: fileName,
        getFile: async () => ({ text: async () => files[fileName] }) as unknown as File,
      }
    },
  } as unknown as FileSystemDirectoryHandle
}

function fakeFileEntry(name: string) {
  return { kind: 'file', name } as unknown as FileSystemHandle
}

function fakeSkillsRoot(entries: Array<[string, FileSystemHandle]>) {
  return {
    kind: 'directory',
    name: 'skills-root',
    // 同步迭代器满足 for-await 的降级协议，真实句柄的 entries() 是异步迭代器
    entries: () => entries[Symbol.iterator]() as unknown as AsyncIterableIterator<[string, FileSystemHandle]>,
  } as unknown as FileSystemDirectoryHandle
}

describe('scanLocalSkills', () => {
  it('遍历一级子目录读取 SKILL.md，frontmatter name 缺失时回退目录名', async () => {
    const root = fakeSkillsRoot([
      ['my-skill', fakeSkillDirectory('my-skill', {
        'SKILL.md': '---\nname: My Skill\ndescription: 描述文本\n---\n\n正文',
      })],
      ['fallback-skill', fakeSkillDirectory('fallback-skill', {
        'SKILL.md': '无 frontmatter 的正文内容',
      })],
    ])

    const skills = await scanLocalSkills(root)

    expect(skills).toHaveLength(2)
    expect(skills[0]).toEqual({ id: 'my-skill', name: 'My Skill', description: '描述文本', body: '正文', source: 'local' })
    expect(skills[1]).toMatchObject({ id: 'fallback-skill', name: 'fallback-skill', body: '无 frontmatter 的正文内容' })
  })

  it('跳过无 SKILL.md 的子目录与文件条目', async () => {
    const root = fakeSkillsRoot([
      ['has-skill', fakeSkillDirectory('has-skill', { 'SKILL.md': '正文' })],
      ['no-skill', fakeSkillDirectory('no-skill', { 'README.md': '不是 SKILL' })],
      ['notes.txt', fakeFileEntry('notes.txt')],
    ])

    const skills = await scanLocalSkills(root)

    expect(skills).toHaveLength(1)
    expect(skills[0].id).toBe('has-skill')
  })

  it('空根目录返回空数组', async () => {
    expect(await scanLocalSkills(fakeSkillsRoot([]))).toEqual([])
  })
})
