import { getStore } from "@netlify/blobs";
import { getVideoModel, VIDEO_MODELS } from "../../shared/video-models.mjs";

const DEFAULT_DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com";
const AGNES_API_BASE = "https://apihub.agnes-ai.com";
const AGNES_VIDEO_MODEL = "agnes-video-v2.0";
const REFERENCE_IMAGE_STORE = "video-reference-images";
const AVAILABILITY_STORE = "video-model-availability";
const AVAILABILITY_KEY = "unavailable-models";
const QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]);

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function getEnv(key) {
  return globalThis.Netlify?.env?.get?.(key) || process.env[key];
}

function dashscopeBase() {
  return (getEnv("DASHSCOPE_BASE_URL") || DEFAULT_DASHSCOPE_API_BASE).replace(/\/$/, "");
}

function upstreamMessage(payload, fallback) {
  return payload?.message || payload?.code || payload?.error?.message || fallback;
}

function validImageSource(value) {
  return /^https?:\/\//i.test(value) || /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value);
}

function validAssetUrl(value) {
  return /^(https?:\/\/|oss:\/\/)/i.test(value);
}

function referenceImageExtension(contentType) {
  return { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" }[contentType] || "png";
}

function availabilityStore() {
  return getStore({ name: AVAILABILITY_STORE, consistency: "strong" });
}

async function readUnavailableModels() {
  try {
    const stored = await availabilityStore().get(AVAILABILITY_KEY, { type: "json" });
    const now = Date.now();
    const active = Object.fromEntries(Object.entries(stored || {}).filter(([, item]) => Number(item?.until) > now));
    if (Object.keys(active).length !== Object.keys(stored || {}).length) {
      await availabilityStore().setJSON(AVAILABILITY_KEY, active);
    }
    return active;
  } catch {
    return {};
  }
}

async function markModelUnavailable(modelId, reason) {
  const unavailable = await readUnavailableModels();
  const until = Date.now() + QUOTA_COOLDOWN_MS;
  unavailable[modelId] = { reason, until };
  await availabilityStore().setJSON(AVAILABILITY_KEY, unavailable);
  return until;
}

function quotaIsExhausted(response, payload) {
  const text = `${payload?.code || ""} ${payload?.message || ""} ${payload?.error?.code || ""} ${payload?.error?.message || ""}`.toLowerCase();
  return text.includes("allocationquota.freetieronly")
    || text.includes("insufficient_quota")
    || text.includes("free allocated quota exceeded")
    || text.includes("free quota expired")
    || text.includes("free quota has been exhausted")
    || (response.status === 402 && text.includes("quota"));
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
    videoUrl: typeof body.videoUrl === "string" ? body.videoUrl.trim() : "",
    duration: Number(body.duration),
    resolution: typeof body.resolution === "string" ? body.resolution : "720P",
    ratio: typeof body.ratio === "string" ? body.ratio : "16:9",
    watermark: Boolean(body.watermark),
    promptExtend: body.promptExtend !== false,
    negativePrompt: typeof body.negativePrompt === "string" ? body.negativePrompt.trim() : "",
    seed: body.seed === null || body.seed === "" || body.seed === undefined ? null : Number(body.seed),
    animationMode: body.animationMode === "wan-pro" ? "wan-pro" : "wan-std",
  };
}

