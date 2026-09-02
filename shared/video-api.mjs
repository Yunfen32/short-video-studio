import {
  getVideoModel,
  getWorkflowCapability,
  inferVideoWorkflow,
  getModelsForWorkflow,
  supportsWorkflow,
  VIDEO_MODELS,
} from "./video-models.mjs";
import {
  getImageModel,
  inferImageWorkflow,
  IMAGE_MODELS,
  supportsImageWorkflow,
} from "./image-models.mjs";
import { isFreeImageModel, isFreeVideoModel } from "./free-models.mjs";
import {
  buildCreativeAgentPlan,
  createProjectPlanPrompt,
  CREATIVE_PLAN_SCHEMA,
  creativePlanForDisplay,
  normalizeCreativePlan,
} from "./creative-agent.mjs";
import {
  buildSiliconFlowImageRequest,
  buildSiliconFlowVideoRequest,
  getSiliconFlowCatalog,
  getSiliconFlowImageModel,
  getSiliconFlowVideoModel,
  siliconFlowImageUrls,
  siliconFlowVideoStatus,
} from "./siliconflow-models.mjs";

const DEFAULT_DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com";
const DEFAULT_AGNES_API_BASE = "https://apihub.agnes-ai.com";
const DEFAULT_ZHIPU_API_BASE = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_SILICONFLOW_API_BASE = "https://api.siliconflow.cn/v1";
const DEFAULT_DOTS_API_BASE = "https://api.dots.ai/v1";
const IMAGE_QUALITY_SIZES = {
  "1K": "1024*1024",
  "2K": "2048*2048",
  "4K": "4096*4096",
};
const ZHIPU_API_PROVIDER = "zhipu";
const FREE_MODELS_ONLY_ENV = "FREE_MODELS_ONLY";
const AGNES_VIDEO_MODEL = "agnes-video-v2.0";
const SUB2API_GROK = Object.freeze({
  provider: "sub2api_grok",
  name: "Sub2API Grok",
  baseUrl: "https://ctmoai.com/v1",
  envKey: "SUB2API_API_KEY",
  wireApi: "responses",
  model: "grok-4.5",
  reviewModel: "grok-4.5",
  videoModel: "grok-imagine-video",
  reasoningEffort: "xhigh",
  contextWindow: 1_000_000,
});
const AVAILABILITY_KEY = "state/unavailable-models";
const MODEL_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PROVIDER_BILLING_COOLDOWN_MS = 15 * 60 * 1000;
const REFERENCE_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
const AGENT_PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_REFERENCE_IMAGE_BYTES = 4 * 1024 * 1024;
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]);

