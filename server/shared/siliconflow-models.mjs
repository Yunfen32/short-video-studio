import { FREE_SILICONFLOW_IMAGE_MODEL_IDS } from "./free-models.mjs";

const DEFAULT_SILICONFLOW_API_BASE = "https://api.siliconflow.cn/v1";
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

let catalogCache = null;

function runtimeEnv(runtime, key) {
  return runtime?.getEnv?.(key) || "";
}

function siliconflowBase(runtime) {
  return (runtimeEnv(runtime, "SILICONFLOW_API_BASE") || DEFAULT_SILICONFLOW_API_BASE).replace(/\/$/, "");
}

function modelRecords(payload) {
  if (!Array.isArray(payload?.data)) return [];
  return payload.data
    .filter((item) => item && typeof item.id === "string" && item.id.trim())
    .map((item) => ({ ...item, id: item.id.trim() }));
}

function modelFamily(id) {
  const [namespace, name] = id.split("/", 2);
  return name ? `${namespace} / ${name.split(/[-_:]/)[0]}` : id.split(/[-_:]/)[0] || id;
}

function modelLabel(id) {
  return id.includes("/") ? id.split("/").slice(-1)[0] : id;
}

function isImageToVideo(record) {
  const text = `${record.id} ${record.sub_type || ""}`.toLowerCase();
  return text.includes("image-to-video") || /(^|[-_:])i2v([-_:]|$)/i.test(text) || text.includes("img2video");
}

function isTextToVideo(record) {
  const text = `${record.id} ${record.sub_type || ""}`.toLowerCase();
  return text.includes("text-to-video") || /(^|[-_:])t2v([-_:]|$)/i.test(text) || text.includes("text2video");
}

function isImageToImage(record) {
  const text = `${record.id} ${record.sub_type || ""}`.toLowerCase();
  return text.includes("image-to-image")
    || text.includes("image-edit")
    || text.includes("imageedit")
    || text.includes("kolors");
}

function capability(fields = {}) {
  return {
    imageMin: 0,
    imageMax: 0,
    imageMode: "none",
    videoMode: "none",
    audioMode: "none",
    promptOptional: false,
    requiresAnyReference: false,
    referenceTotalMax: 0,
    durationWithVideoMax: 0,
    durationMode: "output",
    ratioOptions: VIDEO_RATIOS,
    supportsWatermark: false,
    supportsPromptExtend: false,
    supportsNegativePrompt: true,
    supportsSeed: true,
    supportsAudioSetting: false,
    outputAudio: false,
    ...fields,
  };
}

export function buildSiliconFlowVideoModel(record) {
  const imageToVideo = isImageToVideo(record);
  const textToVideo = isTextToVideo(record);
  if (!textToVideo && !imageToVideo) return null;
  const workflows = {};
  if (textToVideo) workflows["text-to-video"] = capability();
  if (imageToVideo) {
    workflows["first-frame"] = capability({
      imageMin: 1,
      imageMax: 1,
      imageMode: "first_frame",
      promptOptional: true,
    });
  }
  const family = modelFamily(record.id);
  return {
    id: record.id,
    label: `SiliconFlow ${modelLabel(record.id)}`,
    family,
    familyLabel: family,
    variantLabel: record.id,
    provider: "siliconflow",
    providerLabel: "SiliconFlow",
    category: imageToVideo && !textToVideo ? "image" : "text",
    protocol: "siliconflowVideo",
    dynamic: true,
    isFree: false,
    featured: false,
    summary: imageToVideo && !textToVideo ? "首帧图生视频" : "文生视频",
    supportsAudio: false,
    outputAudio: false,
    durations: [5],
    resolutions: ["720P"],
    ratios: true,
    ratioOptions: VIDEO_RATIOS,
    imageMin: imageToVideo ? 1 : 0,
    imageMax: imageToVideo ? 1 : 0,
    workflowCapabilities: workflows,
  };
}

