import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_MODELS } from '../shared/image-models.mjs';
import { buildCreativeAgentPlan, normalizeCreativePlan } from '../shared/creative-agent.mjs';
import { handleVideoApiRequest } from '../shared/video-api.mjs';
import { VIDEO_MODELS } from '../shared/video-models.mjs';

function llmPlan({ target = 'video', duration = 5, timelineDuration = duration } = {}) {
  return {
    title: '雨夜纸飞机',
    target,
    logline: '少女让纸飞机穿过雨夜城市，找到温暖的书店。',
    story: '少女在街角放飞纸飞机，跟随它进入亮着暖光的书店。',
    creativeDirection: '统一蓝紫雨夜与暖黄色室内光，保持少女红围巾连续。',
    planningSummary: '先建立雨夜城市，再跟随纸飞机进入书店，最后用暖光收束。',
    characters: [{ id: 'girl', name: '少女', role: '故事主角', appearance: '短黑发，清秀面容', wardrobe: '黄色雨衣与红围巾', personality: '好奇而勇敢', continuityNotes: '红围巾始终可见', imagePrompt: '短黑发少女，黄色雨衣，红围巾，电影感肖像' }],
    scenes: [{ id: 'street', name: '雨夜街道', description: '霓虹倒映在湿润街面', lighting: '蓝紫色雨夜，路灯反光', palette: '蓝紫与少量暖黄', continuityNotes: '雨势保持中等', imagePrompt: '雨夜霓虹街道，湿润路面，蓝紫色调，电影感' }],
    shots: [{ id: 'shot-1', title: '纸飞机穿过雨幕', duration, timelineDuration, sceneId: 'street', characterIds: ['girl'], storyBeat: '建立并引出目标', visualDescription: '少女在街角放飞纸飞机', action: '纸飞机从手中起飞，穿过雨幕', camera: '镜头从少女近景平滑跟随到纸飞机', transition: '自然跟随', audio: '雨声与轻柔钢琴', imagePrompt: '少女在雨夜街角放飞纸飞机，蓝紫霓虹，红围巾，完整构图', videoPrompt: `【素材引用】\n@场景图1 雨夜街道。@角色1 少女，黄色雨衣与红围巾。\n\n【分段镜头】\n0-${timelineDuration}秒，少女松手放飞纸飞机，纸飞机穿过雨幕向前飞行，镜头平滑跟随，雨滴和霓虹反光自然运动，保留雨声。\n\n【风格画质+约束】\n电影级蓝紫霓虹，人物连续稳定，无字幕、无水印、无背景音乐。` }],
  };
}

function llmResponse(options = {}) {
  return Response.json({ output_text: JSON.stringify(llmPlan(options)) });
}

