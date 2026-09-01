import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVideoModel,
  getWorkflowCapability,
  inferVideoWorkflow,
  supportsWorkflow,
  VIDEO_MODELS,
} from '../shared/video-models.mjs';
import { getImageModel } from '../shared/image-models.mjs';
import {
  buildAgnesPayload,
  buildAgnesImageRequest,
  buildDashscopeRequest,
  buildGrokVideoRequest,
  buildZhipuVideoRequest,
  handleVideoApiRequest,
  normalizePromptMentions,
  prepareImageRequest,
  prepareRequestData,
  quotaIsExhausted,
  validateRequest,
} from '../shared/video-api.mjs';

const BASE_REQUEST = {
  prompt: '人物沿着街道向前走',
  duration: 5,
  resolution: '720P',
  ratio: '16:9',
  watermark: false,
  promptExtend: true,
  negativePrompt: '',
  seed: null,
  audioUrl: '',
  videoUrl: '',
  animationMode: 'wan-std',
};

const image = (name, role = 'character') => ({
  source: 'https://assets.example.com/' + name + '.jpg',
  role,
});

function memoryRuntime(env = {}) {
  const values = new Map();
  return {
    getEnv: (key) => env[key],
    clientId: 'test-client',
    now: () => 1_800_000_000_000,
    storage: {
      async getJSON(key) {
        return values.has(key) ? structuredClone(values.get(key)) : null;
      },
      async setJSON(key, value) {
        values.set(key, structuredClone(value));
      },
      async put(key, body, metadata = {}) {
        values.set(key, { body, ...metadata });
      },
      async get(key) {
        return values.get(key) || null;
      },
      async cleanupExpired() {},
    },
  };
}

test('共享 API 在两个托管入口使用同一模型目录和访问保护', async () => {
  for (const platform of ['netlify', 'sites']) {
    const runtime = { ...memoryRuntime({ VIDEO_ACCESS_TOKEN: 'studio-secret' }), platform };
    const models = await handleVideoApiRequest(new Request('https://studio.example/api/models'), runtime);
    assert.equal(models.status, 200);
    assert.equal((await models.json()).accessRequired, true);

    const denied = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'wan2.7-t2v' }),
    }), runtime);
    assert.equal(denied.status, 401);
  }
});

test('免费模型保护只暴露并允许免费视频模型', async () => {
  const runtime = memoryRuntime({ VIDEO_ACCESS_DISABLED: 'true', FREE_MODELS_ONLY: 'true', ZHIPU_API_KEY: 'zhipu-key' });
  const modelsResponse = await handleVideoApiRequest(new Request('https://studio.example/api/models'), runtime);
  const availability = await modelsResponse.json();
  assert.equal(availability.freeOnly, true);
  assert.equal(availability.availableCount, 1);
  assert.equal(availability.imageAvailableCount, 1);

  const paidAttempt = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    body: JSON.stringify({ model: 'wan2.7-t2v', workflow: 'text-to-video', prompt: 'test' }),
  }), runtime);
  assert.equal(paidAttempt.status, 403);
  assert.equal((await paidAttempt.json()).paidModelBlocked, true);
});

test('模型目录只返回服务端已配置的供应商模型', async () => {
  const runtime = memoryRuntime({ VIDEO_ACCESS_DISABLED: 'true', FREE_MODELS_ONLY: 'false', ZHIPU_API_KEY: 'zhipu-key' });
  const response = await handleVideoApiRequest(new Request('https://studio.example/api/models'), runtime);
  const availability = await response.json();

  assert.ok(availability.videoModels.length > 0);
  assert.ok(availability.imageModels.length > 0);
  assert.ok(availability.videoModels.every((model) => model.provider === 'zhipu'));
  assert.ok(availability.imageModels.every((model) => model.provider === 'zhipu'));
});

test('Grok 视频模型需要显式启用经过验证的视频协议', async () => {
  const disabledRuntime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true',
    FREE_MODELS_ONLY: 'false',
    SUB2API_API_KEY: 'sub2api-key',
  });
  const disabledCatalog = await handleVideoApiRequest(new Request('https://studio.example/api/models'), disabledRuntime);
  assert.equal((await disabledCatalog.json()).videoModels.some((model) => model.provider === 'sub2api_grok'), false);
  const disabledCreate = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'grok-imagine-video', workflow: 'text-to-video', prompt: '不应调用未验证协议' }),
  }), disabledRuntime);
  assert.equal(disabledCreate.status, 503);

  const enabledRuntime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true',
    FREE_MODELS_ONLY: 'false',
    SUB2API_API_KEY: 'sub2api-key',
    SUB2API_GROK_VIDEO_ENABLED: 'true',
  });
  const enabledCatalog = await handleVideoApiRequest(new Request('https://studio.example/api/models'), enabledRuntime);
  assert.equal((await enabledCatalog.json()).videoModels.some((model) => model.provider === 'sub2api_grok'), true);
});

