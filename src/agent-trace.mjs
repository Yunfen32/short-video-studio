export const AGENT_TRACE_STORAGE_KEY = 'short-video-studio:agent-trace:v1';
export const MAX_AGENT_TRACE_EVENTS = 24;

const STATES = new Set(['completed', 'active', 'error', 'pending']);

function cleanText(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function eventId(now) {
  if (globalThis.crypto?.randomUUID) return `trace-${globalThis.crypto.randomUUID()}`;
  return `trace-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAgentTraceEvent(input = {}, now = Date.now()) {
  return {
    id: cleanText(input.id, 160) || eventId(now),
    at: Number.isFinite(Number(input.at)) ? Number(input.at) : now,
    state: STATES.has(input.state) ? input.state : 'completed',
    title: cleanText(input.title, 120) || 'Agent 更新',
    detail: cleanText(input.detail, 700),
  };
}

export function appendAgentTrace(events, input, now = Date.now()) {
  const event = createAgentTraceEvent(input, now);
  return [...(Array.isArray(events) ? events : []), event].slice(-MAX_AGENT_TRACE_EVENTS);
}

export function readAgentTrace(storage) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(AGENT_TRACE_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((event) => event && typeof event === 'object')
      .map((event) => createAgentTraceEvent(event, Number(event.at) || Date.now()))
      .slice(-MAX_AGENT_TRACE_EVENTS);
  } catch {
    storage.removeItem(AGENT_TRACE_STORAGE_KEY);
    return [];
  }
}

export function saveAgentTrace(storage, events) {
  if (!storage) return;
  storage.setItem(AGENT_TRACE_STORAGE_KEY, JSON.stringify((Array.isArray(events) ? events : []).slice(-MAX_AGENT_TRACE_EVENTS)));
}

export function clearAgentTrace(storage) {
  storage?.removeItem(AGENT_TRACE_STORAGE_KEY);
}