function memoryRuntime(env = {}) {
  const values = new Map();
  return {
    getEnv: (key) => env[key] || '',
    clientId: 'creative-agent-test',
    now: () => 1_800_000_000_000,
    storage: {
      async getJSON(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
      async setJSON(key, value) { values.set(key, structuredClone(value)); },
      async put(key, body, metadata = {}) { values.set(key, { body: new Uint8Array(body), ...metadata }); },
      async get(key) { return values.get(key) || null; },
    },
  };
}

test('LLM 漏掉三段式标题时，保留其镜头内容并补齐视频提示词交付格式', () => {
  const raw = llmPlan({ duration: 18, timelineDuration: 18 });
  raw.shots[0].videoPrompt = '少女从二楼跃下，镜头跟随，无人机照亮大厅。';

  const normalized = normalizeCreativePlan(raw, {
    target: 'video',
    source: 'script',
    style: '电影感',
    ratio: '9:16',
    duration: 18,
    durationOptions: [3, 5, 7, 10, 18],
    clipTimings: [{ duration: 18, timelineDuration: 18 }],
  });

  assert.match(normalized.shots[0].videoPrompt, /【素材引用】[\s\S]*【分段镜头】[\s\S]*【风格画质\+约束】/);
  assert.match(normalized.shots[0].videoPrompt, /少女从二楼跃下/);
});

test('创作 Agent 只生成视频，图片计划必须标记为视频中间资产', () => {
  const catalog = { videoModels: VIDEO_MODELS, imageModels: IMAGE_MODELS };
  assert.throws(() => buildCreativeAgentPlan({
    prompt: '2D 动漫风格的雨夜书店海报，暖黄色窗光，角色坐在窗边阅读',
    target: 'image',
    promptPrepared: true,
  }, catalog), /只输出视频/);

  const imagePlan = buildCreativeAgentPlan({
    prompt: '2D 动漫风格的雨夜书店海报，暖黄色窗光，角色坐在窗边阅读',
    target: 'image',
    assetRole: 'intermediate',
    promptPrepared: true,
  }, catalog);
  assert.equal(imagePlan.kind, 'image');
  assert.equal(imagePlan.workflow, 'text-to-image');
  assert.equal(imagePlan.request.model, 'wan2.7-image-pro');
  assert.equal(imagePlan.request.quality, '2K');
  assert.equal(imagePlan.request.prompt, '2D 动漫风格的雨夜书店海报，暖黄色窗光，角色坐在窗边阅读');

  const preparedVideoPrompt = '【素材引用】\n@场景图1 雨夜书店街道。@角色1 少女。\n\n【分段镜头】\n0-5秒，少女推开书店门，镜头从街道平移到室内。\n\n【风格画质+约束】\n2D 动漫，人物稳定，无水印。';
  const videoPlan = buildCreativeAgentPlan({
    prompt: preparedVideoPrompt,
    target: 'video',
    promptPrepared: true,
  }, catalog);
  assert.equal(videoPlan.kind, 'video');
  assert.equal(videoPlan.workflow, 'text-to-video');
  assert.equal(videoPlan.request.model, 'wan2.7-t2v');
  assert.equal(videoPlan.request.duration, 5);
  assert.equal(videoPlan.request.ratio, '9:16');
  assert.equal(videoPlan.request.prompt, preparedVideoPrompt);
});

test('创作 Agent 将项目来源、视觉风格和视频输出偏好写入可执行计划', () => {
  const catalog = { videoModels: VIDEO_MODELS, imageModels: IMAGE_MODELS };
  const plan = buildCreativeAgentPlan({
    target: 'video',
    source: 'script',
    style: '2D 动漫',
    ratio: '16:9',
    duration: 10,
    promptPrepared: true,
    prompt: '书店里的纸飞机飞向夜空，镜头持续向上跟随。',
  }, catalog);

  assert.deepEqual(plan.brief, {
    source: 'script',
    style: '2D 动漫',
    ratio: '16:9',
    duration: 10,
  });
  assert.equal(plan.request.ratio, '16:9');
  assert.equal(plan.request.duration, 10);
  assert.equal(plan.request.prompt, '书店里的纸飞机飞向夜空，镜头持续向上跟随。');
});

test('创作项目规划由 LLM 输出结构化分镜、人物、场景和双提示词', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true',
    FREE_MODELS_ONLY: 'false',
    AGENT_LLM_API_KEY: 'agent-test-key',
    AGENT_LLM_BASE_URL: 'https://llm.example/v1',
    AGENT_LLM_WIRE_API: 'chat_completions',
  });
  const requests = [];
  runtime.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return llmResponse({ duration: 10 });
  };
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/agent/project-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'video', source: 'script', style: '电影感', ratio: '16:9', duration: 10, prompt: '一段雨夜书店的故事' }),
  }), runtime);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://llm.example/v1/chat/completions');
  assert.equal(data.creativePlan.target, 'video');
  assert.equal(data.creativePlan.duration, 10);
  assert.equal(data.creativePlan.characters[0].name, '少女');
  assert.equal(data.creativePlan.scenes[0].name, '雨夜街道');
  assert.equal(data.creativePlan.shots[0].duration, 10);
  assert.ok(data.creativePlan.shots[0].imagePrompt);
  assert.ok(data.creativePlan.shots[0].videoPrompt);
  assert.equal(data.planner.model, 'gpt-4o-mini');
});

test('自定义项目时长会按模型最大单段时长拆分，并保留三段式视频提示词', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true', FREE_MODELS_ONLY: 'false', AGNES_API_KEY: 'agnes-media-key',
    AGENT_LLM_API_KEY: 'agent-test-key', AGENT_LLM_BASE_URL: 'https://llm.example/v1', AGENT_LLM_WIRE_API: 'chat_completions',
  });
  let requestBody;
  runtime.fetch = async (url, options = {}) => {
    assert.equal(String(url), 'https://llm.example/v1/chat/completions');
    requestBody = JSON.parse(options.body);
    const first = llmPlan({ duration: 18, timelineDuration: 18 }).shots[0];
    const last = { ...llmPlan({ duration: 18, timelineDuration: 12 }).shots[0], id: 'shot-2', title: '抵达书店' };
    return Response.json({ output_text: JSON.stringify({ ...llmPlan({ duration: 18, timelineDuration: 18 }), shots: [first, last] }) });
  };
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/agent/project-plan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'video', duration: 30, ratio: '9:16', prompt: '30 秒雨夜书店救场短片' }),
  }), runtime);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.creativePlan.shots.map((shot) => [shot.duration, shot.timelineDuration]), [[18, 18], [18, 12]]);
  assert.match(requestBody.messages[1].content, /镜头1=生成18秒、成片保留18秒/);
  assert.match(requestBody.messages[1].content, /镜头2=生成18秒、成片保留12秒/);
  assert.match(data.creativePlan.shots[0].videoPrompt, /【素材引用】[\s\S]*【分段镜头】[\s\S]*【风格画质\+约束】/);
});

