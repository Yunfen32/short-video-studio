import { supportsImageWorkflow } from "./image-models.mjs";
import { getModelsForWorkflow, getWorkflowCapability } from "./video-models.mjs";

const TARGETS = new Set(["image", "video"]);
const SOURCES = new Set(["inspiration", "script"]);
const VISUAL_STYLES = new Set(["2D 动漫", "电影感", "写实质感", "产品展示"]);
const RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const IMAGE_WORKFLOW = "text-to-image";

function text(value, maxLength = 5000) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maxLength) : "";
}

/** 保留提示词分段，避免三段式视频提示词在执行前被压平成一行。 */
function promptText(value, maxLength = 5000) {
  return typeof value === "string"
    ? value.trim().replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").slice(0, maxLength)
    : "";
}

function list(value, maxItems = 24) {
  return (Array.isArray(value) ? value : []).slice(0, maxItems);
}

function preferredModel(models, { preferLongestDuration = false } = {}) {
  if (preferLongestDuration) {
    return models.reduce((best, model) => {
      if (!best) return model;
      const bestMax = Math.max(...(best.durations || [0]));
      const modelMax = Math.max(...(model.durations || [0]));
      if (modelMax !== bestMax) return modelMax > bestMax ? model : best;
      if (model.featured !== best.featured) return model.featured ? model : best;
      return best;
    }, null);
  }
  return models.find((model) => model.featured) || models[0] || null;
}

function cleanSource(value) {
  return SOURCES.has(value) ? value : "inspiration";
}

function cleanStyle(value) {
  return VISUAL_STYLES.has(value) ? value : "2D 动漫";
}

function cleanRatio(value) {
  return RATIOS.has(value) ? value : "9:16";
}

function requestedDuration(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(300, Math.round(parsed)) : 5;
}

function chooseDuration(model, preferred) {
  if (!model?.durations?.length) return preferred;
  if (model.durations.includes(preferred)) return preferred;
  const lower = model.durations.filter((duration) => duration <= preferred).sort((a, b) => b - a)[0];
  return lower ?? model.durations[0];
}

function normalizeImages(value) {
  return list(value, 4)
    .filter((item) => item && typeof item === "object" && typeof item.source === "string" && item.source.trim())
    .map((item, index) => ({
      source: item.source.trim(),
      role: typeof item.role === "string" && item.role.trim() ? item.role.trim() : (index === 0 ? "first_frame" : "reference"),
    }));
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
  const model = preferredModel(imageModels.filter((item) => supportsImageWorkflow(item, IMAGE_WORKFLOW)));
  if (!model) throw new Error("当前没有可用于文生图的模型");
  const quality = model.qualities.includes("2K") ? "2K" : model.qualities[0];
  const request = {
    model: model.id,
    workflow: IMAGE_WORKFLOW,
    prompt: promptText(prompt, 5000),
    quality,
    count: 1,
    watermark: false,
    images: [],
  };
  return {
    kind: "image",
    workflow: IMAGE_WORKFLOW,
    modelId: model.id,
    modelLabel: model.label,
    provider: model.provider,
    summary: `文生图 → ${model.familyLabel || model.family} → ${quality}`,
    brief: planBrief(input, "image", request),
    request,
  };
}

function createVideoPlan(prompt, input, videoModels) {
  const wantsReference = normalizeImages(input.images).length > 0;
  const requestedWorkflow = wantsReference ? "first-frame" : "text-to-video";
  const candidates = getModelsForWorkflow(requestedWorkflow, videoModels);
  const workflow = candidates.length ? requestedWorkflow : "text-to-video";
  const model = preferredModel(getModelsForWorkflow(workflow, videoModels), {
    preferLongestDuration: input.preferLongestDuration === true,
  });
  if (!model) throw new Error(`当前没有可用于${requestedWorkflow === "first-frame" ? "图生视频" : "文生视频"}的模型`);
  const duration = chooseDuration(model, requestedDuration(input.duration));
  const capability = getWorkflowCapability(model, workflow);
  const requestedRatio = cleanRatio(input.ratio);
  const ratio = capability?.ratioOptions?.includes(requestedRatio)
    ? requestedRatio
    : (capability?.ratioOptions?.[0] || requestedRatio);
  const request = {
    model: model.id,
    workflow,
    prompt: promptText(prompt, 5000),
    ratio,
    duration,
    resolution: model.resolutions.includes("720P") ? "720P" : model.resolutions[0],
    watermark: false,
    promptExtend: true,
    negativePrompt: "",
    seed: null,
    images: workflow === "first-frame" ? normalizeImages(input.images) : [],
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
    summary: `${workflow === "first-frame" ? "图生视频" : "文生视频"} → ${model.familyLabel || model.family} → ${duration} 秒 / ${ratio}`,
    brief: planBrief(input, "video", request),
    request,
  };
}

