const integerRange = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);
const TEXT_DURATIONS = integerRange(2, 15);
const REFERENCE_DURATIONS = integerRange(2, 10);
const HAPPYHORSE_DURATIONS = integerRange(3, 15);
const AGNES_DURATIONS = integerRange(3, 18);
const VIDEO_RESOLUTIONS = ["720P", "1080P"];
const STANDARD_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];
const HAPPYHORSE_RATIOS = [...STANDARD_RATIOS, "4:5", "5:4", "9:21", "21:9"];

export const VIDEO_MODEL_CATEGORIES = [
  { id: "text", label: "文生视频" },
  { id: "image", label: "图生视频" },
  { id: "reference", label: "参考生视频" },
  { id: "edit", label: "编辑 / 动画" },
];

export const VIDEO_WORKFLOW_GROUPS = [
  { id: "text", label: "文字创作", workflowIds: ["text-to-video"] },
  { id: "image", label: "图片驱动", workflowIds: ["first-frame", "first-last-frame", "keyframes"] },
  { id: "reference", label: "参考一致性", workflowIds: ["multi-reference"] },
  { id: "video", label: "视频再创作", workflowIds: ["video-continuation", "video-edit", "motion-transfer", "character-replace"] },
];

export const VIDEO_WORKFLOWS = [
  {
    id: "text-to-video",
    groupId: "text",
    label: "文生视频",
    summary: "只用文字描述生成完整视频",
    inputLabel: "视频描述",
  },
  {
    id: "first-frame",
    groupId: "image",
    label: "首帧驱动",
    summary: "图片作为视频起始画面",
    inputLabel: "首帧图 + 视频描述",
  },
  {
    id: "first-last-frame",
    groupId: "image",
    label: "首尾帧",
    summary: "在指定的开始与结束画面之间生成过渡",
    inputLabel: "首帧图 + 尾帧图 + 视频描述",
  },
  {
    id: "keyframes",
    groupId: "image",
    label: "多关键帧",
    summary: "按上传顺序连接多个关键画面",
    inputLabel: "2-5 个关键帧 + 视频描述",
  },
  {
    id: "multi-reference",
    groupId: "reference",
    label: "多图参考",
    summary: "全程参考人物外观或背景场景",
    inputLabel: "人物 / 背景参考 + 视频描述",
  },
  {
    id: "video-continuation",
    groupId: "video",
    label: "视频续写",
    summary: "从已有视频继续生成，可指定结束画面",
    inputLabel: "起始视频 + 可选尾帧 + 视频描述",
  },
  {
    id: "video-edit",
    groupId: "video",
    label: "指令编辑",
    summary: "按照文字和参考图修改已有视频",
    inputLabel: "原视频 + 可选参考图 + 编辑描述",
  },
  {
    id: "motion-transfer",
    groupId: "video",
    label: "动作迁移",
    summary: "用动作视频驱动图片中的人物",
    inputLabel: "人物图 + 动作视频",
  },
  {
    id: "character-replace",
    groupId: "video",
    label: "角色替换",
    summary: "保留原视频动作与场景并替换人物",
    inputLabel: "替换人物图 + 原视频",
  },
];

