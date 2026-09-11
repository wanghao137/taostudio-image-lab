// ---------------------------------------------------------------------------
// 本地 skills 目录扫描（Skill Workshop P2 Task 4）
// 遍历用户授权的 skills 根目录一级子目录，读取每个子目录的 SKILL.md 生成
// SkillSummary；无 SKILL.md 的子目录与文件条目跳过，单目录读取失败不阻断
// 其余目录。权限（queryPermission/requestPermission）由 store 侧处理：
// requestPermission 需要用户手势且要 toast 反馈，扫描函数保持可独立单测。
// ---------------------------------------------------------------------------

import type { SkillSummary } from '../../types'
import { parseSkillMarkdown } from './skillMarkdown'

/** 项目 tsconfig lib 未含 DOM.AsyncIterable，entries() 无类型；与仓库内
 *  window API（showDirectoryPicker 等）的本地最小声明 cast 风格一致。 */
type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>
}

export async function scanLocalSkills(root: FileSystemDirectoryHandle): Promise<SkillSummary[]> {
  const skills: SkillSummary[] = []
  for await (const [name, entry] of (root as IterableDirectoryHandle).entries()) {
    if (entry.kind !== 'directory') continue
    try {
      const skillFile = await (entry as FileSystemDirectoryHandle).getFileHandle('SKILL.md')
      const text = await (await skillFile.getFile()).text()
      const parsed = parseSkillMarkdown(text, name)
      if (!parsed) continue
      skills.push({
        id: name,
        name: parsed.name,
        title: parsed.title,
        description: parsed.description,
        body: parsed.body,
        source: 'local',
      })
    } catch {
      // 无 SKILL.md 或读取失败：跳过该子目录
    }
  }
  return skills
}