const RATE_LIMITS = {
  create: { limit: 6, windowMs: 60 * 60 * 1000, envKey: "VIDEO_CREATE_LIMIT_PER_HOUR" },
  plan: { limit: 60, windowMs: 60 * 60 * 1000, envKey: "AGENT_PLAN_LIMIT_PER_HOUR" },
  "agent-create": { limit: 60, windowMs: 60 * 60 * 1000, envKey: "AGENT_CREATE_LIMIT_PER_HOUR" },
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

function freeModelsOnly(runtime) {
  const configured = runtimeEnv(runtime, FREE_MODELS_ONLY_ENV);
  if (configured) return configured === "true";
  // 托管站点默认面向公开访问，只有显式设置为 false 才允许付费模型。
  return runtime?.platform === "netlify" || runtime?.platform === "sites";
}

function modelProviderConfigured(model, runtime) {
  const keyByProvider = {
    agnes: "AGNES_API_KEY",
    dashscope: "DASHSCOPE_API_KEY",
    [ZHIPU_API_PROVIDER]: "ZHIPU_API_KEY",
    siliconflow: "SILICONFLOW_API_KEY",
    sub2api_grok: SUB2API_GROK.envKey,
  };
  const key = keyByProvider[model?.provider];
  if (!key || !runtimeEnv(runtime, key)) return false;
  if (model?.provider === "sub2api_grok") {
    return runtimeEnv(runtime, "SUB2API_GROK_VIDEO_ENABLED") === "true";
  }
  return true;
}

function accessProtectionDisabled(runtime) {
  const configured = runtimeEnv(runtime, "VIDEO_ACCESS_DISABLED");
  if (configured) return configured === "true";
  if (runtimeEnv(runtime, "VIDEO_ACCESS_TOKEN")) return false;
  return runtime?.platform === "netlify" || runtime?.platform === "sites";
}

function dashscopeBase(runtime) {
  return (runtimeEnv(runtime, "DASHSCOPE_BASE_URL") || DEFAULT_DASHSCOPE_API_BASE).replace(/\/$/, "");
}

function sub2apiGrokBase(runtime) {
  return (runtimeEnv(runtime, "SUB2API_GROK_BASE_URL") || SUB2API_GROK.baseUrl).replace(/\/$/, "");
}

function zhipuBase(runtime) {
  return (runtimeEnv(runtime, "ZHIPU_API_BASE") || DEFAULT_ZHIPU_API_BASE).replace(/\/$/, "");
}

function agnesBase(runtime) {
  return (runtimeEnv(runtime, "AGNES_API_BASE") || `${DEFAULT_AGNES_API_BASE}/v1`).replace(/\/$/, "");
}

function siliconflowBase(runtime) {
  return (runtimeEnv(runtime, "SILICONFLOW_API_BASE") || DEFAULT_SILICONFLOW_API_BASE).replace(/\/$/, "");
}

function dotsBase(runtime) {
  return (runtimeEnv(runtime, "DOTS_API_BASE") || DEFAULT_DOTS_API_BASE).replace(/\/$/, "");
}

function agnesRoot(runtime) {
  return agnesBase(runtime).replace(/\/v1$/, "");
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

function referenceImageUrl(origin, key, accessToken) {
  const url = new URL(`/api/reference-images/${encodeURIComponent(key)}`, origin);
  url.searchParams.set("token", accessToken);
  return url.href;
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

function encodeBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function publicAgnesImageUrl(source, origin, runtime) {
  if (/^https?:\/\//i.test(source)) return source;
  const match = source.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([\s\S]+)$/i);
  if (!match) throw new Error("Agnes 参考图格式无效");

  if (runtime?.inlineReferenceImages) return source;
  const [, contentType, encoded] = match;
  const key = `agnes/${crypto.randomUUID()}.${referenceImageExtension(contentType.toLowerCase())}`;
  const accessToken = crypto.randomUUID();
  if (!runtime?.storage) throw new Error("图片存储尚未配置");
  await runtime.storage.put(key, decodeBase64(encoded), {
    contentType: contentType.toLowerCase(),
    createdAt: runtimeNow(runtime),
    accessToken,
  });
  const cleanup = runtime.storage.cleanupExpired?.("agnes/", runtimeNow(runtime) - REFERENCE_IMAGE_TTL_MS);
  scheduleBackground(runtime, cleanup);
  return referenceImageUrl(origin, key, accessToken);
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
  if (workflowCapability.audioMode === "required_input_audio" && !data.audioUrl) return "当前生成方式需要人物音频 URL";
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

  if (model.protocol === "s2v") {
    return {
      endpoint: "/api/v1/services/aigc/image2video/video-synthesis",
      payload: {
        model: model.id,
        input: {
          image_url: data.images[0].source,
          audio_url: data.audioUrl,
        },
        parameters: { resolution: data.resolution },
      },
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

  if (model.protocol === "vace") {
    const imageReference = data.images.length > 0;
    return {
      endpoint: defaultEndpoint,
      payload: {
        model: model.id,
        input: {
          function: imageReference ? "image_reference" : "video_repainting",
          prompt,
          video_url: data.videoUrl,
          ...(imageReference ? { ref_images_url: data.images.map((item) => item.source) } : {}),
        },
        parameters: {
          prompt_extend: data.promptExtend,
          size: legacyVideoSize(data.resolution, data.ratio),
          ...(imageReference ? {
            obj_or_bg: data.images.map((item) => item.role === "background" ? "bg" : "obj"),
          } : {}),
        },
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

function grokResolution(resolution) {
  return { "480P": "480p", "720P": "720p", "1080P": "1080p" }[resolution] || "480p";
}

export function buildGrokVideoRequest(model, data, imageUrls) {
  const prompt = normalizePromptMentions(data.prompt, data.workflow, "Image", data.images);
  const payload = {
    model: model.id,
    prompt,
    duration: data.duration,
    aspect_ratio: data.ratio || "16:9",
    resolution: grokResolution(data.resolution),
  };

  if (data.workflow === "first-frame") payload.image = imageUrls[0];
  if (data.workflow === "multi-reference") payload.reference_images = imageUrls;
  return payload;
}

function zhipuVideoSize(resolution, ratio) {
  const sizes = {
    "720P": { "16:9": "1280x720", "9:16": "720x1280", "1:1": "1024x1024", "4:3": "1280x720", "3:4": "720x1280" },
    "1080P": { "16:9": "1920x1080", "9:16": "1080x1920", "1:1": "1024x1024", "4:3": "1920x1080", "3:4": "1080x1920" },
    "4K": { "16:9": "3840x2160", "9:16": "3840x2160", "1:1": "3840x2160", "4:3": "3840x2160", "3:4": "3840x2160" },
  };
  return sizes[resolution]?.[ratio] || sizes[resolution]?.["16:9"] || sizes["720P"]["16:9"];
}

export function buildZhipuVideoRequest(model, data, imageUrls = []) {
  return {
    model: model.id,
    prompt: data.prompt || "让画面自然运动起来",
    quality: "speed",
    with_audio: Boolean(model.outputAudio),
    watermark_enabled: data.watermark,
    size: zhipuVideoSize(data.resolution, data.ratio),
    fps: 30,
    duration: data.duration,
    ...(imageUrls.length ? { image_url: imageUrls.length === 1 ? imageUrls[0] : imageUrls } : {}),
  };
}

function fetchFor(runtime) {
  return runtime?.fetch || globalThis.fetch;
}

class AgentLlmConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentLlmConfigurationError";
  }
}

function agentLlmCandidates(runtime) {
  const explicitKey = runtimeEnv(runtime, "AGENT_LLM_API_KEY");
  const configuredModel = runtimeEnv(runtime, "AGENT_LLM_MODEL");
  const configuredReasoningEffort = runtimeEnv(runtime, "AGENT_LLM_REASONING_EFFORT");
  const candidates = [];
  if (explicitKey) {
    candidates.push({
      provider: runtimeEnv(runtime, "AGENT_LLM_PROVIDER") || "openai-compatible",
      apiKey: explicitKey,
      baseUrl: (runtimeEnv(runtime, "AGENT_LLM_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: configuredModel || "gpt-4o-mini",
      wireApi: runtimeEnv(runtime, "AGENT_LLM_WIRE_API") || "responses",
      reasoningEffort: configuredReasoningEffort || "medium",
    });
  }
  // 显式 LLM 遇到限流或认证故障时，继续尝试已配置的兼容服务。
  // 备用服务不能沿用显式模型名，否则跨服务商模型 ID 会失效。
  const fallbackModel = explicitKey ? "" : configuredModel;
  const sub2apiKey = runtimeEnv(runtime, SUB2API_GROK.envKey);
  if (sub2apiKey) {
    candidates.push({
      provider: SUB2API_GROK.provider,
      apiKey: sub2apiKey,
      baseUrl: sub2apiGrokBase(runtime),
      model: fallbackModel || SUB2API_GROK.reviewModel,
      wireApi: "responses",
      reasoningEffort: configuredReasoningEffort || SUB2API_GROK.reasoningEffort,
    });
  }
  const zhipuKey = runtimeEnv(runtime, "ZHIPU_API_KEY");
  if (zhipuKey) {
    candidates.push({
      provider: ZHIPU_API_PROVIDER,
      apiKey: zhipuKey,
      baseUrl: zhipuBase(runtime),
      model: fallbackModel || "glm-4.5-air",
      wireApi: "chat_completions",
    });
  }
  const dotsKey = runtimeEnv(runtime, "DOTS_API_KEY");
  if (dotsKey) {
    candidates.push({
      provider: "dots",
      apiKey: dotsKey,
      baseUrl: dotsBase(runtime),
      model: fallbackModel || "dots3-note-prev",
      wireApi: "chat_completions",
    });
  }
  const dashscopeKey = runtimeEnv(runtime, "DASHSCOPE_API_KEY");
  if (dashscopeKey) {
    candidates.push({
      provider: "dashscope",
      apiKey: dashscopeKey,
      baseUrl: `${dashscopeBase(runtime)}/compatible-mode/v1`,
      model: fallbackModel || "qwen-plus",
      wireApi: "chat_completions",
    });
  }
  if (!candidates.length) throw new AgentLlmConfigurationError("Agent LLM 尚未配置，请设置 AGENT_LLM_API_KEY（或 SUB2API_API_KEY、ZHIPU_API_KEY、DOTS_API_KEY、DASHSCOPE_API_KEY）");
  return candidates;
}

const AGENT_LLM_SYSTEM_PROMPT = [
  "你是一个负责短视频前期制作的创作 Agent。你需要理解用户的灵感或剧本，做出可执行且可复核的创作方案。",
  "先在内部完成叙事、视觉连续性、镜头节奏和生成约束的推理，但不要输出思维链；只输出符合 JSON Schema 的最终方案和一句简短 planningSummary。",
  "必须提取主要人物和场景，每个人物与场景都要有可以直接交给文生图模型的 imagePrompt。",
  "每个镜头必须同时提供 imagePrompt（关键画面）和 videoPrompt（动作、镜头运动、时序、转场），并沿用人物与场景的 continuityNotes 保持一致。videoPrompt 必须保留三段式换行：\n【素材引用】\n@场景图1、@角色1 等实际涉及的参考资产；\n【分段镜头】\n从 0 秒到 timelineDuration 的连续镜头、动作、台词和环境音；\n【风格画质+约束】\n风格、比例、画质、连续性和负面约束。",
  "严格尊重用户选择的生成目标、视觉风格、画面比例和总时长，不要擅自改成另一种风格或比例。",
  "如果目标是 video，shots 的 duration 是实际提交给视频模型的生成时长，timelineDuration 是成片保留时长；必须严格遵守用户消息中给出的拆分方案，且所有 timelineDuration 之和严格等于用户选择的总时长。",
  "不要写无法执行的音频、字幕或后期指令；audio 只描述氛围或对白，videoPrompt 只描述视频模型可完成的画面动作。",
].join("\n");

function responseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (typeof payload?.choices?.[0]?.message?.content === "string") return payload.choices[0].message.content;
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.value === "string") return part.value;
    }
  }
  const messageContent = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(messageContent)) return messageContent.map((part) => part?.text || part?.value || "").join("");
  return "";
}

function parseJsonObject(value) {
  const source = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(source);
  } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error("LLM 返回的规划结果不是有效 JSON");
  }
}

function preferredAgentVideoModel(candidates) {
  return candidates.reduce((best, model) => {
    if (!best) return model;
    const bestMax = Math.max(...(best.durations || [0]));
    const modelMax = Math.max(...(model.durations || [0]));
    if (modelMax !== bestMax) return modelMax > bestMax ? model : best;
    if (model.featured !== best.featured) return model.featured ? model : best;
    return best;
  }, null);
}

function agentDurationOptions(catalog, input) {
  if (input?.target === "image") return [];
  const requestedWorkflow = "first-frame";
  const videoModels = catalog?.visibleVideoModels || [];
  const referenceCandidates = getModelsForWorkflow(requestedWorkflow, videoModels);
  const candidates = referenceCandidates.length ? referenceCandidates : getModelsForWorkflow("text-to-video", videoModels);
  const model = preferredAgentVideoModel(candidates);
  return (model?.durations || []).filter((duration) => Number.isInteger(duration) && duration >= 2).sort((a, b) => a - b);
}

/**
 * 将用户的总时长映射为实际模型可生成的分段时长。
 * 除最后一段外尽量使用模型最大值；最后一段选能覆盖剩余时间的最短合法时长，成片阶段裁掉多余尾帧。
 */
function projectClipTimings(totalDuration, durationOptions) {
  const total = Math.max(1, Math.min(300, Math.round(Number(totalDuration) || 5)));
  const options = [...new Set((durationOptions || []).map(Number).filter((duration) => Number.isInteger(duration) && duration > 0))].sort((a, b) => a - b);
  if (!options.length) return [];
  const maximum = options.at(-1);
  const timings = [];
  let remaining = total;
  while (remaining > maximum) {
    timings.push({ duration: maximum, timelineDuration: maximum });
    remaining -= maximum;
  }
  const generatedDuration = options.find((duration) => duration >= remaining) || maximum;
  timings.push({ duration: generatedDuration, timelineDuration: remaining });
  return timings;
}

async function callAgentLlm(input, runtime, { durationOptions = [], clipTimings = [] } = {}) {
  const prompt = createProjectPlanPrompt(input, {
    maxClipDuration: durationOptions.length ? Math.max(...durationOptions) : 15,
    durationOptions,
    clipTimings,
  });
  let lastError;
  for (const config of agentLlmCandidates(runtime)) {
    const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
    const endpoint = config.wireApi === "responses" ? `${config.baseUrl}/responses` : `${config.baseUrl}/chat/completions`;
    const body = config.wireApi === "responses"
      ? {
        model: config.model,
        instructions: AGENT_LLM_SYSTEM_PROMPT,
        input: prompt,
        ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
        text: { format: { type: "json_schema", name: "creative_project_plan", strict: true, schema: CREATIVE_PLAN_SCHEMA } },
      }
      : {
        model: config.model,
        temperature: 0.4,
        messages: [{ role: "system", content: AGENT_LLM_SYSTEM_PROMPT }, { role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "creative_project_plan", strict: true, schema: CREATIVE_PLAN_SCHEMA } },
      };
    let response;
    try {
      response = await fetchFor(runtime)(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Agent LLM 网络请求失败");
      continue;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastError = new Error(upstreamMessage(payload, `Agent LLM 请求失败（${response.status}）`));
      if (![401, 403, 404, 429].includes(response.status)) throw lastError;
      continue;
    }
    const raw = parseJsonObject(responseText(payload));
    return { plan: normalizeCreativePlan(raw, { ...input, durationOptions, clipTimings }), provider: config.provider, model: config.model };
  }
  throw lastError || new Error("Agent LLM 请求失败");
}

async function modelCreationFailure(response, result, modelId, runtime, fallback = "视频任务创建失败") {
  const message = upstreamMessage(result, fallback);
  const scope = quotaFailureScope(response, result);
  if (!scope) return json({ error: message }, response.status || 502);

  const model = getVideoModel(modelId) || await getSiliconFlowVideoModel(modelId, runtime);
  let providerModels = VIDEO_MODELS.filter((item) => item.provider === model?.provider);
  if (model?.provider === "siliconflow") {
    const catalog = await getSiliconFlowCatalog(runtime);
    providerModels = catalog.videoModels;
  }
  const modelIds = scope === "provider" ? providerModels.map((item) => item.id) : [modelId];
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

async function createSiliconFlowVideo(model, body, origin, runtime) {
  const apiKey = runtimeEnv(runtime, "SILICONFLOW_API_KEY");
  if (!apiKey) return json({ error: "SiliconFlow 视频服务尚未配置" }, 503);
  const data = prepareRequestData(model, body);
  const validationError = validateRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);
  const imageUrls = await Promise.all(data.images.map((item) => publicAgnesImageUrl(item.source, origin, runtime)));
  const response = await fetchFor(runtime)(`${siliconflowBase(runtime)}/video/submit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildSiliconFlowVideoRequest(model, data, imageUrls[0] || "")),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.requestId) {
    return modelCreationFailure(response, result, model.id, runtime, "SiliconFlow 视频任务创建失败");
  }
  return json({
    taskId: result.requestId,
    provider: "siliconflow",
    modelId: model.id,
    status: "PENDING",
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
  return { 3: 81, 5: 121, 7: 161, 10: 241, 18: 441 }[duration] || 121;
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
  const response = await fetchFor(runtime)(`${agnesBase(runtime)}/videos`, {
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

async function createGrokVideo(model, body, origin, runtime) {
  const apiKey = runtimeEnv(runtime, SUB2API_GROK.envKey);
  if (!apiKey) return json({ error: "Sub2API Grok 视频服务尚未配置" }, 503);
  const data = prepareRequestData(model, body);
  const validationError = validateRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);

  const imageUrls = await Promise.all(data.images.map((item) => publicAgnesImageUrl(item.source, origin, runtime)));
  const response = await fetchFor(runtime)(`${sub2apiGrokBase(runtime)}/videos/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildGrokVideoRequest(model, data, imageUrls)),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.request_id) {
    return modelCreationFailure(response, result, model.id, runtime, "Grok 视频任务创建失败");
  }
  return json({
    taskId: result.request_id,
    provider: "sub2api_grok",
    modelId: model.id,
    status: "PENDING",
  }, 202);
}

function zhipuTaskStatus(status) {
  return { PROCESSING: "RUNNING", PENDING: "PENDING", SUCCESS: "SUCCEEDED", SUCCEEDED: "SUCCEEDED", FAIL: "FAILED", FAILED: "FAILED" }[status] || "UNKNOWN";
}

async function createZhipuVideo(model, body, origin, runtime) {
  const apiKey = runtimeEnv(runtime, "ZHIPU_API_KEY");
  if (!apiKey) return json({ error: "Zhipu AI 视频服务尚未配置" }, 503);
  const data = prepareRequestData(model, body);
  const validationError = validateRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);

  const imageUrls = await Promise.all(data.images.map((item) => publicAgnesImageUrl(item.source, origin, runtime)));
  const response = await fetchFor(runtime)(`${zhipuBase(runtime)}/videos/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildZhipuVideoRequest(model, data, imageUrls)),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !(result.id || result.task_id)) {
    return modelCreationFailure(response, result, model.id, runtime, "Zhipu AI 视频任务创建失败");
  }
  return json({
    taskId: result.id || result.task_id,
    provider: ZHIPU_API_PROVIDER,
    modelId: model.id,
    status: zhipuTaskStatus(result.task_status),
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
  const model = getVideoModel(body.model) || await getSiliconFlowVideoModel(body.model, runtime);
  if (!model) return json({ error: "不支持该视频模型" }, 400);
  if (model.provider === "sub2api_grok" && !modelProviderConfigured(model, runtime)) {
    return json({ error: "Sub2API Grok 视频协议尚未启用或验证" }, 503);
  }
  if (freeModelsOnly(runtime) && !isFreeVideoModel(model)) {
    return json({ error: "当前工作台仅允许免费模型", paidModelBlocked: true, modelId: model.id }, 403);
  }
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
  const origin = new URL(request.url).origin;
  if (model.provider === "agnes") return createAgnesVideo(model, body, origin, runtime);
  if (model.provider === "sub2api_grok") return createGrokVideo(model, body, origin, runtime);
  if (model.provider === ZHIPU_API_PROVIDER) return createZhipuVideo(model, body, origin, runtime);
  if (model.provider === "siliconflow") return createSiliconFlowVideo(model, body, origin, runtime);
  return createDashscopeVideo(model, body, runtime);
}

function parseImageRequest(body) {
  return {
    workflow: typeof body.workflow === "string" ? body.workflow.trim() : "",
    prompt: typeof body.prompt === "string" ? body.prompt.trim() : "",
    images: Array.isArray(body.images)
      ? body.images.map((item) => typeof item === "string" ? item.trim() : String(item?.source || "").trim()).filter(Boolean)
      : [],
    quality: typeof body.quality === "string" ? body.quality : "2K",
    count: Number(body.count) || 1,
    watermark: Boolean(body.watermark),
  };
}

export function prepareImageRequest(model, body) {
  const data = parseImageRequest(body);
  data.workflow = data.workflow || inferImageWorkflow(data);
  return data;
}

export function validateImageRequest(model, data) {
  if (!data.prompt) return "请填写图片描述";
  if (data.prompt.length > 5000) return "图片描述不能超过 5000 个字符";
  if (!supportsImageWorkflow(model, data.workflow)) return "当前模型不支持所选图片生成方式";
  if (!model.qualities.includes(data.quality)) return "当前模型不支持所选清晰度";
  if (!Number.isInteger(data.count) || data.count < 1 || data.count > model.maxOutputs) {
    return `一次可生成 1-${model.maxOutputs} 张图片`;
  }
  const imageLimit = data.workflow === "image-edit" ? Number(model.maxInputImages || 9) : 0;
  if (data.images.length > imageLimit) return `当前生成方式最多使用 ${imageLimit} 张参考图`;
  if (data.workflow === "image-edit" && !data.images.length) return "请上传至少 1 张参考图";
  if (data.images.some((source) => !validImageSource(source))) return "参考图仅支持 HTTPS 地址或 4MB 以内的 JPG、PNG、WEBP 图片";
  if (
    data.workflow === "image-edit"
    && model.editMaxQuality
    && model.qualities.indexOf(data.quality) > model.qualities.indexOf(model.editMaxQuality)
  ) {
    return `当前模型参考图编辑最高支持 ${model.editMaxQuality}`;
  }
  return null;
}

function imageSizeFor(model, quality) {
  return model.qualitySizes?.[quality] || IMAGE_QUALITY_SIZES[quality] || "1024*1024";
}

function imageMessages(data) {
  return [{
    role: "user",
    content: [
      ...data.images.map((image) => ({ image })),
      { text: data.prompt },
    ],
  }];
}

function imageParameters(model, data) {
  return {
    ...(model.maxOutputs > 1 ? { n: data.count } : {}),
    watermark: data.watermark,
    ...(model.protocol !== "zImageSync" ? { prompt_extend: true } : {}),
    size: imageSizeFor(model, data.quality),
  };
}

export function buildDashscopeImageRequest(model, data) {
  if (model.protocol === "wanImage2Image") {
    return {
      endpoint: "/api/v1/services/aigc/image2image/image-synthesis",
      async: true,
      payload: {
        model: model.id,
        input: { prompt: data.prompt, images: data.images },
        parameters: imageParameters(model, data),
      },
    };
  }

  if (model.protocol === "wanLegacyText" || model.protocol === "qwenLegacyText") {
    return {
      endpoint: "/api/v1/services/aigc/text2image/image-synthesis",
      async: true,
      payload: {
        model: model.id,
        input: { prompt: data.prompt },
        parameters: imageParameters(model, data),
      },
    };
  }

  if (model.protocol === "zImageSync") {
    return {
      endpoint: "/api/v1/services/aigc/multimodal-generation/generation",
      async: false,
      payload: {
        model: model.id,
        input: { messages: imageMessages(data) },
        parameters: imageParameters(model, data),
      },
    };
  }

  const synchronous = model.protocol === "qwenMessageSync";
  return {
    endpoint: synchronous
      ? "/api/v1/services/aigc/multimodal-generation/generation"
      : "/api/v1/services/aigc/image-generation/generation",
    async: !synchronous,
    payload: {
      model: model.id,
      input: { messages: imageMessages(data) },
      parameters: imageParameters(model, data),
    },
  };
}

function zhipuImageSize(model, quality) {
  if (quality === "1K") return "1024x1024";
  return model.zhipuSize || "1280x1280";
}

function agnesImageSize(model, quality) {
  return model.agnesSize?.[quality] || (quality === "1K" ? "1024x1024" : "1536x1536");
}

export function buildAgnesImageRequest(model, data, imageSources = []) {
  return {
    model: model.id,
    prompt: data.prompt,
    size: agnesImageSize(model, data.quality),
    extra_body: {
      response_format: "url",
      ...(imageSources.length ? { image: imageSources } : {}),
    },
  };
}

export function buildZhipuImageRequest(model, data) {
  return {
    model: model.id,
    prompt: data.prompt,
    size: zhipuImageSize(model, data.quality),
    ...(model.zhipuAsync ? { quality: "hd", watermark_enabled: data.watermark } : {}),
  };
}

function zhipuImageUrls(result) {
  const dataItems = Array.isArray(result?.data) ? result.data : result?.data ? [result.data] : [];
  const imageItems = Array.isArray(result?.image_result) ? result.image_result : [];
  const direct = [...dataItems, ...imageItems]
    .map((item) => typeof item === "string" ? item : item?.url)
    .filter(Boolean);
  const choices = Array.isArray(result?.choices)
    ? result.choices.flatMap((choice) => Array.isArray(choice?.message?.content) ? choice.message.content : [])
      .map((item) => item?.image_url?.url || item?.image || item?.url)
      .filter(Boolean)
    : [];
  return [...new Set([...direct, ...choices])];
}

async function createZhipuImage(model, body, runtime) {
  const apiKey = runtimeEnv(runtime, "ZHIPU_API_KEY");
  if (!apiKey) return json({ error: "Zhipu AI 图片服务尚未配置" }, 503);
  const data = prepareImageRequest(model, body);
  const validationError = validateImageRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);

  const endpoint = model.zhipuAsync ? "/async/images/generations" : "/images/generations";
  const response = await fetchFor(runtime)(`${zhipuBase(runtime)}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildZhipuImageRequest(model, data)),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return imageCreationFailure(response, result, model.id, runtime);

  if (model.zhipuAsync) {
    if (!result.id) return imageCreationFailure(response, result, model.id, runtime);
    return json({
      taskId: result.id,
      provider: ZHIPU_API_PROVIDER,
      modelId: model.id,
      status: zhipuTaskStatus(result.task_status),
    }, 202);
  }

  const imageUrls = zhipuImageUrls(result);
  if (!imageUrls.length) return imageCreationFailure(response, result, model.id, runtime);
  return json({
    taskId: null,
    provider: ZHIPU_API_PROVIDER,
    modelId: model.id,
    status: "SUCCEEDED",
    terminal: true,
    imageUrls,
  }, 202);
}

async function createAgnesImage(model, body, origin, runtime) {
  const apiKey = runtimeEnv(runtime, "AGNES_API_KEY");
  if (!apiKey) return json({ error: "Agnes AI 图片服务尚未配置" }, 503);
  const data = prepareImageRequest(model, body);
  const validationError = validateImageRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);
  const imageSources = await Promise.all(data.images.map((source) => publicAgnesImageUrl(source, origin, runtime)));
  const response = await fetchFor(runtime)(`${agnesBase(runtime)}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildAgnesImageRequest(model, data, imageSources)),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return imageCreationFailure(response, result, model.id, runtime);
  const imageUrls = zhipuImageUrls(result);
  if (!imageUrls.length) return imageCreationFailure(response, result, model.id, runtime);
  return json({
    taskId: null,
    provider: "agnes",
    modelId: model.id,
    status: "SUCCEEDED",
    terminal: true,
    imageUrls,
  }, 202);
}

async function createSiliconFlowImage(model, body, origin, runtime) {
  const apiKey = runtimeEnv(runtime, "SILICONFLOW_API_KEY");
  if (!apiKey) return json({ error: "SiliconFlow 图片服务尚未配置" }, 503);
  const data = prepareImageRequest(model, body);
  const validationError = validateImageRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);
  const imageSources = await Promise.all(data.images.map((source) => publicAgnesImageUrl(source, origin, runtime)));
  const response = await fetchFor(runtime)(`${siliconflowBase(runtime)}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildSiliconFlowImageRequest(model, { ...data, images: imageSources })),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return imageCreationFailure(response, result, model.id, runtime);
  const imageUrls = siliconFlowImageUrls(result);
  if (!imageUrls.length) return imageCreationFailure(response, result, model.id, runtime);
  return json({
    taskId: null,
    provider: "siliconflow",
    modelId: model.id,
    status: "SUCCEEDED",
    terminal: true,
    imageUrls,
  }, 202);
}