const MODEL_CATALOG = [
  {
    id: "wan2.7-t2v",
    label: "万相 2.7 文生视频",
    family: "Wan 2.7",
    provider: "dashscope",
    category: "text",
    protocol: "t2v",
    featured: true,
    supportsAudio: true,
    durations: TEXT_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    summary: "有声、多镜头、声画同步",
  },
  {
    id: "wan2.7-t2v-2026-06-12",
    label: "万相 2.7 文生视频 06-12",
    family: "Wan 2.7",
    provider: "dashscope",
    category: "text",
    protocol: "t2v",
    supportsAudio: true,
    durations: TEXT_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    summary: "固定版本 2026-06-12",
  },
  {
    id: "wan2.7-t2v-2026-04-25",
    label: "万相 2.7 文生视频 04-25",
    family: "Wan 2.7",
    provider: "dashscope",
    category: "text",
    protocol: "t2v",
    supportsAudio: true,
    durations: TEXT_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    summary: "固定版本 2026-04-25",
  },
  {
    id: "wan2.6-t2v",
    label: "万相 2.6 文生视频",
    family: "Wan 2.6",
    provider: "dashscope",
    category: "text",
    protocol: "t2vLegacy",
    supportsAudio: true,
    durations: TEXT_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    summary: "有声、多镜头叙事",
  },
  {
    id: "wan2.5-t2v-preview",
    label: "万相 2.5 文生视频",
    family: "Wan 2.5",
    provider: "dashscope",
    category: "text",
    protocol: "t2vLegacy",
    supportsAudio: true,
    durations: [5, 10],
    resolutions: ["480P", "720P", "1080P"],
    ratios: true,
    summary: "有声、5 或 10 秒",
  },
  {
    id: "wan2.2-t2v-plus",
    label: "万相 2.2 文生视频 Plus",
    family: "Wan 2.2",
    provider: "dashscope",
    category: "text",
    protocol: "t2vLegacy",
    durations: [5],
    resolutions: ["480P", "1080P"],
    ratios: true,
    summary: "稳定增强、无音频",
  },
  {
    id: "wanx2.1-t2v-turbo",
    label: "万相 2.1 文生视频 Turbo",
    family: "Wan 2.1",
    provider: "dashscope",
    category: "text",
    protocol: "t2vLegacy",
    durations: [5],
    resolutions: ["480P", "720P"],
    ratios: true,
    summary: "快速生成、无音频",
  },
  {
    id: "wanx2.1-t2v-plus",
    label: "万相 2.1 文生视频 Plus",
    family: "Wan 2.1",
    provider: "dashscope",
    category: "text",
    protocol: "t2vLegacy",
    durations: [5],
    resolutions: ["720P"],
    ratios: true,
    summary: "质量增强、无音频",
  },
  ...["1.1", "1.0"].map((version) => ({
    id: `happyhorse-${version}-t2v`,
    label: `HappyHorse ${version} 文生视频`,
    family: "HappyHorse",
    provider: "dashscope",
    category: "text",
    protocol: "happyhorseT2v",
    featured: version === "1.1",
    outputAudio: true,
    durations: HAPPYHORSE_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    ratioOptions: HAPPYHORSE_RATIOS,
    summary: "原生有声、24 fps、3-15 秒",
  })),
  {
    id: "wan2.7-i2v",
    label: "万相 2.7 图生视频",
    family: "Wan 2.7",
    provider: "dashscope",
    category: "image",
    protocol: "i2v27",
    featured: true,
    imageMin: 1,
    imageMax: 2,
    supportsAudio: true,
    acceptsVideo: true,
    durations: TEXT_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    summary: "首帧、首尾帧、视频续写",
  },
  {
    id: "wan2.7-i2v-2026-04-25",
    label: "万相 2.7 图生视频 04-25",
    family: "Wan 2.7",
    provider: "dashscope",
    category: "image",
    protocol: "i2v27",
    imageMin: 1,
    imageMax: 2,
    supportsAudio: true,
    acceptsVideo: true,
    durations: TEXT_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    summary: "固定版本 2026-04-25",
  },
  ...["1.1", "1.0"].map((version) => ({
    id: `happyhorse-${version}-i2v`,
    label: `HappyHorse ${version} 首帧图生视频`,
    family: "HappyHorse",
    provider: "dashscope",
    category: "image",
    protocol: "happyhorseI2v",
    featured: version === "1.1",
    outputAudio: true,
    imageMin: 1,
    imageMax: 1,
    promptOptional: true,
    durations: HAPPYHORSE_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    summary: "首帧比例跟随、原生有声、3-15 秒",
  })),
  ...[
    ["wan2.6-i2v", "万相 2.6 图生视频", "有声、多镜头"],
    ["wan2.6-i2v-flash", "万相 2.6 图生视频 Flash", "快速生成、可选音频"],
  ].map(([id, label, summary]) => ({
    id,
    label,
    family: "Wan 2.6",
    provider: "dashscope",
    category: "image",
    protocol: "i2vLegacy",
    imageMin: 1,
    imageMax: 1,
    supportsAudio: true,
    durations: TEXT_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    summary,
  })),
  {
    id: "wan2.5-i2v-preview",
    label: "万相 2.5 图生视频",
    family: "Wan 2.5",
    provider: "dashscope",
    category: "image",
    protocol: "i2vLegacy",
    imageMin: 1,
    imageMax: 1,
    supportsAudio: true,
    durations: [5, 10],
    resolutions: ["480P", "720P", "1080P"],
    summary: "有声、首帧驱动",
  },
  ...[
    ["wan2.2-i2v-plus", "万相 2.2 图生视频 Plus", ["480P", "1080P"], "稳定增强"],
    ["wan2.2-i2v-flash", "万相 2.2 图生视频 Flash", ["480P", "720P", "1080P"], "快速生成"],
    ["wanx2.1-i2v-turbo", "万相 2.1 图生视频 Turbo", ["480P", "720P"], "快速生成"],
    ["wanx2.1-i2v-plus", "万相 2.1 图生视频 Plus", ["720P"], "质量增强"],
  ].map(([id, label, resolutions, summary]) => ({
    id,
    label,
    family: id.includes("2.2") ? "Wan 2.2" : "Wan 2.1",
    provider: "dashscope",
    category: "image",
    protocol: "i2vLegacy",
    imageMin: 1,
    imageMax: 1,
    durations: id.includes("turbo") ? [3, 4, 5] : [5],
    resolutions,
    summary: `${summary}、无音频`,
  })),
  {
    id: "wan2.2-kf2v-flash",
    label: "万相 2.2 首尾帧 Flash",
    family: "Wan 2.2",
    provider: "dashscope",
    category: "image",
    protocol: "kf2vLegacy",
    imageMin: 2,
    imageMax: 2,
    durations: [5],
    resolutions: ["480P", "720P", "1080P"],
    summary: "首尾帧过渡",
  },
  {
    id: "wanx2.1-kf2v-plus",
    label: "万相 2.1 首尾帧 Plus",
    family: "Wan 2.1",
    provider: "dashscope",
    category: "image",
    protocol: "kf2vLegacy",
    imageMin: 2,
    imageMax: 2,
    durations: [5],
    resolutions: ["720P"],
    summary: "首尾帧过渡",
  },
  {
    id: "agnes-video-v2.0",
    label: "Agnes Video V2.0",
    family: "Agnes",
    provider: "agnes",
    category: "image",
    protocol: "agnes",
    imageMin: 1,
    imageMax: 5,
    durations: AGNES_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    ratioOptions: STANDARD_RATIOS,
    summary: "文字、单图与关键帧生成",
  },
  {
    id: "grok-imagine-video",
    label: "Grok Imagine Video",
    family: "Grok Imagine",
    provider: "sub2api_grok",
    category: "text",
    protocol: "grokVideo",
    featured: true,
    imageMin: 1,
    imageMax: 5,
    durations: TEXT_DURATIONS,
    resolutions: ["480P", "720P"],
    ratios: true,
    ratioOptions: STANDARD_RATIOS,
    summary: "文生、首帧和多图参考视频",
  },
  {
    id: "wan2.7-r2v",
    label: "万相 2.7 参考生视频",
    family: "Wan 2.7",
    provider: "dashscope",
    category: "reference",
    protocol: "r2v",
    featured: true,
    imageMin: 1,
    imageMax: 5,
    acceptsVideo: true,
    referenceTotalMax: 5,
    supportsVoiceReference: true,
    durations: TEXT_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    summary: "多主体参考；纯图片 2-15 秒，含视频 2-10 秒",
  },
  {
    id: "wan2.7-r2v-2026-06-12",
    label: "万相 2.7 参考生视频 06-12",
    family: "Wan 2.7",
    provider: "dashscope",
    category: "reference",
    protocol: "r2v",
    imageMin: 1,
    imageMax: 5,
    acceptsVideo: true,
    referenceTotalMax: 5,
    supportsVoiceReference: true,
    durations: TEXT_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    summary: "固定版本；纯图片 2-15 秒，含视频 2-10 秒",
  },
  ...[
    ["wan2.6-r2v", "万相 2.6 参考生视频", "有声、多角色叙事"],
    ["wan2.6-r2v-flash", "万相 2.6 参考生视频 Flash", "快速、多角色"],
  ].map(([id, label, summary]) => ({
    id,
    label,
    family: "Wan 2.6",
    provider: "dashscope",
    category: "reference",
    protocol: "r2vLegacy",
    imageMin: 1,
    imageMax: 5,
    acceptsVideo: true,
    referenceTotalMax: 5,
    durations: REFERENCE_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    summary,
  })),
  ...["1.1", "1.0"].map((version) => ({
    id: `happyhorse-${version}-r2v`,
    label: `HappyHorse ${version} 多图参考`,
    family: "HappyHorse",
    provider: "dashscope",
    category: "reference",
    protocol: "happyhorseR2v",
    featured: version === "1.1",
    outputAudio: true,
    imageMin: 1,
    imageMax: 9,
    durations: HAPPYHORSE_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    ratioOptions: HAPPYHORSE_RATIOS,
    summary: "1-9 张图片、原生有声、3-15 秒",
  })),
  {
    id: "wan2.7-videoedit",
    label: "万相 2.7 视频编辑",
    family: "Wan 2.7",
    provider: "dashscope",
    category: "edit",
    protocol: "videoEdit",
    imageMin: 0,
    imageMax: 4,
    requiresVideo: true,
    promptOptional: true,
    durationMode: "truncate",
    supportsAudioSetting: true,
    durations: [0, ...REFERENCE_DURATIONS],
    resolutions: VIDEO_RESOLUTIONS,
    ratios: true,
    ratioOptions: ["source", ...STANDARD_RATIOS],
    summary: "指令编辑、参考图替换",
  },
  {
    id: "happyhorse-1.0-video-edit",
    label: "HappyHorse 1.0 视频编辑",
    family: "HappyHorse",
    provider: "dashscope",
    category: "edit",
    protocol: "happyhorseVideoEdit",
    imageMin: 0,
    imageMax: 5,
    requiresVideo: true,
    outputAudio: true,
    durationMode: "source",
    supportsAudioSetting: true,
    durations: HAPPYHORSE_DURATIONS,
    resolutions: VIDEO_RESOLUTIONS,
    summary: "指令编辑、跟随源视频、最长输出 15 秒",
  },
  {
    id: "wan2.2-animate-move",
    label: "万相 2.2 图像动作迁移",
    family: "Wan 2.2",
    provider: "dashscope",
    category: "edit",
    protocol: "animateMove",
    imageMin: 1,
    imageMax: 1,
    requiresVideo: true,
    promptOptional: true,
    durationMode: "source",
    durations: [5, 10, 15, 30],
    resolutions: ["720P"],
    summary: "参考视频驱动人物动作",
  },
  {
    id: "wan2.2-animate-mix",
    label: "万相 2.2 视频角色替换",
    family: "Wan 2.2",
    provider: "dashscope",
    category: "edit",
    protocol: "animateMix",
    imageMin: 1,
    imageMax: 1,
    requiresVideo: true,
    promptOptional: true,
    durationMode: "source",
    durations: [5, 10, 15, 30],
    resolutions: ["720P"],
    summary: "保留动作与场景替换角色",
  },
];

