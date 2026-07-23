import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInitialTaskState,
  createTaskSnapshot,
  isTransientPollError,
  mergeUnavailableModels,
  outputDurationLabel,
  reduceTaskState,
} from '../src/video-task-state.mjs';

test('任务状态按提交令牌推进并忽略过期轮询', () => {
  const snapshot = createTaskSnapshot({
    workflowId: 'text-to-video',
    workflowLabel: '文生视频',
    modelId: 'agnes-video-v2.0',
    modelLabel: 'Agnes Video V2.0',
    variantLabel: '标准版',
    ratio: '16:9',
    resolution: '720P',
    duration: 5,
    durationMode: 'output',
    isDemo: true,
  });
  let state = reduceTaskState(createInitialTaskState(), { type: 'start', token: 3, snapshot });
  assert.equal(state.status, 'PENDING');

  state = reduceTaskState(state, { type: 'created', token: 3, taskId: 'task-1', provider: 'agnes' });
  state = reduceTaskState(state, { type: 'polled', token: 3, status: 'RUNNING', progress: 45 });
  assert.equal(state.status, 'RUNNING');
  assert.equal(state.progress, 45);

  const stale = reduceTaskState(state, { type: 'polled', token: 2, status: 'FAILED', error: '旧任务失败' });
  assert.strictEqual(stale, state);

  state = reduceTaskState(state, {
    type: 'polled',
    token: 3,
    status: 'SUCCEEDED',
    progress: 100,
    videoUrl: 'https://video.example/result.mp4',
    size: '1280x720',
    seconds: '5.0',
  });
  assert.equal(state.status, 'SUCCEEDED');
  assert.equal(state.snapshot.modelId, 'agnes-video-v2.0');
  assert.equal(state.actual.size, '1280x720');
  assert.equal(state.snapshot.isDemo, true);
});

test('重置使旧任务失效，但提交快照不会随当前选择变化', () => {
  const snapshot = createTaskSnapshot({ modelId: 'wan2.7-t2v', modelLabel: '万相 2.7 文生视频' });
  let state = reduceTaskState(createInitialTaskState(), { type: 'start', token: 5, snapshot });
  const currentSelection = { modelId: 'happyhorse-1.1-t2v' };
  assert.notEqual(state.snapshot.modelId, currentSelection.modelId);

  state = reduceTaskState(state, { type: 'polled', token: 5, status: 'RUNNING', progress: 36 });
  assert.equal(state.status, 'RUNNING');
  assert.equal(state.snapshot.modelId, 'wan2.7-t2v');

  state = reduceTaskState(state, { type: 'reset', token: 6 });
  assert.equal(state.status, 'IDLE');
  assert.equal(state.snapshot, null);
  assert.equal(state.token, 6);
});

test('轮询只重试暂时性网络和服务错误', () => {
  assert.equal(isTransientPollError({ status: 0 }), true);
  assert.equal(isTransientPollError({ status: 429 }), true);
  assert.equal(isTransientPollError({ status: 503 }), true);
  assert.equal(isTransientPollError({ status: 401 }), false);
  assert.equal(isTransientPollError({ status: 404 }), false);
});

test('服务商停用列表按模型合并，输出时长文案保持真实语义', () => {
  const merged = mergeUnavailableModels(
    [{ modelId: 'wan2.7-t2v', until: 1 }],
    [
      { modelId: 'wan2.7-t2v', until: 2 },
      { modelId: 'wan2.7-i2v', until: 2 },
    ],
  );
  assert.deepEqual(merged.map((item) => [item.modelId, item.until]), [
    ['wan2.7-t2v', 2],
    ['wan2.7-i2v', 2],
  ]);
  assert.equal(outputDurationLabel('output', 5), '5 秒');
  assert.equal(outputDurationLabel('truncate', 0), '保留原时长');
  assert.equal(outputDurationLabel('truncate', 4), '截取前 4 秒');
  assert.equal(outputDurationLabel('source', 5), '跟随源视频');
});
