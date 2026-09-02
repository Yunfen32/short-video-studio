# 创作 Agent 模块

## 1. 模块目标

创作 Agent 是视频生成工作台中的第三个入口。它采用项目式的四步流程：`创作立项 -> 视觉设定 -> 审核计划 -> 生成结果`。用户可以从一句灵感开始，也可以粘贴已有剧本或分镜；两者都先进入人工可审阅的计划阶段，再提交真实生成。

项目建立后会同时保存一份 **Creative State**。它记录创作目标、动态工作流、当前步骤、暂停/阻塞状态和最近一次可解释事件；因此状态不只是聊天记录，也不依赖页面是否仍然打开。

Agent 会：

1. 由服务端 LLM 理解灵感或剧本，形成结构化创作方案。
2. 从方案中提取故事、主要人物、场景和可编辑分镜脚本文件。
3. 为每个分镜分别生成关键画面的 `imagePrompt` 和三段式运动镜头 `videoPrompt`（素材引用、分段镜头、风格画质+约束）。
4. 从服务端当前可用模型中选择兼容模型，校验用户选择的风格、比例与时长。
5. 先调用图片模型生成镜头关键画面，再将关键画面作为首帧参考提交视频模型。
6. 复用已有任务状态、下载、额度下架、访问保护和限流机制。
7. 在本地运行时通过 FFmpeg 按分镜顺序合并已完成镜头；最后一段如因模型最小合法时长而超出，会裁切到用户输入的项目总时长后归档。

它不是独立供应商，也不在浏览器中保存 API Key。Agent 的职责是“编排已有模型能力”，实际媒体生成仍由已配置的阿里云、Agnes、Zhipu、SiliconFlow 或其他服务商完成。

创作规划必须经过服务端 LLM；未配置 LLM 时接口会明确返回配置错误，不会偷偷退回关键词或固定模板。模型选择和参数校验仍是确定性的执行约束，用来保证 LLM 方案能够被现有媒体供应商实际执行。

## 2. 用户流程

```text
灵感或剧本 + 视频风格、比例、时长
        |
        v
POST /api/agent/project-plan
        |
        v
保存故事、人物、场景和分镜脚本文件
        |
        v
逐镜头生成中间关键画面
        |
         +-- 图片中间资产：imagePrompt -> /api/images
        |       （不作为项目最终输出）
        |
         +-- 视频成片：videoPrompt + 首帧 -> /api/videos
        |
        v
按顺序拼接视频镜头
        |
        v
预览、打开、下载、归档
```

页面会先向服务端请求计划，再展示媒体类型、工作流、模型、服务商和输出规格。只有用户确认“开始生成”后才会调用真实生成接口；执行时服务端会再次计算计划，避免浏览器目录过期或被篡改。用户在审核后仍可以“返回调整”，更改任一立项或视觉设定都会使旧计划失效，必须重新审核。

## 3. 页面入口与交互

文件：[src/agent-studio.jsx](../src/agent-studio.jsx)

顶栏的“视频 / 图片 / Agent”可以在三个工作台之间切换。Agent 页面由四个阶段组成：

| 区域 | 行为 |
| --- | --- |
| 创作立项 | 选择`灵感`或`剧本`来源。Agent 固定输出视频成片；点击“创建项目与分镜”后由服务端 LLM 按用户的风格、比例和时长制定视频分镜。 |
| 视觉设定 | 选择 2D 动漫、电影感、写实质感或产品展示。视频比例由用户选择，项目时长可直接输入 1-300 秒。系统会读取当前模型的单次时长能力。 |
| 审核生成计划 | 项目创建时先取得 LLM 结构化方案；单镜头执行时再取得服务端模型计划。计划包含来源、风格、模型、工作流和真实输出参数；若当前没有兼容模型，会给出可读错误。 |
| 生成结果 | 仅在用户确认后创建真实任务。右侧会持续显示排队、生成、完成或失败状态，并提供预览、打开、下载。 |
| 项目成片 | 项目会先为人物、场景和每个镜头生成中间关键画面，再将镜头图作为首帧生成视频。总时长超过单次模型上限时，会优先用模型的最大合法时长拆分；最后一段按最短可覆盖的合法时长生成。全部完成后，FFmpeg 按分镜顺序拼接并裁切为用户输入的总时长。 |
| 创作状态与人工干预 | 用户可保存某一镜头的修改、重新审核以创建新的视频版本，也可在连续执行中要求当前镜头结束后暂停后续镜头。 |