function capability({
  imageMin = 0,
  imageMax = 0,
  imageMode = "none",
  videoMode = "none",
  audioMode = "none",
  promptOptional = false,
  requiresAnyReference = false,
  referenceTotalMax = 0,
  durationWithVideoMax = 0,
} = {}) {
  return {
    imageMin,
    imageMax,
    imageMode,
    videoMode,
    audioMode,
    promptOptional,
    requiresAnyReference,
    referenceTotalMax,
    durationWithVideoMax,
  };
}

function workflowCapabilitiesFor(model) {
  if (model.protocol === "t2v" || model.protocol === "t2vLegacy" || model.protocol === "happyhorseT2v") {
    return {
      "text-to-video": capability({ audioMode: model.supportsAudio ? "input_audio" : "none" }),
    };
  }
  if (model.protocol === "i2vLegacy") {
    return {
      "first-frame": capability({
        imageMin: 1,
        imageMax: 1,
        imageMode: "first_frame",
        audioMode: model.supportsAudio ? "input_audio" : "none",
        promptOptional: true,
      }),
    };
  }
  if (model.protocol === "happyhorseI2v") {
    return {
      "first-frame": capability({
        imageMin: 1,
        imageMax: 1,
        imageMode: "first_frame",
        promptOptional: true,
      }),
    };
  }
  if (model.protocol === "i2v27") {
    const audioMode = model.supportsAudio ? "driving_audio" : "none";
    return {
      "first-frame": capability({ imageMin: 1, imageMax: 1, imageMode: "first_frame", audioMode, promptOptional: true }),
      "first-last-frame": capability({ imageMin: 2, imageMax: 2, imageMode: "first_last", audioMode, promptOptional: true }),
      "video-continuation": capability({
        imageMax: 1,
        imageMode: "last_frame",
        videoMode: "required_first_clip",
        audioMode: "none",
        promptOptional: true,
      }),
    };
  }
  if (model.protocol === "kf2vLegacy") {
    return {
      "first-last-frame": capability({ imageMin: 2, imageMax: 2, imageMode: "first_last", promptOptional: true }),
    };
  }
  if (model.protocol === "agnes") {
    return {
      "text-to-video": capability(),
      "first-frame": capability({ imageMin: 1, imageMax: 1, imageMode: "first_frame" }),
      keyframes: capability({ imageMin: 2, imageMax: 5, imageMode: "keyframes" }),
    };
  }
  if (model.protocol === "grokVideo") {
    return {
      "text-to-video": capability(),
      "first-frame": capability({ imageMin: 1, imageMax: 1, imageMode: "first_frame" }),
      "multi-reference": capability({ imageMin: 1, imageMax: model.imageMax, imageMode: "reference" }),
    };
  }
  if (model.protocol === "happyhorseR2v") {
    return {
      "multi-reference": capability({
        imageMin: 1,
        imageMax: model.imageMax,
        imageMode: "reference",
      }),
    };
  }
  if (model.protocol === "r2v" || model.protocol === "r2vLegacy") {
    return {
      "multi-reference": capability({
        imageMax: model.imageMax,
        imageMode: "reference",
        videoMode: model.acceptsVideo ? "optional_reference" : "none",
        audioMode: model.supportsVoiceReference ? "voice_reference" : "none",
        requiresAnyReference: true,
        referenceTotalMax: model.referenceTotalMax,
        durationWithVideoMax: model.protocol === "r2v" ? 10 : 0,
      }),
    };
  }
  if (model.protocol === "videoEdit") {
    return {
      "video-edit": capability({
        imageMax: model.imageMax,
        imageMode: "reference",
        videoMode: "required_source",
        promptOptional: model.promptOptional,
      }),
    };
  }
  if (model.protocol === "happyhorseVideoEdit") {
    return {
      "video-edit": capability({
        imageMax: model.imageMax,
        imageMode: "reference",
        videoMode: "required_source",
      }),
    };
  }
  if (model.protocol === "animateMove") {
    return {
      "motion-transfer": capability({
        imageMin: 1,
        imageMax: 1,
        imageMode: "character",
        videoMode: "required_driver",
        promptOptional: true,
      }),
    };
  }
  if (model.protocol === "animateMix") {
    return {
      "character-replace": capability({
        imageMin: 1,
        imageMax: 1,
        imageMode: "replacement_character",
        videoMode: "required_source",
        promptOptional: true,
      }),
    };
  }
  return {};
}

