import { supportsImageWorkflow } from "./image-models.mjs";
import { getModelsForWorkflow, getWorkflowCapability } from "./video-models.mjs";

const TARGETS = new Set(["auto", "image", "video"]);
const SOURCES = new Set(["inspiration", "script"]);
const VISUAL_STYLES = new Set(["2D 动漫", "电影感", "写实质感", "产品展示"]);
const RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const VIDEO_CUES = /视频|短片|动画|镜头|运动|移动|平移|推镜|拉镜|摇镜|跟随|转场|动作|飞过|走过|跑过|舞动|秒/;
const IMAGE_CUES = /图片|图像|海报|插画|封面|头像|壁纸|画面|摄影/;

function cleanPrompt(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function preferredModel(models) {
  return models.find((model) => model.featured) || models[0] || null;
}

function chooseTarget(target, prompt) {
  if (target === "image" || target === "video") return target;
  const videoMatch = VIDEO_CUES.test(prompt);
  const imageMatch = IMAGE_CUES.test(prompt);
  if (videoMatch && !imageMatch) return "video";
  if (imageMatch && !videoMatch) return "image";
  return videoMatch ? "video" : "image";
}

function requestedRatio(prompt) {
  if (/横屏|横向|16\s*[:：]\s*9|宽画幅/.test(prompt)) return "16:9";
  if (/方形|正方形|1\s*[:：]\s*1/.test(prompt)) return "1:1";
  return "9:16";
}

function chooseVideoRatio(model, workflow, prompt, preferredRatio) {
  const ratios = getWorkflowCapability(model, workflow)?.ratioOptions || model.ratioOptions || [];
  const preferred = preferredRatio || requestedRatio(prompt);
  return ratios.includes(preferred) ? preferred : (ratios[0] || "16:9");
}

function withGuidance(prompt, guidance) {
  const ending = /[。！？.!?]$/.test(prompt) ? "" : "。";
  return `${prompt}${ending}${guidance}`;
}

function cleanSource(value) {
  return SOURCES.has(value) ? value : "inspiration";
}

function cleanStyle(value) {
  return VISUAL_STYLES.has(value) ? value : "2D 动漫";
}

function cleanRatio(value) {
  return RATIOS.has(value) ? value : "";
}

function requestedDuration(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5;
}

function chooseDuration(model, preferred) {
  return model.durations.includes(preferred)
    ? preferred
    : (model.durations.includes(5) ? 5 : model.durations[0]);
}

function promptWithDirection(prompt, style, guidance) {
  return withGuidance(
    withGuidance(prompt, `视觉风格为${style}。`),
    guidance,
  );
}

function planBrief(input, kind, request) {
  return {
    source: cleanSource(input.source),
    style: cleanStyle(input.style),
    ratio: kind === "video" ? request.ratio : "",
    duration: kind === "video" ? request.duration : null,
  };
}

function createImagePlan(prompt, input, imageModels) {
  const model = preferredModel(imageModels.filter((item) => supportsImageWorkflow(item, "text-to-image")));
  if (!model) throw new Error("当前没有可用于文生图的模型");
  const quality = model.qualities.includes("2K") ? "2K" : model.qualities[0];
  const request = {
    model: model.id,
    workflow: "text-to-image",
    prompt: promptWithDirection(prompt, cleanStyle(input.style), "主体清晰，构图完整，层次分明，保留与主题一致的细节。"),
    quality,
    count: 1,
    watermark: false,
    images: [],
  };
  return {
    kind: "image",
    workflow: "text-to-image",
    modelId: model.id,
    modelLabel: model.label,
    provider: model.provider,
    summary: `文生图 → ${model.familyLabel || model.family} → ${quality}`,
    brief: planBrief(input, "image", request),
    request,
  };
}

function createVideoPlan(prompt, input, videoModels) {
  const workflow = "text-to-video";
  const model = preferredModel(getModelsForWorkflow(workflow, videoModels));
  if (!model) throw new Error("当前没有可用于文生视频的模型");
  const duration = chooseDuration(model, requestedDuration(input.duration));
  const resolution = model.resolutions.includes("720P") ? "720P" : model.resolutions[0];
  const ratio = chooseVideoRatio(model, workflow, prompt, cleanRatio(input.ratio));
  const request = {
    model: model.id,
    workflow,
    prompt: promptWithDirection(prompt, cleanStyle(input.style), "主体清晰，动作自然，镜头运动连贯，画面稳定。"),
    ratio,
    duration,
    resolution,
    watermark: false,
    promptExtend: true,
    negativePrompt: "",
    seed: null,
    images: [],
    audioUrl: "",
    videoUrl: "",
    animationMode: "wan-std",
    audioSetting: "auto",
  };
  return {
    kind: "video",
    workflow,
    modelId: model.id,
    modelLabel: model.label,
    provider: model.provider,
    summary: `文生视频 → ${model.familyLabel || model.family} → ${duration} 秒 / ${resolution}`,
    brief: planBrief(input, "video", request),
    request,
  };
}

export function buildCreativeAgentPlan(input = {}, catalog = {}) {
  const prompt = cleanPrompt(input.prompt);
  if (!prompt) throw new Error("请先告诉 Agent 你想创作什么");
  if (prompt.length > 5000) throw new Error("创作描述不能超过 5000 个字符");
  const target = typeof input.target === "string" ? input.target : "auto";
  if (!TARGETS.has(target)) throw new Error("生成目标仅支持自动、图片或视频");
  const kind = chooseTarget(target, prompt);
  return kind === "video"
    ? createVideoPlan(prompt, input, Array.isArray(catalog.videoModels) ? catalog.videoModels : [])
    : createImagePlan(prompt, input, Array.isArray(catalog.imageModels) ? catalog.imageModels : []);
}

