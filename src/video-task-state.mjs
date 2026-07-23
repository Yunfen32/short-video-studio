const STATUS_PROGRESS = {
  IDLE: 0,
  PENDING: 12,
  RUNNING: 58,
  SUCCEEDED: 100,
  FAILED: 0,
  CANCELED: 0,
  UNKNOWN: 0,
};

export function createInitialTaskState(token = 0) {
  return {
    token,
    status: 'IDLE',
    progress: 0,
    taskId: '',
    provider: '',
    videoId: '',
    videoUrl: '',
    error: '',
    snapshot: null,
    actual: { size: '', seconds: '' },
  };
}

export function createTaskSnapshot(input = {}) {
  return {
    workflowId: input.workflowId || '',
    workflowLabel: input.workflowLabel || '',
    modelId: input.modelId || '',
    modelLabel: input.modelLabel || '',
    familyLabel: input.familyLabel || '',
    variantLabel: input.variantLabel || '',
    provider: input.provider || '',
    ratio: input.ratio || '',
    resolution: input.resolution || '',
    duration: Number.isFinite(input.duration) ? input.duration : 0,
    durationMode: input.durationMode || 'output',
    routeInput: input.routeInput || '',
    prompt: input.prompt || '',
    isDemo: Boolean(input.isDemo),
  };
}

function belongsToActiveTask(state, action) {
  return action.token === state.token;
}

export function reduceTaskState(state, action) {
  if (action.type === 'reset') return createInitialTaskState(action.token);
  if (action.type === 'start') {
    return {
      ...createInitialTaskState(action.token),
      status: 'PENDING',
      progress: STATUS_PROGRESS.PENDING,
      snapshot: action.snapshot,
    };
  }
  if (!belongsToActiveTask(state, action)) return state;
  if (action.type === 'created') {
    return {
      ...state,
      taskId: action.taskId || '',
      provider: action.provider || '',
      videoId: action.videoId || '',
      status: action.status || state.status,
      progress: action.progress ?? state.progress,
    };
  }
  if (action.type === 'polled') {
    const status = action.status || state.status;
    return {
      ...state,
      status,
      progress: action.progress ?? STATUS_PROGRESS[status] ?? state.progress,
      videoUrl: action.videoUrl || state.videoUrl,
      error: action.error || '',
      actual: {
        size: action.size || state.actual.size,
        seconds: action.seconds || state.actual.seconds,
      },
    };
  }
  if (action.type === 'failed') {
    return {
      ...state,
      status: 'FAILED',
      progress: 0,
      error: action.error || '视频任务未能完成',
    };
  }
  return state;
}

export function isTransientPollError(error) {
  const status = Number(error?.status || 0);
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export function pollRetryDelay(attempt, baseDelay) {
  const retryAfter = Number(attempt?.retryAfter || 0);
  if (retryAfter > 0) return retryAfter * 1000;
  const count = Number(attempt?.count || 0);
  return Math.max(100, baseDelay) * Math.min(count + 1, 3);
}

export function mergeUnavailableModels(current = [], incoming = []) {
  const merged = new Map(current.map((item) => [item.modelId, item]));
  for (const item of incoming) {
    if (item?.modelId) merged.set(item.modelId, item);
  }
  return [...merged.values()];
}

export function outputDurationLabel(durationMode, duration) {
  if (durationMode === 'source') return '跟随源视频';
  if (durationMode === 'truncate') return duration > 0 ? `截取前 ${duration} 秒` : '保留原时长';
  return `${duration} 秒`;
}