test('Agnes 免费图片模型使用服务端密钥并支持参考图', async () => {
  const runtime = memoryRuntime({ VIDEO_ACCESS_DISABLED: 'true', FREE_MODELS_ONLY: 'true', AGNES_API_KEY: 'agnes-key' });
  const calls = [];
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return Response.json({ data: [{ url: 'https://cdn.example.com/agnes-image.png' }] });
  };

  const created = await handleVideoApiRequest(new Request('https://studio.example/api/images', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'agnes-image-2.1-flash',
      workflow: 'image-edit',
      prompt: '把背景改成夜晚的城市灯光',
      images: ['https://assets.example.com/reference.png'],
      quality: '2K',
      count: 1,
    }),
  }), runtime);
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), {
    taskId: null,
    provider: 'agnes',
    modelId: 'agnes-image-2.1-flash',
    status: 'SUCCEEDED',
    terminal: true,
    imageUrls: ['https://cdn.example.com/agnes-image.png'],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://apihub.agnes-ai.com/v1/images/generations');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.model, 'agnes-image-2.1-flash');
  assert.deepEqual(payload.extra_body.image, ['https://assets.example.com/reference.png']);
  assert.equal(payload.extra_body.response_format, 'url');
});

test('Netlify 与 Sites 入口都能加载共享后端适配器', async () => {
  const [netlify, sites] = await Promise.all([
    import('../netlify/functions/videos.mjs'),
    import('../worker/index.js'),
  ]);
  assert.equal(typeof netlify.default, 'function');
  assert.equal(typeof sites.default?.fetch, 'function');
});

test('阿里与 Agnes 创建和轮询结果统一为任务状态协议', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_TOKEN: 'studio-secret',
    DASHSCOPE_API_KEY: 'dashscope-server-key',
    AGNES_API_KEY: 'agnes-server-key',
  });
  const calls = [];
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/v1/videos')) {
      return Response.json({
        task_id: 'agnes-task-12345678',
        video_id: 'agnes-video-12345678',
        status: 'queued',
      });
    }
    if (String(url).includes('/agnesapi?video_id=')) {
      return Response.json({
        task_id: 'agnes-task-12345678',
      video_id: 'agnes-video-12345678',
      status: 'completed',
      progress: 100,
      metadata: { url: 'https://platform-outputs.agnes-ai.space/videos/result.mp4' },
      seconds: '5.0',
        size: '1280x720',
      });
    }
    if (options.method === 'POST') {
      return Response.json({ output: { task_id: 'dash-task-12345678', task_status: 'PENDING' } });
    }
    return Response.json({
      output: {
        task_id: 'dash-task-12345678',
        task_status: 'SUCCEEDED',
        video_url: 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/result.mp4',
      },
      usage: { output_video_duration: 5, size: '1280x720' },
    });
  };
  const headers = { authorization: 'Bearer studio-secret', 'content-type': 'application/json' };

  const dashCreate = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...BASE_REQUEST, model: 'wan2.7-t2v', workflow: 'text-to-video', images: [] }),
  }), runtime);
  assert.equal(dashCreate.status, 202);
  assert.deepEqual(await dashCreate.json(), {
    taskId: 'dash-task-12345678',
    provider: 'dashscope',
    modelId: 'wan2.7-t2v',
    status: 'PENDING',
  });

  const dashStatus = await handleVideoApiRequest(new Request(
    'https://studio.example/api/videos/dash-task-12345678?provider=dashscope',
    { headers: { authorization: 'Bearer studio-secret' } },
  ), runtime);
  const dashResult = await dashStatus.json();
  assert.equal(dashResult.status, 'SUCCEEDED');
  assert.equal(dashResult.terminal, true);
  assert.equal(dashResult.seconds, 5);
  assert.equal(dashResult.size, '1280x720');

  const agnesCreate = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...BASE_REQUEST, model: 'agnes-video-v2.0', workflow: 'text-to-video', images: [] }),
  }), runtime);
  assert.equal(agnesCreate.status, 202);
  const agnesTask = await agnesCreate.json();
  assert.equal(agnesTask.taskId, 'agnes-task-12345678');
  assert.equal(agnesTask.videoId, 'agnes-video-12345678');
  assert.equal(agnesTask.provider, 'agnes');

  const agnesStatus = await handleVideoApiRequest(new Request(
    'https://studio.example/api/videos/agnes-task-12345678?provider=agnes&video_id=agnes-video-12345678',
    { headers: { authorization: 'Bearer studio-secret' } },
  ), runtime);
  const agnesResult = await agnesStatus.json();
  assert.equal(agnesResult.status, 'SUCCEEDED');
  assert.equal(agnesResult.terminal, true);
  assert.equal(agnesResult.videoUrl, 'https://platform-outputs.agnes-ai.space/videos/result.mp4');
  assert.equal(agnesResult.seconds, '5.0');
  assert.ok(calls.every((call) => call.options.headers?.Authorization));
});

