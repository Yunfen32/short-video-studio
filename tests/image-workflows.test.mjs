import test from 'node:test';
import assert from 'node:assert/strict';

import { getImageModel, inferImageWorkflow } from '../shared/image-models.mjs';
import {
  buildDashscopeImageRequest,
  handleVideoApiRequest,
  prepareImageRequest,
  validateImageRequest,
} from '../shared/video-api.mjs';

function memoryRuntime(env = {}) {
  const values = new Map();
  return {
    getEnv: (key) => env[key],
    clientId: 'image-test-client',
    storage: {
      async getJSON(key) { return values.has(key) ? structuredClone(values.get(key)) : null; },
      async setJSON(key, value) { values.set(key, structuredClone(value)); },
      async put() {},
      async get() { return null; },
      async cleanupExpired() {},
    },
  };
}

const baseRequest = {
  model: 'wan2.7-image-pro',
  workflow: 'text-to-image',
  prompt: '一盏银色台灯放在黑色石材桌面上，柔和棚拍光线',
  quality: '2K',
  count: 2,
  watermark: false,
  images: [],
};

test('万相图片模型按文生图和参考图编辑约束素材与清晰度', () => {
  const pro = getImageModel('wan2.7-image-pro');
  const text = prepareImageRequest(pro, baseRequest);
  assert.equal(validateImageRequest(pro, text), null);
  assert.equal(inferImageWorkflow({ images: [] }), 'text-to-image');
  assert.equal(inferImageWorkflow({ images: ['https://assets.example.com/source.png'] }), 'image-edit');

  const edit = prepareImageRequest(pro, {
    ...baseRequest,
    workflow: 'image-edit',
    images: ['https://assets.example.com/source.png', 'https://assets.example.com/style.png'],
  });
  assert.equal(validateImageRequest(pro, edit), null);
  assert.equal(buildDashscopeImageRequest(pro, edit).payload.input.messages[0].content.length, 3);

  const invalid4kEdit = prepareImageRequest(pro, { ...baseRequest, workflow: 'image-edit', quality: '4K', images: ['https://assets.example.com/source.png'] });
  assert.equal(validateImageRequest(pro, invalid4kEdit), '参考图编辑最高支持 2K');
});

test('图片任务使用服务端密钥创建、轮询并返回全部图片 URL', async () => {
  const runtime = memoryRuntime({ VIDEO_ACCESS_TOKEN: 'studio-secret', DASHSCOPE_API_KEY: 'dashscope-server-key' });
  const calls = [];
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (options.method === 'POST') return Response.json({ output: { task_id: 'image-task-12345678', task_status: 'PENDING' } });
    return Response.json({
      output: {
        task_id: 'image-task-12345678',
        task_status: 'SUCCEEDED',
        choices: [{ message: { content: [
          { image: 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/first.png' },
          { image: 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/second.png' },
        ] } }],
      },
      usage: { size: '2K' },
    });
  };
  const headers = { authorization: 'Bearer studio-secret', 'content-type': 'application/json' };
  const created = await handleVideoApiRequest(new Request('https://studio.example/api/images', {
    method: 'POST', headers, body: JSON.stringify(baseRequest),
  }), runtime);
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), {
    taskId: 'image-task-12345678', provider: 'dashscope', modelId: 'wan2.7-image-pro', status: 'PENDING',
  });
  const createPayload = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation');
  assert.equal(createPayload.parameters.size, '2K');
  assert.equal(createPayload.parameters.n, 2);
  assert.equal(createPayload.input.messages[0].content.at(-1).text, baseRequest.prompt);

  const statusResponse = await handleVideoApiRequest(new Request('https://studio.example/api/images/image-task-12345678', {
    headers: { authorization: 'Bearer studio-secret' },
  }), runtime);
  const status = await statusResponse.json();
  assert.equal(status.status, 'SUCCEEDED');
  assert.equal(status.terminal, true);
  assert.deepEqual(status.imageUrls, [
    'https://dashscope-result.oss-cn-beijing.aliyuncs.com/first.png',
    'https://dashscope-result.oss-cn-beijing.aliyuncs.com/second.png',
  ]);
});

test('图片接口沿用访问令牌保护', async () => {
  const runtime = memoryRuntime({ VIDEO_ACCESS_TOKEN: 'studio-secret', DASHSCOPE_API_KEY: 'dashscope-server-key' });
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/images', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(baseRequest),
  }), runtime);
  assert.equal(response.status, 401);
});
