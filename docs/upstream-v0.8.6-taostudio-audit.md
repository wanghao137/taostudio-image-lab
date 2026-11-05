# TaoStudio 升级 v0.8.6 审计

日期：2026 年 11 月 5 日。

## 两批发布

1. 当前 GIF 工作台已以 `ee584d019ad642c0c9c417a480acbb2adad020a2` 提交并推送；[生产部署工作流](https://github.com/wanghao137/taostudio-image-lab/actions/runs/41986307275) 成功。线上桌面与手机检查确认自有 GIF 工作台、两个模型、六档画质与时序控制已上线。
2. 本次从上游 v0.8.4 基线 `4b46b292a2b8ef42a703aabec27d2b8c8a253b0a` 三方迁移至 [v0.8.6](https://github.com/CookSleep/gpt_image_playground/releases/tag/v0.8.6)，目标提交 `d6b96793b0231dd54d9c5cef62125951c72fc9e8`，包含 v0.8.5 的累计更新。迁移在独立工作树及 `codex/upstream-v0.8.6` 分支完成。

## 合并原则与结果

升级的判断依据是可观察的产品行为：旧配置仍能使用原模型和接口，已有任务与原件仍能恢复，自有场景与 4K 路径仍成立，新参数真正进入请求。没有用上游整目录覆盖本地，也没有修改参考克隆或本地服务商容器。

- 新建 Images 配置默认 `gpt-image-2.6-sunburst`；已有模型、模型列表、场景覆盖与 Images/Responses 的模型记忆保留。旧 2.5 默认模型仍被模式切换规则识别，避免切到 Responses 后误带图片模型。
- 合入复杂度、SVG 编写模型、fal.ai 2.6、共享 GIF 参数、审核明细与独立画板标注层。
- 自有 GIF 工作台继续使用任务局部模型、2–64 帧、完整 GIF 检验、静态辅助图分离、刷新恢复与原件下载。画廊新 GIF 控件按上游开放 2–16 帧；两种配置不会互相覆盖。
- SVG/GIF 原件跳过静态尺寸校正、比例裁切和去底，避免丢失矢量或动画。静态图的 4K、原图关联和尺寸变换记录保留。
- 标注层加入任务重试、复用、场景草稿、持久化、隐私快照与清理引用。带独立标注时与遮罩一样跳过输入图比例预处理，避免只裁切原图导致标注坐标错位；普通静态输入的原有预处理不变。
- TaoStudio 桌面参数区和手机创作抽屉分别接入新控件，保留自有 4K、批量、历史和输入图比例操作。窄屏参数分段允许换行，折叠容器允许收缩。

## 冲突与保留文件逐项审计

升级器报告 17 个冲突、5 个保留文件审计项及 1 个 removedPaths 项，按下列决策处理：

| 路径 | 决策 |
| --- | --- |
| `README.md` | 保留 TaoStudio 产品说明与部署入口；上游 README 的介绍、示例默认模型及原产品截图不覆盖本地；本文件与参数文档记录新能力 |
| `docs/custom-provider-llm-prompt.md` | 合入 complexity、GIF、SVG 模板变量与新示例默认模型，保留本地文档结构 |
| `gpt-image-config.agent.example.json`、`src/lib/agentApi.ts`、`src/lib/cliBridge.ts` | 保持删除；不恢复已移除的 Agent 或暂缓接线的网页 CLI bridge |
| `gpt-image-config.example.json` | 只更新示例模型；保留本地接口模式等配置 |
| `package-lock.json` | 按最终本地 package.json 安装校验；依赖版本未发生批量升级，仅项目版本更新 |
| `src/components/DetailModal.tsx` | 保留精确尺寸与原件信息，加入复杂度、帧数、帧间隔等任务详情 |
| `src/components/InputBar.tsx` | 手工接入新参数与标注预览，保留本地 inline 参数区、4K、批量、历史、比例控制；未以未使用的上游面板替换 |
| `src/components/SettingsModal.tsx` | 保留自动保存、模型记忆与配置导入规则，合入 SVG 模型和 Responses 模型说明；不引回 Agent 文案 |
| `src/index.css` | 仅补折叠区域 `min-width: 0`，保留 TaoStudio 样式 |
| `src/lib/api.test.ts` | 新配置默认模型断言跟随默认常量，其余协议回归保留 |
| `src/lib/api.ts` | 保留任务指定档案和场景解析，合入标注原生发送/合成逻辑；自有 GIF 校验限于其独立任务参数 |
| `src/lib/apiProfiles.ts` | 合并 SVG 配置归一化与本地 modelByApiMode；不迁移或覆盖存量模型 |
| `src/lib/imageApiShared.ts` | 合入 2.6 参数、SVG MIME 与审核辅助函数，保留 API 错误结构、恢复信息和 GIF 元数据 |
| `src/lib/imageModels.ts` | 新建默认模型更新；合入 2.5+、2.6+ 能力识别，保留本地宽松调用签名 |
| `src/lib/inputDraftState.ts` | 独立标注层与本地输入图宽高一起保存；不恢复已删除的 Agent 草稿路径 |
| `src/lib/openaiCompatibleImageApi.ts` | 合并共享参数、markup 与 SVG 并发，保留重试/代理/诊断；自有 GIF 仍禁止隐式重发、压缩和流式 |
| `src/lib/paramCompatibility.ts` | 保留按服务能力处理 4K 请求与精确尺寸意图；加入新格式/画质限制，自有 GIF 独立参数不被普通图片规则改写 |
| `src/lib/persistedState.ts` | 在本地收藏、场景、Skill、提示词历史与尺寸字段上加法合并新字段，兼容缺少字段的旧数据 |
| `src/store.test.ts` | 保留 TaoStudio 既有测试；默认模型断言跟随默认常量，canvas mock 改为只替换遮罩校验，保留新增输入转换辅助函数 |
| `src/store.ts` | 保留任务槽位、4K、自动保存、场景/Skill、收藏与删除事务，合入标注生命周期、SVG 并发与输入转换 |
| `src/types.ts` | 加法合并格式、复杂度、GIF、SVG 及标注字段；保留自有 TaskParams.gif、精确尺寸和场景契约 |

## 验证记录

- 关键参数与配置兼容测试：205 项通过。
- Task API service 与 web-agent 专项：60 项通过。
- 升级器专项：23 项通过。
- 自有场景浏览器检查与 64 帧、多结果 GIF 原件流程通过。
- finalize 已通过：113 个测试文件全部通过，1465 项通过、6 项跳过；构建成功；lint 为 0 错误、93 项既有警告。基线已正式推进到 v0.8.6，pending 迁移文件已清除。
- 同目标重复 dry-run 通过：新增、更新、合并、删除、保留审计及冲突均为 0，未重复应用上游改动。
- 本地浏览器新增 `scripts/verify-upstream086.mjs` 检查桌面与手机新控件进入请求、SVG 多结果及原件字节保留；使用模拟服务，不产生真实生成费用。
- 已回放原 3001 返回的真实 GIF，确认新版本下混合输出提取、实际帧数、原件保存与下载、刷新恢复、64 帧和多结果控制仍成立。浏览器证据已归档到 `output/release-20261105/upstream086/`。

本次没有重新编译或发布桌面安装包，没有重测服务商 GIF 权限和真实 4K 计费请求。8090、3001 已确认的服务端兼容限制仍见 [真实接口验收报告](gif-live-validation-2026-11-05.md)，应用升级不代表网关已修复。