test('Sub2API Grok 使用视频任务协议创建并轮询 Grok Imagine Video', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_TOKEN: 'studio-secret',
    SUB2API_API_KEY: 'sub2api-server-key',
    SUB2API_GROK_VIDEO_ENABLED: 'true',
  });
  const calls = [];
  runtime.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/videos/generations')) {
      return Response.json({ request_id: 'grok-request-12345678' });
    }
    if (String(url).endsWith('/videos/grok-request-12345678')) {
      return Response.json({
        status: 'done',
        model: 'grok-imagine-video',
        video: {
          url: 'https://vidgen.x.ai/videos/result.mp4',
          duration: 5,
        },
      });
    }
    return Response.json({ error: { message: 'unexpected request' } }, { status: 500 });
  };
  const headers = { authorization: 'Bearer studio-secret', 'content-type': 'application/json' };
  const created = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...BASE_REQUEST, model: 'grok-imagine-video', workflow: 'text-to-video', images: [] }),
  }), runtime);
  assert.equal(created.status, 202);
  assert.deepEqual(await created.json(), {
    taskId: 'grok-request-12345678',
    provider: 'sub2api_grok',
    modelId: 'grok-imagine-video',
    status: 'PENDING',
  });

  const createdPayload = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, 'https://ctmoai.com/v1/videos/generations');
  assert.equal(createdPayload.model, 'grok-imagine-video');
  assert.equal(createdPayload.aspect_ratio, '16:9');
  assert.equal(createdPayload.resolution, '720p');

  const statusResponse = await handleVideoApiRequest(new Request(
    'https://studio.example/api/videos/grok-request-12345678?provider=sub2api_grok',
    { headers: { authorization: 'Bearer studio-secret' } },
  ), runtime);
  const status = await statusResponse.json();
  assert.equal(status.status, 'SUCCEEDED');
  assert.equal(status.terminal, true);
  assert.equal(status.videoUrl, 'https://vidgen.x.ai/videos/result.mp4');
  assert.equal(status.seconds, 5);
});

test('公共写入和任务接口默认关闭，并校验访问令牌', async () => {
  const unconfigured = memoryRuntime();
  const missingProtection = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }), unconfigured);
  assert.equal(missingProtection.status, 503);
  assert.equal((await missingProtection.json()).accessRequired, true);

  const runtime = memoryRuntime({ VIDEO_ACCESS_TOKEN: 'studio-secret' });
  const wrongToken = await handleVideoApiRequest(new Request('https://studio.example/api/videos/task-12345678'), runtime);
  assert.equal(wrongToken.status, 401);

  const acceptedToken = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    headers: {
      authorization: 'Bearer studio-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'wan2.7-t2v' }),
  }), runtime);
  assert.equal(acceptedToken.status, 503);
  assert.match((await acceptedToken.json()).error, /阿里视频服务尚未配置/);
});

test('公开演示模式会优先于旧访问令牌，但仍通过统一的限流路径', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_DISABLED: 'true',
    VIDEO_ACCESS_TOKEN: 'legacy-studio-secret',
  });
  const models = await handleVideoApiRequest(new Request('https://studio.example/api/models'), runtime);
  const availability = await models.json();
  assert.equal(models.status, 200);
  assert.equal(availability.accessRequired, false);
  assert.equal(availability.directAccess, true);

  const upload = await handleVideoApiRequest(new Request('https://studio.example/api/reference-images', {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: new Uint8Array([137, 80, 78, 71]),
  }), runtime);
  assert.equal(upload.status, 201);
});

test('托管入口未配置访问变量时自动进入公开演示模式', async () => {
  for (const platform of ['netlify', 'sites']) {
    const runtime = { ...memoryRuntime(), platform };
    const models = await handleVideoApiRequest(new Request('https://studio.example/api/models'), runtime);
    const availability = await models.json();
    assert.equal(models.status, 200, platform);
    assert.equal(availability.accessRequired, false, platform);
    assert.equal(availability.freeOnly, true, platform);
    assert.equal(availability.videoModels.some((model) => model.id === 'wan2.7-t2v'), false, platform);
    assert.equal(availability.imageModels.some((model) => model.id === 'wan2.7-image-pro'), false, platform);

    const upload = await handleVideoApiRequest(new Request('https://studio.example/api/reference-images', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([137, 80, 78, 71]),
    }), runtime);
    assert.equal(upload.status, 201, platform);
  }
});

test('Netlify 入口会把 Agent 计划和生成请求交给共享后端', async () => {
  const netlify = await import('../netlify/functions/videos.mjs');
  assert.ok(netlify.config.path.includes('/api/agent/plan'));
  assert.ok(netlify.config.path.includes('/api/agent/generate'));
});

