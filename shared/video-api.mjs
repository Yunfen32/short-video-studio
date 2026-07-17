import {
  getVideoModel,
  getWorkflowCapability,
  inferVideoWorkflow,
  supportsWorkflow,
  VIDEO_MODELS,
} from "./video-models.mjs";

const DEFAULT_DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com";
const AGNES_API_BASE = "https://apihub.agnes-ai.com";
const AGNES_VIDEO_MODEL = "agnes-video-v2.0";
const AVAILABILITY_KEY = "state/unavailable-models";
const MODEL_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PROVIDER_BILLING_COOLDOWN_MS = 15 * 60 * 1000;
const REFERENCE_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REFERENCE_IMAGE_BYTES = 4 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]);

const RATE_LIMITS = {
  create: { limit: 6, windowMs: 60 * 60 * 1000, envKey: "VIDEO_CREATE_LIMIT_PER_HOUR" },
  upload: { limit: 30, windowMs: 60 * 60 * 1000, envKey: "VIDEO_UPLOAD_LIMIT_PER_HOUR" },
  status: { limit: 360, windowMs: 60 * 60 * 1000, envKey: "VIDEO_STATUS_LIMIT_PER_HOUR" },
  download: { limit: 12, windowMs: 60 * 60 * 1000, envKey: "VIDEO_DOWNLOAD_LIMIT_PER_HOUR" },
};

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

function runtimeEnv(runtime, key) {
  return runtime?.getEnv?.(key) || "";
}

function runtimeNow(runtime) {
  return Number(runtime?.now?.() ?? Date.now());
}

function dashscopeBase(runtime) {
  return (runtimeEnv(runtime, "DASHSCOPE_BASE_URL") || DEFAULT_DASHSCOPE_API_BASE).replace(/\/$/, "");
}

function upstreamMessage(payload, fallback) {
  return payload?.message || payload?.code || payload?.error?.message || fallback;
}

