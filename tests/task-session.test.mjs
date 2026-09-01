import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearStudioTask,
  isRecoverableStudioTask,
  readStudioTask,
  saveStudioTask,
} from '../src/task-session.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) || null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}

test('工作台切换后可恢复带任务编号的生成任务', () => {
  const storage = memoryStorage();
  const task = {
    status: 'RUNNING',
    taskId: 'task-123',
    provider: 'agnes',
    snapshot: { modelId: 'agnes-video-v2.0' },
  };

  saveStudioTask(storage, 'video', task, 100);
  assert.deepEqual(readStudioTask(storage, 'video', 101), task);
  assert.equal(isRecoverableStudioTask(task), true);
});

test('旧模拟任务、空任务和过期任务不会被恢复', () => {
  const storage = memoryStorage();
  const activeDemo = { status: 'RUNNING', taskId: 'demo-123', snapshot: { isDemo: true } };
  saveStudioTask(storage, 'video', activeDemo, 100);
  assert.equal(readStudioTask(storage, 'video', 101), null);

  saveStudioTask(storage, 'image', { status: 'IDLE', taskId: '' }, 100);
  assert.equal(readStudioTask(storage, 'image', 101), null);

  saveStudioTask(storage, 'agent', { status: 'PENDING', taskId: 'old-task' }, 100);
  assert.equal(readStudioTask(storage, 'agent', 100 + 24 * 60 * 60 * 1000 + 1), null);

  clearStudioTask(storage, 'agent');
  assert.equal(readStudioTask(storage, 'agent', 101), null);
});