test('上传、生成和下载分别限流，参考图使用私有持有者链接', async () => {
  const runtime = memoryRuntime({
    VIDEO_ACCESS_TOKEN: 'studio-secret',
    VIDEO_UPLOAD_LIMIT_PER_HOUR: '1',
  });
  const headers = { authorization: 'Bearer studio-secret', 'content-type': 'image/png' };
  const upload = await handleVideoApiRequest(new Request('https://studio.example/api/reference-images', {
    method: 'POST',
    headers,
    body: new Uint8Array([137, 80, 78, 71]),
  }), runtime);
  assert.equal(upload.status, 201);
  const uploadedUrl = (await upload.json()).url;

  const privateRead = await handleVideoApiRequest(new Request(uploadedUrl), runtime);
  assert.equal(privateRead.status, 200);
  assert.equal(privateRead.headers.get('content-type'), 'image/png');
  assert.equal(privateRead.headers.get('cache-control'), 'private, no-store');

  const pathOnly = new URL(uploadedUrl);
  pathOnly.search = '';
  const unauthorizedRead = await handleVideoApiRequest(new Request(pathOnly), runtime);
  assert.equal(unauthorizedRead.status, 404);

  const limited = await handleVideoApiRequest(new Request('https://studio.example/api/reference-images', {
    method: 'POST',
    headers,
    body: new Uint8Array([137, 80, 78, 71]),
  }), runtime);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);

  const blockedDownload = await handleVideoApiRequest(new Request(
    'https://studio.example/api/video-download?url=https%3A%2F%2Fexample.com%2Fprivate.mp4',
    { headers: { authorization: 'Bearer studio-secret' } },
  ), runtime);
  assert.equal(blockedDownload.status, 400);
});

test('本地服务可将上传参考图内嵌到真实模型请求中', async () => {
  const runtime = memoryRuntime({ VIDEO_ACCESS_TOKEN: 'studio-secret' });
  runtime.inlineReferenceImages = true;
  const response = await handleVideoApiRequest(new Request('http://127.0.0.1:5173/api/reference-images', {
    method: 'POST',
    headers: { authorization: 'Bearer studio-secret', 'content-type': 'image/png' },
    body: new Uint8Array([137, 80, 78, 71]),
  }), runtime);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).url, 'data:image/png;base64,iVBORw==');
});

test('Base64 参考图执行 4MB 上限，公开图片在 24 小时后失效', async () => {
  const model = getVideoModel('agnes-video-v2.0');
  const oversized = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((4 * 1024 * 1024 + 1) / 3) * 4);
  const data = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'first-frame',
    images: [{ source: oversized, role: 'first_frame' }],
  });
  assert.equal(validateRequest(model, data), '单张参考图不能超过 4MB');

  const start = 1_800_000_000_000;
  const runtime = memoryRuntime({ VIDEO_ACCESS_TOKEN: 'studio-secret' });
  runtime.now = () => start;
  const upload = await handleVideoApiRequest(new Request('https://studio.example/api/reference-images', {
    method: 'POST',
    headers: { authorization: 'Bearer studio-secret', 'content-type': 'image/png' },
    body: new Uint8Array([137, 80, 78, 71]),
  }), runtime);
  const uploadedUrl = (await upload.json()).url;
  runtime.now = () => start + 24 * 60 * 60 * 1000;
  const expired = await handleVideoApiRequest(new Request(uploadedUrl), runtime);
  assert.equal(expired.status, 404);
  assert.equal((await expired.json()).error, '参考图已过期');
});

test('模型只出现在真实支持的工作流中', () => {
  const agnes = getVideoModel('agnes-video-v2.0');
  assert.equal(supportsWorkflow(agnes, 'text-to-video'), true);
  assert.equal(supportsWorkflow(agnes, 'first-frame'), true);
  assert.equal(supportsWorkflow(agnes, 'keyframes'), true);
  assert.equal(supportsWorkflow(agnes, 'multi-reference'), false);

  const wan27 = getVideoModel('wan2.7-i2v');
  assert.equal(supportsWorkflow(wan27, 'first-frame'), true);
  assert.equal(supportsWorkflow(wan27, 'first-last-frame'), true);
  assert.equal(supportsWorkflow(wan27, 'video-continuation'), true);
  assert.equal(getWorkflowCapability(wan27, 'video-continuation').imageMin, 0);
  assert.equal(getWorkflowCapability(wan27, 'video-continuation').imageMax, 1);

  const r2v = getVideoModel('wan2.7-r2v');
  assert.deepEqual(Object.keys(r2v.workflowCapabilities), ['multi-reference']);

  const grok = getVideoModel('grok-imagine-video');
  assert.equal(grok.provider, 'sub2api_grok');
  assert.deepEqual(Object.keys(grok.workflowCapabilities), ['text-to-video', 'first-frame', 'multi-reference']);
  assert.equal(grok.supportsWatermark, false);
  assert.equal(grok.supportsPromptExtend, false);
});

