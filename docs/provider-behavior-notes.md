# 服务行为说明（provider behavior notes）

> 记录日期：2026-09-11，基于本地网关实测（诊断脚本归档在 `.omx/`）。
> 供未来排查「参数发了但没生效」类问题时对照；各网关/通道行为可能随其上游版本变化，此处结论仅代表实测时点。

## 实测证据表

| 通道 | size | quality |
|---|---|---|
| /v1/images/generations（生成） | ✅ 真实生效（4K 实测） | ⚠️ 部分网关提示词化 |
| /v1/responses + image_generation tool（生成） | ❌ 无视（要 1152x2048 回显 1254x1254） | ❌ 改写（high→low） |
| /v1/responses + image_generation tool（编辑） | ❌ 输出锁输入图原尺寸 | ❌ 改写（high→medium） |
| /v1/images/edits（编辑） | ❌ 输出锁输入图原尺寸 | 未单独验证 |

## 结论

- 编辑任务控画幅的正解是**输入图预处理**（提交前把输入图归一到目标画幅，见优化方案 T2 的 `inputRatioPolicy`），不要依赖编辑通道的 size 参数。
- responses 通道的 quality 会被改写：任务详情的质量「请求值｜返回值」双显与「质量档已被服务端改写」警告条即为此行为的前端呈现。