结果区域只展示最终视频；图片会带有`intermediate`标记保存在资产中心，作为人物、场景或首帧参考，不提供为 Agent 最终结果。重置会停止当前轮询并清空本次任务状态。

## 4. 计划器

文件：[shared/creative-agent.mjs](../shared/creative-agent.mjs)

对外唯一入口是：

```js
buildCreativeAgentPlan(
  { prompt, target: "video", source, style, ratio, duration, images },
  { videoModels, imageModels },
)
```

输入：

| 字段 | 说明 |
| --- | --- |
| `prompt` | 1-5000 字符的创作描述。 |
| `target` | 执行阶段为 `image` 或 `video`；`auto` 只在服务端 LLM 项目规划请求中使用。 |
| `source` | `inspiration` 或 `script`，用于记录该项目从灵感还是已有剧本开始。默认 `inspiration`。 |
| `style` | `2D 动漫`、`电影感`、`写实质感`或`产品展示`，作为 LLM 的硬约束。 |
| `ratio` | 视频比例偏好。必须是已支持的比例；模型不支持时回退到其首个合法比例。 |
| `duration` | 执行阶段为单镜头实际提交给模型的生成时长；项目建立阶段是用户输入的成片总时长。 |
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

### 4.1 模型与参数约束

1. 只考虑服务端返回的可用模型；被免费保护筛掉、额度暂停或当前不兼容的模型不会进入候选列表。
2. 优先选择标为 `featured` 的模型，否则选择目录的第一个兼容模型。
3. 图片固定使用 `text-to-image`，优先选择 `2K`，提示词直接来自 LLM 的 `imagePrompt`。
4. 有关键画面时视频使用 `first-frame`，否则使用 `text-to-video`；清晰度优先 720P，比例和单镜头时长必须是模型声明的合法选项。
5. 项目总时长由用户直接输入（1-300 秒）。超过单段上限时，代码先按当前兼容模型的最大合法时长计算实际生成段；LLM 只为这些段编写连续分镜。最后一段如实际生成时长大于成片保留时长，最终拼接会裁切尾部，确保成片严格等于用户输入。
6. 每个视频分镜同时保存 `duration`（模型生成时长）和 `timelineDuration`（成片保留时长）。所有 `timelineDuration` 之和严格等于项目总时长。
7. `videoPrompt` 由 LLM 根据分镜脚本生成，严格保留三段式：`【素材引用】` 中列出 `@场景图1`、`@角色1`、`@道具1` 等涉及资产；`【分段镜头】` 用从 0 秒开始的连续时间段描述镜头、动作、台词和环境音；`【风格画质+约束】` 写入风格、比例、画质、连续性与负面约束。
8. LLM 负责视觉风格、人物连续性、动作和镜头语言；代码只做字段清洗、引用关系校验、模型时长约束和最终裁切。

`buildCreativeAgentPlan` 现在只负责把已准备好的提示词绑定到实际媒体模型；真正的创作规划由服务端 LLM 完成。

## 4.2 Creative State 与动态工作流

文件：[src/creative-library.mjs](../src/creative-library.mjs)

每个项目都会随资产库一起持久化以下状态：

```js
{
  target: 'image' | 'video',
  status: 'ready' | 'running' | 'waiting_review' | 'paused' | 'blocked' | 'complete',
  currentStepId: '...',
  paused: false,
  lastEvent: '可读的最近动作说明',
  workflow: [{ id, label, detail, status }]
}
```

这不是对未接入能力的虚构：工作流只显示当前项目实际可执行的资料、分镜、图片或视频步骤。音频、字幕和合成在未接入相应服务前不会标记为已完成。