async function imageCreationFailure(response, result, modelId, runtime) {
  const message = upstreamMessage(result, "图片任务创建失败");
  const scope = quotaFailureScope(response, result);
  if (!scope) return json({ error: message }, response.status || 502);

  const model = getImageModel(modelId) || await getSiliconFlowImageModel(modelId, runtime);
  let providerModels = IMAGE_MODELS.filter((item) => item.provider === model?.provider);
  if (model?.provider === "siliconflow") {
    const catalog = await getSiliconFlowCatalog(runtime);
    providerModels = catalog.imageModels;
  }
  const modelIds = scope === "provider" ? providerModels.map((item) => item.id) : [modelId];
  const cooldownMs = scope === "provider" ? PROVIDER_BILLING_COOLDOWN_MS : MODEL_QUOTA_COOLDOWN_MS;
  let unavailable = modelIds.map((item) => ({ modelId: item, reason: message, until: runtimeNow(runtime) + cooldownMs, scope }));
  try {
    unavailable = await markModelsUnavailable(runtime, modelIds, message, cooldownMs, scope);
  } catch {
    // Preserve the upstream error even when persistent model availability is unavailable.
  }
  return json({
    error: message,
    modelUnavailable: true,
    modelId,
    unavailableUntil: unavailable.find((item) => item.modelId === modelId)?.until,
    unavailable,
  }, response.status || 429);
}

