# 视频生成工作台（本地真实服务）

运行 `npm run dev` 后，打开终端显示的本地地址即可使用。这个命令同时启动前端和本地 API：视频、图片、任务状态和下载请求都会由你的电脑直接发送到已配置的服务商，不会使用演示结果。`npm run local` 仍然可用；需要只启动 Vite 前端时使用 `npm run vite`。

首次使用前，在 `.env` 中配置至少一个真实服务密钥：`DASHSCOPE_API_KEY`、`AGNES_API_KEY`、`SUB2API_API_KEY` 或 `SILICONFLOW_API_KEY`。不要使用 `VITE_` 前缀，也不要把 `.env` 提交到代码仓库。

本地服务默认读取 `.env` 中的 `VIDEO_ACCESS_DISABLED` 或 `VIDEO_ACCESS_TOKEN`；托管到 Netlify 或 Sites 后可保持公开访问，但会默认强制 `FREE_MODELS_ONLY=true`，除非服务器显式设置为 `false`。服务商密钥始终只留在服务端，模型列表只会展示已配置服务商的可调用模型。

阿里模型会将本地上传的参考图作为图片数据直接发送给服务商，因此可在本机实际使用。需要服务商从公网拉取参考图的模型，请使用可访问的 HTTPS 图片地址。
# Short Video Studio

一个面向简历展示的黑色工业风 AI 创作平台。它将“自己生成 → Agent 自动创作 → 资产沉淀”收敛为四个入口；当前默认启用免费模型保护，前端不会展示或调用付费模型。

## 产品入口

- **图片创作**：手动选择图片模型、生成方式、参考图与输出参数；结果可保存到项目资产。
- **视频创作**：手动选择兼容的视频模型和工作流，支持文生视频、首帧、首尾帧、关键帧、多图参考、续写与编辑等真实模型能力。
- **创作 Agent**：从灵感或剧本建立项目，自动沉淀立项、故事、角色、场景、提示词和按 5 秒拆分的分镜；每次先审核当前镜头的真实模型计划，再执行生成并回写资产关系。右侧会显示可解释决策和真实执行记录，包括模型审核、任务提交、状态轮询与资产归档。
- **创作资产**：按项目、类型和标签管理图片、视频、音频与文档；可查看模型、提示词、参数、版本和资产之间的关联。资产库保存于当前浏览器，媒体链接仍由原服务商托管。

当前已接入真实的图片、视频任务执行与轮询。音频生成、配音、BGM、字幕和自动剪辑在 Agent 流程中会明确显示为待接入，避免把未配置的服务伪装为已经完成的能力。

## 本地运行

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173/`。

## 当前免费模型

- 视频：`cogvideox-flash`
- 图片：`cogview-3-flash`
- Agnes 视频：`agnes-video-v2.0`
- Agnes 图片：`agnes-image-2.0-flash`、`agnes-image-2.1-flash`
- SiliconFlow 图片：`Kwai-Kolors/Kolors`

服务端通过 `FREE_MODELS_ONLY=true` 强制限制模型白名单。API 密钥只从服务端环境变量读取，不放入 `VITE_*` 变量，也不进入前端构建产物。参考图使用 24 小时有效的私有持有者链接，响应不会被公共缓存。

## SiliconFlow

配置 `SILICONFLOW_API_KEY` 后，服务端会从 SiliconFlow `/models?type=image` 和 `/models?type=video` 动态读取当前可用模型，并自动映射到文生图、参考图编辑、文生视频和首帧图生视频。图片任务使用 `/images/generations`，视频任务使用 `/video/submit` 与 `/video/status`。

项目默认保持 `FREE_MODELS_ONLY=true`，因此只展示免费白名单。SiliconFlow 当前公开价格页中两款视频模型均为付费，工作台不会把它们列为免费模型，也会在接口层拒绝直接调用。详细调研结论见 [docs/provider-free-media-models.md](docs/provider-free-media-models.md)。

## 验证

```bash
npm test
npm run build
```

视频和图片任务都通过统一的任务状态协议轮询；模型不可用或额度耗尽时，会在状态接口和页面中自动移除对应模型。

## 创作 Agent

工作台包含“Agent”入口：它只输出视频成片。服务端 LLM 会理解用户灵感或剧本，生成故事、人物、场景、分镜脚本，以及每个镜头的中间图片提示词和三段式视频提示词（素材引用、分段镜头、风格画质+约束）。人物、场景和镜头关键画面图带有 `intermediate` 标记，仅作为首帧或参考资产生成视频，不会作为 Agent 最终输出。项目总时长由用户直接输入；若超过当前模型的单次上限，系统会优先按最大合法时长分段生成，按顺序拼接并裁切为用户指定时长。模型能力绑定、计划审核、任务状态和资产版本仍复用已有受保护接口。需要配置 `AGENT_LLM_*`；未配置时按顺序尝试 `SUB2API_API_KEY`、`ZHIPU_API_KEY`、`DOTS_API_KEY`、`DASHSCOPE_API_KEY`。

`SUB2API_GROK_VIDEO_ENABLED` 默认关闭。只有在已依据实际视频接口文档验证 `/videos/generations` 协议和 `grok-imagine-video` 模型后，才应将其设为 `true`。

## Dots

`DOTS_API_KEY` 仅保存在服务端环境变量。Dots 当前公开 API 为文本与多模态理解/对话接口，未提供图片或视频生成端点，因此不会在生成模型列表中显示。