/** 将 LLM 已经写好的提示词绑定到实际模型能力，不再按关键词猜测创作意图。 */
export function buildCreativeAgentPlan(input = {}, catalog = {}) {
  const prompt = promptText(input.prompt);
  if (!prompt) throw new Error("请先告诉 Agent 你想创作什么");
  if (prompt.length > 5000) throw new Error("创作描述不能超过 5000 个字符");
  const target = typeof input.target === "string" ? input.target : "video";
  if (!TARGETS.has(target)) throw new Error("生成目标仅支持视频；图片仅可作为视频生成的中间资产");
  if (target === "image" && input.assetRole !== "intermediate") {
    throw new Error("Agent 只输出视频；图片仅可作为视频生成的中间资产");
  }
  if (input.promptPrepared !== true) throw new Error("媒体执行计划必须由服务端 LLM 准备完成");
  const videoModels = Array.isArray(catalog.videoModels) ? catalog.videoModels : [];
  const imageModels = Array.isArray(catalog.imageModels) ? catalog.imageModels : [];
  return target === "video"
    ? createVideoPlan(prompt, input, videoModels)
    : createImagePlan(prompt, input, imageModels);
}

function cleanId(value, fallback) {
  const normalized = text(value, 80).replace(/[^\w-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || fallback;
}

function normalizeCharacter(item, index) {
  return {
    id: cleanId(item?.id, `character-${index + 1}`),
    name: text(item?.name, 120) || `人物 ${index + 1}`,
    role: text(item?.role, 240),
    appearance: text(item?.appearance, 1200),
    wardrobe: text(item?.wardrobe, 600),
    personality: text(item?.personality, 600),
    continuityNotes: text(item?.continuityNotes, 800),
    imagePrompt: text(item?.imagePrompt, 3000),
  };
}

function normalizeScene(item, index) {
  return {
    id: cleanId(item?.id, `scene-${index + 1}`),
    name: text(item?.name, 120) || `场景 ${index + 1}`,
    description: text(item?.description, 1200),
    lighting: text(item?.lighting, 500),
    palette: text(item?.palette, 500),
    continuityNotes: text(item?.continuityNotes, 800),
    imagePrompt: text(item?.imagePrompt, 3000),
  };
}

function normalizeShot(item, index, target) {
  const duration = Number.isFinite(Number(item?.duration)) ? Math.round(Number(item.duration)) : 5;
  const timelineDuration = Number.isFinite(Number(item?.timelineDuration)) ? Math.round(Number(item.timelineDuration)) : duration;
  const imagePrompt = promptText(item?.imagePrompt, 4000);
  const videoPrompt = promptText(item?.videoPrompt, 5000) || imagePrompt;
  return {
    id: cleanId(item?.id, `shot-${index + 1}`),
    title: text(item?.title, 160) || `镜头 ${String(index + 1).padStart(2, "0")}`,
    duration,
    timelineDuration,
    sceneId: cleanId(item?.sceneId, "scene-1"),
    characterIds: list(item?.characterIds, 8).map((id) => cleanId(id, "")).filter(Boolean),
    storyBeat: text(item?.storyBeat, 600),
    visualDescription: text(item?.visualDescription, 1600),
    action: text(item?.action, 1200),
    camera: text(item?.camera, 800),
    transition: text(item?.transition, 500),
    audio: text(item?.audio, 800),
    imagePrompt,
    videoPrompt: target === "image" ? imagePrompt : videoPrompt,
  };
}

function hasThreePartVideoPrompt(value) {
  const prompt = promptText(value, 5000);
  const sections = ["【素材引用】", "【分段镜头】", "【风格画质+约束】"];
  let position = -1;
  for (const section of sections) {
    const next = prompt.indexOf(section);
    if (next <= position) return false;
    position = next;
  }
  return true;
}

/**
 * LLM 负责镜头内容；若供应商忽略格式标题，只补齐交付给视频模型的三段式外壳。
 * 这不是重新规划，原始镜头描述仍完整保留在“分段镜头”中。
 */
function formatVideoPrompt(shot, scene, characters, { style, ratio }) {
  if (hasThreePartVideoPrompt(shot.videoPrompt)) return shot.videoPrompt;
  const references = [
    scene ? `@场景图1 ${[scene.name, scene.description, scene.lighting, scene.continuityNotes].filter(Boolean).join('，')}。` : "",
    ...characters.map((character, index) => `@角色${index + 1} ${[character.name, character.role, character.appearance, character.wardrobe, character.continuityNotes].filter(Boolean).join('，')}。`),
  ].filter(Boolean).join("\n");
  const rawPrompt = promptText(shot.videoPrompt, 5000)
    .replace(/【素材引用】|【分段镜头】|【风格画质\+约束】/g, "")
    .trim();
  const storyboard = [rawPrompt, shot.visualDescription, shot.action, shot.camera, shot.audio ? `环境音：${shot.audio}` : ""]
    .filter(Boolean).join("；");
  return [
    "【素材引用】",
    references || "@场景图1 使用本镜头场景设定。",
    "",
    "【分段镜头】",
    `0-${shot.timelineDuration}秒，${storyboard || "按照分镜完成连贯的角色动作与镜头运动。"}`,
    "",
    "【风格画质+约束】",
    `${style}风格，${ratio}画幅，电影级光影与高分辨率画质。人物外观与场景连续稳定，人体结构正常，动作自然流畅；无字幕、无水印、无额外人物、无重复人物、无闪烁。`,
  ].join("\n");
}

export function normalizeCreativePlan(raw, input = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("LLM 没有返回有效的创作方案");
  const requestedTarget = input.target === "image" || input.target === "video" ? input.target : null;
  if (requestedTarget && raw.target && raw.target !== requestedTarget) {
    throw new Error("LLM 返回的生成目标与用户选择不一致");
  }
  const target = requestedTarget || (raw.target === "image" || raw.target === "video" ? raw.target : null);
  if (!target) throw new Error("LLM 没有明确生成目标");
  const requested = requestedDuration(input.duration);
  const characters = list(raw.characters, 16).map(normalizeCharacter);
  const scenes = list(raw.scenes, 16).map(normalizeScene);
  const shots = list(raw.shots, 48).map((item, index) => normalizeShot(item, index, target));
  if (!shots.length) throw new Error("LLM 没有生成分镜");
  if (!scenes.length) throw new Error("LLM 没有提取场景");
  if (target === "video") {
    const durationOptions = Array.isArray(input.durationOptions) ? input.durationOptions.map(Number).filter(Number.isFinite) : [];
    const maxClipDuration = durationOptions.length ? Math.max(...durationOptions) : Math.max(2, Number(input.maxClipDuration) || 60);
    const invalidIndex = shots.findIndex((shot) => shot.duration < 2 || shot.duration > maxClipDuration || shot.timelineDuration < 1 || shot.timelineDuration > shot.duration || (durationOptions.length && !durationOptions.includes(shot.duration)));
    if (invalidIndex >= 0) {
      const invalid = shots[invalidIndex];
      const reasons = [
        invalid.duration < 2 || invalid.duration > maxClipDuration ? `生成时长 ${invalid.duration} 秒超出范围` : "",
        durationOptions.length && !durationOptions.includes(invalid.duration) ? `生成时长必须是 ${durationOptions.join('、')} 秒之一` : "",
        invalid.timelineDuration < 1 || invalid.timelineDuration > invalid.duration ? `成片保留时长 ${invalid.timelineDuration} 秒无效` : "",
      ].filter(Boolean);
      throw new Error(`第 ${invalidIndex + 1} 个分镜不符合模型约束：${reasons.join('；')}`);
    }
    const clipTimings = list(input.clipTimings, 48);
    if (clipTimings.length && (clipTimings.length !== shots.length || clipTimings.some((timing, index) => (
      Number(timing?.duration) !== shots[index].duration || Number(timing?.timelineDuration) !== shots[index].timelineDuration
    )))) {
      throw new Error("LLM 没有遵守本次生成的镜头时长拆分方案");
    }
    const total = shots.reduce((sum, shot) => sum + shot.timelineDuration, 0);
    if (total !== requested) throw new Error(`LLM 分镜时长合计为 ${total} 秒，应为用户选择的 ${requested} 秒`);
  }
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const characterIds = new Set(characters.map((character) => character.id));
  const fixedShots = shots.map((shot) => ({
    ...shot,
    sceneId: sceneIds.has(shot.sceneId) ? shot.sceneId : scenes[0].id,
    characterIds: shot.characterIds.filter((id) => characterIds.has(id)),
  })).map((shot) => ({
    ...shot,
    videoPrompt: target === "video"
      ? formatVideoPrompt(
        shot,
        scenes.find((scene) => scene.id === shot.sceneId),
        characters.filter((character) => shot.characterIds.includes(character.id)),
        { style: cleanStyle(input.style), ratio: cleanRatio(input.ratio) },
      )
      : shot.videoPrompt,
  }));
  if (target === "video" && fixedShots.some((shot) => !hasThreePartVideoPrompt(shot.videoPrompt))) {
    throw new Error("无法整理出完整的三段式视频提示词");
  }
  return {
    version: 1,
    target,
    source: cleanSource(input.source),
    style: cleanStyle(input.style),
    ratio: cleanRatio(input.ratio),
    duration: target === "video" ? requested : null,
    title: text(raw.title, 120) || "未命名创作项目",
    logline: text(raw.logline, 1200),
    story: text(raw.story, 5000),
    creativeDirection: text(raw.creativeDirection, 1500),
    planningSummary: text(raw.planningSummary, 1200),
    characters,
    scenes,
    shots: fixedShots,
  };
}

export function createProjectPlanPrompt(input = {}, { maxClipDuration = 15, durationOptions = [], clipTimings = [] } = {}) {
  const target = TARGETS.has(input.target) ? input.target : "auto";
  const duration = requestedDuration(input.duration);
  const timingInstruction = clipTimings.length
    ? `本次已根据模型最大单次生成时长安排好镜头：${clipTimings.map((timing, index) => `镜头${index + 1}=生成${timing.duration}秒、成片保留${timing.timelineDuration}秒`).join('；')}。shots 必须按该顺序、数量和两个时长字段原样返回；最后一段如生成时长大于成片保留时长，会在拼接时自动裁切。`
    : durationOptions.length
      ? `视频每个分镜的 duration 只能从 ${durationOptions.join('、')} 秒中选择，所有分镜的 timelineDuration 之和必须严格等于总时长；总时长超过单段上限时拆成多个连续镜头，后续会按顺序拼接。`
      : `视频每个分镜必须是 2-${Math.min(60, maxClipDuration)} 秒，所有分镜的 timelineDuration 之和必须严格等于总时长；总时长超过单段上限时拆成多个连续镜头，后续会按顺序拼接。`;
  return [
    "用户创作请求：",
    promptText(input.prompt, 5000),
    "",
    `用户选择：生成目标=${target}；视觉风格=${cleanStyle(input.style)}；画面比例=${cleanRatio(input.ratio)}；总时长=${duration}秒。`,
    timingInstruction,
    `来源=${cleanSource(input.source)}。请把已有剧本中的人物和场景抽取出来，并为每个镜头分别写图片提示词 imagePrompt 与视频提示词 videoPrompt。videoPrompt 必须严格按三段式输出并保留换行：第一段以“【素材引用】”开始，按 @场景图1、@角色1、@角色2……列出本镜头涉及的场景与人物及其身份、外观或连续性；用户剧本明确出现关键道具时同样用 @道具1、@道具2……列出。第二段以“【分段镜头】”开始，用“0-X秒”连续描述本镜头内的景别、机位、动作、人物台词和环境音，X 必须等于 timelineDuration。第三段以“【风格画质+约束】”开始，写入用户选择的风格、比例、光影、画质、角色稳定性及负面约束。不要遗漏任何一个段落，也不要把三段合并成一段。`,
  ].join("\n");
}

export const CREATIVE_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "target", "logline", "story", "creativeDirection", "planningSummary", "characters", "scenes", "shots"],
  properties: {
    title: { type: "string" },
    target: { type: "string", enum: ["image", "video"] },
    logline: { type: "string" },
    story: { type: "string" },
    creativeDirection: { type: "string" },
    planningSummary: { type: "string" },
    characters: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "role", "appearance", "wardrobe", "personality", "continuityNotes", "imagePrompt"], properties: { id: { type: "string" }, name: { type: "string" }, role: { type: "string" }, appearance: { type: "string" }, wardrobe: { type: "string" }, personality: { type: "string" }, continuityNotes: { type: "string" }, imagePrompt: { type: "string" } } } },
    scenes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name", "description", "lighting", "palette", "continuityNotes", "imagePrompt"], properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, lighting: { type: "string" }, palette: { type: "string" }, continuityNotes: { type: "string" }, imagePrompt: { type: "string" } } } },
    shots: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["id", "title", "duration", "timelineDuration", "sceneId", "characterIds", "storyBeat", "visualDescription", "action", "camera", "transition", "audio", "imagePrompt", "videoPrompt"], properties: { id: { type: "string" }, title: { type: "string" }, duration: { type: "integer" }, timelineDuration: { type: "integer" }, sceneId: { type: "string" }, characterIds: { type: "array", items: { type: "string" } }, storyBeat: { type: "string" }, visualDescription: { type: "string" }, action: { type: "string" }, camera: { type: "string" }, transition: { type: "string" }, audio: { type: "string" }, imagePrompt: { type: "string" }, videoPrompt: { type: "string" } } } },
  },
};

export function creativePlanForDisplay(plan) {
  if (!plan) return null;
  return {
    title: plan.title,
    target: plan.target,
    logline: plan.logline,
    planningSummary: plan.planningSummary,
    characterCount: plan.characters?.length || 0,
    sceneCount: plan.scenes?.length || 0,
    shotCount: plan.shots?.length || 0,
    duration: plan.duration,
  };
}