async function createImage(request, runtime) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求内容不是有效的 JSON" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "请求内容必须是 JSON 对象" }, 400);
  const model = getImageModel(body.model) || await getSiliconFlowImageModel(body.model, runtime);
  if (!model) return json({ error: "不支持该图片模型" }, 400);
  if (freeModelsOnly(runtime) && !isFreeImageModel(model)) {
    return json({ error: "当前工作台仅允许免费模型", paidModelBlocked: true, modelId: model.id }, 403);
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
  if (model.provider === ZHIPU_API_PROVIDER) return createZhipuImage(model, body, runtime);
  if (model.provider === "agnes") return createAgnesImage(model, body, new URL(request.url).origin, runtime);
  if (model.provider === "siliconflow") return createSiliconFlowImage(model, body, new URL(request.url).origin, runtime);
  const apiKey = runtimeEnv(runtime, "DASHSCOPE_API_KEY");
  if (!apiKey) return json({ error: "阿里图片服务尚未配置" }, 503);

  const data = prepareImageRequest(model, body);
  const validationError = validateImageRequest(model, data);
  if (validationError) return json({ error: validationError }, 400);
  const { endpoint, payload, async: asyncRequest = true } = buildDashscopeImageRequest(model, data);
  const response = await fetchFor(runtime)(`${dashscopeBase(runtime)}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(asyncRequest ? { "X-DashScope-Async": "enable" } : {}),
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return imageCreationFailure(response, result, model.id, runtime);
  if (!asyncRequest) {
    const imageUrls = imageUrlsFromOutput(result?.output);
    if (imageUrls.length) {
      return json({
        taskId: null,
        provider: "dashscope",
        modelId: model.id,
        status: "SUCCEEDED",
        terminal: true,
        imageUrls,
        size: result?.usage?.size || null,
      }, 202);
    }
  }
  if (!result?.output?.task_id) return imageCreationFailure(response, result, model.id, runtime);
  return json({
    taskId: result.output.task_id,
    provider: "dashscope",
    modelId: model.id,
    status: result.output.task_status || "PENDING",
  }, 202);
}

async function getModelAvailability(runtime) {
  const catalog = await getAvailableModelCatalog(runtime);
  const accessDisabled = accessProtectionDisabled(runtime);
  return json({
    availableCount: catalog.visibleVideoModels.length,
    imageAvailableCount: catalog.visibleImageModels.length,
    videoModels: catalog.visibleVideoModels,
    imageModels: catalog.visibleImageModels,
    siliconflow: catalog.siliconflow,
    dots: catalog.dots,
    freeOnly: catalog.onlyFree,
    unavailable: Object.entries(catalog.unavailable).map(([modelId, item]) => ({ modelId, ...item })),
    accessRequired: !accessDisabled,
    accessConfigured: accessDisabled || Boolean(runtimeEnv(runtime, "VIDEO_ACCESS_TOKEN")),
    directAccess: accessDisabled,
    checkedAt: runtimeNow(runtime),
  });
}

async function getAvailableModelCatalog(runtime) {
  const unavailable = await readUnavailableModels(runtime);
  const onlyFree = freeModelsOnly(runtime);
  const siliconflow = await getSiliconFlowCatalog(runtime);
  const videoCatalog = [...VIDEO_MODELS, ...siliconflow.videoModels]
    .filter((model, index, models) => models.findIndex((item) => item.id === model.id) === index);
  const imageCatalog = [...IMAGE_MODELS, ...siliconflow.imageModels]
    .filter((model, index, models) => models.findIndex((item) => item.id === model.id) === index);
  const visibleVideoModels = (onlyFree ? videoCatalog.filter(isFreeVideoModel) : videoCatalog)
    .filter((model) => modelProviderConfigured(model, runtime));
  const visibleImageModels = (onlyFree ? imageCatalog.filter(isFreeImageModel) : imageCatalog)
    .filter((model) => modelProviderConfigured(model, runtime));
  return {
    unavailable,
    onlyFree,
    visibleVideoModels: visibleVideoModels.filter((model) => !unavailable[model.id]),
    visibleImageModels: visibleImageModels.filter((model) => !unavailable[model.id]),
    siliconflow: {
      configured: siliconflow.configured,
      videoModelCount: siliconflow.videoModels.length,
      imageModelCount: siliconflow.imageModels.length,
      freeVideoModelCount: siliconflow.videoModels.filter(isFreeVideoModel).length,
      freeImageModelCount: siliconflow.imageModels.filter(isFreeImageModel).length,
      error: siliconflow.error,
    },
    // Dots 官方公开文档当前只定义文本、多模态理解和工具调用，未定义媒体生成端点。
    // 仅反馈配置状态，避免将理解模型伪装成图片或视频生成模型。
    dots: {
      configured: Boolean(runtimeEnv(runtime, "DOTS_API_KEY")),
      mediaGenerationSupported: false,
      message: "Dots 当前仅支持多模态理解，不提供图片或视频生成模型",
    },
  };
}

function publicAgentPlan(plan) {
  return {
    kind: plan.kind,
    workflow: plan.workflow,
    modelId: plan.modelId,
    modelLabel: plan.modelLabel,
    provider: plan.provider,
    summary: plan.summary,
    planner: plan.planner || null,
    prompt: plan.request.prompt,
    brief: plan.brief,
    output: plan.kind === "video"
      ? { ratio: plan.request.ratio, duration: plan.request.duration, resolution: plan.request.resolution }
      : { quality: plan.request.quality, count: plan.request.count },
  };
}

async function resolveAgentPlan(request, runtime) {
  let input;
  try {
    input = await request.json();
  } catch {
    return { errorResponse: json({ error: "请求内容不是有效的 JSON" }, 400) };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { errorResponse: json({ error: "请求内容必须是 JSON 对象" }, 400) };
  }
  if (input.target === "image" && input.assetRole !== "intermediate") {
    return { errorResponse: json({ error: "Agent 只输出视频；图片仅可作为视频生成的中间资产" }, 400) };
  }

  try {
    const catalog = await getAvailableModelCatalog(runtime);
    if (input.promptPrepared === true) {
      if (input.target !== "image" && input.target !== "video") {
        return { errorResponse: json({ error: "已准备好的镜头必须明确生成目标" }, 400) };
      }
      return { plan: buildCreativeAgentPlan(input, {
        videoModels: catalog.visibleVideoModels,
        imageModels: catalog.visibleImageModels,
      }) };
    }
    const videoInput = { ...input, target: "video" };
    const durationOptions = agentDurationOptions(catalog, videoInput);
    const llm = await callAgentLlm(videoInput, runtime, {
      durationOptions,
      clipTimings: projectClipTimings(videoInput.duration, durationOptions),
    });
    if (llm.plan.shots.length > 1) {
      return { errorResponse: json({ error: "该请求需要多个分镜才能完成，请先创建项目，Agent 会按镜头生成并自动拼接" }, 400) };
    }
    const shot = llm.plan.shots[0];
    const target = llm.plan.target;
    const prompt = target === "image" ? shot.imagePrompt : shot.videoPrompt;
    const plan = buildCreativeAgentPlan({
      ...input,
      target,
      prompt,
      duration: shot.duration,
      promptPrepared: true,
    }, {
      videoModels: catalog.visibleVideoModels,
      imageModels: catalog.visibleImageModels,
    });
    plan.planner = { provider: llm.provider, model: llm.model, planning: "llm" };
    return { plan };
  } catch (error) {
    const status = error instanceof AgentLlmConfigurationError ? 503 : 400;
    return { errorResponse: json({ error: error instanceof Error ? error.message : "Agent 暂时无法制定生成计划" }, status) };
  }
}

async function previewAgentProjectPlan(request, runtime) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "请求内容不是有效的 JSON" }, 400);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json({ error: "请求内容必须是 JSON 对象" }, 400);
  if (input.target && input.target !== "video") return json({ error: "Agent 项目只输出视频；图片会作为中间资产自动生成" }, 400);
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) return json({ error: "请先告诉 Agent 你想创作什么" }, 400);
  if (prompt.length > 5000) return json({ error: "创作描述不能超过 5000 个字符" }, 400);
  try {
    const catalog = await getAvailableModelCatalog(runtime);
    const videoInput = { ...input, target: "video", prompt };
    const durationOptions = agentDurationOptions(catalog, videoInput);
    const llm = await callAgentLlm(videoInput, runtime, {
      durationOptions,
      clipTimings: projectClipTimings(videoInput.duration, durationOptions),
    });
    return json({
      creativePlan: llm.plan,
      display: creativePlanForDisplay(llm.plan),
      planner: { provider: llm.provider, model: llm.model, planning: "llm" },
    });
  } catch (error) {
    const status = error instanceof AgentLlmConfigurationError ? 503 : 502;
    return json({ error: error instanceof Error ? error.message : "Agent 暂时无法完成创作规划" }, status);
  }
}

function requestClientIdentifier(request, runtime) {
  return runtime.clientId
    || request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("user-agent")
    || "anonymous";
}

async function agentPlanKey(request, runtime) {
  return `state/agent-plan/${await rateLimitKey(requestClientIdentifier(request, runtime))}`;
}

async function resolveApprovedAgentPlan(request, runtime) {
  let input;
  try {
    input = await request.json();
  } catch {
    return { errorResponse: json({ error: "请求内容不是有效的 JSON" }, 400) };
  }
  const planId = typeof input?.planId === "string" ? input.planId.trim() : "";
  if (!planId) return { errorResponse: json({ error: "请先审核生成计划" }, 400) };
  if (!runtime?.storage) return { errorResponse: json({ error: "计划存储尚未配置" }, 503) };

  const stored = await runtime.storage.getJSON(await agentPlanKey(request, runtime));
  if (!stored?.plan || !sameSecret(planId, stored.planId || "")) {
    return { errorResponse: json({ error: "生成计划不存在或已被新的计划替换，请重新审核" }, 409) };
  }
  if (runtimeNow(runtime) > Number(stored.expiresAt)) {
    return { errorResponse: json({ error: "生成计划已过期，请重新审核" }, 410) };
  }
  return { plan: stored.plan };
}

async function previewAgentPlan(request, runtime) {
  const result = await resolveAgentPlan(request, runtime);
  if (result.errorResponse) return result.errorResponse;
  if (!runtime?.storage) return json({ error: "计划存储尚未配置" }, 503);
  const planId = crypto.randomUUID();
  const planKey = await agentPlanKey(request, runtime);
  await runtime.storage.setJSON(planKey, {
    planId,
    plan: result.plan,
    expiresAt: runtimeNow(runtime) + AGENT_PLAN_TTL_MS,
  });
  return json({ agentPlan: publicAgentPlan(result.plan), planId });
}

async function createAgentGeneration(request, runtime) {
  const result = await resolveApprovedAgentPlan(request, runtime);
  if (result.errorResponse) return result.errorResponse;
  const { plan } = result;

  const delegatedRequest = new Request(request.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(plan.request),
  });
  const generation = plan.kind === "video"
    ? await createVideo(delegatedRequest, runtime)
    : await createImage(delegatedRequest, runtime);
  const payload = await generation.json().catch(() => ({}));
  return json({ ...payload, agentPlan: publicAgentPlan(plan) }, generation.status);
}

async function uploadReferenceImage(request, runtime) {
  const contentType = (request.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    return json({ error: "参考图仅支持 JPG、PNG 或 WEBP" }, 415);
  }
  const image = await request.arrayBuffer();
  if (!image.byteLength || image.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
    return json({ error: "参考图大小需在 4MB 以内" }, 413);
  }
  if (runtime?.inlineReferenceImages) {
    return json({ url: `data:${contentType};base64,${encodeBase64(new Uint8Array(image))}` }, 201);
  }
  if (!runtime?.storage) return json({ error: "图片存储尚未配置" }, 503);
  const key = `uploads/${crypto.randomUUID()}.${referenceImageExtension(contentType)}`;
  const accessToken = crypto.randomUUID();
  await runtime.storage.put(key, image, {
    contentType,
    createdAt: runtimeNow(runtime),
    accessToken,
  });
  const cleanup = runtime.storage.cleanupExpired?.("uploads/", runtimeNow(runtime) - REFERENCE_IMAGE_TTL_MS);
  scheduleBackground(runtime, cleanup);
  return json({ url: referenceImageUrl(new URL(request.url).origin, key, accessToken) }, 201);
}

async function getReferenceImage(encodedKey, request, runtime) {
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
  const accessToken = new URL(request.url).searchParams.get("token") || "";
  if (!image.accessToken || !sameSecret(accessToken, image.accessToken)) return json({ error: "未找到参考图" }, 404);
  const createdAt = Number(image.createdAt) || 0;
  if (createdAt && runtimeNow(runtime) - createdAt >= REFERENCE_IMAGE_TTL_MS) {
    return json({ error: "参考图已过期" }, 404);
  }
  return new Response(image.body, {
    headers: {
      "cache-control": "private, no-store",
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

async function getSiliconFlowVideo(taskId, runtime) {
  const apiKey = runtimeEnv(runtime, "SILICONFLOW_API_KEY");
  if (!apiKey) return json({ error: "SiliconFlow 视频服务尚未配置" }, 503);
  const response = await fetchFor(runtime)(`${siliconflowBase(runtime)}/video/status`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: taskId }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: upstreamMessage(result, "SiliconFlow 视频任务状态查询失败") }, response.status || 502);
  const status = siliconFlowVideoStatus(result.status);
  const videoUrl = result?.results?.videos?.[0]?.url || result.video_url || result.url || null;
  return json({
    taskId,
    provider: "siliconflow",
    status,
    terminal: TERMINAL_STATUSES.has(status),
    videoUrl,
    progress: status === "SUCCEEDED" ? 100 : status === "RUNNING" ? 58 : 12,
    seconds: null,
    size: null,
    error: status === "FAILED" ? upstreamMessage(result, "SiliconFlow 视频生成失败") : null,
  });
}

async function getZhipuVideo(taskId, runtime) {
  const apiKey = runtimeEnv(runtime, "ZHIPU_API_KEY");
  if (!apiKey) return json({ error: "Zhipu AI 视频服务尚未配置" }, 503);
  const response = await fetchFor(runtime)(`${zhipuBase(runtime)}/async-result/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: upstreamMessage(result, "Zhipu AI 视频任务查询失败") }, response.status || 502);
  const status = zhipuTaskStatus(result.task_status || result.status);
  const video = Array.isArray(result.video_result) ? result.video_result[0] : null;
  return json({
    taskId,
    provider: ZHIPU_API_PROVIDER,
    status,
    terminal: TERMINAL_STATUSES.has(status),
    videoUrl: video?.url || result.video_url || null,
    progress: status === "SUCCEEDED" ? 100 : status === "RUNNING" ? 58 : 12,
    seconds: video?.duration || null,
    size: video?.resolution || null,
    error: status === "FAILED" ? upstreamMessage(result, "Zhipu AI 视频生成失败") : null,
  });
}