test('每个模型的每条工作流都能通过约束并构造请求', () => {
  let pathCount = 0;
  for (const model of VIDEO_MODELS) {
    for (const [workflow, capability] of Object.entries(model.workflowCapabilities)) {
      pathCount += 1;
      const imageCount = Math.max(capability.imageMin, capability.requiresAnyReference ? 1 : 0);
      const body = {
        ...BASE_REQUEST,
        workflow,
        prompt: capability.promptOptional ? '' : BASE_REQUEST.prompt,
        duration: capability.durationMode === 'truncate' ? 0 : model.durations[0],
        resolution: model.resolutions[0],
        ratio: capability.ratioOptions[0] || '16:9',
        images: Array.from({ length: imageCount }, (_, index) => image('path-' + index)),
        audioUrl: capability.audioMode === 'required_input_audio' ? 'https://assets.example.com/voice.mp3' : '',
        videoUrl: capability.videoMode.startsWith('required_') ? 'https://assets.example.com/source.mp4' : '',
      };
      const data = prepareRequestData(model, body);
      assert.equal(validateRequest(model, data), null, `${model.id} / ${workflow}`);
      if (model.provider === 'agnes') {
        const urls = data.images.map((item) => item.source);
        assert.equal(buildAgnesPayload(data, urls).model, 'agnes-video-v2.0');
      } else if (model.provider === 'sub2api_grok') {
        const urls = data.images.map((item) => item.source);
        assert.equal(buildGrokVideoRequest(model, data, urls).model, model.id);
      } else if (model.provider === 'zhipu') {
        const urls = data.images.map((item) => item.source);
        assert.equal(buildZhipuVideoRequest(model, data, urls).model, model.id);
      } else {
        const request = buildDashscopeRequest(model, data);
        assert.ok(request.endpoint.startsWith('/api/'), `${model.id} / ${workflow}`);
        assert.equal(request.payload.model, model.id);
      }
    }
  }
  assert.ok(pathCount >= VIDEO_MODELS.length);
});

test('旧请求可以从模型和素材推断生成方式', () => {
  const agnes = getVideoModel('agnes-video-v2.0');
  assert.equal(inferVideoWorkflow(agnes, { images: [] }), 'text-to-video');
  assert.equal(inferVideoWorkflow(agnes, { images: [image('one')] }), 'first-frame');
  assert.equal(inferVideoWorkflow(agnes, { images: [image('one'), image('two')] }), 'keyframes');

  const wan27 = getVideoModel('wan2.7-i2v');
  assert.equal(inferVideoWorkflow(wan27, { images: [image('one')] }), 'first-frame');
  assert.equal(inferVideoWorkflow(wan27, { images: [image('one'), image('two')] }), 'first-last-frame');
  assert.equal(inferVideoWorkflow(wan27, { images: [], videoUrl: 'https://assets.example.com/start.mp4' }), 'video-continuation');

  const grok = getVideoModel('grok-imagine-video');
  assert.equal(inferVideoWorkflow(grok, { images: [] }), 'text-to-video');
  assert.equal(inferVideoWorkflow(grok, { images: [image('one')] }), 'first-frame');
  assert.equal(inferVideoWorkflow(grok, { images: [image('one'), image('two')] }), 'multi-reference');
});

test('Agnes 文生视频不发送空图片字段', () => {
  const model = getVideoModel('agnes-video-v2.0');
  const data = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'text-to-video',
    images: [],
  });
  assert.equal(validateRequest(model, data), null);
  const payload = buildAgnesPayload(data, []);
  assert.equal(payload.model, 'agnes-video-v2.0');
  assert.equal('image' in payload, false);
  assert.equal('extra_body' in payload, false);
});

test('Agnes 图片请求按清晰度映射尺寸并保留无图文生图协议', () => {
  const model = getImageModel('agnes-image-2.1-flash');
  const data = prepareImageRequest(model, {
    workflow: 'text-to-image',
    prompt: '一间明亮的现代工作室',
    quality: '2K',
    count: 1,
    images: [],
  });
  const payload = buildAgnesImageRequest(model, data, []);
  assert.equal(payload.size, '1536x1536');
  assert.equal('image' in payload.extra_body, false);
  assert.equal(payload.extra_body.response_format, 'url');
});

test('Agnes 单图与多关键帧使用不同请求字段', () => {
  const model = getVideoModel('agnes-video-v2.0');
  const firstFrame = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'first-frame',
    images: [image('start', 'background')],
  });
  assert.equal(validateRequest(model, firstFrame), null);
  assert.equal(firstFrame.images[0].role, 'first_frame');
  const firstPayload = buildAgnesPayload(firstFrame, ['https://cdn.example.com/start.jpg']);
  assert.equal(firstPayload.image, 'https://cdn.example.com/start.jpg');
  assert.equal('extra_body' in firstPayload, false);

  const keyframes = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'keyframes',
    images: [image('one'), image('two'), image('three')],
  });
  assert.equal(validateRequest(model, keyframes), null);
  assert.deepEqual(keyframes.images.map((item) => item.role), ['keyframe', 'keyframe', 'keyframe']);
  const frameUrls = keyframes.images.map((item) => item.source);
  const keyframePayload = buildAgnesPayload(keyframes, frameUrls);
  assert.deepEqual(keyframePayload.extra_body, { image: frameUrls, mode: 'keyframes' });
  assert.equal('image' in keyframePayload, false);
});

