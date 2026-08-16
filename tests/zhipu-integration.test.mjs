import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildZhipuImageRequest,
  buildZhipuVideoRequest,
  handleVideoApiRequest,
} from '../shared/video-api.mjs';
import { IMAGE_MODELS, getImageModel } from '../shared/image-models.mjs';
import { VIDEO_MODELS } from '../shared/video-models.mjs';

function memoryRuntime(env = {}) {
  const values = new Map();
  return {
    getEnv: (key) => env[key],
    clientId: 'zhipu-test-client',
    now: () => 1_800_000_000_000,
    storage: {
      async getJSON(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
      async setJSON(key, value) { values.set(key, structuredClone(value)); },
      async put(key, body, metadata = {}) { values.set(key, { body, ...metadata }); },
      async get(key) { return values.get(key) || null; },
      async cleanupExpired() {},
    },
  };
}

const authEnv = {
  VIDEO_ACCESS_DISABLED: 'true',
  VIDEO_RATE_LIMIT_DISABLED: 'true',
  ZHIPU_API_KEY: 'zhipu-server-key',
};

test('Zhipu model catalog only exposes the free image and video models', () => {
  assert.deepEqual(IMAGE_MODELS.filter((model) => model.provider === 'zhipu').map((model) => model.id), ['cogview-3-flash']);
  assert.deepEqual(VIDEO_MODELS.filter((model) => model.provider === 'zhipu').map((model) => model.id), ['cogvideox-flash']);
  assert.equal(getImageModel('glm-image'), null);
});

test('Zhipu video request omits image fields for text-to-video and maps output settings', () => {
  const request = buildZhipuVideoRequest(
    { id: 'cogvideox-flash', outputAudio: true },
    { prompt: 'A paper boat crossing a moonlit lake', duration: 5, resolution: '1080P', ratio: '16:9', watermark: false },
  );
  assert.deepEqual(request, {
    model: 'cogvideox-flash',
    prompt: 'A paper boat crossing a moonlit lake',
    quality: 'speed',
    with_audio: true,
    watermark_enabled: false,
    size: '1920x1080',
    fps: 30,
    duration: 5,
  });
});

test('Zhipu free image requests use the correct sync model parameters', () => {
  assert.deepEqual(buildZhipuImageRequest(
    { id: 'cogview-3-flash', zhipuSize: '1344x768' },
    { prompt: 'A bright paper collage', quality: '2K', watermark: false },
  ), {
    model: 'cogview-3-flash',
    prompt: 'A bright paper collage',
    size: '1344x768',
  });

});

test('Zhipu video create and async status return the shared task contract', async () => {
  const runtime = memoryRuntime(authEnv);
  const calls = [];
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST') return Response.json({ id: 'zhipu-video-task', task_status: 'PROCESSING' });
    return Response.json({
      task_status: 'SUCCESS',
      video_result: [{ url: 'https://sfile.chatglm.cn/result.mp4' }],
    });
  };

  const create = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    body: JSON.stringify({
      model: 'cogvideox-flash',
      workflow: 'text-to-video',
      prompt: 'A paper boat crossing a moonlit lake',
      duration: 5,
      resolution: '720P',
      ratio: '16:9',
      watermark: false,
      images: [],
    }),
  }), runtime);
  assert.equal(create.status, 202);
  assert.deepEqual(await create.json(), {
    taskId: 'zhipu-video-task',
    provider: 'zhipu',
    modelId: 'cogvideox-flash',
    status: 'RUNNING',
  });
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/videos/generations');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer zhipu-server-key');
  assert.equal(JSON.parse(calls[0].options.body).image_url, undefined);

  const status = await handleVideoApiRequest(new Request('https://studio.example/api/videos/zhipu-video-task?provider=zhipu'), runtime);
  assert.deepEqual(await status.json(), {
    taskId: 'zhipu-video-task',
    provider: 'zhipu',
    status: 'SUCCEEDED',
    terminal: true,
    videoUrl: 'https://sfile.chatglm.cn/result.mp4',
    progress: 100,
    seconds: null,
    size: null,
    error: null,
  });
});

test('local Zhipu image-to-video requests keep uploaded references as Base64', async () => {
  const runtime = memoryRuntime(authEnv);
  runtime.inlineReferenceImages = true;
  let payload;
  runtime.fetch = async (url, options = {}) => {
    payload = JSON.parse(options.body);
    return Response.json({ id: 'zhipu-inline-task', task_status: 'PROCESSING' });
  };

  const response = await handleVideoApiRequest(new Request('http://127.0.0.1:5173/api/videos', {
    method: 'POST',
    body: JSON.stringify({
      model: 'cogvideox-flash',
      workflow: 'first-frame',
      prompt: '让画面动起来',
      duration: 5,
      resolution: '720P',
      ratio: '16:9',
      images: [{ source: 'data:image/png;base64,iVBORw==', role: 'first_frame' }],
    }),
  }), runtime);
  assert.equal(response.status, 202);
  assert.equal(payload.image_url, 'data:image/png;base64,iVBORw==');
});

test('Zhipu free image task returns image URLs without mixing DashScope polling', async () => {
  const runtime = memoryRuntime(authEnv);
  const calls = [];
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/images/generations')) {
      return Response.json({ data: [{ url: 'https://sfile.chatglm.cn/cogview.png' }] });
    }
    return Response.json({ task_status: 'SUCCESS', data: [{ url: 'https://sfile.chatglm.cn/cogview.png' }] });
  };

  const syncCreate = await handleVideoApiRequest(new Request('https://studio.example/api/images', {
    method: 'POST',
    body: JSON.stringify({ model: 'cogview-3-flash', workflow: 'text-to-image', prompt: 'A bright paper collage', quality: '2K', count: 1 }),
  }), runtime);
  assert.equal(syncCreate.status, 202);
  assert.deepEqual(await syncCreate.json(), {
    taskId: null,
    provider: 'zhipu',
    modelId: 'cogview-3-flash',
    status: 'SUCCEEDED',
    terminal: true,
    imageUrls: ['https://sfile.chatglm.cn/cogview.png'],
  });

  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/images/generations');
});
