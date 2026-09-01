# 免费媒体模型调研

调研日期：2026-08-22

本项目的 `FREE_MODELS_ONLY=true` 是服务端强制策略：前端隐藏不是安全边界，创建接口也会再次拒绝未被确认免费的模型。

## SiliconFlow

- 官方价格页的“生图模型”中，`Kwai-Kolors/Kolors` 标为“免费”。项目将它以动态目录模型的形式接入，支持文生图；官方图片接口也展示了携带单张 `image` 的请求示例，因此保留单图参考编辑能力。
- 同一价格页中，`Wan-AI/Wan2.2-I2V-A14B` 和 `Wan-AI/Wan2.2-T2V-A14B` 均为 ¥2.00。它们不会被加入免费视频模型白名单，也无法通过直接调用本项目 API 绕过限制。
- 价格和可用模型会变动。每次上调依赖版本时，应先复核价格页，再把明确免费的模型 ID 加入 `shared/free-models.mjs`。

来源：

- [SiliconFlow 模型价格页](https://siliconflow.cn/pricing)
- [SiliconFlow 图片生成接口](https://api-docs.siliconflow.cn/docs/api/images-generations-post)
- [SiliconFlow 视频生成接口](https://api-docs.siliconflow.cn/docs/api/video-submit-post)

## Dots

- 当前公开文档只提供 `dots3-note-prev` 的 OpenAI Chat Completions 与 Anthropic Messages 接口。
- 它可以理解文本、图片、视频和音频输入，但文档中没有图片生成、视频生成、异步任务查询或媒体生成模型清单。
- 因此 `DOTS_API_KEY` 仅作为服务端配置保留；它不会被放入前端，也不会在这个媒体生成页面中展示为可生成模型。若 Dots 后续发布媒体生成端点，应补充官方协议与测试后再接入。

来源：

- [Dots API 开放平台文档](https://dots.ai/platform/docs)

## 密钥处理

- 所有供应商密钥只写入部署平台的服务端环境变量或本机忽略的 `.env`。
- 禁止使用 `VITE_` 前缀、提交密钥、将密钥放进 URL、日志、截图或文档。

