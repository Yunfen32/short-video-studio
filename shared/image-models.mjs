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

export const IMAGE_MODELS = Object.freeze([
  {
    id: "wan2.7-image-pro",
    label: "万相 2.7 Image Pro",
    provider: "dashscope",
    providerLabel: "阿里云百炼",
    family: "万相 2.7 Image",
    variantLabel: "Pro",
    summary: "高质量、文字渲染、多图参考与编辑",
    featured: true,
    workflows: ["text-to-image", "image-edit"],
    qualities: ["1K", "2K", "4K"],
    maxOutputs: 4,
  },
  {
    id: "wan2.7-image",
    label: "万相 2.7 Image",
    provider: "dashscope",
    providerLabel: "阿里云百炼",
    family: "万相 2.7 Image",
    variantLabel: "标准",
    summary: "更快的文生图和参考图编辑",
    featured: false,
    workflows: ["text-to-image", "image-edit"],
    qualities: ["1K", "2K"],
    maxOutputs: 4,
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