连续镜头执行会在每个真实任务完成并归档后更新该状态；出现错误时标为 `blocked`，用户请求暂停时只停止后续任务（已经提交给供应商的当前任务不会被强行取消）。镜头资料修改后，既有结果仍保留在资产库中，新生成内容以版本形式关联到同一镜头。

## 5. 服务端接口

文件：[shared/video-api.mjs](../shared/video-api.mjs)

### `POST /api/agent/project-plan`

该接口调用服务端 LLM，返回完整的项目方案，但不会调用图片或视频供应商，也不会创建媒体任务：

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

响应包含 `creativePlan`：

```json
{
  "creativePlan": {
    "target": "video",
    "title": "雨夜纸飞机",
    "story": "...",
    "characters": [{ "id": "girl", "name": "少女", "imagePrompt": "..." }],
    "scenes": [{ "id": "street", "name": "雨夜街道", "imagePrompt": "..." }],
    "shots": [{ "duration": 18, "timelineDuration": 12, "imagePrompt": "...", "videoPrompt": "【素材引用】\n...\n\n【分段镜头】\n...\n\n【风格画质+约束】\n..." }]
  },
  "planner": { "provider": "sub2api_grok", "model": "grok-4.5", "planning": "llm" }
}
```

### `POST /api/agent/plan`

单镜头审核接口。未带 `promptPrepared: true` 时会先由 LLM 把原始描述整理成一个镜头；项目队列会传入分镜文件中的已准备提示词，服务端只做模型能力绑定。该接口会保存短期 `planId`，不会创建媒体任务。

### `POST /api/agent/generate`

请求：

```json
{
  "planId": "审核阶段返回的短期计划编号"
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

`/api/agent/generate` 使用独立的 `agent-create` 限流桶（默认每小时 60 次），避免一个长项目的多镜头任务被普通单镜头配额截断；`/api/agent/project-plan` 与 `/api/agent/plan` 使用独立的 `plan` 限流桶（默认每小时 60 次），因为它们会调用 LLM。两者都遵循以下规则：

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

打开 `http://127.0.0.1:5173/`，点击顶栏的“Agent”。至少配置一个 Agent LLM 密钥和一个媒体服务商密钥后，Agent 才能完成从规划到真实生成的完整流程。LLM 支持 `AGENT_LLM_*` 通用配置；未配置时按顺序尝试 `SUB2API_API_KEY`、`ZHIPU_API_KEY`、`DOTS_API_KEY`、`DASHSCOPE_API_KEY`。

## 8. 测试与验证

测试文件：[tests/creative-agent.test.mjs](../tests/creative-agent.test.mjs)

覆盖范围：

1. 项目规划接口确实调用 LLM，并返回人物、场景、分镜和双提示词。
2. 用户选择的目标、视觉风格、比例与总时长会进入 LLM 约束并保留在方案中。
3. 用户可输入项目总时长；分镜按模型最大合法单段时长拆分，`timelineDuration` 总和严格匹配用户输入，最终拼接会裁切多余尾帧。
4. 视频提示词必须保留“素材引用 / 分段镜头 / 风格画质+约束”三段式。
4. 已审核的镜头计划只委托给原有图片/视频生成接口，不会在执行阶段重新规划。
5. 视频镜头会优先使用先生成的关键画面作为首帧参考。
6. 图片与视频响应均带有可解释的 `agentPlan`，项目脚本和人物/场景文档会归档到资产中心。

运行：

```bash
npm test
npm run build
```

## 9. 后续扩展建议

| 能力 | 推荐扩展点 |
| --- | --- |
| LLM 规划 | 已实现：`/api/agent/project-plan` 使用结构化 JSON Schema 调用服务端 LLM。 |
| 多步骤工作流 | 已实现：逐镜头先生成关键画面，再把结果作为首帧提交图生视频。 |
| 素材记忆 | 在登录用户命名空间存储角色、风格和常用参考图，不在浏览器保存供应商密钥。 |
| 成本预估 | 在模型目录中加入计价与余额信息，计划提交前展示预估消耗。 |
| 审批模式 | 已实现：前端将“制定计划”和“执行计划”拆成两个操作，适合团队或高成本任务。 |