function validateRequest(model, data) {
  if (!model.promptOptional && (!data.prompt || data.prompt.length > 5000)) return "视频描述长度需在 1-5000 个字符之间";
  if (model.promptOptional && data.prompt.length > 5000) return "视频描述不能超过 5000 个字符";
  if (data.negativePrompt.length > 500) return "负面提示词不能超过 500 个字符";
  if (data.seed !== null && (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 2147483647)) return "随机种子需为 0-2147483647 的整数";
  if (!model.durations.includes(data.duration)) return `当前模型仅支持 ${model.durations.join("、")} 秒`;
  if (!model.resolutions.includes(data.resolution)) return `当前模型不支持 ${data.resolution}`;
  if (data.images.some((item) => !validImageSource(item.source))) return "参考图格式无效";
  if (data.audioUrl && !validAssetUrl(data.audioUrl)) return "音频需使用可访问的 HTTP、HTTPS 或 OSS URL";
  if (data.videoUrl && !validAssetUrl(data.videoUrl)) return "视频需使用可访问的 HTTP、HTTPS 或 OSS URL";
  if (model.supportsAudio !== true && model.supportsVoiceReference !== true && data.audioUrl) return "当前模型不支持外部音频";
  if (model.supportsVoiceReference && data.audioUrl && data.images.length === 0) return "音色参考需要至少 1 张人物参考图";

  if (model.protocol === "i2v27" && data.videoUrl) {
    if (data.images.length > 1) return "视频续写最多可再提供 1 张尾帧图";
  } else if ((model.protocol === "r2v" || model.protocol === "r2vLegacy") && data.videoUrl) {
    if (data.images.length > model.imageMax) return `当前模型最多支持 ${model.imageMax} 张参考图`;
  } else {
    const imageMin = model.imageMin || 0;
    const imageMax = model.imageMax || 0;
    if (data.images.length < imageMin || data.images.length > imageMax) {
      return imageMin === imageMax
        ? `当前模型需要 ${imageMin} 张参考图`
        : `当前模型需要 ${imageMin}-${imageMax} 张参考图`;
    }
  }

  if (model.requiresVideo && !data.videoUrl) return "当前模型需要输入视频 URL";
  if (model.protocol === "i2v27" && !data.videoUrl && data.images.length < 1) return "图生视频需要首帧图或续写视频";
  if ((model.protocol === "r2v" || model.protocol === "r2vLegacy") && !data.videoUrl && data.images.length < 1) return "参考生视频需要图片或视频素材";
  return null;
}

function normalizeAliMentions(prompt) {
  return prompt.replace(/@参考图\s*(\d+)/g, "Image $1");
}

function buildReferencePrompt(prompt, images) {
  const normalized = normalizeAliMentions(prompt);
  if (!images.length) return normalized;
  const roles = images.map((item, index) => `Image ${index + 1}作为${item.role === "背景" ? "背景场景" : "人物主体"}`).join("；");
  return `${normalized}。${roles}。`;
}

function commonParameters(model, data) {
  return {
    resolution: data.resolution,
    duration: data.duration,
    prompt_extend: data.promptExtend,
    watermark: data.watermark,
    ...(data.seed !== null ? { seed: data.seed } : {}),
    ...(model.ratios ? { ratio: ["16:9", "9:16", "3:4", "4:3", "1:1"].includes(data.ratio) ? data.ratio : "16:9" } : {}),
  };
}

function legacyVideoSize(resolution, ratio) {
  const sizes = {
    "480P": { "16:9": "832*480", "9:16": "480*832", "1:1": "624*624" },
    "720P": { "16:9": "1280*720", "9:16": "720*1280", "1:1": "960*960", "4:3": "1088*832", "3:4": "832*1088" },
    "1080P": { "16:9": "1920*1080", "9:16": "1080*1920", "1:1": "1440*1440", "4:3": "1632*1248", "3:4": "1248*1632" },
  };
  return sizes[resolution]?.[ratio] || sizes[resolution]?.["16:9"] || "1280*720";
}

