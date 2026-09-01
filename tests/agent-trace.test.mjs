import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_TRACE_STORAGE_KEY,
  MAX_AGENT_TRACE_EVENTS,
  appendAgentTrace,
  readAgentTrace,
  saveAgentTrace,
} from '../src/agent-trace.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('Agent 工作记录保留状态、时间和最新事件', () => {
  let events = [];
  for (let index = 0; index < MAX_AGENT_TRACE_EVENTS + 3; index += 1) {
    events = appendAgentTrace(events, {
      id: `event-${index}`,
      state: index === 0 ? 'active' : 'completed',
      title: `步骤 ${index}`,
      detail: `记录 ${index}`,
    }, 1_800_000_000_000 + index);
  }
  assert.equal(events.length, MAX_AGENT_TRACE_EVENTS);
  assert.equal(events[0].id, 'event-3');
  assert.equal(events.at(-1).state, 'completed');
});

test('Agent 工作记录可从浏览器存储恢复，损坏数据会安全清空', () => {
  const storage = memoryStorage();
  saveAgentTrace(storage, [appendAgentTrace([], {
    id: 'plan-confirmed', state: 'completed', title: '服务端计划已确认', detail: '文生视频',
  }, 1_800_000_000_000)[0]]);
  assert.equal(readAgentTrace(storage)[0].title, '服务端计划已确认');

  storage.setItem(AGENT_TRACE_STORAGE_KEY, '{bad-json');
  assert.deepEqual(readAgentTrace(storage), []);
  assert.equal(storage.getItem(AGENT_TRACE_STORAGE_KEY), null);
});