function modelControlsFor(model) {
  const isAgnes = model.protocol === "agnes";
  const isGrokVideo = model.protocol === "grokVideo";
  const isHappyHorse = model.protocol.startsWith("happyhorse");
  const isAnimation = model.protocol === "animateMove" || model.protocol === "animateMix";
  const isLegacyReference = model.protocol === "r2vLegacy";
  const ratioOptions = model.ratioOptions || (model.ratios ? STANDARD_RATIOS : []);
  return {
    durationMode: model.durationMode || "output",
    supportsWatermark: !isAgnes && !isGrokVideo,
    supportsPromptExtend: !isAgnes && !isGrokVideo && !isHappyHorse && !isAnimation && !isLegacyReference,
    supportsNegativePrompt: isAgnes || (!isGrokVideo && !isHappyHorse && !isAnimation),
    supportsSeed: !isGrokVideo && !isAnimation && !isLegacyReference,
    supportsAudioSetting: Boolean(model.supportsAudioSetting),
    ratioOptions,
    outputAudio: Boolean(
      model.outputAudio
      || model.supportsAudio
      || model.supportsVoiceReference
      || model.protocol === "r2vLegacy",
    ),
  };
}

function variantLabelFor(model) {
  const happyHorseVersion = model.id.match(/^happyhorse-(\d+\.\d+)-/)?.[1];
  if (happyHorseVersion) return happyHorseVersion;
  const date = model.id.match(/(20\d{2}-\d{2}-\d{2})$/)?.[1];
  if (date) return `固定版 ${date}`;
  if (model.id.endsWith("-flash")) return "Flash";
  if (model.id.endsWith("-turbo")) return "Turbo";
  if (model.id.endsWith("-plus")) return "Plus";
  if (model.id.includes("preview")) return "Preview";
  if (model.featured) return "推荐版";
  if (model.id.includes("2.6")) return "Standard";
  return "标准版";
}

