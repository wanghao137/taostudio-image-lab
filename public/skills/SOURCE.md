# Skill 来源说明

## vibeshot-candid-photography

- 来源仓库：https://github.com/vibeshotclub/vsc-skills
- 子目录：`vibeshot-candid-photography/`（含 SKILL.md / README.md / agents/openai.yaml）
- 抓取 commit：`cf6cf9f`（main，2026-09-02 最后推送）
- 内置日期：2026-09-10
- 方法论出处：X 文章《从此以后，你也可以是AI摄影师》（@MANISH1027512 / VibeShotClub，2026-09-03）
- License 状态：**来源仓库未声明任何开源 license**（GitHub 元数据 license=null）。
  本目录内容仅限 TaoStudio 内部工作台使用，不得对外再分发；如需公开分发须先取得作者授权。
- 维护约定：原样内置，不改动内容；后续如更新，从上游子目录重新覆盖并在本文件追加记录。

## voyeur-style-photographer

- 来源：@VoxcatAI 的 X 文章《卧槽，我做了个色狼角色摄影师 Skill》（2026-09-09）
  https://x.com/VoxcatAI/status/2097511865857507750
- 整理方式：文章正文即完整提示词体系，整理为 SKILL.md 格式（frontmatter + 章节结构），
  提示词内容保留原文；作者原文自带安全边界（成年角色、虚构摆拍、仅公开场所）原样保留并加粗。
- 内置日期：2026-09-10
- License 状态：X 文章未附许可声明。同上，仅限 TaoStudio 内部使用，不对外再分发。

以下四个技能均为 TaoStudio Skill 工坊适配版（2026-09-11 内置）：frontmatter 保留原
name/description 并新增中文 title，原 metadata 嵌套块保留；参考文件全文内联进
SKILL.md，创作规则、禁止事项与成年声明语义未改动。来源均为本地只读研究快照
`D:\codesolo\vsc-skills-research-20260912`（vibeshot-candid-photography 同源仓库
https://github.com/vibeshotclub/vsc-skills ）。License 状态同上：来源仓库未声明开源
license，仅限 TaoStudio 内部使用，不对外再分发。

## character-candid-photography

- 来源：vsc-skills `character-candid-photography/`（作者 @VoxcatAI）
- 适配：内联 `references/photography-guide.md` 全文为「参考：摄影机位与提示词指南」节；
  工作流程第 1 步的读取文件指示句改为指向该节。

## summer-boyfriend-pov

- 来源：vsc-skills `summer-boyfriend-pov/`（作者 @94vanAI）
- 适配：内联 `references/creative-direction.md` 全文为「参考：完整创作规则」节；
  执行流程开头的读取文件指示句改为指向该节。

## shan-ze-school

- 来源：vsc-skills `shan-ze-school/`（作者 @zhurichmond）
- 适配：内联 `references/style-grammar.md` 全文为「参考：风格语法（Style Grammar）」节；
  Style Reference 节的读取文件指示句改为指向该节。

## rare-style-explorer

- 来源：vsc-skills `rare-style-explorer/`（作者 @MANISH1027512）
- 适配：删除 Python 脚本工作流（「Script Usage」「Manual Library Lookup」两节与
  `scripts/explore_styles.py` 运行步骤）；`references/style_library.json` 全部 620 条
  由一次性脚本 `.omx/gen-style-index.mjs` 转为行式索引「风格库索引（620 条）」写死进
  SKILL.md（行格式 `- {style_id} {中文风格名}［{类别}］：{视觉DNA / 关键词}`，DNA 原文
  不截断）；`--style-family` 表述改为「按风格族筛选索引」。组合规则与输出标准原文保留。
