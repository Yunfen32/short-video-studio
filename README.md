# 视频生成工作台（本地真实服务）

运行 `npm run dev` 后，打开终端显示的本地地址即可使用。这个命令同时启动前端和本地 API：视频、图片、任务状态和下载请求都会由你的电脑直接发送到已配置的服务商，不会使用演示结果。`npm run local` 仍然可用；需要只启动 Vite 前端时使用 `npm run vite`。

首次使用前，在 `.env` 中配置至少一个真实服务密钥：`DASHSCOPE_API_KEY`、`AGNES_API_KEY` 或 `SUB2API_API_KEY`。不要使用 `VITE_` 前缀，也不要把 `.env` 提交到代码仓库。

本地服务默认读取 `.env` 中的 `VIDEO_ACCESS_DISABLED` 或 `VIDEO_ACCESS_TOKEN`；托管到 Netlify 或 Sites 后，未配置访问变量时会进入公开演示模式，仍受接口限流保护。服务商密钥始终只留在服务端。页面右上角应显示“真实服务”。

阿里模型会将本地上传的参考图作为图片数据直接发送给服务商，因此可在本机实际使用。需要服务商从公网拉取参考图的模型，请使用可访问的 HTTPS 图片地址。
# Short Video Studio

一个面向简历展示的黑色工业风 AI 媒体工作台，包含视频生成和图片生成两个入口。当前默认启用免费模型保护，前端不会展示或调用付费模型。

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

服务端通过 `FREE_MODELS_ONLY=true` 强制限制模型白名单。API 密钥只从服务端环境变量读取，不放入 `VITE_*` 变量，也不进入前端构建产物。

## 验证

```bash
npm test
npm run build
```

视频和图片任务都通过统一的任务状态协议轮询；模型不可用或额度耗尽时，会在状态接口和页面中自动移除对应模型。
