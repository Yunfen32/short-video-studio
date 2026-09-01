import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSiliconFlowImageModel,
  buildSiliconFlowImageRequest,
  buildSiliconFlowVideoModel,
  buildSiliconFlowVideoRequest,
  getSiliconFlowCatalog,
  siliconFlowImageUrls,
} from '../shared/siliconflow-models.mjs';
import { isFreeImageModel } from '../shared/free-models.mjs';
import { handleVideoApiRequest } from '../shared/video-api.mjs';

function runtimeWithFetch(fetch, environment = {}) {
  const values = new Map();
  return {
    getEnv: (key) => ({
      SILICONFLOW_API_KEY: 'test-key',
      SILICONFLOW_API_BASE: 'https://siliconflow.test/v1',
      FREE_MODELS_ONLY: 'false',
      VIDEO_ACCESS_DISABLED: 'true',
      ...environment,
    }[key] || ''),
    fetch,
    clientId: 'siliconflow-test-client',
    now: () => 1_800_000_000_000,
    storage: {
      async getJSON(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
      async setJSON(key, value) { values.set(key, structuredClone(value)); },
    },
  };
}

function modelCatalogResponse(type) {
  return Response.json({
    data: type === 'video'
      ? [{ id: 'Wan-AI/Wan2.2-T2V-A14B' }, { id: 'Wan-AI/Wan2.2-I2V-A14B' }]
      : [{ id: 'Tongyi-MAI/Z-Image' }, { id: 'Qwen/Qwen-Image-Edit' }, { id: 'Kwai-Kolors/Kolors' }],
  });
}

test('SiliconFlow 动态目录映射全部图片和视频模型能力', async () => {
  const catalog = await getSiliconFlowCatalog(runtimeWithFetch(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/models') return modelCatalogResponse(parsed.searchParams.get('type'));
    throw new Error('unexpected request');
  }), { force: true });

  assert.equal(catalog.videoModels.length, 2);
  assert.deepEqual(catalog.videoModels[0].workflowCapabilities, {
    'text-to-video': catalog.videoModels[0].workflowCapabilities['text-to-video'],
  });
  assert.equal(catalog.videoModels[1].workflowCapabilities['first-frame'].imageMode, 'first_frame');
  assert.deepEqual(catalog.imageModels[0].workflows, ['text-to-image']);
  assert.deepEqual(catalog.imageModels[1].workflows, ['text-to-image', 'image-edit']);
  assert.equal(catalog.imageModels[2].maxOutputs, 4);
  assert.equal(catalog.imageModels[0].isFree, false);
  assert.equal(catalog.imageModels[2].isFree, true);
  assert.equal(isFreeImageModel(catalog.imageModels[2]), true);
  assert.equal(isFreeImageModel(catalog.imageModels[0]), false);
});

test('SiliconFlow 不会把未知视频模型猜测为文生视频', () => {
  assert.equal(buildSiliconFlowVideoModel({ id: 'Vendor/Experimental-Video' }), null);
});

test('免费模式只展示并允许调用已确认免费的 SiliconFlow 生图模型', async () => {
  const calls = [];
  const runtime = runtimeWithFetch(async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.pathname);
    if (parsed.pathname === '/v1/models') return modelCatalogResponse(parsed.searchParams.get('type'));
    throw new Error('不应向上游创建付费任务');
  }, { FREE_MODELS_ONLY: 'true', DOTS_API_KEY: 'dots-server-only-key' });

  const models = await handleVideoApiRequest(new Request('https://studio.example/api/models'), runtime);
  const payload = await models.json();
  assert.equal(payload.siliconflow.freeVideoModelCount, 0);
  assert.equal(payload.siliconflow.freeImageModelCount, 1);
  assert.ok(payload.imageModels.some((model) => model.id === 'Kwai-Kolors/Kolors'));
  assert.ok(!payload.imageModels.some((model) => model.id === 'Tongyi-MAI/Z-Image'));
  assert.deepEqual(payload.dots, {
    configured: true,
    mediaGenerationSupported: false,
    message: 'Dots 当前仅支持多模态理解，不提供图片或视频生成模型',
  });

  const paidRequest = await handleVideoApiRequest(new Request('https://studio.example/api/images', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'Tongyi-MAI/Z-Image', workflow: 'text-to-image', prompt: '不应收费', quality: '1K', count: 1 }),
  }), runtime);
  assert.equal(paidRequest.status, 403);
  assert.equal((await paidRequest.json()).paidModelBlocked, true);
  assert.ok(!calls.includes('/v1/images/generations'));
});

