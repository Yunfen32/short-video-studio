export const IMAGE_WORKFLOWS = Object.freeze([
  {
    id: "text-to-image",
    label: "文生图",
    summary: "用描述直接生成图片",
    imageMin: 0,
    imageMax: 0,
  },
  {
    id: "image-edit",
    label: "参考图编辑",
    summary: "基于一张或多张图片重绘、组合或改造",
    imageMin: 1,
    imageMax: 9,
  },
]);

const QUALITY_SIZES = {
  "1K": "1024*1024",
  "2K": "2048*2048",
  "4K": "4096*4096",
};

const WAN_26_SIZES = { "1K": "1280*1280", "2K": "1440*1440" };
const WAN_25_SIZES = { "1K": "1280*1280", "2K": "1440*1440" };
const LEGACY_WAN_SIZES = { "1K": "1024*1024" };
const QWEN_FIXED_SIZES = { "1K": "1024*1024", "2K": "2048*2048" };
const QWEN_FIXED_WIDE_SIZES = { "1K": "1664*928" };

function dashscopeModel(options) {
  return {
    provider: "dashscope",
    providerLabel: "阿里云百炼",
    ...options,
  };
}

function wanTextModel(id, label, family, options = {}) {
  return dashscopeModel({
    id,
    label,
    family,
    variantLabel: options.variantLabel || "标准",
    summary: options.summary || "万相文生图",
    protocol: "wanLegacyText",
    workflows: ["text-to-image"],
    qualities: ["1K"],
    qualitySizes: LEGACY_WAN_SIZES,
    maxOutputs: 4,
    ...options,
  });
}

function wanMessageModel(id, label, family, options = {}) {
  return dashscopeModel({
    id,
    label,
    family,
    variantLabel: options.variantLabel || "标准",
    summary: options.summary || "万相图像生成与编辑",
    protocol: "wanMessageAsync",
    workflows: ["text-to-image", "image-edit"],
    qualities: ["1K", "2K"],
    qualitySizes: QUALITY_SIZES,
    maxOutputs: 4,
    maxInputImages: 3,
    ...options,
  });
}

function qwenMessageModel(id, label, options = {}) {
  return dashscopeModel({
    id,
    label,
    family: "Qwen Image",
    variantLabel: options.variantLabel || "标准",
    summary: options.summary || "千问图像生成与编辑",
    protocol: "qwenMessageSync",
    workflows: ["text-to-image", "image-edit"],
    qualities: ["1K", "2K"],
    qualitySizes: QWEN_FIXED_SIZES,
    maxOutputs: 6,
    maxInputImages: 3,
    ...options,
  });
}

function qwenTextModel(id, label, options = {}) {
  return dashscopeModel({
    id,
    label,
    family: "Qwen Image",
    variantLabel: options.variantLabel || "标准",
    summary: options.summary || "千问文生图",
    protocol: "qwenLegacyText",
    workflows: ["text-to-image"],
    qualities: ["1K"],
    qualitySizes: QWEN_FIXED_WIDE_SIZES,
    maxOutputs: 1,
    ...options,
  });
}