function buildDashscopeRequest(model, data) {
  const parameters = commonParameters(model, data);
  const prompt = normalizeAliMentions(data.prompt);
  const defaultEndpoint = "/api/v1/services/aigc/video-generation/video-synthesis";

  if (model.protocol === "t2v") {
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: { prompt, ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}), ...(data.audioUrl ? { audio_url: data.audioUrl } : {}) },
        parameters,
      },
    };
  }

  if (model.protocol === "t2vLegacy") {
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: { prompt, ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}), ...(data.audioUrl ? { audio_url: data.audioUrl } : {}) },
        parameters: {
          size: legacyVideoSize(data.resolution, data.ratio),
          duration: data.duration,
          prompt_extend: data.promptExtend,
          watermark: data.watermark,
          ...(data.seed !== null ? { seed: data.seed } : {}),
          ...(model.id.startsWith("wan2.6-") ? { shot_type: "multi" } : {}),
        },
      },
    };
  }

  if (model.protocol === "i2vLegacy") {
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: { prompt, img_url: data.images[0].source, ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}), ...(data.audioUrl ? { audio_url: data.audioUrl } : {}) },
        parameters,
      },
    };
  }

  if (model.protocol === "i2v27") {
    const media = data.videoUrl
      ? [{ type: "first_clip", url: data.videoUrl }, ...data.images.map((item) => ({ type: "last_frame", url: item.source }))]
      : data.images.map((item, index) => ({ type: index === 0 ? "first_frame" : "last_frame", url: item.source }));
    if (data.audioUrl) media.push({ type: "driving_audio", url: data.audioUrl });
    return {
      endpoint: defaultEndpoint,
      payload: { model: model.id, input: { prompt, ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}), media }, parameters },
    };
  }

  if (model.protocol === "kf2vLegacy") {
    return {
      endpoint: "/api/v1/services/aigc/image2video/video-synthesis",
      payload: {
        model: model.id,
        input: { prompt, ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}), first_frame_url: data.images[0].source, last_frame_url: data.images[1].source },
        parameters,
      },
    };
  }

  if (model.protocol === "r2v") {
    const firstCharacter = data.images.find((item) => item.role === "人物") || data.images[0];
    const media = data.images.map((item) => ({
      type: "reference_image",
      url: item.source,
      ...(model.supportsVoiceReference && data.audioUrl && item === firstCharacter ? { reference_voice: data.audioUrl } : {}),
    }));
    if (data.videoUrl) media.push({ type: "reference_video", url: data.videoUrl });
    return {
      endpoint: defaultEndpoint,
      payload: { model: model.id, input: { prompt: buildReferencePrompt(data.prompt, data.images), ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}), media }, parameters },
    };
  }

  if (model.protocol === "r2vLegacy") {
    const referenceUrls = [...data.images.map((item) => item.source), ...(data.videoUrl ? [data.videoUrl] : [])];
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: {
          prompt: data.prompt.replace(/@参考图\s*(\d+)/g, "character$1"),
          ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}),
          reference_urls: referenceUrls,
        },
        parameters: {
          size: legacyVideoSize(data.resolution, data.ratio),
          duration: data.duration,
          shot_type: "multi",
          watermark: data.watermark,
          ...(model.id.endsWith("-flash") ? { audio: true } : {}),
        },
      },
    };
  }

  if (model.protocol === "videoEdit") {
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: {
          prompt,
          ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}),
          media: [
            { type: "video", url: data.videoUrl },
            ...data.images.map((item) => ({ type: "reference_image", url: item.source })),
          ],
        },
        parameters,
      },
    };
  }

  if (model.protocol === "animateMove" || model.protocol === "animateMix") {
    return {
      endpoint: "/api/v1/services/aigc/image2video/video-synthesis",
      payload: {
        model: model.id,
        input: {
          image_url: data.images[0].source,
          video_url: data.videoUrl,
          watermark: data.watermark,
        },
        parameters: { mode: data.animationMode },
      },
    };
  }

  throw new Error("当前模型协议尚未配置");
}

async function dashscopeFailure(response, result, modelId) {
  const message = upstreamMessage(result, "视频任务创建失败");
  if (!quotaIsExhausted(response, result)) return json({ error: message }, response.status || 502);

  let unavailableUntil = Date.now() + QUOTA_COOLDOWN_MS;
  try {
    unavailableUntil = await markModelUnavailable(modelId, message);
  } catch {
    // The current client still removes the model even if shared persistence is temporarily unavailable.
  }
  return json({ error: `${message}；该模型已从列表暂时移除`, modelUnavailable: true, modelId, unavailableUntil }, response.status || 429);
}