test('SiliconFlow 请求字段分别符合文生视频、首帧和图片生成协议', () => {
  const t2v = buildSiliconFlowVideoModel({ id: 'Wan-AI/Wan2.2-T2V-A14B' });
  const i2v = buildSiliconFlowVideoModel({ id: 'Wan-AI/Wan2.2-I2V-A14B' });
  const t2vRequest = buildSiliconFlowVideoRequest(t2v, { prompt: 'anime city', ratio: '9:16', negativePrompt: '', seed: null });
  const i2vRequest = buildSiliconFlowVideoRequest(i2v, { prompt: 'animate', ratio: '16:9', negativePrompt: '', seed: 7 }, 'data:image/png;base64,AA==');
  assert.deepEqual(t2vRequest, { model: t2v.id, prompt: 'anime city', image_size: '720x1280' });
  assert.equal(i2vRequest.image, 'data:image/png;base64,AA==');
  assert.equal(i2vRequest.seed, 7);

  const imageModel = buildSiliconFlowImageModel({ id: 'Qwen/Qwen-Image-Edit' });
  const imageRequest = buildSiliconFlowImageRequest(imageModel, {
    prompt: '改成夜景', quality: '1K', count: 1, images: ['https://assets.example/one.png', 'https://assets.example/two.png'],
  });
  assert.equal(imageRequest.image, 'https://assets.example/one.png');
  assert.equal(imageRequest.image2, 'https://assets.example/two.png');
  assert.deepEqual(siliconFlowImageUrls({ images: [{ url: 'https://cdn.example/result.png' }] }), ['https://cdn.example/result.png']);
});

test('SiliconFlow 视频提交、状态轮询和图片同步结果统一任务协议', async () => {
  const calls = [];
  const runtime = runtimeWithFetch(async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ pathname: parsed.pathname, options });
    if (parsed.pathname === '/v1/models') return modelCatalogResponse(parsed.searchParams.get('type'));
    if (parsed.pathname === '/v1/video/submit') return Response.json({ requestId: 'sf-video-task' });
    if (parsed.pathname === '/v1/video/status') return Response.json({ status: 'Succeed', results: { videos: [{ url: 'https://siliconflow.cn/result.mp4' }] } });
    if (parsed.pathname === '/v1/images/generations') return Response.json({ images: [{ url: 'https://siliconflow.cn/result.png' }] });
    throw new Error('unexpected request: ' + url);
  });

  const video = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'Wan-AI/Wan2.2-T2V-A14B', workflow: 'text-to-video', prompt: '2D anime sunrise', duration: 5, resolution: '720P', ratio: '16:9' }),
  }), runtime);
  assert.equal(video.status, 202);
  assert.deepEqual(await video.json(), { taskId: 'sf-video-task', provider: 'siliconflow', modelId: 'Wan-AI/Wan2.2-T2V-A14B', status: 'PENDING' });

  const status = await handleVideoApiRequest(new Request('https://studio.example/api/videos/sf-video-task?provider=siliconflow'), runtime);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).videoUrl, 'https://siliconflow.cn/result.mp4');

  const image = await handleVideoApiRequest(new Request('https://studio.example/api/images', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'Tongyi-MAI/Z-Image', workflow: 'text-to-image', prompt: '2D anime girl under cherry blossoms', quality: '1K', count: 1 }),
  }), runtime);
  assert.equal(image.status, 202);
  assert.deepEqual((await image.json()).imageUrls, ['https://siliconflow.cn/result.png']);
  assert.ok(calls.some((call) => call.pathname === '/v1/video/submit'));
  assert.ok(calls.some((call) => call.pathname === '/v1/video/status'));
  assert.ok(calls.some((call) => call.pathname === '/v1/images/generations'));
});