export function buildSiliconFlowImageModel(record) {
  const imageEdit = isImageToImage(record);
  const family = modelFamily(record.id);
  const isFree = FREE_SILICONFLOW_IMAGE_MODEL_IDS.includes(record.id);
  return {
    id: record.id,
    label: `SiliconFlow ${modelLabel(record.id)}`,
    family,
    familyLabel: family,
    variantLabel: record.id,
    provider: "siliconflow",
    providerLabel: "SiliconFlow",
    protocol: "siliconflowImage",
    dynamic: true,
    isFree,
    billingLabel: isFree ? "免费" : "付费",
    featured: false,
    summary: imageEdit ? "文生图与参考图编辑" : "文生图",
    workflows: imageEdit ? ["text-to-image", "image-edit"] : ["text-to-image"],
    qualities: ["1K"],
    qualitySizes: { "1K": "1024x1024" },
    maxOutputs: /kolors/i.test(record.id) ? 4 : 1,
    maxInputImages: imageEdit ? 3 : 0,
    editMaxQuality: "1K",
  };
}

async function fetchModelType(runtime, type) {
  const apiKey = runtimeEnv(runtime, "SILICONFLOW_API_KEY");
  if (!apiKey) return { models: [], error: null };
  const fetcher = runtime?.fetch || globalThis.fetch;
  try {
    const response = await fetcher(`${siliconflowBase(runtime)}/models?type=${encodeURIComponent(type)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { models: [], error: payload?.message || payload?.error?.message || `SiliconFlow ${type} 模型目录读取失败` };
    }
    return { models: modelRecords(payload), error: null };
  } catch {
    return { models: [], error: `SiliconFlow ${type} 模型目录暂时无法读取` };
  }
}

export async function getSiliconFlowCatalog(runtime, { force = false } = {}) {
  const apiKey = runtimeEnv(runtime, "SILICONFLOW_API_KEY");
  if (!apiKey) return { configured: false, videoModels: [], imageModels: [], error: null };
  const base = siliconflowBase(runtime);
  const now = Number(runtime?.now?.() ?? Date.now());
  if (!force && catalogCache && catalogCache.base === base && catalogCache.expiresAt > now) return catalogCache.value;

  const [videoResult, imageResult] = await Promise.all([
    fetchModelType(runtime, "video"),
    fetchModelType(runtime, "image"),
  ]);
  const value = {
    configured: true,
    videoModels: videoResult.models.map(buildSiliconFlowVideoModel).filter(Boolean),
    imageModels: imageResult.models.map(buildSiliconFlowImageModel),
    error: videoResult.error || imageResult.error || null,
  };
  catalogCache = { base, expiresAt: now + MODEL_CACHE_TTL_MS, value };
  return value;
}

export async function getSiliconFlowVideoModel(id, runtime) {
  const catalog = await getSiliconFlowCatalog(runtime);
  return catalog.videoModels.find((model) => model.id === id) || null;
}

export async function getSiliconFlowImageModel(id, runtime) {
  const catalog = await getSiliconFlowCatalog(runtime);
  return catalog.imageModels.find((model) => model.id === id) || null;
}

export function siliconFlowVideoSize(ratio = "16:9") {
  return {
    "16:9": "1280x720",
    "9:16": "720x1280",
    "1:1": "1024x1024",
    "4:3": "1280x960",
    "3:4": "960x1280",
  }[ratio] || "1280x720";
}

export function buildSiliconFlowVideoRequest(model, data, imageSource = "") {
  return {
    model: model.id,
    prompt: data.prompt || "让画面自然运动起来",
    image_size: siliconFlowVideoSize(data.ratio),
    ...(data.negativePrompt ? { negative_prompt: data.negativePrompt } : {}),
    ...(data.seed !== null ? { seed: data.seed } : {}),
    ...(imageSource ? { image: imageSource } : {}),
  };
}

export function buildSiliconFlowImageRequest(model, data) {
  const payload = {
    model: model.id,
    prompt: data.prompt,
    image_size: model.qualitySizes?.[data.quality] || "1024x1024",
    ...(model.maxOutputs > 1 && data.count > 1 ? { batch_size: data.count } : {}),
  };
  for (const [index, source] of data.images.entries()) {
    payload[index === 0 ? "image" : `image${index + 1}`] = source;
  }
  return payload;
}

export function siliconFlowImageUrls(payload) {
  const items = Array.isArray(payload?.images) ? payload.images : [];
  return items.map((item) => typeof item === "string" ? item : item?.url).filter(Boolean);
}

export function siliconFlowVideoStatus(status) {
  return {
    Succeed: "SUCCEEDED",
    Succeeded: "SUCCEEDED",
    InQueue: "PENDING",
    InProgress: "RUNNING",
    Failed: "FAILED",
  }[status] || "UNKNOWN";
}

export { DEFAULT_SILICONFLOW_API_BASE };