function validRemoteUrl(value, protocols) {
  try {
    const url = new URL(value);
    return protocols.has(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function dataImageBytes(value) {
  const match = value.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([\s\S]+)$/i);
  if (!match) return null;
  const encoded = match[1].replace(/\s/g, "");
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor(encoded.length * 3 / 4) - padding;
}

function validImageSource(value) {
  if (validRemoteUrl(value, new Set(["http:", "https:"]))) return true;
  const bytes = dataImageBytes(value);
  return bytes !== null && bytes <= MAX_REFERENCE_IMAGE_BYTES;
}

function validAssetUrl(value) {
  return validRemoteUrl(value, new Set(["http:", "https:", "oss:"]));
}

function referenceImageExtension(contentType) {
  return { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp" }[contentType] || "png";
}

function scheduleBackground(runtime, promise) {
  if (!promise) return;
  const settled = Promise.resolve(promise).catch(() => undefined);
  runtime.waitUntil?.(settled);
}

async function readUnavailableModels(runtime) {
  if (!runtime?.storage) return {};
  try {
    const stored = await runtime.storage.getJSON(AVAILABILITY_KEY);
    const now = runtimeNow(runtime);
    const active = Object.fromEntries(Object.entries(stored || {}).filter(([, item]) => Number(item?.until) > now));
    if (Object.keys(active).length !== Object.keys(stored || {}).length) {
      await runtime.storage.setJSON(AVAILABILITY_KEY, active);
    }
    return active;
  } catch {
    return {};
  }
}

async function markModelsUnavailable(runtime, modelIds, reason, cooldownMs, scope) {
  const unavailable = await readUnavailableModels(runtime);
  const until = runtimeNow(runtime) + cooldownMs;
  for (const modelId of modelIds) unavailable[modelId] = { reason, until, scope };
  await runtime.storage.setJSON(AVAILABILITY_KEY, unavailable);
  return modelIds.map((modelId) => ({ modelId, reason, until, scope }));
}

export function quotaFailureScope(response, payload) {
  const text = `${payload?.code || ""} ${payload?.message || ""} ${payload?.error?.code || ""} ${payload?.error?.message || ""}`.toLowerCase();
  const accountBillingBlocked = text.includes("overdue payment")
    || text.includes("account is in good standing")
    || text.includes("account has overdue")
    || text.includes("account arrears");
  if (accountBillingBlocked) return "provider";
  if (text.includes("allocationquota.freetieronly")
    || text.includes("insufficient_quota")
    || text.includes("free allocated quota exceeded")
    || text.includes("free quota expired")
    || text.includes("free quota has been exhausted")
    || (response.status === 402 && text.includes("quota"))) return "model";
  return null;
}

export function quotaIsExhausted(response, payload) {
  return quotaFailureScope(response, payload) !== null;
}

function decodeBase64(encoded) {
  if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(encoded, "base64"));
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function publicAgnesImageUrl(source, origin, runtime) {
  if (/^https?:\/\//i.test(source)) return source;
  const match = source.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([\s\S]+)$/i);
  if (!match) throw new Error("Agnes 参考图格式无效");

  const [, contentType, encoded] = match;
  const key = `agnes/${crypto.randomUUID()}.${referenceImageExtension(contentType.toLowerCase())}`;
  if (!runtime?.storage) throw new Error("图片存储尚未配置");
  await runtime.storage.put(key, decodeBase64(encoded), {
    contentType: contentType.toLowerCase(),
    createdAt: runtimeNow(runtime),
  });
  const cleanup = runtime.storage.cleanupExpired?.("agnes/", runtimeNow(runtime) - REFERENCE_IMAGE_TTL_MS);
  scheduleBackground(runtime, cleanup);
  return `${origin}/api/reference-images/${encodeURIComponent(key)}`;
}

const IMAGE_ROLES = new Set([
  "character",
  "background",
  "first_frame",
  "last_frame",
  "keyframe",
  "replacement_character",
]);

function normalizeImageRole(role) {
  if (role === "人物") return "character";
  if (role === "背景") return "background";
  return IMAGE_ROLES.has(role) ? role : "character";
}

export function parseRequest(body) {
  return {
    workflow: typeof body.workflow === "string" ? body.workflow.trim() : "",
    prompt: typeof body.prompt === "string" ? body.prompt.trim() : "",
    images: Array.isArray(body.images) ? body.images
      .map((item) => typeof item === "string" ? { source: item.trim(), role: "character" } : {
        source: typeof item?.source === "string" ? item.source.trim() : "",
        role: normalizeImageRole(item?.role),
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
    audioSetting: body.audioSetting === "origin" ? "origin" : "auto",
  };
}

function applyWorkflowImageRoles(images, workflow) {
  return images.map((image, index) => {
    if (workflow === "first-frame") return { ...image, role: "first_frame" };
    if (workflow === "first-last-frame") return { ...image, role: index === 0 ? "first_frame" : "last_frame" };
    if (workflow === "keyframes") return { ...image, role: "keyframe" };
    if (workflow === "video-continuation") return { ...image, role: "last_frame" };
    if (workflow === "motion-transfer") return { ...image, role: "character" };
    if (workflow === "character-replace") return { ...image, role: "replacement_character" };
    if (workflow === "multi-reference" || workflow === "video-edit") {
      return { ...image, role: image.role === "background" ? "background" : "character" };
    }
    return image;
  });
}

export function prepareRequestData(model, body) {
  const data = parseRequest(body);
  data.workflow = data.workflow || inferVideoWorkflow(model, data);
  data.images = applyWorkflowImageRoles(data.images, data.workflow);
  return data;
}

function imageRequirementLabel(workflow) {
  return {
    "first-frame": "首帧图",
    "first-last-frame": "首尾帧图片",
    keyframes: "关键帧",
    "multi-reference": "人物或背景参考图",
    "video-continuation": "尾帧图",
    "video-edit": "编辑参考图",
    "motion-transfer": "人物图",
    "character-replace": "替换人物图",
  }[workflow] || "图片";
}

export function validateRequest(model, data) {
  const workflowCapability = getWorkflowCapability(model, data.workflow);
  if (!workflowCapability) return "当前模型不支持所选生成方式";

  if (!workflowCapability.promptOptional && (!data.prompt || data.prompt.length > 5000)) return "视频描述长度需在 1-5000 个字符之间";
  if (workflowCapability.promptOptional && data.prompt.length > 5000) return "视频描述不能超过 5000 个字符";
  if (data.negativePrompt.length > 500) return "负面提示词不能超过 500 个字符";
  if (data.seed !== null && (!Number.isInteger(data.seed) || data.seed < 0 || data.seed > 2147483647)) return "随机种子需为 0-2147483647 的整数";
  if (workflowCapability.durationMode !== "source" && !model.durations.includes(data.duration)) {
    return `当前模型仅支持 ${model.durations.join("、")} 秒`;
  }
  if (data.videoUrl && workflowCapability.durationWithVideoMax && data.duration > workflowCapability.durationWithVideoMax) {
    return `包含参考视频时，生成时长不能超过 ${workflowCapability.durationWithVideoMax} 秒`;
  }
  if (!model.resolutions.includes(data.resolution)) return `当前模型不支持 ${data.resolution}`;
  if (data.images.some((item) => {
    const bytes = dataImageBytes(item.source);
    return bytes !== null && bytes > MAX_REFERENCE_IMAGE_BYTES;
  })) return "单张参考图不能超过 4MB";
  if (data.images.some((item) => !validImageSource(item.source))) return "参考图格式无效";
  if (data.audioUrl && !validAssetUrl(data.audioUrl)) return "音频需使用可访问的 HTTP、HTTPS 或 OSS URL";
  if (data.videoUrl && !validAssetUrl(data.videoUrl)) return "视频需使用可访问的 HTTP、HTTPS 或 OSS URL";
  if (workflowCapability.audioMode === "none" && data.audioUrl) return "当前生成方式不支持外部音频";
  if (workflowCapability.audioMode === "voice_reference" && data.audioUrl && !data.images.some((item) => item.role === "character")) {
    return "音色参考需要至少 1 张人物参考图";
  }

  const { imageMin, imageMax, videoMode, requiresAnyReference } = workflowCapability;
  if (data.images.length < imageMin || data.images.length > imageMax) {
    const label = imageRequirementLabel(data.workflow);
    return imageMin === imageMax
      ? `当前生成方式需要 ${imageMin} 张${label}`
      : `当前生成方式需要 ${imageMin}-${imageMax} 张${label}`;
  }
  if (videoMode.startsWith("required_") && !data.videoUrl) return "当前生成方式需要输入视频 URL";
  if (videoMode === "none" && data.videoUrl) return "当前生成方式不接受视频输入";
  if (requiresAnyReference && data.images.length === 0 && !data.videoUrl) return "请至少提供一张参考图或一段参考视频";
  if (workflowCapability.referenceTotalMax && data.images.length + Number(Boolean(data.videoUrl)) > workflowCapability.referenceTotalMax) {
    return `参考图片与参考视频合计最多 ${workflowCapability.referenceTotalMax} 个`;
  }
  return null;
}

export function normalizePromptMentions(prompt, workflow, prefix = "Image", images = []) {
  const token = (index) => {
    if (prefix === "character") return `character${index}`;
    if (prefix === "[Image]") return `[Image ${index}]`;
    return `${prefix} ${index}`;
  };
  const roleIndex = (role, ordinal) => {
    const matches = images
      .map((image, index) => ({ image, index }))
      .filter((item) => item.image.role === role);
    return matches[Number(ordinal) - 1]?.index + 1 || Number(ordinal);
  };
  const lastFrameIndex = workflow === "video-continuation" ? 1 : 2;
  return prompt
    .replace(/@参考图\s*(\d+)/g, (_, index) => token(index))
    .replace(/@人物\s*(\d+)/g, (_, index) => token(roleIndex("character", index)))
    .replace(/@背景\s*(\d+)/g, (_, index) => token(roleIndex("background", index)))
    .replace(/@关键帧\s*(\d+)/g, (_, index) => token(index))
    .replace(/@首帧/g, token(1))
    .replace(/@尾帧/g, token(lastFrameIndex))
    .replace(/@替换人物/g, token(1))
    .replace(/@人物(?!\s*\d)/g, token(1));
}

function buildReferencePrompt(prompt, images, workflow, prefix = "Image") {
  const normalized = normalizePromptMentions(prompt, workflow, prefix, images);
  if (!images.length) return normalized;
  const roles = images.map((item, index) => {
    const reference = prefix === "character"
      ? `character${index + 1}`
      : prefix === "[Image]" ? `[Image ${index + 1}]` : `${prefix} ${index + 1}`;
    return `${reference}作为${item.role === "background" ? "背景场景" : "人物主体"}`;
  }).join("；");
  return `${normalized}。${roles}。`;
}

function buildEditPrompt(data) {
  const prompt = normalizePromptMentions(data.prompt, data.workflow, "Image", data.images);
  if (!data.images.length) return prompt;
  const roles = data.images.map((item, index) => (
    `第${index + 1}张参考图作为${item.role === "background" ? "背景场景" : "人物主体"}编辑参考`
  )).join("；");
  return `${prompt}。${roles}。`;
}

function commonParameters(model, data) {
  return {
    resolution: data.resolution,
    ...(model.durationMode === "output" || (model.durationMode === "truncate" && data.duration > 0)
      ? { duration: data.duration }
      : {}),
    ...(model.supportsPromptExtend ? { prompt_extend: data.promptExtend } : {}),
    ...(model.supportsWatermark ? { watermark: data.watermark } : {}),
    ...(model.supportsSeed && data.seed !== null ? { seed: data.seed } : {}),
    ...(model.ratioOptions.includes(data.ratio) && data.ratio !== "source" ? { ratio: data.ratio } : {}),
  };
}

function negativePromptInput(model, data) {
  return model.supportsNegativePrompt && data.negativePrompt
    ? { negative_prompt: data.negativePrompt }
    : {};
}

function legacyVideoSize(resolution, ratio) {
  const sizes = {
    "480P": { "16:9": "832*480", "9:16": "480*832", "1:1": "624*624" },
    "720P": { "16:9": "1280*720", "9:16": "720*1280", "1:1": "960*960", "4:3": "1088*832", "3:4": "832*1088" },
    "1080P": { "16:9": "1920*1080", "9:16": "1080*1920", "1:1": "1440*1440", "4:3": "1632*1248", "3:4": "1248*1632" },
  };
  return sizes[resolution]?.[ratio] || sizes[resolution]?.["16:9"] || "1280*720";
}

export function buildDashscopeRequest(model, data) {
  const parameters = commonParameters(model, data);
  const prompt = normalizePromptMentions(data.prompt, data.workflow, "Image", data.images);
  const defaultEndpoint = "/api/v1/services/aigc/video-generation/video-synthesis";

  if (model.protocol === "t2v" || model.protocol === "happyhorseT2v") {
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: { prompt, ...negativePromptInput(model, data), ...(model.supportsAudio && data.audioUrl ? { audio_url: data.audioUrl } : {}) },
        parameters,
      },
    };
  }

  if (model.protocol === "t2vLegacy") {
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: { prompt, ...negativePromptInput(model, data), ...(data.audioUrl ? { audio_url: data.audioUrl } : {}) },
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
        input: { prompt, img_url: data.images[0].source, ...negativePromptInput(model, data), ...(data.audioUrl ? { audio_url: data.audioUrl } : {}) },
        parameters,
      },
    };
  }

  if (model.protocol === "happyhorseI2v") {
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: {
          prompt,
          media: [{ type: "first_frame", url: data.images[0].source }],
        },
        parameters,
      },
    };
  }

  if (model.protocol === "i2v27") {
    let media;
    if (data.workflow === "video-continuation") {
      media = [
        { type: "first_clip", url: data.videoUrl },
        ...data.images.map((item) => ({ type: "last_frame", url: item.source })),
      ];
    } else if (data.workflow === "first-last-frame") {
      media = [
        { type: "first_frame", url: data.images[0].source },
        { type: "last_frame", url: data.images[1].source },
      ];
    } else {
      media = [{ type: "first_frame", url: data.images[0].source }];
    }
    if (data.audioUrl && data.workflow !== "video-continuation") {
      media.push({ type: "driving_audio", url: data.audioUrl });
    }
    return {
      endpoint: defaultEndpoint,
      payload: { model: model.id, input: { prompt, ...negativePromptInput(model, data), media }, parameters },
    };
  }

  if (model.protocol === "kf2vLegacy") {
    return {
      endpoint: "/api/v1/services/aigc/image2video/video-synthesis",
      payload: {
        model: model.id,
        input: { prompt, ...negativePromptInput(model, data), first_frame_url: data.images[0].source, last_frame_url: data.images[1].source },
        parameters,
      },
    };
  }

  if (model.protocol === "r2v" || model.protocol === "happyhorseR2v") {
    const firstCharacter = data.images.find((item) => item.role === "character");
    const media = data.images.map((item) => ({
      type: "reference_image",
      url: item.source,
      ...(model.supportsVoiceReference && data.audioUrl && item === firstCharacter ? { reference_voice: data.audioUrl } : {}),
    }));
    if (data.videoUrl) media.push({ type: "reference_video", url: data.videoUrl });
    const referencePrefix = model.protocol === "happyhorseR2v" ? "[Image]" : "Image";
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: {
          prompt: buildReferencePrompt(data.prompt, data.images, data.workflow, referencePrefix),
          ...negativePromptInput(model, data),
          media,
        },
        parameters,
      },
    };
  }

  if (model.protocol === "r2vLegacy") {
    const referenceUrls = [...data.images.map((item) => item.source), ...(data.videoUrl ? [data.videoUrl] : [])];
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: {
          prompt: buildReferencePrompt(data.prompt, data.images, data.workflow, "character"),
          ...negativePromptInput(model, data),
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
          prompt: buildEditPrompt(data),
          ...negativePromptInput(model, data),
          media: [
            { type: "video", url: data.videoUrl },
            ...data.images.map((item) => ({ type: "reference_image", url: item.source })),
          ],
        },
        parameters: { ...parameters, audio_setting: data.audioSetting },
      },
    };
  }

  if (model.protocol === "happyhorseVideoEdit") {
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: {
          prompt: buildEditPrompt(data),
          media: [
            { type: "video", url: data.videoUrl },
            ...data.images.map((item) => ({ type: "reference_image", url: item.source })),
          ],
        },
        parameters: { ...parameters, audio_setting: data.audioSetting },
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

function fetchFor(runtime) {
  return runtime?.fetch || globalThis.fetch;
}

async function modelCreationFailure(response, result, modelId, runtime, fallback = "视频任务创建失败") {
  const message = upstreamMessage(result, fallback);
  const scope = quotaFailureScope(response, result);
  if (!scope) return json({ error: message }, response.status || 502);

  const model = getVideoModel(modelId);
  const modelIds = scope === "provider"
    ? VIDEO_MODELS.filter((item) => item.provider === model?.provider).map((item) => item.id)
    : [modelId];
  const cooldownMs = scope === "provider" ? PROVIDER_BILLING_COOLDOWN_MS : MODEL_QUOTA_COOLDOWN_MS;
  let unavailable = modelIds.map((item) => ({ modelId: item, reason: message, until: runtimeNow(runtime) + cooldownMs, scope }));
  try {
    unavailable = await markModelsUnavailable(runtime, modelIds, message, cooldownMs, scope);
  } catch {
    // The client can still react immediately if shared persistence is temporarily unavailable.
  }
  const label = scope === "provider" ? "该服务商模型已暂时停用" : "该模型已从列表暂时移除";
  return json({
    error: `${message}；${label}`,
    modelUnavailable: true,
    modelId,
    unavailableUntil: unavailable.find((item) => item.modelId === modelId)?.until,
    unavailable,
  }, response.status || 429);
}

async function createDashscopeVideo(model, body, runtime) {
  const apiKey = runtimeEnv(runtime, "DASHSCOPE_API_KEY");
  if (!apiKey) return json({ error: "阿里视频服务尚未配置" }, 503);

  const data = prepareRequestData(model, body);
  const validationError = validateRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);

  const { endpoint, payload } = buildDashscopeRequest(model, data);
  const response = await fetchFor(runtime)(`${dashscopeBase(runtime)}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result?.output?.task_id) return modelCreationFailure(response, result, model.id, runtime);

  return json({
    taskId: result.output.task_id,
    provider: "dashscope",
    modelId: model.id,
    status: result.output.task_status || "PENDING",
  }, 202);
}

function agnesDimensions(ratio, resolution) {
  const dimensions = {
    "720P": {
      "16:9": [1280, 720],
      "9:16": [720, 1280],
      "1:1": [960, 960],
      "4:3": [1104, 832],
      "3:4": [832, 1104],
    },
    "1080P": {
      "16:9": [1920, 1080],
      "9:16": [1080, 1920],
      "1:1": [1440, 1440],
      "4:3": [1648, 1248],
      "3:4": [1248, 1648],
    },
  };
  const tier = dimensions[resolution] || dimensions["720P"];
  return tier[ratio] || tier["16:9"];
}

function agnesFrames(duration) {
  return Math.min(441, Math.round(duration * 24 / 8) * 8 + 1);
}

function agnesStatus(status) {
  return { queued: "PENDING", in_progress: "RUNNING", completed: "SUCCEEDED", failed: "FAILED" }[status] || "UNKNOWN";
}

function agnesReferencePrompt(data) {
  if (data.workflow === "first-frame") return "Image 1作为视频起始画面";
  if (data.workflow === "keyframes") {
    return data.images.map((_, index) => `Image ${index + 1}作为第${index + 1}个关键帧`).join("；");
  }
  return "";
}

export function buildAgnesPayload(data, imageUrls) {
  const [width, height] = agnesDimensions(data.ratio, data.resolution);
  const prompt = [
    normalizePromptMentions(data.prompt, data.workflow, "Image", data.images),
    agnesReferencePrompt(data),
  ].filter(Boolean).join("。");
  return {
    model: AGNES_VIDEO_MODEL,
    prompt,
    ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}),
    ...(data.seed !== null ? { seed: data.seed } : {}),
    ...(data.workflow === "first-frame" ? { image: imageUrls[0] } : {}),
    ...(data.workflow === "keyframes" ? { extra_body: { image: imageUrls, mode: "keyframes" } } : {}),
    width,
    height,
    num_frames: agnesFrames(data.duration),
    frame_rate: 24,
  };
}

async function createAgnesVideo(model, body, origin, runtime) {
  const apiKey = runtimeEnv(runtime, "AGNES_API_KEY");
  if (!apiKey) return json({ error: "Agnes 视频服务尚未配置" }, 503);
  const data = prepareRequestData(model, body);
  const validationError = validateRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);

  const imageUrls = await Promise.all(data.images.map((item) => publicAgnesImageUrl(item.source, origin, runtime)));
  const response = await fetchFor(runtime)(`${AGNES_API_BASE}/v1/videos`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildAgnesPayload(data, imageUrls)),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !(result.video_id || result.task_id || result.id)) {
    return modelCreationFailure(response, result, model.id, runtime, "Agnes 视频任务创建失败");
  }
  return json({
    taskId: result.task_id || result.id || result.video_id,
    videoId: result.video_id || null,
    provider: "agnes",
    modelId: model.id,
    status: agnesStatus(result.status),
  }, 202);
}

async function createVideo(request, runtime) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求内容不是有效的 JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "请求内容必须是 JSON 对象" }, 400);
  const model = getVideoModel(body.model);
  if (!model) return json({ error: "不支持该视频模型" }, 400);
  if (body.workflow && !supportsWorkflow(model, body.workflow)) {
    return json({ error: "当前模型不支持所选生成方式" }, 400);
  }

  const unavailable = await readUnavailableModels(runtime);
  if (unavailable[model.id]) {
    return json({
      error: "该模型额度暂不可用，已从模型列表移除",
      modelUnavailable: true,
      modelId: model.id,
      unavailableUntil: unavailable[model.id].until,
    }, 429);
  }
  return model.provider === "agnes"
    ? createAgnesVideo(model, body, new URL(request.url).origin, runtime)
    : createDashscopeVideo(model, body, runtime);
}

async function getModelAvailability(runtime) {
  const unavailable = await readUnavailableModels(runtime);
  const unavailableCount = VIDEO_MODELS.filter((model) => unavailable[model.id]).length;
  const accessDisabled = runtimeEnv(runtime, "VIDEO_ACCESS_DISABLED") === "true";
  return json({
    availableCount: VIDEO_MODELS.length - unavailableCount,
    unavailable: Object.entries(unavailable).map(([modelId, item]) => ({ modelId, ...item })),
    accessRequired: !accessDisabled,
    accessConfigured: accessDisabled || Boolean(runtimeEnv(runtime, "VIDEO_ACCESS_TOKEN")),
    checkedAt: runtimeNow(runtime),
  });
}

async function uploadReferenceImage(request, runtime) {
  if (!runtime?.storage) return json({ error: "图片存储尚未配置" }, 503);
  const contentType = (request.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    return json({ error: "参考图仅支持 JPG、PNG 或 WEBP" }, 415);
  }
  const image = await request.arrayBuffer();
  if (!image.byteLength || image.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
    return json({ error: "参考图大小需在 4MB 以内" }, 413);
  }
  const key = `uploads/${crypto.randomUUID()}.${referenceImageExtension(contentType)}`;
  await runtime.storage.put(key, image, {
    contentType,
    createdAt: runtimeNow(runtime),
  });
  const cleanup = runtime.storage.cleanupExpired?.("uploads/", runtimeNow(runtime) - REFERENCE_IMAGE_TTL_MS);
  scheduleBackground(runtime, cleanup);
  return json({ url: `${new URL(request.url).origin}/api/reference-images/${encodeURIComponent(key)}` }, 201);
}

async function getReferenceImage(encodedKey, runtime) {
  let key;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return json({ error: "参考图地址无效" }, 400);
  }
  if (!key.startsWith("agnes/") && !key.startsWith("uploads/")) return json({ error: "未找到参考图" }, 404);

  if (!runtime?.storage) return json({ error: "图片存储尚未配置" }, 503);
  const image = await runtime.storage.get(key);
  if (!image?.body) return json({ error: "未找到参考图" }, 404);
  const createdAt = Number(image.createdAt) || 0;
  if (createdAt && runtimeNow(runtime) - createdAt >= REFERENCE_IMAGE_TTL_MS) {
    return json({ error: "参考图已过期" }, 404);
  }
  const maxAge = createdAt
    ? Math.max(0, Math.floor((createdAt + REFERENCE_IMAGE_TTL_MS - runtimeNow(runtime)) / 1000))
    : Math.floor(REFERENCE_IMAGE_TTL_MS / 1000);
  return new Response(image.body, {
    headers: {
      "cache-control": `public, max-age=${maxAge}, immutable`,
      "content-type": image.contentType || "image/png",
      "x-content-type-options": "nosniff",
    },
  });
}

async function getDashscopeVideo(taskId, runtime) {
  const apiKey = runtimeEnv(runtime, "DASHSCOPE_API_KEY");
  if (!apiKey) return json({ error: "阿里视频服务尚未配置" }, 503);
  const response = await fetchFor(runtime)(`${dashscopeBase(runtime)}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
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
    progress: status === "SUCCEEDED" ? 100 : status === "RUNNING" ? 58 : 12,
    seconds: result?.usage?.output_video_duration ?? result?.usage?.duration ?? null,
    size: result?.usage?.size || null,
    error: status === "FAILED" ? (output.message || result.message || "视频生成失败") : null,
  });
}

