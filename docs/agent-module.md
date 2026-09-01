# 创作 Agent 模块

## 1. 模块目标

创作 Agent 是视频生成工作台中的第三个入口。它采用项目式的四步流程：`创作立项 -> 视觉设定 -> 审核计划 -> 生成结果`。用户可以从一句灵感开始，也可以粘贴已有剧本或分镜；两者都先进入人工可审阅的计划阶段，再提交真实生成。

Agent 会：

1. 从服务端当前可用模型中选择兼容模型。
2. 选择符合模型能力的工作流与输出参数。
3. 为原始描述补全一段稳定的画面或镜头质量约束。
4. 调用已有的图片或视频生成接口。
5. 复用已有任务状态、下载、额度下架、访问保护和限流机制。

它不是独立供应商，也不在浏览器中保存 API Key。Agent 的职责是“编排已有模型能力”，实际媒体生成仍由已配置的阿里云、Agnes、Zhipu、SiliconFlow 或其他服务商完成。

## 2. 用户流程

```text
灵感或剧本 + 目标类型 + 视觉设定
        |
        v
POST /api/agent/plan 审核计划
        |
        v
用户确认执行计划
        |
        v
POST /api/agent/generate
        |
        +-- 图片：文生图 -> 可用图片模型 -> /api/images
        |
        +-- 视频：文生视频 -> 可用视频模型 -> /api/videos
        |
        v
统一任务状态与媒体结果
        |
        v
预览、打开、下载
```

页面会先向服务端请求计划，再展示媒体类型、工作流、模型、服务商和输出规格。只有用户确认“开始生成”后才会调用真实生成接口；执行时服务端会再次计算计划，避免浏览器目录过期或被篡改。用户在审核后仍可以“返回调整”，更改任一立项或视觉设定都会使旧计划失效，必须重新审核。

## 3. 页面入口与交互

文件：[src/agent-studio.jsx](../src/agent-studio.jsx)

顶栏的“视频 / 图片 / Agent”可以在三个工作台之间切换。Agent 页面由四个阶段组成：

| 区域 | 行为 |
| --- | --- |
| 创作立项 | 选择`灵感`或`剧本`来源，并选择`自动判断`、`生成图片`、`生成视频`。自动判断会根据动作、镜头、动画、秒数等词选择视频；海报、插画、封面等静态画面词选择图片。 |
| 视觉设定 | 选择 2D 动漫、电影感、写实质感或产品展示。视频还可指定比例和时长；若选中模型不支持，会由服务端回退到可用值。 |
| 审核生成计划 | 页面先显示本地预览，再点击“审核生成计划”取得服务端确认。计划包含来源、风格、模型、工作流和真实输出参数；若当前没有兼容模型，会给出可读错误。 |
| 生成结果 | 仅在用户确认后创建真实任务。右侧会持续显示排队、生成、完成或失败状态，并提供预览、打开、下载。 |

结果区域会自动区分图片和视频：图片支持逐张打开与下载，视频支持播放、打开与下载。重置会停止当前轮询并清空本次任务状态。

## 4. 计划器

文件：[shared/creative-agent.mjs](../shared/creative-agent.mjs)

对外唯一入口是：

```js
buildCreativeAgentPlan(
  { prompt, target, source, style, ratio, duration },
  { videoModels, imageModels },
)
```

输入：

| 字段 | 说明 |
| --- | --- |
| `prompt` | 1-5000 字符的创作描述。 |
| `target` | `auto`、`image` 或 `video`。 |
| `source` | `inspiration` 或 `script`，用于记录该项目从灵感还是已有剧本开始。默认 `inspiration`。 |
| `style` | `2D 动漫`、`电影感`、`写实质感`或`产品展示`。它会追加到实际提示词中。 |
| `ratio` | 视频比例偏好。必须是已支持的比例；模型不支持时回退到其首个合法比例。 |
| `duration` | 视频时长偏好。模型不支持时优先回退到 5 秒，再回退到其首个合法时长。 |
| `videoModels` | 已过滤免费保护、额度下架后的可用视频目录。 |
| `imageModels` | 已过滤免费保护、额度下架后的可用图片目录。 |

输出计划：

```js
{
  kind: "image" | "video",
  workflow: "text-to-image" | "text-to-video",
  modelId: "...",
  modelLabel: "...",
  provider: "...",
  summary: "...",
  brief: { source: "inspiration", style: "2D 动漫", ratio: "9:16", duration: 5 },
  request: { /* 可直接委托给原有生成接口的请求体 */ }
}
```

### 4.1 模型与参数选择规则

1. 只考虑服务端返回的可用模型；被免费保护筛掉、额度暂停或当前不兼容的模型不会进入候选列表。
2. 优先选择标为 `featured` 的模型，否则选择目录的第一个兼容模型。
3. 图片固定使用 `text-to-image`，优先选择 `2K`，模型不支持时回退到该模型第一档清晰度。
4. 视频固定使用 `text-to-video`，清晰度优先 720P；比例和时长优先采用项目设定，模型不支持时回退到它声明的合法选项。
5. 用户未选择比例时，文本包含横屏、16:9、宽画幅会优先 16:9；包含方形、1:1 会优先 1:1。
6. 视觉风格会作为实际提示词的一部分。图片计划追加“主体清晰、构图完整、层次分明”的画面约束；视频计划追加“动作自然、镜头运动连贯、画面稳定”的运动约束。

