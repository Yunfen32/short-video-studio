const DEFAULT_DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com";
const AGNES_API_BASE = "https://apihub.agnes-ai.com";
const AGNES_VIDEO_MODEL = "agnes-video-v2.0";
const DASH_SCOPE_MODELS = {
  "happyhorse-1.1-t2v": { needsReferenceImages: false },
  "happyhorse-1.1-r2v": { needsReferenceImages: true },
};
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]);

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function getEnv(key) {
  return Netlify.env.get(key) || process.env[key];
}

function dashscopeBase() {
  return (getEnv("DASHSCOPE_BASE_URL") || DEFAULT_DASHSCOPE_API_BASE).replace(/\/$/, "");
}

function upstreamMessage(payload, fallback) {
  return payload?.message || payload?.code || fallback;
}

function validImageSource(value) {
  return /^https?:\/\//i.test(value) || /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value);
}

function parseRequest(body) {
  return {
    prompt: typeof body.prompt === "string" ? body.prompt.trim() : "",
    images: Array.isArray(body.images)
      ? body.images.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
      : [],
    duration: Number(body.duration),
  };
}

function validationError({ prompt, duration }) {
  if (!prompt || prompt.length > 5000) return "提示词长度需在 1-5000 个字符之间";
  if (!Number.isInteger(duration) || duration < 3 || duration > 15) return "视频时长需为 3-15 秒";
  return null;
}

function agnesDimensions(ratio) {
  return {
    "9:16": [768, 1152],
    "1:1": [768, 768],
    "4:3": [1024, 768],
    "3:4": [768, 1024],
  }[ratio] || [1152, 768];
}

function agnesFrames(duration) {
  return Math.min(441, Math.round(duration * 24 / 8) * 8 + 1);
}

function agnesStatus(status) {
  return { queued: "PENDING", in_progress: "RUNNING", completed: "SUCCEEDED", failed: "FAILED" }[status] || "UNKNOWN";
}

async function createDashscopeVideo(body) {
  const apiKey = getEnv("DASHSCOPE_API_KEY");
  if (!apiKey) return json({ error: "HappyHorse 视频服务尚未配置" }, 503);

  const { prompt, images, duration } = parseRequest(body);
  const model = DASH_SCOPE_MODELS[body.model] ? body.model : "happyhorse-1.1-t2v";
  const modelConfig = DASH_SCOPE_MODELS[model];
  const error = validationError({ prompt, duration });
  if (error) return json({ error }, 400);
  if (modelConfig.needsReferenceImages && (images.length < 1 || images.length > 9 || images.some((item) => !validImageSource(item)))) {
    return json({ error: "请提供 1-9 张有效的参考图" }, 400);
  }

  const response = await fetch(`${dashscopeBase()}/api/v1/services/aigc/video-generation/video-synthesis`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify({
      model,
      input: modelConfig.needsReferenceImages
        ? { prompt, media: images.map((url) => ({ type: "reference_image", url })) }
        : { prompt },
      parameters: {
        resolution: body.resolution === "720P" ? "720P" : "1080P",
        ratio: ["16:9", "9:16", "3:4", "4:3", "4:5", "5:4", "1:1", "9:21", "21:9"].includes(body.ratio) ? body.ratio : "16:9",
        duration,
        watermark: Boolean(body.watermark),
      },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.output?.task_id) {
    return json({ error: upstreamMessage(result, "视频任务创建失败") }, response.status || 502);
  }

  return json({ taskId: result.output.task_id, provider: "dashscope", status: result.output.task_status || "PENDING" }, 202);
}

async function createAgnesVideo(body) {
  const apiKey = getEnv("AGNES_API_KEY");
  if (!apiKey) return json({ error: "Agnes 视频服务尚未配置" }, 503);

  const { prompt, duration } = parseRequest(body);
  const error = validationError({ prompt, duration });
  if (error) return json({ error }, 400);
  const [width, height] = agnesDimensions(body.ratio);
  const response = await fetch(`${AGNES_API_BASE}/v1/videos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AGNES_VIDEO_MODEL,
      prompt,
      width,
      height,
      num_frames: agnesFrames(duration),
      frame_rate: 24,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !(result.video_id || result.task_id || result.id)) {
    return json({ error: upstreamMessage(result, "Agnes 视频任务创建失败") }, response.status || 502);
  }

  return json({
    taskId: result.task_id || result.id,
    videoId: result.video_id || null,
    provider: "agnes",
    status: agnesStatus(result.status),
  }, 202);
}

async function createVideo(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求内容不是有效的 JSON" }, 400);
  }
  return body.model === AGNES_VIDEO_MODEL ? createAgnesVideo(body) : createDashscopeVideo(body);
}

async function getDashscopeVideo(taskId) {
  const apiKey = getEnv("DASHSCOPE_API_KEY");
  if (!apiKey) return json({ error: "HappyHorse 视频服务尚未配置" }, 503);
  const response = await fetch(`${dashscopeBase()}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const result = await response.json().catch(() => ({}));
  const output = result?.output || {};
  if (!response.ok) return json({ error: upstreamMessage(result, "任务状态查询失败") }, response.status || 502);

  const status = output.task_status || "UNKNOWN";
  return json({
    taskId,
    provider: "dashscope",
    status,
    terminal: TERMINAL_STATUSES.has(status),
    videoUrl: output.video_url || null,
    error: status === "FAILED" ? (output.message || result.message || "视频生成失败") : null,
  });
}

async function getAgnesVideo(taskId, videoId) {
  const apiKey = getEnv("AGNES_API_KEY");
  if (!apiKey) return json({ error: "Agnes 视频服务尚未配置" }, 503);
  const lookupId = videoId || taskId;
  const response = await fetch(`${AGNES_API_BASE}/agnesapi?video_id=${encodeURIComponent(lookupId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: upstreamMessage(result, "Agnes 任务状态查询失败") }, response.status || 502);

  const status = agnesStatus(result.status);
  return json({
    taskId: result.task_id || result.id || taskId,
    videoId: result.video_id || lookupId,
    provider: "agnes",
    status,
    terminal: ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(status),
    videoUrl: result.url || null,
    error: status === "FAILED" ? (typeof result.error === "string" ? result.error : result.error?.message || "Agnes 视频生成失败") : null,
  });
}

export default async (request) => {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/videos" && request.method === "POST") return await createVideo(request);

    const taskMatch = url.pathname.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)$/);
    if (taskMatch && request.method === "GET") {
      return url.searchParams.get("provider") === "agnes"
        ? await getAgnesVideo(taskMatch[1], url.searchParams.get("video_id"))
        : await getDashscopeVideo(taskMatch[1]);
    }
    return json({ error: "未找到请求的接口" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "视频服务暂时不可用" }, 502);
  }
};

export const config = {
  path: ["/api/videos", "/api/videos/:taskId"],
};
