import { getStore } from "@netlify/blobs";

const DEFAULT_DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com";
const AGNES_API_BASE = "https://apihub.agnes-ai.com";
const AGNES_VIDEO_MODEL = "agnes-video-v2.0";
const REFERENCE_IMAGE_STORE = "video-reference-images";
const DASH_SCOPE_MODELS = {
  "happyhorse-1.1-t2v": { needsReferenceImages: false },
  "happyhorse-1.1-r2v": { needsReferenceImages: true },
  "wan2.7-r2v-2026-06-12": { needsReferenceImages: true, supportsAudioReference: true },
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

function referenceImageExtension(contentType) {
  return { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" }[contentType] || "png";
}

async function publicAgnesImageUrl(source, origin) {
  if (/^https?:\/\//i.test(source)) return source;

  const match = source.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([\s\S]+)$/i);
  if (!match) throw new Error("Agnes 参考图格式无效");

  const [, contentType, encoded] = match;
  const key = `agnes/${crypto.randomUUID()}.${referenceImageExtension(contentType.toLowerCase())}`;
  await getStore({ name: REFERENCE_IMAGE_STORE, consistency: "strong" }).set(key, Buffer.from(encoded, "base64"), {
    metadata: { contentType: contentType.toLowerCase() },
  });
  return `${origin}/api/reference-images/${encodeURIComponent(key)}`;
}

function parseRequest(body) {
  return {
    prompt: typeof body.prompt === "string" ? body.prompt.trim() : "",
    images: Array.isArray(body.images) ? body.images
      .map((item) => typeof item === "string" ? { source: item.trim(), role: "人物" } : {
        source: typeof item?.source === "string" ? item.source.trim() : "",
        role: item?.role === "背景" ? "背景" : "人物",
      })
      .filter((item) => item.source) : [],
    audioUrl: typeof body.audioUrl === "string" ? body.audioUrl.trim() : "",
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

  const { prompt, images, audioUrl, duration } = parseRequest(body);
  const model = DASH_SCOPE_MODELS[body.model] ? body.model : "happyhorse-1.1-t2v";
  const modelConfig = DASH_SCOPE_MODELS[model];
  const error = validationError({ prompt, duration });
  if (error) return json({ error }, 400);
  const referenceLimit = model === "wan2.7-r2v-2026-06-12" ? 5 : 9;
  if (modelConfig.needsReferenceImages && (images.length < 1 || images.length > referenceLimit || images.some((item) => !validImageSource(item.source)))) {
    return json({ error: `请提供 1-${referenceLimit} 张有效的参考图` }, 400);
  }
  if (modelConfig.supportsAudioReference && audioUrl && !/^https?:\/\//i.test(audioUrl)) {
    return json({ error: "音频参考需使用可访问的 MP3 或 WAV URL" }, 400);
  }

  const promptWithReferences = modelConfig.needsReferenceImages
    ? `${prompt}。${images.map((item, index) => model === "wan2.7-r2v-2026-06-12"
      ? `图 ${index + 1}作为${item.role === "背景" ? "背景场景" : "人物主体"}`
      : `[Image ${index + 1}]作为${item.role === "背景" ? "背景场景" : "人物主体"}`).join("；")}。`
    : prompt;
  const firstCharacter = images.find((item) => item.role === "人物") || images[0];

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
        ? {
          prompt: promptWithReferences,
          media: images.map((item) => ({
            type: "reference_image",
            url: item.source,
            ...(modelConfig.supportsAudioReference && audioUrl && item === firstCharacter ? { reference_voice: audioUrl } : {}),
          })),
        }
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

async function createAgnesVideo(body, origin) {
  const apiKey = getEnv("AGNES_API_KEY");
  if (!apiKey) return json({ error: "Agnes 视频服务尚未配置" }, 503);

  const { prompt, images, duration } = parseRequest(body);
  const error = validationError({ prompt, duration });
  if (error) return json({ error }, 400);
  if (images.length !== 1 || !validImageSource(images[0]?.source)) {
    return json({ error: "Agnes 图生视频需要 1 张有效的参考图" }, 400);
  }

  const imageUrl = await publicAgnesImageUrl(images[0].source, origin);
  const [width, height] = agnesDimensions(body.ratio);
  const response = await fetch(`${AGNES_API_BASE}/v1/videos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AGNES_VIDEO_MODEL,
      prompt: `${prompt}。@参考图1：以该图片中的${images[0].role === "背景" ? "场景、构图和氛围" : "主体、外观和视觉特征"}为核心参考。`,
      image: imageUrl,
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
  return body.model === AGNES_VIDEO_MODEL ? createAgnesVideo(body, new URL(request.url).origin) : createDashscopeVideo(body);
}

async function getReferenceImage(encodedKey) {
  let key;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return json({ error: "参考图地址无效" }, 400);
  }
  if (!key.startsWith("agnes/")) return json({ error: "未找到参考图" }, 404);

  const store = getStore({ name: REFERENCE_IMAGE_STORE, consistency: "strong" });
  const [image, metadata] = await Promise.all([
    store.get(key, { type: "arrayBuffer" }),
    store.getMetadata(key),
  ]);
  if (!image) return json({ error: "未找到参考图" }, 404);

  return new Response(image, {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": metadata?.metadata?.contentType || "image/png",
      "x-content-type-options": "nosniff",
    },
  });
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

    const referenceMatch = url.pathname.match(/^\/api\/reference-images\/(.+)$/);
    if (referenceMatch && request.method === "GET") return await getReferenceImage(referenceMatch[1]);

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