export const VIDEO_MODELS = MODEL_CATALOG.map((model) => {
  const controls = modelControlsFor(model);
  const workflows = workflowCapabilitiesFor(model);
  return {
    ...model,
    ...controls,
    providerLabel: model.provider === "agnes"
      ? "Agnes AI"
      : model.provider === "sub2api_grok" ? "Sub2API Grok" : "阿里云百炼",
    familyLabel: model.family.replace(/^Wan /, "万相 "),
    variantLabel: variantLabelFor(model),
    workflowCapabilities: Object.fromEntries(
      Object.entries(workflows).map(([workflowId, workflow]) => [workflowId, { ...workflow, ...controls }]),
    ),
  };
});

export function getVideoWorkflow(workflowId) {
  return VIDEO_WORKFLOWS.find((workflow) => workflow.id === workflowId);
}

export function getWorkflowCapability(model, workflowId) {
  return model?.workflowCapabilities?.[workflowId] || null;
}

export function supportsWorkflow(model, workflowId) {
  return Boolean(getWorkflowCapability(model, workflowId));
}

export function getModelsForWorkflow(workflowId, models = VIDEO_MODELS) {
  return models.filter((model) => supportsWorkflow(model, workflowId));
}

export function inferVideoWorkflow(model, { images = [], videoUrl = "" } = {}) {
  if (!model) return null;
  if (model.protocol === "agnes") {
    if (images.length === 0) return "text-to-video";
    return images.length === 1 ? "first-frame" : "keyframes";
  }
  if (model.protocol === "grokVideo") {
    if (images.length === 0) return "text-to-video";
    return images.length === 1 ? "first-frame" : "multi-reference";
  }
  if (model.protocol === "i2v27") {
    if (videoUrl) return "video-continuation";
    return images.length > 1 ? "first-last-frame" : "first-frame";
  }
  if (model.protocol === "i2vLegacy" || model.protocol === "happyhorseI2v") return "first-frame";
  if (model.protocol === "kf2vLegacy") return "first-last-frame";
  if (model.protocol === "r2v" || model.protocol === "r2vLegacy" || model.protocol === "happyhorseR2v") return "multi-reference";
  if (model.protocol === "videoEdit" || model.protocol === "happyhorseVideoEdit") return "video-edit";
  if (model.protocol === "animateMove") return "motion-transfer";
  if (model.protocol === "animateMix") return "character-replace";
  return "text-to-video";
}

export function getVideoModel(modelId) {
  return VIDEO_MODELS.find((model) => model.id === modelId);
}