async function getAgnesVideo(taskId, videoId, runtime) {
  const apiKey = runtimeEnv(runtime, "AGNES_API_KEY");
  if (!apiKey) return json({ error: "Agnes 视频服务尚未配置" }, 503);
  const lookupId = videoId || taskId;
  const response = await fetchFor(runtime)(`${AGNES_API_BASE}/agnesapi?video_id=${encodeURIComponent(lookupId)}`, {
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
    progress: Number.isFinite(Number(result.progress)) ? Number(result.progress) : (status === "SUCCEEDED" ? 100 : null),
    seconds: result.seconds || null,
    size: result.size || null,
    error: status === "FAILED" ? (typeof result.error === "string" ? result.error : result.error?.message || "Agnes 视频生成失败") : null,
  });
}

function suppliedAccessToken(request) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return request.headers.get("x-video-access-token") || "";
}

function sameSecret(left, right) {
  if (!left || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function authorizeRequest(request, runtime) {
  const expected = runtimeEnv(runtime, "VIDEO_ACCESS_TOKEN");
  if (!expected) {
    if (runtimeEnv(runtime, "VIDEO_ACCESS_DISABLED") === "true") return null;
    return json({
      error: "接口访问保护尚未配置，请设置 VIDEO_ACCESS_TOKEN",
      accessRequired: true,
      configurationError: true,
    }, 503);
  }
  if (sameSecret(suppliedAccessToken(request), expected)) return null;
  return json({ error: "接口访问密钥无效或缺失", accessRequired: true }, 401);
}

async function rateLimitKey(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function enforceRateLimit(request, runtime, kind) {
  if (runtimeEnv(runtime, "VIDEO_RATE_LIMIT_DISABLED") === "true") return null;
  if (!runtime?.storage) return json({ error: "请求保护服务尚未配置" }, 503);
  const config = RATE_LIMITS[kind];
  const configuredLimit = Number(runtimeEnv(runtime, config.envKey));
  const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : config.limit;
  const clientId = runtime.clientId
    || request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("user-agent")
    || "anonymous";
  const key = `ratelimit/${kind}/${await rateLimitKey(clientId)}`;
  const now = runtimeNow(runtime);
  const current = await runtime.storage.getJSON(key);
  const record = current && now - Number(current.windowStart) < config.windowMs
    ? current
    : { windowStart: now, count: 0 };
  if (record.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((record.windowStart + config.windowMs - now) / 1000));
    return json({ error: "请求过于频繁，请稍后再试", retryAfter }, 429, { "retry-after": String(retryAfter) });
  }
  await runtime.storage.setJSON(key, { ...record, count: record.count + 1 });
  return null;
}

function allowedDownloadUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && (hostname === "aliyuncs.com" || hostname.endsWith(".aliyuncs.com") || hostname === "agnes-ai.space" || hostname.endsWith(".agnes-ai.space"));
  } catch {
    return false;
  }
}

