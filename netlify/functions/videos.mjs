const DEFAULT_API_BASE = "https://dashscope.aliyuncs.com";
const MODEL = "happyhorse-1.1-r2v";
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

function apiBase() {
  return (getEnv("DASHSCOPE_BASE_URL") || DEFAULT_API_BASE).replace(/\/$/, "");
}

function upstreamMessage(payload, fallback) {
  return payload?.message || payload?.code || fallback;
}

function validImageSource(value) {
  return /^https?:\/\//i.test(value) || /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value);
}

async function createVideo(request) {
  const apiKey = getEnv("DASHSCOPE_API_KEY");
  if (!apiKey) return json({ error: "视频服务尚未配置" }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求内容不是有效的 JSON" }, 400);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const images = Array.isArray(body.images)
    ? body.images.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
  const duration = Number(body.duration);
  const allowedRatios = new Set(["16:9", "9:16", "3:4", "4:3", "4:5", "5:4", "1:1", "9:21", "21:9"]);

  if (!prompt || prompt.length > 5000) return json({ error: "提示词长度需在 1-5000 个字符之间" }, 400);
  if (images.length < 1 || images.length > 9 || images.some((item) => !validImageSource(item))) {
    return json({ error: "请提供 1-9 张有效的参考图" }, 400);
  }
  if (!Number.isInteger(duration) || duration < 3 || duration > 15) {
    return json({ error: "视频时长需为 3-15 秒" }, 400);
  }

  const response = await fetch(`${apiBase()}/api/v1/services/aigc/video-generation/video-synthesis`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify({
      model: MODEL,
      input: {
        prompt,
        media: images.map((url) => ({ type: "reference_image", url })),
      },
      parameters: {
        resolution: body.resolution === "720P" ? "720P" : "1080P",
        ratio: allowedRatios.has(body.ratio) ? body.ratio : "16:9",
        duration,
        watermark: Boolean(body.watermark),
      },
    }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result?.output?.task_id) {
    return json({ error: upstreamMessage(result, "视频任务创建失败") }, response.status || 502);
  }

  return json({ taskId: result.output.task_id, status: result.output.task_status || "PENDING" }, 202);
}

async function getVideo(taskId) {
  const apiKey = getEnv("DASHSCOPE_API_KEY");
  if (!apiKey) return json({ error: "视频服务尚未配置" }, 503);
  if (!/^[a-zA-Z0-9-]{8,128}$/.test(taskId)) return json({ error: "任务 ID 无效" }, 400);

  const response = await fetch(`${apiBase()}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const result = await response.json().catch(() => ({}));
  const output = result?.output || {};

  if (!response.ok) return json({ error: upstreamMessage(result, "任务状态查询失败") }, response.status || 502);

  const status = output.task_status || "UNKNOWN";
  return json({
    taskId,
    status,
    terminal: TERMINAL_STATUSES.has(status),
    videoUrl: output.video_url || null,
    error: status === "FAILED" ? (output.message || result.message || "视频生成失败") : null,
  });
}

export default async (request) => {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/videos" && request.method === "POST") return await createVideo(request);

    const taskMatch = url.pathname.match(/^\/api\/videos\/([a-zA-Z0-9-]+)$/);
    if (taskMatch && request.method === "GET") return await getVideo(taskMatch[1]);
    return json({ error: "未找到请求的接口" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "视频服务暂时不可用" }, 502);
  }
};

export const config = {
  path: ["/api/videos", "/api/videos/:taskId"],
};