test('未配置 Agent LLM 时不会静默退回规则式规划', async () => {
  const runtime = memoryRuntime({ VIDEO_ACCESS_DISABLED: 'true', FREE_MODELS_ONLY: 'false' });
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/agent/project-plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'video', prompt: '一个短片' }),
  }), runtime);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /LLM/);
});

test('Agent 项目接口拒绝图片最终输出', async () => {
  const runtime = memoryRuntime({ VIDEO_ACCESS_DISABLED: 'true', FREE_MODELS_ONLY: 'false' });
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/agent/project-plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'image', prompt: '一张海报' }),
  }), runtime);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /只输出视频/);
});

test('Agent 支持 OpenAI Responses 兼容的结构化输出协议', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true', FREE_MODELS_ONLY: 'false', AGENT_LLM_API_KEY: 'agent-test-key',
    AGENT_LLM_BASE_URL: 'https://responses.example/v1', AGENT_LLM_WIRE_API: 'responses', AGENT_LLM_MODEL: 'planner-model',
  });
  let requestBody;
  runtime.fetch = async (url, options = {}) => {
    assert.equal(String(url), 'https://responses.example/v1/responses');
    requestBody = JSON.parse(options.body);
    return llmResponse();
  };
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/agent/project-plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'video', duration: 5, prompt: '纸飞机短片' }),
  }), runtime);
  assert.equal(response.status, 200);
  assert.equal(requestBody.model, 'planner-model');
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal((await response.json()).planner.provider, 'openai-compatible');
});

test('未显式指定规划服务时，认证失败会回退到下一家 LLM', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true', FREE_MODELS_ONLY: 'false', SUB2API_API_KEY: 'expired-key', ZHIPU_API_KEY: 'working-key',
  });
  const calls = [];
  runtime.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('ctmoai.com')) return Response.json({ error: { message: 'Invalid API key' } }, { status: 401 });
    return llmResponse();
  };
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/agent/project-plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'video', duration: 5, prompt: '纸飞机短片' }),
  }), runtime);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['https://ctmoai.com/v1/responses', 'https://open.bigmodel.cn/api/paas/v4/chat/completions']);
  assert.equal((await response.json()).planner.provider, 'zhipu');
});

test('显式 Agent LLM 限流时会使用备用服务的默认模型继续规划', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true', FREE_MODELS_ONLY: 'false',
    AGENT_LLM_API_KEY: 'limited-key', AGENT_LLM_BASE_URL: 'https://agnes-llm.example/v1', AGENT_LLM_MODEL: 'agnes-2.5-flash', AGENT_LLM_WIRE_API: 'chat_completions',
    DASHSCOPE_API_KEY: 'fallback-key',
  });
  const calls = [];
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).includes('agnes-llm.example')) return Response.json({ error: { message: 'rate limited' } }, { status: 429 });
    return llmResponse();
  };
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/agent/project-plan', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'video', duration: 5, prompt: '纸飞机短片' }),
  }), runtime);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.url), ['https://agnes-llm.example/v1/chat/completions', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions']);
  assert.equal(calls[1].body.model, 'qwen-plus');
  assert.equal((await response.json()).planner.provider, 'dashscope');
});

test('创作 Agent 可先制定服务端计划，且不会创建供应商任务', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true',
    FREE_MODELS_ONLY: 'false',
    DASHSCOPE_API_KEY: 'dashscope-test-key',
  });
  let upstreamCalls = 0;
  runtime.fetch = async (url) => {
    upstreamCalls += 1;
    if (String(url).includes('/chat/completions')) return llmResponse({ duration: 10, timelineDuration: 7 });
    throw new Error('计划阶段不应调用供应商');
  };

  const response = await handleVideoApiRequest(new Request('https://studio.example/api/agent/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'video',
      source: 'script',
      style: '2D 动漫',
      ratio: '16:9',
      duration: 7,
      prompt: '5 秒动画：纸飞机穿过夜色城市，镜头向上跟随',
    }),
  }), runtime);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.agentPlan.kind, 'video');
  assert.equal(data.agentPlan.modelId, 'wan2.7-t2v');
  assert.equal(data.agentPlan.brief.source, 'script');
  assert.equal(data.agentPlan.brief.style, '2D 动漫');
  assert.deepEqual(data.agentPlan.output, { ratio: '16:9', duration: 10, resolution: '720P' });
  assert.match(data.planId, /^[a-f0-9-]{36}$/);
  assert.equal(upstreamCalls, 1);
});