async function fetchDownload(url, runtime, redirects = 0) {
  if (!allowedDownloadUrl(url)) throw new Error("视频下载地址不受信任");
  const response = await fetchFor(runtime)(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400 && response.headers.get("location") && redirects < 3) {
    return fetchDownload(new URL(response.headers.get("location"), url).href, runtime, redirects + 1);
  }
  return response;
}

async function downloadVideo(request, runtime) {
  const source = new URL(request.url).searchParams.get("url") || "";
  if (!allowedDownloadUrl(source)) return json({ error: "视频下载地址无效" }, 400);
  const response = await fetchDownload(source, runtime);
  if (!response.ok || !response.body) return json({ error: "视频下载失败" }, response.status || 502);
  return new Response(response.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": 'attachment; filename="generated-video.mp4"',
      "content-type": response.headers.get("content-type") || "video/mp4",
      ...(response.headers.get("content-length") ? { "content-length": response.headers.get("content-length") } : {}),
    },
  });
}

export async function handleVideoApiRequest(request, runtime = {}) {
  const url = new URL(request.url);
  try {
    if (!url.pathname.startsWith("/api/")) return null;
    if (url.pathname === "/api/models" && request.method === "GET") return await getModelAvailability(runtime);

    const referenceMatch = url.pathname.match(/^\/api\/reference-images\/(.+)$/);
    if (referenceMatch && request.method === "GET") return await getReferenceImage(referenceMatch[1], runtime);

    const protectedRoute = (kind, action) => async () => {
      const denied = authorizeRequest(request, runtime);
      if (denied) return denied;
      const limited = await enforceRateLimit(request, runtime, kind);
      return limited || action();
    };

    if (url.pathname === "/api/reference-images" && request.method === "POST") {
      return protectedRoute("upload", () => uploadReferenceImage(request, runtime))();
    }
    if (url.pathname === "/api/videos" && request.method === "POST") {
      return protectedRoute("create", () => createVideo(request, runtime))();
    }
    if (url.pathname === "/api/video-download" && request.method === "GET") {
      return protectedRoute("download", () => downloadVideo(request, runtime))();
    }

    const taskMatch = url.pathname.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)$/);
    if (taskMatch && request.method === "GET") {
      return protectedRoute("status", () => url.searchParams.get("provider") === "agnes"
        ? getAgnesVideo(taskMatch[1], url.searchParams.get("video_id"), runtime)
        : getDashscopeVideo(taskMatch[1], runtime))();
    }
    return json({ error: "未找到请求的接口" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "视频服务暂时不可用" }, 502);
  }
}