async function getZhipuImage(taskId, runtime) {
  const apiKey = runtimeEnv(runtime, "ZHIPU_API_KEY");
  if (!apiKey) return json({ error: "Zhipu AI 图片服务尚未配置" }, 503);
  const response = await fetchFor(runtime)(`${zhipuBase(runtime)}/async-result/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: upstreamMessage(result, "Zhipu AI 图片任务查询失败") }, response.status || 502);
  const imageUrls = zhipuImageUrls(result);
  const status = zhipuTaskStatus(result.task_status || result.status || (imageUrls.length ? "SUCCESS" : "PROCESSING"));
  return json({
    taskId,
    provider: ZHIPU_API_PROVIDER,
    status,
    terminal: TERMINAL_STATUSES.has(status),
    imageUrls: status === "SUCCEEDED" ? imageUrls : [],
    progress: status === "SUCCEEDED" ? 100 : status === "RUNNING" ? 58 : 12,
    size: result.size || null,
    error: status === "FAILED" ? upstreamMessage(result, "Zhipu AI 图片生成失败") : null,
  });
}

function imageUrlsFromOutput(output) {
  const legacy = Array.isArray(output?.results) ? output.results.map((item) => item?.url).filter(Boolean) : [];
  const choices = Array.isArray(output?.choices)
    ? output.choices.flatMap((choice) => choice?.message?.content || []).map((item) => item?.image).filter(Boolean)
    : [];
  return [...new Set([...legacy, ...choices])];
}

async function getDashscopeImage(taskId, runtime) {
  const apiKey = runtimeEnv(runtime, "DASHSCOPE_API_KEY");
  if (!apiKey) return json({ error: "阿里图片服务尚未配置" }, 503);
  const response = await fetchFor(runtime)(`${dashscopeBase(runtime)}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const result = await response.json().catch(() => ({}));
  const output = result?.output || {};
  if (!response.ok) return json({ error: upstreamMessage(result, "图片任务状态查询失败") }, response.status || 502);
  const status = output.task_status || "UNKNOWN";
  return json({
    taskId,
    provider: "dashscope",
    status,
    terminal: TERMINAL_STATUSES.has(status),
    imageUrls: status === "SUCCEEDED" ? imageUrlsFromOutput(output) : [],
    progress: status === "SUCCEEDED" ? 100 : status === "RUNNING" ? 58 : 12,
    size: result?.usage?.size || null,
    error: status === "FAILED" ? (output.message || result.message || "图片生成失败") : null,
  });
}

async function getAgnesVideo(taskId, videoId, runtime) {
  const apiKey = runtimeEnv(runtime, "AGNES_API_KEY");
  if (!apiKey) return json({ error: "Agnes 视频服务尚未配置" }, 503);
  const lookupId = videoId || taskId;
  const response = await fetchFor(runtime)(`${agnesRoot(runtime)}/agnesapi?video_id=${encodeURIComponent(lookupId)}`, {
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
    // Agnes returns the completed asset under metadata.url; keep the older
    // top-level field as a fallback for tasks created by earlier API versions.
    videoUrl: result.metadata?.url || result.video_url || result.remixed_from_video_id || result.url || null,
    progress: Number.isFinite(Number(result.progress)) ? Number(result.progress) : (status === "SUCCEEDED" ? 100 : null),
    seconds: result.seconds || null,
    size: result.size || null,
    error: status === "FAILED" ? (typeof result.error === "string" ? result.error : result.error?.message || "Agnes 视频生成失败") : null,
  });
}

function grokTaskStatus(status) {
  return { pending: "PENDING", done: "SUCCEEDED", failed: "FAILED", expired: "FAILED" }[status] || "UNKNOWN";
}

async function getGrokVideo(taskId, runtime) {
  const apiKey = runtimeEnv(runtime, SUB2API_GROK.envKey);
  if (!apiKey) return json({ error: "Sub2API Grok 视频服务尚未配置" }, 503);
  const response = await fetchFor(runtime)(`${sub2apiGrokBase(runtime)}/videos/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: upstreamMessage(result, "Grok 任务状态查询失败") }, response.status || 502);
  const status = grokTaskStatus(result.status);
  return json({
    taskId,
    provider: "sub2api_grok",
    status,
    terminal: ["SUCCEEDED", "FAILED", "UNKNOWN"].includes(status),
    videoUrl: result.video?.url || result.url || null,
    progress: status === "SUCCEEDED" ? 100 : status === "PENDING" ? 30 : null,
    seconds: result.video?.duration ?? result.duration ?? null,
    size: result.video?.resolution || result.resolution || null,
    error: status === "FAILED" ? upstreamMessage(result, "Grok 视频生成失败") : null,
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
  if (accessProtectionDisabled(runtime)) return null;
  const expected = runtimeEnv(runtime, "VIDEO_ACCESS_TOKEN");
  if (!expected) {
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
  const clientId = requestClientIdentifier(request, runtime);
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
      && (hostname === "aliyuncs.com"
        || hostname.endsWith(".aliyuncs.com")
        || hostname === "agnes-ai.space"
        || hostname.endsWith(".agnes-ai.space")
        || hostname === "x.ai"
        || hostname.endsWith(".x.ai")
        || hostname === "bigmodel.cn"
        || hostname.endsWith(".bigmodel.cn")
        || hostname === "chatglm.cn"
        || hostname.endsWith(".chatglm.cn")
        || hostname === "zhipuai.cn"
        || hostname.endsWith(".zhipuai.cn")
        || hostname === "siliconflow.cn"
        || hostname.endsWith(".siliconflow.cn")
        || hostname === "siliconflow.com"
        || hostname.endsWith(".siliconflow.com"));
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

async function downloadImage(request, runtime) {
  const source = new URL(request.url).searchParams.get("url") || "";
  if (!allowedDownloadUrl(source)) return json({ error: "图片下载地址无效" }, 400);
  const response = await fetchDownload(source, runtime);
  if (!response.ok || !response.body) return json({ error: "图片下载失败" }, response.status || 502);
  return new Response(response.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": 'attachment; filename="generated-image.png"',
      "content-type": response.headers.get("content-type") || "image/png",
      ...(response.headers.get("content-length") ? { "content-length": response.headers.get("content-length") } : {}),
    },
  });
}

async function createVideoComposition(request, runtime) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "请求内容不是有效的 JSON" }, 400);
  }
  const videoUrls = Array.isArray(input?.videoUrls) ? input.videoUrls.filter((value) => typeof value === "string" && value.trim()) : [];
  const requestedDuration = Number(input?.targetDuration);
  const targetDuration = Number.isFinite(requestedDuration) && requestedDuration > 0
    ? Math.min(300, Math.round(requestedDuration))
    : null;
  if (videoUrls.length < 2) return json({ error: "至少需要两段已完成的视频才能合并" }, 400);
  if (videoUrls.length > 24) return json({ error: "一次最多合并 24 段视频" }, 400);
  if (videoUrls.some((url) => !allowedDownloadUrl(url))) return json({ error: "存在不受信任的视频地址，无法合并" }, 400);
  if (typeof runtime?.composeVideos !== "function") {
    return json({ error: "当前运行环境未配置本地视频拼接器", compositionAvailable: false }, 501);
  }
  if (!runtime?.storage) return json({ error: "成片存储尚未配置" }, 503);

  const video = await runtime.composeVideos(videoUrls, { targetDuration });
  const body = video instanceof Uint8Array ? video : video instanceof ArrayBuffer ? new Uint8Array(video) : null;
  if (!body?.byteLength) return json({ error: "视频拼接器没有返回有效成片" }, 502);
  const compositionId = crypto.randomUUID();
  const accessToken = crypto.randomUUID();
  const key = `compositions/${compositionId}.mp4`;
  await runtime.storage.put(key, body, {
    contentType: "video/mp4",
    createdAt: runtimeNow(runtime),
    accessToken,
  });
  return json({
    compositionId,
    status: "SUCCEEDED",
    videoUrl: new URL(`/api/compositions/${compositionId}?token=${encodeURIComponent(accessToken)}`, request.url).href,
    clipCount: videoUrls.length,
    targetDuration,
  }, 201);
}

async function getVideoComposition(compositionId, request, runtime) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(compositionId)) return json({ error: "成片地址无效" }, 400);
  if (!runtime?.storage) return json({ error: "成片存储尚未配置" }, 503);
  const video = await runtime.storage.get(`compositions/${compositionId}.mp4`);
  if (!video?.body) return json({ error: "未找到成片" }, 404);
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!sameSecret(token, video.accessToken || "")) {
    const denied = authorizeRequest(request, runtime);
    if (denied) return denied;
  }
  return new Response(video.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": 'inline; filename="agent-final-video.mp4"',
      "content-type": video.contentType || "video/mp4",
    },
  });
}

export async function handleVideoApiRequest(request, runtime = {}) {
  const url = new URL(request.url);
  try {
    if (!url.pathname.startsWith("/api/")) return null;
    if (url.pathname === "/api/models" && request.method === "GET") return await getModelAvailability(runtime);

    const referenceMatch = url.pathname.match(/^\/api\/reference-images\/(.+)$/);
    if (referenceMatch && request.method === "GET") return await getReferenceImage(referenceMatch[1], request, runtime);

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
    if (url.pathname === "/api/images" && request.method === "POST") {
      return protectedRoute("create", () => createImage(request, runtime))();
    }
    if (url.pathname === "/api/agent/plan" && request.method === "POST") {
      return protectedRoute("plan", () => previewAgentPlan(request, runtime))();
    }
    if (url.pathname === "/api/agent/project-plan" && request.method === "POST") {
      return protectedRoute("plan", () => previewAgentProjectPlan(request, runtime))();
    }
    if (url.pathname === "/api/agent/generate" && request.method === "POST") {
      return protectedRoute("agent-create", () => createAgentGeneration(request, runtime))();
    }
    if (url.pathname === "/api/video-download" && request.method === "GET") {
      return protectedRoute("download", () => downloadVideo(request, runtime))();
    }
    if (url.pathname === "/api/image-download" && request.method === "GET") {
      return protectedRoute("download", () => downloadImage(request, runtime))();
    }
    if (url.pathname === "/api/video-compositions" && request.method === "POST") {
      return protectedRoute("create", () => createVideoComposition(request, runtime))();
    }
    const compositionMatch = url.pathname.match(/^\/api\/compositions\/([a-zA-Z0-9-]+)$/);
    if (compositionMatch && request.method === "GET") return getVideoComposition(compositionMatch[1], request, runtime);

    const taskMatch = url.pathname.match(/^\/api\/videos\/([a-zA-Z0-9_-]+)$/);
    if (taskMatch && request.method === "GET") {
      return protectedRoute("status", () => {
        const provider = url.searchParams.get("provider");
        if (provider === "agnes") return getAgnesVideo(taskMatch[1], url.searchParams.get("video_id"), runtime);
        if (provider === "sub2api_grok") return getGrokVideo(taskMatch[1], runtime);
        if (provider === ZHIPU_API_PROVIDER) return getZhipuVideo(taskMatch[1], runtime);
        if (provider === "siliconflow") return getSiliconFlowVideo(taskMatch[1], runtime);
        return getDashscopeVideo(taskMatch[1], runtime);
      })();
    }
    const imageTaskMatch = url.pathname.match(/^\/api\/images\/([a-zA-Z0-9_-]+)$/);
    if (imageTaskMatch && request.method === "GET") {
      return protectedRoute("status", () => {
        const provider = url.searchParams.get("provider");
        return provider === ZHIPU_API_PROVIDER
          ? getZhipuImage(imageTaskMatch[1], runtime)
          : getDashscopeImage(imageTaskMatch[1], runtime);
      })();
    }
    return json({ error: "未找到请求的接口" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "视频服务暂时不可用" }, 502);
  }
}
