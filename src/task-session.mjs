const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PREFIX = 'short-video-studio:task:';

function storageKey(studio) {
  return KEY_PREFIX + studio;
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

export function isRecoverableStudioTask(task) {
  return Boolean(
    task
    && ['PENDING', 'RUNNING'].includes(task.status)
    && task.taskId,
  );
}

export function readStudioTask(storage, studio, now = Date.now()) {
  if (!storage) return null;
  try {
    const stored = JSON.parse(storage.getItem(storageKey(studio)) || 'null');
    if (!isRecord(stored) || !isRecord(stored.task)) return null;
    if (stored.task.snapshot?.isDemo) {
      storage.removeItem(storageKey(studio));
      return null;
    }
    if (!Number.isFinite(stored.updatedAt) || now - stored.updatedAt > TASK_TTL_MS) {
      storage.removeItem(storageKey(studio));
      return null;
    }
    return stored.task;
  } catch {
    storage.removeItem(storageKey(studio));
    return null;
  }
}

export function saveStudioTask(storage, studio, task, now = Date.now()) {
  if (!storage) return;
  const key = storageKey(studio);
  if (!task || task.status === 'IDLE') {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify({ updatedAt: now, task }));
}

export function clearStudioTask(storage, studio) {
  storage?.removeItem(storageKey(studio));
}