export const IMAGE_MODELS = Object.freeze([
  wanMessageModel("wan2.7-image-pro", "万相 2.7 Image Pro", "Wan 2.7 Image", {
    featured: true,
    variantLabel: "Pro",
    summary: "高质量、文字渲染、多图参考与编辑",
    qualities: ["1K", "2K", "4K"],
    qualitySizes: QUALITY_SIZES,
    maxInputImages: 9,
    editMaxQuality: "2K",
  }),
  wanMessageModel("wan2.7-image", "万相 2.7 Image", "Wan 2.7 Image", {
    variantLabel: "标准",
    summary: "更快的文生图和参考图编辑",
    qualitySizes: { "1K": "1024*1024", "2K": "2048*2048" },
    maxInputImages: 9,
  }),
  wanMessageModel("wan2.6-t2i", "万相 2.6 文生图", "Wan 2.6", {
    variantLabel: "T2I",
    summary: "自由尺寸、文生图",
    workflows: ["text-to-image"],
    qualitySizes: WAN_26_SIZES,
    maxInputImages: 0,
  }),
  wanMessageModel("wan2.6-image", "万相 2.6 Image", "Wan 2.6", {
    variantLabel: "Image",
    summary: "文生图与参考图编辑",
    qualitySizes: WAN_26_SIZES,
    maxInputImages: 3,
  }),
  wanTextModel("wan2.5-t2i-preview", "万相 2.5 文生图 Preview", "Wan 2.5", {
    variantLabel: "Preview",
    summary: "高质量文生图",
    qualities: ["1K", "2K"],
    qualitySizes: WAN_25_SIZES,
  }),
  dashscopeModel({
    id: "wan2.5-i2i-preview",
    label: "万相 2.5 图像编辑 Preview",
    family: "Wan 2.5",
    variantLabel: "I2I Preview",
    summary: "参考图编辑",
    protocol: "wanImage2Image",
    workflows: ["image-edit"],
    qualities: ["1K"],
    qualitySizes: { "1K": "1280*1280" },
    maxOutputs: 4,
    maxInputImages: 1,
  }),
  wanTextModel("wan2.2-t2i-flash", "万相 2.2 文生图 Flash", "Wan 2.2", {
    variantLabel: "Flash",
    summary: "快速文生图",
  }),
  wanTextModel("wan2.2-t2i-plus", "万相 2.2 文生图 Plus", "Wan 2.2", {
    variantLabel: "Plus",
    summary: "稳定增强文生图",
  }),
  wanTextModel("wan2.1-t2i-turbo", "万相 2.1 文生图 Turbo", "Wan 2.1", {
    variantLabel: "Turbo",
    summary: "快速文生图",
  }),
  wanTextModel("wan2.1-t2i-plus", "万相 2.1 文生图 Plus", "Wan 2.1", {
    variantLabel: "Plus",
    summary: "质量增强文生图",
  }),
  wanTextModel("wanx2.0-t2i-turbo", "万相 2.0 文生图 Turbo", "Wan 2.0", {
    variantLabel: "Turbo",
    summary: "经典快速文生图",
  }),
  dashscopeModel({
    id: "wanx2.1-imageedit",
    label: "万相 2.1 图像编辑",
    family: "Wan 2.1",
    variantLabel: "ImageEdit",
    summary: "经典参考图编辑",
    protocol: "wanImage2Image",
    workflows: ["image-edit"],
    qualities: ["1K"],
    qualitySizes: { "1K": "1024*1024" },
    maxOutputs: 1,
    maxInputImages: 1,
  }),

  qwenMessageModel("qwen-image-3.0-pro", "千问 Image 3.0 Pro", {
    featured: true,
    variantLabel: "3.0 Pro",
    summary: "高精度文字渲染、多图生成与编辑",
    protocol: "qwenMessageAsync",
    maxOutputs: 1,
    qualitySizes: { "1K": "1024*1024", "2K": "2048*2048" },
  }),
  qwenMessageModel("qwen-image-3.0", "千问 Image 3.0", {
    variantLabel: "3.0",
    summary: "快速图像生成与编辑",
    protocol: "qwenMessageAsync",
    maxOutputs: 1,
    qualitySizes: { "1K": "1024*1024", "2K": "2048*2048" },
  }),
  qwenMessageModel("qwen-image-2.0-pro", "千问 Image 2.0 Pro", {
    featured: true,
    variantLabel: "2.0 Pro",
    summary: "文字渲染、真实质感与多图编辑",
  }),
  ...[
    "2026-06-22",
    "2026-04-22",
    "2026-03-03",
  ].map((date) => qwenMessageModel(`qwen-image-2.0-pro-${date}`, `千问 Image 2.0 Pro ${date}`, {
    variantLabel: date,
    summary: "千问 Image 2.0 Pro 固定版本",
  })),
  qwenMessageModel("qwen-image-2.0", "千问 Image 2.0", {
    variantLabel: "2.0",
    summary: "平衡效果与速度的图像生成与编辑",
  }),
  qwenMessageModel("qwen-image-2.0-2026-03-03", "千问 Image 2.0 2026-03-03", {
    variantLabel: "2026-03-03",
    summary: "千问 Image 2.0 固定版本",
  }),
  ...[
    ["qwen-image-edit-max", "千问 Image Edit Max", "Max"],
    ["qwen-image-edit-max-2026-01-16", "千问 Image Edit Max 2026-01-16", "2026-01-16"],
    ["qwen-image-edit-plus", "千问 Image Edit Plus", "Plus"],
    ["qwen-image-edit-plus-2025-12-15", "千问 Image Edit Plus 2025-12-15", "2025-12-15"],
    ["qwen-image-edit-plus-2025-10-30", "千问 Image Edit Plus 2025-10-30", "2025-10-30"],
  ].map(([id, label, variantLabel]) => qwenMessageModel(id, label, {
    variantLabel,
    summary: "千问专用图像编辑模型",
    workflows: ["image-edit"],
    maxOutputs: 6,
  })),
  qwenMessageModel("qwen-image-edit", "千问 Image Edit", {
    variantLabel: "Edit",
    summary: "单图编辑与多图融合",
    workflows: ["image-edit"],
    qualities: ["1K"],
    qualitySizes: { "1K": "1024*1024" },
    maxOutputs: 1,
  }),
  qwenTextModel("qwen-image-max", "千问 Image Max", {
    featured: true,
    variantLabel: "Max",
    summary: "真实质感、纹理与文字渲染",
    protocol: "qwenMessageSync",
  }),
  qwenTextModel("qwen-image-max-2025-12-30", "千问 Image Max 2025-12-30", {
    variantLabel: "2025-12-30",
    summary: "千问 Image Max 固定版本",
    protocol: "qwenMessageSync",
  }),
  ...[
    ["qwen-image-plus", "千问 Image Plus", "Plus"],
    ["qwen-image-plus-2026-01-09", "千问 Image Plus 2026-01-09", "2026-01-09"],
    ["qwen-image", "千问 Image", "标准"],
  ].map(([id, label, variantLabel]) => qwenTextModel(id, label, {
    variantLabel,
    protocol: "qwenLegacyText",
    summary: "快速文生图",
  })),
  dashscopeModel({
    id: "z-image-turbo",
    label: "Z-Image Turbo",
    family: "Z-Image",
    variantLabel: "Turbo",
    summary: "快速、低成本、写实人像",
    featured: true,
    protocol: "zImageSync",
    workflows: ["text-to-image"],
    qualities: ["1K", "2K"],
    qualitySizes: QWEN_FIXED_SIZES,
    maxOutputs: 1,
  }),

  {
    id: "cogview-3-flash",
    label: "CogView-3-Flash",
    provider: "zhipu",
    providerLabel: "Zhipu AI",
    family: "CogView",
    variantLabel: "Flash",
    summary: "Free, fast text-to-image generation with multiple aspect ratios",
    featured: true,
    workflows: ["text-to-image"],
    qualities: ["1K", "2K"],
    maxOutputs: 1,
    zhipuSize: "1344x768",
  },
  {
    id: "agnes-image-2.0-flash",
    label: "Agnes Image 2.0 Flash",
    provider: "agnes",
    providerLabel: "Agnes AI",
    family: "Agnes Image",
    variantLabel: "2.0 Flash",
    summary: "Free text-to-image and multi-image editing",
    featured: false,
    workflows: ["text-to-image", "image-edit"],
    qualities: ["1K", "2K"],
    maxOutputs: 1,
    agnesSize: { "1K": "1024x1024", "2K": "1536x1536" },
  },
  {
    id: "agnes-image-2.1-flash",
    label: "Agnes Image 2.1 Flash",
    provider: "agnes",
    providerLabel: "Agnes AI",
    family: "Agnes Image",
    variantLabel: "2.1 Flash",
    summary: "Free high-density text-to-image and reference editing",
    featured: true,
    workflows: ["text-to-image", "image-edit"],
    qualities: ["1K", "2K"],
    maxOutputs: 1,
    agnesSize: { "1K": "1024x1024", "2K": "1536x1536" },
  },
]);

export function getImageModel(modelId) {
  return IMAGE_MODELS.find((model) => model.id === modelId) || null;
}

export function getImageWorkflow(workflowId) {
  return IMAGE_WORKFLOWS.find((workflow) => workflow.id === workflowId) || null;
}

export function supportsImageWorkflow(model, workflowId) {
  return Boolean(model?.workflows?.includes(workflowId));
}

export function inferImageWorkflow({ images = [] } = {}) {
  return images.length ? "image-edit" : "text-to-image";
}