async function createDashscopeVideo(model, body) {
  const apiKey = getEnv("DASHSCOPE_API_KEY");
  if (!apiKey) return json({ error: "阿里视频服务尚未配置" }, 503);

  const data = parseRequest(body);
  const validationError = validateRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);

  const { endpoint, payload } = buildDashscopeRequest(model, data);
  const response = await fetch(`${dashscopeBase()}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.output?.task_id) return dashscopeFailure(response, result, model.id);

  return json({
    taskId: result.output.task_id,
    provider: "dashscope",
    modelId: model.id,
    status: result.output.task_status || "PENDING",
  }, 202);
}

function agnesDimensions(ratio) {
  return { "9:16": [768, 1152], "1:1": [768, 768], "4:3": [1024, 768], "3:4": [768, 1024] }[ratio] || [1152, 768];
}

function agnesFrames(duration) {
  return Math.min(441, Math.round(duration * 24 / 8) * 8 + 1);
}

function agnesStatus(status) {
  return { queued: "PENDING", in_progress: "RUNNING", completed: "SUCCEEDED", failed: "FAILED" }[status] || "UNKNOWN";
}

async function createAgnesVideo(model, body, origin) {
  const apiKey = getEnv("AGNES_API_KEY");
  if (!apiKey) return json({ error: "Agnes 视频服务尚未配置" }, 503);
  const data = parseRequest(body);
  const validationError = validateRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);

  const imageUrls = await Promise.all(data.images.map((item) => publicAgnesImageUrl(item.source, origin)));
  const referencePrompt = data.images.map((item, index) => (
    `@参考图${index + 1}：以该图片中的${item.role === "背景" ? "场景、构图和氛围" : "主体、外观和视觉特征"}为参考`
  )).join("；");
  const [width, height] = agnesDimensions(data.ratio);
  const response = await fetch(`${AGNES_API_BASE}/v1/videos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AGNES_VIDEO_MODEL,
      prompt: `${data.prompt}。${referencePrompt}。`,
      ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}),
      ...(data.seed !== null ? { seed: data.seed } : {}),
      ...(imageUrls.length === 1 ? { image: imageUrls[0] } : { extra_body: { image: imageUrls, mode: "keyframes" } }),
      width,
      height,
      num_frames: agnesFrames(data.duration),
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
    modelId: model.id,
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
  const model = getVideoModel(body.model);
  if (!model) return json({ error: "不支持该视频模型" }, 400);

  const unavailable = await readUnavailableModels();
  if (unavailable[model.id]) {
    return json({
      error: "该模型额度暂不可用，已从模型列表移除",
      modelUnavailable: true,
      modelId: model.id,
      unavailableUntil: unavailable[model.id].until,
    }, 429);
  }
  return model.provider === "agnes"
    ? createAgnesVideo(model, body, new URL(request.url).origin)
    : createDashscopeVideo(model, body);
}

async function getModelAvailability() {
  const unavailable = await readUnavailableModels();
  return json({
    availableCount: VIDEO_MODELS.length - Object.keys(unavailable).length,
    unavailable: Object.entries(unavailable).map(([modelId, item]) => ({ modelId, ...item })),
    checkedAt: Date.now(),
  });
}

async function uploadReferenceImage(request) {
  const contentType = (request.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    return json({ error: "参考图仅支持 JPG、PNG 或 WEBP" }, 415);
  }
  const image = await request.arrayBuffer();
  if (!image.byteLength || image.byteLength > 4 * 1024 * 1024) {
    return json({ error: "参考图大小需在 4MB 以内" }, 413);
  }
  const key = `uploads/${crypto.randomUUID()}.${referenceImageExtension(contentType)}`;
  await getStore({ name: REFERENCE_IMAGE_STORE, consistency: "strong" }).set(key, image, {
    metadata: { contentType },
  });
  return json({ url: `${new URL(request.url).origin}/api/reference-images/${encodeURIComponent(key)}` }, 201);
}

async function getReferenceImage(encodedKey) {
  let key;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return json({ error: "参考图地址无效" }, 400);
  }
  if (!key.startsWith("agnes/") && !key.startsWith("uploads/")) return json({ error: "未找到参考图" }, 404);

  const store = getStore({ name: REFERENCE_IMAGE_STORE, consistency: "strong" });
  const [image, metadata] = await Promise.all([store.get(key, { type: "arrayBuffer" }), store.getMetadata(key)]);
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
  if (!apiKey) return json({ error: "阿里视频服务尚未配置" }, 503);
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
    if (url.pathname === "/api/models" && request.method === "GET") return await getModelAvailability();
    if (url.pathname === "/api/reference-images" && request.method === "POST") return await uploadReferenceImage(request);
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
  path: ["/api/models", "/api/videos", "/api/videos/:taskId", "/api/reference-images", "/api/reference-images/:key"],
};
