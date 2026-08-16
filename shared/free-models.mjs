// 当前工作台允许直接调用的免费媒体模型白名单。
export const FREE_VIDEO_MODEL_IDS = Object.freeze(["cogvideox-flash", "agnes-video-v2.0"]);
export const FREE_IMAGE_MODEL_IDS = Object.freeze([
  "cogview-3-flash",
  "agnes-image-2.0-flash",
  "agnes-image-2.1-flash",
]);

export function isFreeVideoModel(model) {
  return Boolean(model?.id && FREE_VIDEO_MODEL_IDS.includes(model.id));
}

export function isFreeImageModel(model) {
  return Boolean(model?.id && FREE_IMAGE_MODEL_IDS.includes(model.id));
}
