import { IMAGE_MODELS } from '../shared/image-models.mjs';
import { VIDEO_MODELS } from '../shared/video-models.mjs';
import { buildCreativeAgentPlan } from '../shared/creative-agent.mjs';

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE !== 'false';
const plans = new Map();
const demoBasePath = window.location.pathname.startsWith('/short-video-studio') ? '/short-video-studio' : '';

function demoAsset(name) {
  return `${window.location.origin}${demoBasePath}/demo/${name}`;
}

function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function readBody(init) {
  try {
    return JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
  } catch {
    return {};
  }
}

function demoPlanId() {
  return `demo-plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function demoCreativePlan(input = {}) {
  const prompt = String(input.prompt || '一段充满想象力的短视频').trim();
  const duration = Math.max(1, Math.min(300, Math.round(Number(input.duration) || 5)));
  const style = input.style || '2D 动漫';
  const ratio = input.ratio || '9:16';
  const shotCount = Math.max(1, Math.ceil(duration / 5));
  const shots = Array.from({ length: shotCount }, (_, index) => {
    const timelineDuration = index === shotCount - 1 ? duration - (shotCount - 1) * 5 : 5;
    return {
      id: `shot-${index + 1}`,
      title: `镜头 ${String(index + 1).padStart(2, '0')}`,
      duration: 5,
      timelineDuration,
      sceneId: 'scene-1',
      characterIds: ['character-1'],
      storyBeat: index === 0 ? '建立场景并引出主体' : '主体动作推进并完成情绪收束',
      visualDescription: `${prompt}，${index === 0 ? '镜头从环境开始建立氛围' : '镜头跟随主体完成连续动作'}。`,
      action: index === 0 ? '主体进入画面并观察环境。' : '主体继续动作，光影和环境细节自然变化。',
      camera: index === 0 ? '中景缓慢推进。' : '平滑跟拍并在结尾稳定。',
      transition: index === 0 ? '淡入' : '自然连续剪辑',
      audio: '保留环境声和轻微动作音，无背景音乐。',
      imagePrompt: `${style}，${prompt}，${ratio}画幅，电影级构图，高细节关键画面。`,
      videoPrompt: `【素材引用】\n@场景图1 演示场景参考。\n@角色1 演示主体，外观连续稳定。\n\n【分段镜头】\n0-${timelineDuration}秒，${prompt}，镜头平滑运动，动作自然连贯，保留环境声。\n\n【风格画质+约束】\n${style}，${ratio}画幅，高分辨率画质；人物面部稳定、人体结构正常、无字幕、无水印、无闪烁。`,
    };
  });
  return {
    version: 1,
    target: 'video',
    source: input.source || 'inspiration',
    style,
    ratio,
    duration,
    title: '演示创作项目',
    logline: prompt,
    story: `演示模式根据“${prompt}”整理出的故事。`,
    creativeDirection: `${style}下的演示视频创作方案。`,
    planningSummary: `演示模式已生成 ${shotCount} 个分镜，总时长 ${duration} 秒。`,
    characters: [{ id: 'character-1', name: '演示主体', role: '主要人物', appearance: '外观清晰、动作自然的演示角色。', wardrobe: '与风格匹配的服装。', personality: '积极、专注。', continuityNotes: '所有镜头保持外观、服装和比例一致。', imagePrompt: `${style}角色设定图，演示主体，正面与侧面细节，高分辨率。` }],
    scenes: [{ id: 'scene-1', name: '演示场景', description: `围绕“${prompt}”构建的连续场景。`, lighting: '柔和电影级布光。', palette: '清晰、协调的综合色彩。', continuityNotes: '场景布局和主要光源保持一致。', imagePrompt: `${style}场景设定图，${prompt}，高分辨率环境概念图。` }],
    shots,
  };
}

function modelAvailability() {
  return {
    availableCount: VIDEO_MODELS.length,
    imageAvailableCount: IMAGE_MODELS.length,
    videoModels: VIDEO_MODELS,
    imageModels: IMAGE_MODELS,
    unavailable: [],
    freeOnly: false,
    accessRequired: false,
    accessConfigured: true,
    directAccess: true,
    demoMode: true,
    checkedAt: Date.now(),
  };
}

function taskResult(kind) {
  return kind === 'image'
    ? { status: 'SUCCEEDED', terminal: true, imageUrls: [demoAsset('demo-image.svg')], size: '2K' }
    : { status: 'SUCCEEDED', terminal: true, videoUrl: demoAsset('demo-video.mp4'), size: '1280x720', seconds: '5.0' };
}

export function installDemoFetch() {
  if (!DEMO_MODE || typeof window === 'undefined' || window.__shortVideoDemoFetchInstalled) return;
  window.__shortVideoDemoFetchInstalled = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const requestUrl = typeof input === 'string' ? input : input?.url;
    const url = new URL(requestUrl || '', window.location.origin);
    if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
    const method = (init.method || (typeof input !== 'string' ? input.method : 'GET') || 'GET').toUpperCase();
    const body = readBody(init);

    if (url.pathname === '/api/models') return response(modelAvailability());
    if (url.pathname === '/api/reference-images' && method === 'POST') return response({ url: demoAsset('demo-image.svg') }, 201);
    if (url.pathname === '/api/agent/project-plan' && method === 'POST') {
      return response({ creativePlan: demoCreativePlan(body), display: { mode: 'demo' }, planner: { provider: 'demo', model: '演示规划器' } });
    }
    if (url.pathname === '/api/agent/plan' && method === 'POST') {
      const agentPlan = buildCreativeAgentPlan({ ...body, promptPrepared: true }, { videoModels: VIDEO_MODELS, imageModels: IMAGE_MODELS });
      const planId = demoPlanId();
      plans.set(planId, agentPlan);
      return response({ agentPlan, planId, planner: { provider: 'demo', model: '演示规划器' } });
    }
    if (url.pathname === '/api/agent/generate' && method === 'POST') {
      const plan = plans.get(body.planId) || { kind: 'video', provider: 'demo', modelId: 'demo-video' };
      const taskId = `demo-task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return response({ taskId, provider: 'demo', status: 'PENDING', agentPlan: plan }, 202);
    }
    if (url.pathname === '/api/videos' && method === 'POST') {
      return response({ taskId: `demo-video-${Date.now()}`, provider: 'demo', status: 'PENDING' }, 202);
    }
    if (url.pathname === '/api/images' && method === 'POST') {
      return response({ taskId: `demo-image-${Date.now()}`, provider: 'demo', status: 'PENDING' }, 202);
    }
    if (url.pathname.startsWith('/api/videos/')) return response({ taskId: url.pathname.split('/').pop(), provider: 'demo', ...taskResult('video') });
    if (url.pathname.startsWith('/api/images/')) return response({ taskId: url.pathname.split('/').pop(), provider: 'demo', ...taskResult('image') });
    if (url.pathname === '/api/video-compositions' && method === 'POST') return response({ taskId: `demo-compose-${Date.now()}`, provider: 'demo', status: 'SUCCEEDED', terminal: true, videoUrl: demoAsset('demo-video.mp4') }, 202);
    if (url.pathname.startsWith('/api/compositions/')) return response({ status: 'SUCCEEDED', terminal: true, videoUrl: demoAsset('demo-video.mp4') });
    if (url.pathname.endsWith('-download')) return new Response('演示模式下载内容', { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment' } });
    return response({ error: '演示模式暂未覆盖该接口' }, 404);
  };
}