test('创作 Agent 只执行已审核的计划，且执行模型不会重新规划', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true',
    FREE_MODELS_ONLY: 'false',
    DASHSCOPE_API_KEY: 'dashscope-test-key',
  });
  const calls = [];
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/chat/completions')) return llmResponse();
    return Response.json({ output: { task_id: 'planned-agent-task', task_status: 'PENDING' } });
  };

  const preview = await handleVideoApiRequest(new Request('https://studio.example/api/agent/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'video', prompt: '纸飞机穿过夜色城市，镜头向上跟随' }),
  }), runtime);
  const { planId, agentPlan } = await preview.json();

  const rawGenerate = await handleVideoApiRequest(new Request('https://studio.example/api/agent/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'image', prompt: '这不应重新规划为图片' }),
  }), runtime);
  assert.equal(rawGenerate.status, 400);

  const generated = await handleVideoApiRequest(new Request('https://studio.example/api/agent/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId }),
  }), runtime);
  assert.equal(generated.status, 202);
  assert.equal((await generated.json()).agentPlan.modelId, agentPlan.modelId);
  assert.equal(calls.length, 2);
});

test('创作 Agent 端点生成视频，并仅为视频流程创建中间图片资产', async () => {
  const calls = [];
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true',
    FREE_MODELS_ONLY: 'false',
    DASHSCOPE_API_KEY: 'dashscope-test-key',
  });
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/chat/completions')) {
      return llmResponse({ target: 'video' });
    }
    return Response.json({ output: { task_id: `agent-task-${calls.length}`, task_status: 'PENDING' } });
  };

  const videoPlanResponse = await handleVideoApiRequest(new Request('https://studio.example/api/agent/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'video',
      prompt: '5 秒动画：纸飞机穿过夜色城市，镜头向上跟随',
    }),
  }), runtime);
  const { planId: videoPlanId } = await videoPlanResponse.json();

  const videoResponse = await handleVideoApiRequest(new Request('https://studio.example/api/agent/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: videoPlanId }),
  }), runtime);
  assert.equal(videoResponse.status, 202);
  const video = await videoResponse.json();
  assert.equal(video.provider, 'dashscope');
  assert.equal(video.agentPlan.kind, 'video');
  assert.equal(video.agentPlan.modelId, 'wan2.7-t2v');

  const imagePlanResponse = await handleVideoApiRequest(new Request('https://studio.example/api/agent/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: 'image',
      assetRole: 'intermediate',
      promptPrepared: true,
      prompt: '2D 动漫风格的纸飞机主题海报，蓝色夜空与霓虹城市',
    }),
  }), runtime);
  const { planId: imagePlanId } = await imagePlanResponse.json();

  const imageResponse = await handleVideoApiRequest(new Request('https://studio.example/api/agent/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: imagePlanId }),
  }), runtime);
  assert.equal(imageResponse.status, 202);
  const image = await imageResponse.json();
  assert.equal(image.provider, 'dashscope');
  assert.equal(image.agentPlan.kind, 'image');
  assert.equal(image.agentPlan.modelId, 'wan2.7-image-pro');
  assert.equal(calls.filter((call) => !call.url.includes('/chat/completions')).length, 2);
  assert.equal(calls.filter((call) => call.url.includes('/chat/completions')).length, 1);
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer dashscope-test-key'));
});

test('本地成片接口只在提供拼接器时合并已审核的视频地址，并提供可播放结果', async () => {
  const runtime = memoryRuntime({ VIDEO_ACCESS_DISABLED: 'true' });
  let receivedUrls = [];
  let receivedOptions = null;
  runtime.composeVideos = async (urls, options) => {
    receivedUrls = urls;
    receivedOptions = options;
    return new Uint8Array([0, 1, 2, 3]);
  };
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/video-compositions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoUrls: ['https://media.aliyuncs.com/clip-1.mp4', 'https://media.aliyuncs.com/clip-2.mp4'], targetDuration: 21 }),
  }), runtime);
  assert.equal(response.status, 201);
  const composed = await response.json();
  assert.deepEqual(receivedUrls, ['https://media.aliyuncs.com/clip-1.mp4', 'https://media.aliyuncs.com/clip-2.mp4']);
  assert.deepEqual(receivedOptions, { targetDuration: 21 });
  assert.equal(composed.clipCount, 2);
  assert.equal(composed.targetDuration, 21);

  const playable = await handleVideoApiRequest(new Request(composed.videoUrl), runtime);
  assert.equal(playable.status, 200);
  assert.equal(playable.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(new Uint8Array(await playable.arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
});