这是可解释、可测试的规则型 Agent。它不会假装具有未配置的聊天模型能力；如需把规则型计划器升级为 LLM 计划器，可在同一公共接口前增加服务端文本规划适配器。

## 5. 服务端接口

文件：[shared/video-api.mjs](../shared/video-api.mjs)

### `POST /api/agent/plan`

请求体与生成接口一致，但该接口只返回计划，不会调用图片或视频供应商，也不会创建任务：

```json
{
  "target": "auto",
  "source": "inspiration",
  "style": "2D 动漫",
  "ratio": "9:16",
  "duration": 5,
  "prompt": "5 秒 2D 动漫短片：纸飞机穿过霓虹夜城，镜头向上跟随"
}
```

响应：

```json
{
  "agentPlan": {
    "kind": "video",
    "workflow": "text-to-video",
    "modelId": "wan2.7-t2v",
    "modelLabel": "万相 2.7 文生视频",
    "provider": "dashscope",
    "summary": "文生视频 -> 万相 2.7 -> 5 秒 / 720P",
    "prompt": "...",
    "brief": { "source": "inspiration", "style": "2D 动漫", "ratio": "9:16", "duration": 5 },
    "output": { "ratio": "9:16", "duration": 5, "resolution": "720P" }
  }
}
```

### `POST /api/agent/generate`

请求：

```json
{
  "target": "auto",
  "source": "inspiration",
  "style": "2D 动漫",
  "ratio": "9:16",
  "duration": 5,
  "prompt": "5 秒 2D 动漫短片：纸飞机穿过霓虹夜城，镜头向上跟随"
}
```

成功响应沿用图片或视频任务协议，并增加 `agentPlan`：

```json
{
  "taskId": "provider-task-id",
  "provider": "dashscope",
  "modelId": "wan2.7-t2v",
  "status": "PENDING",
  "agentPlan": {
    "kind": "video",
    "workflow": "text-to-video",
    "modelId": "wan2.7-t2v",
    "modelLabel": "万相 2.7 文生视频",
    "provider": "dashscope",
    "summary": "文生视频 -> 万相 2.7 -> 5 秒 / 720P",
    "prompt": "..."
  }
}
```

图片服务若同步返回 URL，响应会直接包含 `imageUrls` 和 `status: "SUCCEEDED"`；异步图片与视频则继续使用现有的任务状态接口：

| 媒体类型 | 状态接口 |
| --- | --- |
| 视频 | `GET /api/videos/:taskId?provider=...&video_id=...` |
| 图片 | `GET /api/images/:taskId?provider=...` |

### 5.1 安全与资源保护

`/api/agent/generate` 与 `/api/images`、`/api/videos` 使用同一个 `create` 限流桶。`/api/agent/plan` 不会创建任务，但仍经过任务状态接口同级的访问保护与限流。两者都遵循以下规则：

- `VIDEO_ACCESS_TOKEN` 已配置时，请求必须携带正确访问令牌。
- `VIDEO_ACCESS_DISABLED=true` 时允许公开调用，但仍受每客户端限流保护。
- `FREE_MODELS_ONLY=true` 时，Agent 只能从免费模型白名单选取模型。
- 上游返回账户欠费或额度耗尽时，现有的模型/服务商下架逻辑继续生效。
- 所有供应商密钥只从服务端环境变量读取，绝不使用 `VITE_*` 变量。

## 6. 模型目录与 SiliconFlow

Agent 使用 `/api/models` 中的动态模型目录，而不是写死服务商 ID。配置 `SILICONFLOW_API_KEY` 后，服务端会从 SiliconFlow 的图片和视频模型目录读取可用项，再交给 Agent 选择。

保留 `FREE_MODELS_ONLY=true` 时，Agent 只会选免费白名单。若项目明确允许使用所有已配置模型，可在服务端环境变量中设置：

```env
FREE_MODELS_ONLY=false
```

这会影响整个工作台，而不只是 Agent；使用前应确认服务商账户的费用策略。

## 7. 本地运行

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173/`，点击顶栏的“Agent”。至少配置一个媒体服务商密钥后，Agent 才能提交真实生成任务。

## 8. 测试与验证

测试文件：[tests/creative-agent.test.mjs](../tests/creative-agent.test.mjs)

覆盖范围：

1. 自动判断在静态描述与动态描述间选择图片或视频。
2. 来源、视觉风格、比例与时长会进入服务端计划，并影响真实委托请求。
3. Agent 选择有效工作流、模型、时长、清晰度和比例。
4. 计划接口不会调用供应商或创建任务。
5. Agent 端点委托给原有图片/视频生成接口，而非绕过认证、限流或任务协议。
6. 图片与视频响应均带有可解释的 `agentPlan`。

运行：

```bash
npm test
npm run build
```

## 9. 后续扩展建议

| 能力 | 推荐扩展点 |
| --- | --- |
| LLM 规划 | 新增服务端规划适配器，输出仍保持 `buildCreativeAgentPlan` 的计划结构。 |
| 多步骤工作流 | 计划结构增加 `steps`，先文生图，再把结果作为首帧提交图生视频。 |
| 素材记忆 | 在登录用户命名空间存储角色、风格和常用参考图，不在浏览器保存供应商密钥。 |
| 成本预估 | 在模型目录中加入计价与余额信息，计划提交前展示预估消耗。 |
| 审批模式 | 已实现：前端将“制定计划”和“执行计划”拆成两个操作，适合团队或高成本任务。 |
