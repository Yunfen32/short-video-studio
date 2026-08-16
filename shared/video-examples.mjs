const VIDEO_EXAMPLE_CATALOG = Object.freeze({
  "agnes-video-v2.0": Object.freeze({
    workflow: "text-to-video",
    title: "月光电车站",
    prompt: "2D 动漫风格，5 秒竖屏短片。夜晚的月光电车站，一位橙色短发少女抱着画册跑过站台，列车灯光掠过她的眼睛，纸张被风吹起，镜头从中景轻轻推近，蓝紫夜色与暖黄色灯光，动作连贯，画面干净。",
    ratio: "9:16",
    duration: 5,
    resolution: "720P",
    style: "动画短片",
  }),
  "cogvideox-flash": Object.freeze({
    workflow: "text-to-video",
    title: "屋顶上的纸飞机",
    prompt: "2D 动漫风格，5 秒竖屏短片。晴朗午后的城市屋顶，一名戴红围巾的少年放飞纸飞机，纸飞机穿过发光的云朵，少年抬头微笑，镜头跟随纸飞机向前平滑移动，明亮蓝天、白云和清爽线稿，动作自然流畅。",
    ratio: "9:16",
    duration: 5,
    resolution: "720P",
    style: "动画短片",
  }),
});

export const VIDEO_EXAMPLES = VIDEO_EXAMPLE_CATALOG;

export function getVideoExample(modelId, workflowId = "text-to-video") {
  const example = VIDEO_EXAMPLE_CATALOG[modelId];
  return example?.workflow === workflowId ? example : null;
}