test('Agnes 清晰度会改变请求尺寸且只暴露真实控制项', () => {
  const model = getVideoModel('agnes-video-v2.0');
  const capability = getWorkflowCapability(model, 'text-to-video');
  assert.equal(capability.supportsWatermark, false);
  assert.equal(capability.supportsPromptExtend, false);
  assert.equal(capability.supportsNegativePrompt, true);
  assert.equal(capability.outputAudio, true);

  const low = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'text-to-video',
    resolution: '720P',
  });
  const high = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'text-to-video',
    resolution: '1080P',
  });
  const lowPayload = buildAgnesPayload(low, []);
  const highPayload = buildAgnesPayload(high, []);
  assert.deepEqual([lowPayload.width, lowPayload.height], [1280, 720]);
  assert.deepEqual([highPayload.width, highPayload.height], [1920, 1080]);
});

test('Agnes 视频时长映射到官方合法帧数', () => {
  const model = getVideoModel('agnes-video-v2.0');
  assert.deepEqual(model.durations, [3, 5, 7, 10, 18]);
  for (const duration of model.durations) {
    const data = prepareRequestData(model, { ...BASE_REQUEST, duration, workflow: 'text-to-video' });
    const payload = buildAgnesPayload(data, []);
    assert.equal(payload.num_frames, { 3: 81, 5: 121, 7: 161, 10: 241, 18: 441 }[duration]);
  }
});

test('HappyHorse 全系列使用各自协议和方括号图片引用', () => {
  const t2v = getVideoModel('happyhorse-1.1-t2v');
  const i2v = getVideoModel('happyhorse-1.1-i2v');
  const r2v = getVideoModel('happyhorse-1.1-r2v');
  const editModel = getVideoModel('happyhorse-1.0-video-edit');
  assert.ok(t2v && i2v && r2v && editModel);
  assert.equal(t2v.durations.includes(3), true);
  assert.equal(t2v.durations.includes(15), true);

  const text = prepareRequestData(t2v, {
    ...BASE_REQUEST,
    workflow: 'text-to-video',
    duration: 3,
    negativePrompt: '模糊',
    seed: 42,
  });
  const textPayload = buildDashscopeRequest(t2v, text).payload;
  assert.deepEqual(textPayload.input, { prompt: BASE_REQUEST.prompt });
  assert.equal(textPayload.parameters.prompt_extend, undefined);
  assert.equal(textPayload.parameters.seed, 42);

  const first = prepareRequestData(i2v, {
    ...BASE_REQUEST,
    workflow: 'first-frame',
    duration: 3,
    prompt: '',
    images: [image('start')],
  });
  assert.equal(validateRequest(i2v, first), null);
  assert.deepEqual(buildDashscopeRequest(i2v, first).payload.input.media, [
    { type: 'first_frame', url: image('start').source },
  ]);

  const references = prepareRequestData(r2v, {
    ...BASE_REQUEST,
    workflow: 'multi-reference',
    duration: 3,
    prompt: '@人物1拿起@背景1中的杯子',
    images: [image('person'), image('scene', 'background')],
  });
  const referencePayload = buildDashscopeRequest(r2v, references).payload;
  assert.match(referencePayload.input.prompt, /^\[Image 1\]拿起\[Image 2\]中的杯子/);
  assert.equal(referencePayload.parameters.prompt_extend, undefined);

  const edit = prepareRequestData(editModel, {
    ...BASE_REQUEST,
    workflow: 'video-edit',
    duration: 5,
    videoUrl: 'https://assets.example.com/source.mp4',
    images: [image('clothes')],
  });
  assert.equal(validateRequest(editModel, edit), null);
  const editPayload = buildDashscopeRequest(editModel, edit).payload;
  assert.equal(editPayload.parameters.duration, undefined);
  assert.equal(editPayload.parameters.prompt_extend, undefined);
  assert.equal(editPayload.input.media[0].type, 'video');
});

test('万相 2.7 正确区分首帧、首尾帧和视频续写', () => {
  const model = getVideoModel('wan2.7-i2v');
  const first = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'first-frame',
    images: [image('start')],
  });
  assert.equal(validateRequest(model, first), null);
  assert.deepEqual(buildDashscopeRequest(model, first).payload.input.media.map((item) => item.type), ['first_frame']);

  const firstLast = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'first-last-frame',
    images: [image('start'), image('end')],
  });
  assert.equal(validateRequest(model, firstLast), null);
  assert.deepEqual(buildDashscopeRequest(model, firstLast).payload.input.media.map((item) => item.type), ['first_frame', 'last_frame']);

  const continuation = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'video-continuation',
    videoUrl: 'https://assets.example.com/start.mp4',
    images: [image('end')],
  });
  assert.equal(validateRequest(model, continuation), null);
  assert.deepEqual(buildDashscopeRequest(model, continuation).payload.input.media.map((item) => item.type), ['first_clip', 'last_frame']);

  const continuationWithAudio = { ...continuation, audioUrl: 'https://assets.example.com/voice.mp3' };
  assert.equal(validateRequest(model, continuationWithAudio), '当前生成方式不支持外部音频');
});

