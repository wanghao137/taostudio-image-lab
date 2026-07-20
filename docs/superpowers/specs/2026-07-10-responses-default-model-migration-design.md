# Responses API 默认模型迁移设计

## 背景

TaoStudio Image Lab 当前按 API 接口类型维护两个内置模型默认值：

- Images API：`gpt-image-2`
- Responses API：`gpt-5.5`

设置界面允许用户手动输入模型 ID，并会在当前模型仍属于内置默认值时，随 API 模式切换自动替换模型。目标是将 Responses API 的内置默认模型更新为 `gpt-5.6-sol`，并迁移仍使用旧默认值 `gpt-5.5` 的已有配置，同时不覆盖其他自定义模型。

`gpt-5.6-sol` 按用户指定的 OpenAI 兼容接口模型 ID 处理。本次改动不增加远程模型列表查询，也不把任何特定 API 网关写入产品逻辑。

## 目标行为

| 场景 | 期望模型 |
| --- | --- |
| 新建 Images API 配置 | `gpt-image-2` |
| 新建 Responses API 配置 | `gpt-5.6-sol` |
| Images 模式切换到 Responses，当前模型为内置默认值 | `gpt-5.6-sol` |
| Responses 模式切换到 Images，当前模型为内置或旧版默认值 | `gpt-image-2` |
| 加载 Responses 配置且模型为 `gpt-5.5` | 自动归一化为 `gpt-5.6-sol` |
| 加载或切换包含其他自定义模型的配置 | 保持原模型不变 |
| URL 仅指定 `apiMode=responses` | 默认使用 `gpt-5.6-sol` |
| URL 明确指定其他非空 `model` | 保持明确指定值 |

精确值 `gpt-5.5` 被定义为旧版 Responses 内置默认值。系统无法区分“历史默认产生的 `gpt-5.5`”与“用户手动输入的同名模型”，因此所有 OpenAI Responses 配置中的精确 `gpt-5.5` 都按旧默认值迁移；其他模型 ID 一律保留。

## 设计

### 1. 统一默认模型规则

在 `src/lib/apiProfiles.ts` 中保留 Images 与 Responses 两个默认模型常量，将 Responses 常量更新为 `gpt-5.6-sol`，并记录旧版 Responses 默认值 `gpt-5.5`。

提供可复用的模式映射与默认值判断函数，作为以下路径的共同规则：

- 默认 OpenAI 配置创建；
- 配置归一化；
- 设置界面 API 模式切换；
- URL 参数导入。

这样可以避免设置组件维护一套规则、配置归一化维护另一套规则。

### 2. 默认配置创建

`createDefaultOpenAIProfile` 在调用方没有明确提供模型、部署默认 URL 也没有提供模型时，根据最终 `apiMode` 选择模型：

- `images` -> `gpt-image-2`
- `responses` -> `gpt-5.6-sol`

明确传入的其他非空模型继续优先，确保兼容自定义服务商和 URL 配置。

### 3. 旧配置迁移

OpenAI 配置归一化时执行窄范围迁移：

- 仅当 `apiMode === 'responses'` 且模型精确等于 `gpt-5.5` 时替换为 `gpt-5.6-sol`；
- 空模型按当前 API 模式补默认值；
- `gpt-5.5-pro`、供应商别名及任何其他自定义模型均不修改；
- fal 与自定义 Images 服务商不参与 Responses 模型迁移。

持久化状态在加载时已经经过 `normalizeSettings`，所以旧配置会以新模型进入应用状态；后续设置保存或其他状态持久化会写回归一化结果。不需要引入独立迁移弹窗。

### 4. 设置界面切换

设置界面不再自行维护 Responses/Images 的映射逻辑，而调用配置层帮助函数。

只有当前模型属于以下“受管理默认值”时，API 模式切换才自动替换模型：

- `gpt-image-2`
- `gpt-5.6-sol`
- 旧默认值 `gpt-5.5`

其他模型视为用户自定义值，切换 API 模式时保持不变。

### 5. URL 参数

现有 URL 导入逻辑继续允许 `apiMode` 与 `model` 独立覆盖：

- 只有 `apiMode=responses` 时使用新 Responses 默认值；
- 明确指定其他非空 `model` 时保留该模型；
- 明确指定旧默认 `model=gpt-5.5` 时，按旧默认迁移规则归一化为 `gpt-5.6-sol`。

## 错误处理与兼容性

- 不新增模型可用性探测；接口若不支持 `gpt-5.6-sol`，继续使用现有请求错误与诊断展示。
- 不改变 API URL、代理、鉴权、流式传输或 `image_generation` 工具请求结构。
- 不强制锁定模型输入框，用户仍可改用任意兼容模型 ID。
- 不修改历史任务中已经记录的 `apiModel`，避免篡改任务审计信息。

## 测试设计

先添加失败测试，再实现最小改动：

1. `createDefaultOpenAIProfile({ apiMode: 'responses' })` 返回 `gpt-5.6-sol`。
2. `normalizeSettings` 将 Responses 配置的 `gpt-5.5` 迁移到 `gpt-5.6-sol`。
3. `normalizeSettings` 保留 Responses 配置的其他自定义模型。
4. URL 仅传 `apiMode=responses` 时生成新默认模型。
5. URL 明确传入其他模型时保持该值。
6. 设置界面所依赖的默认值判断覆盖 Images、新 Responses 默认值和旧 Responses 默认值。

实现后运行：

```bash
npm test
npm run build
npm run lint
```

本次属于配置逻辑与设置文案更新，不改变布局；若本地应用可直接启动，再检查设置弹窗中两种模式的模型切换。生产站点不会在未部署的情况下用于验证此本地改动。

## 非目标

- 不验证或注册远程服务商的模型目录。
- 不修改 Agent 独立文本配置策略。
- 不升级历史文档、示例、任务记录或测试夹具中仅用于模拟响应的模型字符串。
- 不提交、推送或部署代码，除非用户另行明确授权。
