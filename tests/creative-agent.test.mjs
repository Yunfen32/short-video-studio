import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_MODELS } from '../shared/image-models.mjs';
import { buildCreativeAgentPlan } from '../shared/creative-agent.mjs';
import { handleVideoApiRequest } from '../shared/video-api.mjs';
import { VIDEO_MODELS } from '../shared/video-models.mjs';

function memoryRuntime(env = {}) {
  const values = new Map();
  return {
    getEnv: (key) => env[key] || '',
    clientId: 'creative-agent-test',
    now: () => 1_800_000_000_000,
    storage: {
      async getJSON(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
      async setJSON(key, value) { values.set(key, structuredClone(value)); },
    },
  };
}

test('创作 Agent 会根据目标与描述生成图片或视频的可执行计划', () => {
  const catalog = { videoModels: VIDEO_MODELS, imageModels: IMAGE_MODELS };
  const imagePlan = buildCreativeAgentPlan({
    prompt: '2D 动漫风格的雨夜书店海报，暖黄色窗光，角色坐在窗边阅读',
    target: 'auto',
  }, catalog);
  assert.equal(imagePlan.kind, 'image');
  assert.equal(imagePlan.workflow, 'text-to-image');
  assert.equal(imagePlan.request.model, 'wan2.7-image-pro');
  assert.equal(imagePlan.request.quality, '2K');
  assert.match(imagePlan.request.prompt, /构图完整/);

  const videoPlan = buildCreativeAgentPlan({
    prompt: '5 秒 2D 动漫短片：少女推开书店门，镜头从街道平移到室内',
    target: 'auto',
  }, catalog);
  assert.equal(videoPlan.kind, 'video');
  assert.equal(videoPlan.workflow, 'text-to-video');
  assert.equal(videoPlan.request.model, 'wan2.7-t2v');
  assert.equal(videoPlan.request.duration, 5);
  assert.equal(videoPlan.request.ratio, '9:16');
  assert.match(videoPlan.request.prompt, /动作自然/);
});

test('创作 Agent 将项目来源、视觉风格和视频输出偏好写入可执行计划', () => {
  const catalog = { videoModels: VIDEO_MODELS, imageModels: IMAGE_MODELS };
  const plan = buildCreativeAgentPlan({
    target: 'video',
    source: 'script',
    style: '2D 动漫',
    ratio: '16:9',
    duration: 10,
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
  assert.match(plan.request.prompt, /视觉风格为2D 动漫/);
});

test('创作 Agent 可先制定服务端计划，且不会创建供应商任务', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true',
    FREE_MODELS_ONLY: 'false',
    DASHSCOPE_API_KEY: 'dashscope-test-key',
  });
  let upstreamCalls = 0;
  runtime.fetch = async () => {
    upstreamCalls += 1;
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
  assert.deepEqual(data.agentPlan.output, { ratio: '16:9', duration: 7, resolution: '720P' });
  assert.match(data.planId, /^[a-f0-9-]{36}$/);
  assert.equal(upstreamCalls, 0);
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
  assert.equal(calls.length, 1);
});

test('创作 Agent 端点沿用已有的图片和视频创建权限与任务协议', async () => {
  const calls = [];
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true',
    FREE_MODELS_ONLY: 'false',
    DASHSCOPE_API_KEY: 'dashscope-test-key',
  });
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
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
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer dashscope-test-key'));
});