test('多图参考保留人物背景角色并将音色绑定人物', () => {
  const model = getVideoModel('wan2.7-r2v');
  const data = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'multi-reference',
    prompt: '@人物1站在@背景1前',
    images: [image('person'), image('scene', 'background')],
    audioUrl: 'https://assets.example.com/voice.mp3',
  });
  assert.equal(validateRequest(model, data), null);
  const payload = buildDashscopeRequest(model, data).payload;
  assert.equal(payload.input.media[0].reference_voice, 'https://assets.example.com/voice.mp3');
  assert.equal('reference_voice' in payload.input.media[1], false);
  assert.match(payload.input.prompt, /^Image 1站在Image 2前/);

  const backgroundOnly = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'multi-reference',
    images: [image('scene', 'background')],
    audioUrl: 'https://assets.example.com/voice.mp3',
  });
  assert.equal(validateRequest(model, backgroundOnly), '音色参考需要至少 1 张人物参考图');

  const tooManyReferences = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'multi-reference',
    images: [1, 2, 3, 4, 5].map((index) => image('person-' + index)),
    videoUrl: 'https://assets.example.com/reference.mp4',
  });
  assert.equal(validateRequest(model, tooManyReferences), '参考图片与参考视频合计最多 5 个');

  const imageOnlyLong = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'multi-reference',
    duration: 15,
    images: [image('person')],
  });
  assert.equal(validateRequest(model, imageOnlyLong), null);

  const videoLong = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'multi-reference',
    duration: 15,
    images: [image('person')],
    videoUrl: 'https://assets.example.com/reference.mp4',
  });
  assert.equal(validateRequest(model, videoLong), '包含参考视频时，生成时长不能超过 10 秒');
});

test('视频编辑、动作迁移和角色替换使用各自素材协议', () => {
  const editModel = getVideoModel('wan2.7-videoedit');
  const edit = prepareRequestData(editModel, {
    ...BASE_REQUEST,
    workflow: 'video-edit',
    videoUrl: 'https://assets.example.com/source.mp4',
    images: [image('person')],
  });
  assert.equal(validateRequest(editModel, edit), null);
  assert.deepEqual(buildDashscopeRequest(editModel, edit).payload.input.media.map((item) => item.type), ['video', 'reference_image']);

  const moveModel = getVideoModel('wan2.2-animate-move');
  const move = prepareRequestData(moveModel, {
    ...BASE_REQUEST,
    workflow: 'motion-transfer',
    prompt: '',
    videoUrl: 'https://assets.example.com/motion.mp4',
    images: [image('person')],
  });
  assert.equal(validateRequest(moveModel, move), null);
  assert.equal(buildDashscopeRequest(moveModel, move).payload.input.image_url, image('person').source);

  const mixModel = getVideoModel('wan2.2-animate-mix');
  const mix = prepareRequestData(mixModel, {
    ...BASE_REQUEST,
    workflow: 'character-replace',
    prompt: '',
    videoUrl: 'https://assets.example.com/source.mp4',
    images: [image('replacement')],
  });
  assert.equal(validateRequest(mixModel, mix), null);
  assert.equal(mix.images[0].role, 'replacement_character');
  assert.equal(buildDashscopeRequest(mixModel, mix).payload.input.video_url, 'https://assets.example.com/source.mp4');
});

test('视频编辑区分保留原时长与截断，动画时长始终跟随源视频', () => {
  const editModel = getVideoModel('wan2.7-videoedit');
  const preserve = prepareRequestData(editModel, {
    ...BASE_REQUEST,
    workflow: 'video-edit',
    duration: 0,
    ratio: 'source',
    videoUrl: 'https://assets.example.com/source.mp4',
  });
  assert.equal(validateRequest(editModel, preserve), null);
  const preserveParameters = buildDashscopeRequest(editModel, preserve).payload.parameters;
  assert.equal(preserveParameters.duration, undefined);
  assert.equal(preserveParameters.ratio, undefined);

  const truncate = { ...preserve, duration: 4, ratio: '9:16' };
  const truncateParameters = buildDashscopeRequest(editModel, truncate).payload.parameters;
  assert.equal(truncateParameters.duration, 4);
  assert.equal(truncateParameters.ratio, '9:16');

  const moveModel = getVideoModel('wan2.2-animate-move');
  assert.equal(getWorkflowCapability(moveModel, 'motion-transfer').durationMode, 'source');
});

test('S2V 需要人物音频并使用 image2video 音频驱动协议', () => {
  const model = getVideoModel('wan2.2-s2v');
  const missingAudio = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'first-frame',
    prompt: '',
    images: [image('person')],
    audioUrl: '',
  });
  assert.equal(validateRequest(model, missingAudio), '当前生成方式需要人物音频 URL');

  const data = prepareRequestData(model, {
    ...missingAudio,
    audioUrl: 'https://assets.example.com/voice.mp3',
    resolution: '720P',
  });
  assert.equal(validateRequest(model, data), null);
  const request = buildDashscopeRequest(model, data);
  assert.equal(request.endpoint, '/api/v1/services/aigc/image2video/video-synthesis');
  assert.deepEqual(request.payload.input, {
    image_url: image('person').source,
    audio_url: 'https://assets.example.com/voice.mp3',
  });
  assert.deepEqual(request.payload.parameters, { resolution: '720P' });
});

test('VACE 按参考图用途构造视频编辑函数', () => {
  const model = getVideoModel('wanx2.1-vace-plus');
  const data = prepareRequestData(model, {
    ...BASE_REQUEST,
    workflow: 'video-edit',
    duration: 0,
    videoUrl: 'https://assets.example.com/source.mp4',
    images: [image('person'), image('scene', 'background')],
  });
  assert.equal(validateRequest(model, data), null);
  const payload = buildDashscopeRequest(model, data).payload;
  assert.equal(payload.input.function, 'image_reference');
  assert.deepEqual(payload.input.ref_images_url, data.images.map((item) => item.source));
  assert.deepEqual(payload.parameters.obj_or_bg, ['obj', 'bg']);

  const repaint = prepareRequestData(model, { ...data, images: [] });
  assert.equal(validateRequest(model, repaint), null);
  assert.equal(buildDashscopeRequest(model, repaint).payload.input.function, 'video_repainting');
});

test('语义化图片标签与旧 @参考图 标签同时兼容', () => {
  assert.equal(
    normalizePromptMentions('@首帧转场到@尾帧', 'first-last-frame'),
    'Image 1转场到Image 2',
  );
  assert.equal(
    normalizePromptMentions('@关键帧1接近@关键帧2', 'keyframes'),
    'Image 1接近Image 2',
  );
  assert.equal(
    normalizePromptMentions('@参考图1与@背景1', 'multi-reference', 'character', [
      { role: 'character' },
      { role: 'background' },
    ]),
    'character1与character2',
  );
});

test('账户欠费或账户状态拦截会暂停对应模型', () => {
  assert.equal(
    quotaIsExhausted(
      { status: 403 },
      { message: 'Access denied, please make sure your account is in good standing. For details: overdue payment' },
    ),
    true,
  );
});

test('账户欠费暂停整个服务商，单模型额度耗尽只暂停当前变体', async () => {
  const billingRuntime = memoryRuntime({
    VIDEO_ACCESS_TOKEN: 'studio-secret',
    DASHSCOPE_API_KEY: 'server-only-key',
  });
  billingRuntime.fetch = async () => Response.json({
    message: 'Access denied, please make sure your account is in good standing. overdue payment',
  }, { status: 403 });

  const requestBody = {
    ...BASE_REQUEST,
    workflow: 'text-to-video',
    model: 'wan2.7-t2v',
    images: [],
  };
  const billingResponse = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    headers: { authorization: 'Bearer studio-secret', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  }), billingRuntime);
  assert.equal(billingResponse.status, 403);
  const billingFailure = await billingResponse.json();
  const dashscopeIds = VIDEO_MODELS.filter((model) => model.provider === 'dashscope').map((model) => model.id);
  assert.deepEqual(billingFailure.unavailable.map((item) => item.modelId), dashscopeIds);
  assert.equal(billingFailure.unavailable.every((item) => item.scope === 'provider'), true);

  const availability = await handleVideoApiRequest(new Request('https://studio.example/api/models'), billingRuntime);
  assert.equal((await availability.json()).unavailable.length, dashscopeIds.length);

  const quotaRuntime = memoryRuntime({
    VIDEO_ACCESS_TOKEN: 'studio-secret',
    DASHSCOPE_API_KEY: 'server-only-key',
  });
  quotaRuntime.fetch = async () => Response.json({
    code: 'AllocationQuota.FreeTierOnly',
    message: 'Free allocated quota exceeded',
  }, { status: 429 });
  const quotaResponse = await handleVideoApiRequest(new Request('https://studio.example/api/videos', {
    method: 'POST',
    headers: { authorization: 'Bearer studio-secret', 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  }), quotaRuntime);
  const quotaFailure = await quotaResponse.json();
  assert.deepEqual(quotaFailure.unavailable.map((item) => item.modelId), ['wan2.7-t2v']);
  assert.equal(quotaFailure.unavailable[0].scope, 'model');
});
