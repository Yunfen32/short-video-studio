import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  BrainCircuit,
  Bot,
  Check,
  Clapperboard,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  FolderKanban,
  Image as ImageIcon,
  Home,
  Loader2,
  Palette,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Video,
} from 'lucide-react';
import { IMAGE_MODELS } from '../shared/image-models.mjs';
import { VIDEO_MODELS } from '../shared/video-models.mjs';
import { projectProgress } from './creative-library.mjs';
import { appendAgentTrace, clearAgentTrace, readAgentTrace, saveAgentTrace } from './agent-trace.mjs';
import { isTransientPollError, pollRetryDelay } from './video-task-state.mjs';
import { isRecoverableStudioTask, readStudioTask, saveStudioTask } from './task-session.mjs';

const POLL_INTERVAL = Number(import.meta.env.VITE_POLL_INTERVAL) || 5000;
const MAX_POLL_RETRIES = 3;
const AGENT_TARGET = 'video';
const SOURCES = [
  { id: 'inspiration', label: '灵感', summary: '从一句想法开始' },
  { id: 'script', label: '剧本', summary: '粘贴已有剧情或分镜' },
];
const VISUAL_STYLES = ['2D 动漫', '电影感', '写实质感', '产品展示'];
const VIDEO_RATIOS = ['9:16', '16:9', '1:1', '4:3', '3:4'];
const PROJECT_DURATION_MIN = 1;
const PROJECT_DURATION_MAX = 300;
const PROJECT_STEPS = [
  { id: 'brief', label: '创作立项', summary: '灵感与目标' },
  { id: 'storyboard', label: '分镜资料', summary: '故事、角色、场景' },
  { id: 'review', label: '镜头审核', summary: '模型与参数' },
  { id: 'generate', label: '生成视频', summary: '中间资产与视频镜头' },
  { id: 'archive', label: '资产沉淀', summary: '可追溯归档' },
];

function createInitialAgentTask() {
  return {
    status: 'IDLE', taskId: '', provider: '', videoId: '', kind: '', videoUrl: '', imageUrls: [], error: '', plan: null, size: '', projectId: '', shotId: '',
  };
}

function createInitialProjectRun() {
  return { status: 'IDLE', shotIds: [], completedShotIds: [], failedShotId: '', error: '' };
}

function statusLabel(status) {
  return { IDLE: '等待创作', PENDING: '计划已提交', RUNNING: '正在生成', SUCCEEDED: '已完成', FAILED: '生成失败' }[status] || status;
}

function statusTone(status) {
  if (status === 'SUCCEEDED') return 'status-success';
  if (status === 'FAILED') return 'status-error';
  if (status === 'PENDING' || status === 'RUNNING') return 'status-active';
  return '';
}

function planOutput(plan) {
  if (!plan) return '--';
  if (plan.kind === 'video') {
    const output = plan.output || plan.request || {};
    const ratio = output.ratio || plan.brief?.ratio || '--';
    const duration = output.duration ?? plan.brief?.duration;
    return `${ratio} / ${duration ? `${duration} 秒` : '--'} / ${output.resolution || '--'}`;
  }
  const output = plan.output || plan.request || {};
  return `${output.quality || '--'} / ${output.count || 1} 张`;
}

function traceTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '请求失败，请稍后重试');
    Object.assign(error, data);
    throw error;
  }
  return data;
}

export default function AgentStudio({
  onOpenHome,
  onOpenVideo,
  onOpenImage,
  onOpenAssets,
  onCreateProject,
  onSaveAssets,
  onUpdateAsset,
  onUpdateProjectState,
  launchDraft,
  projects = [],
  assets = [],
}) {
  const target = AGENT_TARGET;
  const [source, setSource] = useState('inspiration');
  const [prompt, setPrompt] = useState('');
  const [shotDraft, setShotDraft] = useState('');
  const [visualStyle, setVisualStyle] = useState('2D 动漫');
  const [ratio, setRatio] = useState('9:16');
  const [duration, setDuration] = useState(5);
  const [projectId, setProjectId] = useState('');
  const [shotId, setShotId] = useState('');
  const [videoModels, setVideoModels] = useState(VIDEO_MODELS);
  const [imageModels, setImageModels] = useState(IMAGE_MODELS);
  const [freeOnly, setFreeOnly] = useState(false);
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [serverPlan, setServerPlan] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [planningProject, setPlanningProject] = useState(false);
  const [task, setTask] = useState(() => readStudioTask(window.localStorage, 'agent') || createInitialAgentTask());
  const [error, setError] = useState('');
  const [trace, setTrace] = useState(() => readAgentTrace(window.localStorage));
  const [projectRun, setProjectRun] = useState(createInitialProjectRun);
  const [composition, setComposition] = useState({ status: 'IDLE', videoUrl: '', error: '', clipCount: 0 });
  const pollToken = useRef(0);
  const pollTimer = useRef(0);
  const tracedTaskState = useRef('');
  const projectRunToken = useRef(0);
  const projectQueuePauseRequested = useRef(false);
  const archivedTaskIds = useRef(new Set());
  const handledLaunchId = useRef('');

  function appendTrace(input) {
    setTrace((current) => appendAgentTrace(current, input));
  }

  function setProjectWorkflow(projectKey, { status, currentStepId, paused, lastEvent, stepUpdates = [] }) {
    if (!projectKey || !onUpdateProjectState) return;
    onUpdateProjectState(projectKey, (state) => ({
      ...state,
      ...(status ? { status } : {}),
      ...(currentStepId ? { currentStepId } : {}),
      ...(paused === undefined ? {} : { paused }),
      ...(lastEvent ? { lastEvent } : {}),
      workflow: state.workflow.map((step) => {
        const patch = stepUpdates.find((item) => item.id === step.id);
        return patch ? { ...step, ...patch } : step;
      }),
    }));
  }

  const selectedProject = projects.find((project) => project.id === projectId) || null;
  const selectedShot = assets.find((asset) => asset.id === shotId && asset.projectId === projectId) || null;
  const projectShots = useMemo(() => selectedProject
    ? selectedProject.shotIds.map((id) => assets.find((asset) => asset.id === id)).filter(Boolean)
    : [], [assets, selectedProject]);
  const projectCharacters = useMemo(() => selectedProject
    ? assets.filter((asset) => asset.projectId === selectedProject.id && asset.category === 'character' && asset.isCurrent !== false)
    : [], [assets, selectedProject]);
  const projectScenes = useMemo(() => selectedProject
    ? assets.filter((asset) => asset.projectId === selectedProject.id && asset.category === 'scene' && asset.isCurrent !== false)
    : [], [assets, selectedProject]);
  const shotParameters = selectedShot?.source?.parameters || {};
  const shotIsEdited = Boolean(selectedShot && shotDraft.trim() && shotDraft.trim() !== selectedShot.content);
  const projectTarget = AGENT_TARGET;
  const activePrompt = selectedShot
    ? (shotIsEdited ? shotDraft.trim() : shotParameters.videoPrompt || selectedShot.content)
    : prompt.trim();
  const activeDuration = selectedShot ? (Number(shotParameters.duration) || 5) : duration;
  const selectedReference = selectedShot
    ? assets.find((asset) => asset.type === 'image' && asset.isCurrent !== false && asset.relatedAssetIds.includes(selectedShot.id) && asset.previewUrl)
    : null;
  const agentInput = useMemo(() => ({
    target: projectTarget,
    source,
    prompt: activePrompt,
    style: visualStyle,
    ratio,
    duration: activeDuration,
    promptPrepared: Boolean(selectedShot && !shotIsEdited),
    images: selectedReference ? [{ source: selectedReference.previewUrl, role: 'first_frame' }] : [],
  }), [activeDuration, activePrompt, projectTarget, ratio, selectedReference?.previewUrl, selectedShot?.id, shotIsEdited, source, visualStyle]);
  const plannedAgent = serverPlan;
  const displayPlan = task.plan || plannedAgent;
  const isGenerating = task.status === 'PENDING' || task.status === 'RUNNING';
  const isProjectRunning = projectRun.status === 'RUNNING' || projectRun.status === 'PAUSE_REQUESTED';
  const isShotDirty = shotIsEdited;
  const canPlan = Boolean(agentInput.prompt && !isShotDirty && !planning && !planningProject && !isGenerating && !isProjectRunning);
  const canGenerate = Boolean(serverPlan?.planId && !isShotDirty && !isGenerating && !isProjectRunning);
  const taskError = error || task.error;
  const resultKind = task.kind || plannedAgent?.kind || '';
  const projectProgressState = selectedProject ? projectProgress(selectedProject, assets) : { complete: 0, total: 0 };
  const projectOutputType = 'video';
  const projectVideoClips = useMemo(() => selectedProject
    ? selectedProject.shotIds.map((id) => {
      const versions = assets.filter((asset) => asset.type === 'video' && asset.relatedAssetIds.includes(id));
      return versions.find((asset) => asset.isCurrent !== false) || versions[0] || null;
    }).filter(Boolean)
    : [], [assets, selectedProject]);
  const pendingProjectShotCount = selectedProject
    ? projectShots.filter((shot) => !assets.some((asset) => asset.type === projectOutputType && asset.relatedAssetIds.includes(shot.id))).length
    : 0;
  const pendingProjectEntityCount = selectedProject
    ? [...projectCharacters, ...projectScenes].filter((entity) => !assets.some((asset) => asset.type === 'image' && asset.relatedAssetIds.includes(entity.id))).length
    : 0;
  const failedProjectShot = projectRun.failedShotId ? projectShots.find((shot) => shot.id === projectRun.failedShotId) : null;
  const projectWorkflow = selectedProject?.creativeState?.workflow || PROJECT_STEPS;
  const decisionSummary = !activePrompt
    ? '等待创作描述。填写灵感或剧本后，Agent 会先给出可审核的模型路径。'
    : selectedShot
      ? `${selectedShot.title} 已设为当前执行镜头；会先准备关键画面，再生成视频镜头。`
      : 'Agent 只输出视频成片；人物、场景和关键画面会作为中间资产自动准备。';
  const traceEvents = [...trace].reverse();
  const currentStep = task.status === 'SUCCEEDED'
    ? 5
    : task.status !== 'IDLE'
      ? 4
      : (serverPlan || planning || planningProject)
        ? 3
        : selectedProject
          ? 2
          : 1;

  async function refreshAvailability() {
    setAvailabilityLoading(true);
    try {
      const data = await requestJson('/api/models');
      if (Array.isArray(data.videoModels)) setVideoModels(data.videoModels);
      if (Array.isArray(data.imageModels)) setImageModels(data.imageModels);
      setFreeOnly(data.freeOnly === true);
    } catch {
      setError('模型状态暂时无法读取，请稍后重试');
    } finally {
      setAvailabilityLoading(false);
    }
  }

  function archiveAgentTaskResult(resultTask) {
    const hasResult = resultTask?.status === 'SUCCEEDED' && (resultTask.videoUrl || resultTask.imageUrls?.length);
    if (!hasResult || !resultTask.taskId || !onSaveAssets || archivedTaskIds.current.has(resultTask.taskId)) return;
    if (assets.some((asset) => asset.source?.parameters?.taskId === resultTask.taskId)) {
      archivedTaskIds.current.add(resultTask.taskId);
      return;
    }
    archivedTaskIds.current.add(resultTask.taskId);
    const isIntermediateAsset = resultTask.kind === 'image';
    const urls = resultTask.kind === 'video' ? [resultTask.videoUrl] : resultTask.imageUrls;
    const shot = assets.find((asset) => asset.id === resultTask.shotId);
    appendTrace({
      state: 'completed',
      title: '生成结果已归档',
      detail: `${urls.filter(Boolean).length} 个${resultTask.kind === 'video' ? '视频' : '中间图片资产'}已关联${shot ? `到${shot.title}` : '到资产中心'}。`,
    });
    onSaveAssets(urls.filter(Boolean).map((url, index) => ({
      projectId: resultTask.projectId || null,
      type: resultTask.kind === 'video' ? 'video' : 'image',
      category: resultTask.projectId ? 'shot' : 'material',
      title: `${resultTask.plan?.modelLabel || 'Agent 生成'} · ${shot?.title || `${resultTask.kind === 'video' ? '视频' : '中间关键画面'} ${index + 1}`}`,
      previewUrl: url,
      tags: [resultTask.plan?.brief?.style, resultTask.plan?.workflow, shot?.title, isIntermediateAsset ? '中间资产' : '视频成片'].filter(Boolean),
      relatedAssetIds: resultTask.shotId ? [resultTask.shotId] : [],
      versionGroupId: resultTask.shotId
        ? `shot:${resultTask.shotId}:${resultTask.kind}:variant:${index + 1}`
        : resultTask.projectId
          ? `project:${resultTask.projectId}:${resultTask.kind}:agent:variant:${index + 1}`
          : `agent:${resultTask.kind}:${resultTask.plan?.request?.prompt || ''}:variant:${index + 1}`,
      source: {
        provider: resultTask.provider || resultTask.plan?.provider || '',
        model: resultTask.plan?.modelId || '',
        workflow: resultTask.plan?.workflow || '',
        prompt: resultTask.plan?.request?.prompt || '',
        parameters: { ...(resultTask.plan?.output || resultTask.plan?.request || {}), taskId: resultTask.taskId, ...(isIntermediateAsset ? { assetRole: 'intermediate' } : {}) },
      },
    })));
    if (resultTask.projectId && !resultTask.fromProjectQueue) {
      setProjectWorkflow(resultTask.projectId, {
        status: 'waiting_review',
        currentStepId: 'review',
        paused: false,
        lastEvent: `${shot?.title || '当前镜头'} 已生成，等待人工查看或继续生成新版本。`,
        stepUpdates: [
          { id: 'generate', status: 'completed', detail: `${shot?.title || '当前镜头'} 已生成，可继续创建版本。` },
          { id: 'review', status: 'waiting_review', detail: '结果已写入资产中心，等待人工查看。' },
        ],
      });
    }
  }

  useEffect(() => {
    refreshAvailability();
    return () => {
      pollToken.current += 1;
      projectRunToken.current += 1;
      window.clearTimeout(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    saveStudioTask(window.localStorage, 'agent', task);
  }, [task]);

  useEffect(() => {
    saveAgentTrace(window.localStorage, trace);
  }, [trace]);

  useEffect(() => {
    setServerPlan(null);
  }, [agentInput]);

  useEffect(() => {
    if (!launchDraft?.id || handledLaunchId.current === launchDraft.id) return;
    handledLaunchId.current = launchDraft.id;
    setSource(launchDraft.source === 'script' ? 'script' : 'inspiration');
    setPrompt(launchDraft.prompt || '继续完成当前创作。');
    if (VISUAL_STYLES.includes(launchDraft.style)) setVisualStyle(launchDraft.style);
    if (VIDEO_RATIOS.includes(launchDraft.ratio)) setRatio(launchDraft.ratio);
    if (Number.isFinite(Number(launchDraft.duration))) {
      setDuration(Math.min(PROJECT_DURATION_MAX, Math.max(PROJECT_DURATION_MIN, Math.round(Number(launchDraft.duration)))));
    }
    if (launchDraft.projectId && projects.some((project) => project.id === launchDraft.projectId)) {
      setProjectId(launchDraft.projectId);
      const project = projects.find((item) => item.id === launchDraft.projectId);
      setShotId(launchDraft.shotId && project?.shotIds.includes(launchDraft.shotId) ? launchDraft.shotId : (project?.shotIds[0] || ''));
    }
    setError('');
    appendTrace({
      state: 'completed',
      title: '已接收继续创作任务',
      detail: launchDraft.detail || '已从生成工作台带入创作上下文，等待审核下一步执行路径。',
    });
  }, [launchDraft, projects]);

  useEffect(() => {
    if (projectId && !selectedProject) {
      setProjectId('');
      setShotId('');
    }
  }, [projectId, selectedProject]);

  useEffect(() => {
    setComposition({ status: 'IDLE', videoUrl: '', error: '', clipCount: 0 });
  }, [projectId]);

  useEffect(() => {
    if (!selectedProject || shotId || !projectShots[0]) return;
    setShotId(projectShots[0].id);
  }, [projectShots, selectedProject, shotId]);

  useEffect(() => {
    setShotDraft(selectedShot?.content || '');
  }, [selectedShot?.content, selectedShot?.id]);

  useEffect(() => {
    const hasResult = task.status === 'SUCCEEDED' && (task.videoUrl || task.imageUrls.length);
    if (!hasResult) return;
    archiveAgentTaskResult(task);
  }, [assets, task]);

  useEffect(() => {
    if (projectRun.status !== 'SUCCEEDED' || projectVideoClips.length < 2 || composition.status !== 'IDLE') return;
    composeProjectVideos();
  }, [composition.status, projectOutputType, projectRun.status, projectVideoClips.length]);

  useEffect(() => {
    if (!task.taskId) return;
    const key = `${task.taskId}:${task.status}`;
    if (tracedTaskState.current === key) return;
    tracedTaskState.current = key;
    const state = task.status === 'FAILED' ? 'error' : task.status === 'SUCCEEDED' ? 'completed' : 'active';
    const detail = task.status === 'SUCCEEDED'
      ? `${task.kind === 'video' ? '视频' : '图片'}结果已返回，正在归档到资产中心。`
      : task.status === 'FAILED'
        ? (task.error || '任务未能完成。')
        : `任务 ${task.taskId} 当前为${statusLabel(task.status)}。`;
    appendTrace({ state, title: `生成任务${statusLabel(task.status)}`, detail });
  }, [task.error, task.kind, task.status, task.taskId]);

  async function pollTask(taskId, kind, provider, videoId, token, retryCount = 0) {
    if (pollToken.current !== token) return;
    const endpoint = kind === 'video' ? '/api/videos/' : '/api/images/';
    const query = new URLSearchParams(provider ? { provider } : {});
    if (kind === 'video' && videoId) query.set('video_id', videoId);
    try {
      const data = await requestJson(endpoint + encodeURIComponent(taskId) + (query.size ? '?' + query.toString() : ''));
      if (pollToken.current !== token) return;
      const status = data.status || 'RUNNING';
      if (status === 'SUCCEEDED' && (kind === 'video' ? data.videoUrl : data.imageUrls?.length)) {
        setTask((current) => ({ ...current, status, videoUrl: data.videoUrl || '', imageUrls: data.imageUrls || [], size: data.size || current.size, error: '' }));
        return;
      }
      if (data.terminal || status === 'FAILED') {
        setTask((current) => ({ ...current, status: 'FAILED', error: data.error || '生成任务未能完成' }));
        return;
      }
      setTask((current) => ({ ...current, status, size: data.size || current.size }));
      pollTimer.current = window.setTimeout(() => pollTask(taskId, kind, provider, videoId, token, 0), POLL_INTERVAL);
    } catch (pollError) {
      if (pollToken.current !== token) return;
      if (isTransientPollError(pollError) && retryCount < MAX_POLL_RETRIES) {
        pollTimer.current = window.setTimeout(
          () => pollTask(taskId, kind, provider, videoId, token, retryCount + 1),
          pollRetryDelay({ count: retryCount, retryAfter: pollError.retryAfter }, POLL_INTERVAL),
        );
        return;
      }
      setTask((current) => ({ ...current, status: 'FAILED', error: pollError.message }));
    }
  }

  async function waitForProjectTask(startedTask, token) {
    let retryCount = 0;
    while (projectRunToken.current === token) {
      const endpoint = startedTask.kind === 'video' ? '/api/videos/' : '/api/images/';
      const query = new URLSearchParams(startedTask.provider ? { provider: startedTask.provider } : {});
      if (startedTask.kind === 'video' && startedTask.videoId) query.set('video_id', startedTask.videoId);
      try {
        const data = await requestJson(endpoint + encodeURIComponent(startedTask.taskId) + (query.size ? '?' + query.toString() : ''));
        const status = data.status || 'RUNNING';
        if (status === 'SUCCEEDED' && (startedTask.kind === 'video' ? data.videoUrl : data.imageUrls?.length)) {
          const completed = { ...startedTask, status, videoUrl: data.videoUrl || '', imageUrls: data.imageUrls || [], size: data.size || '' };
          setTask(completed);
          return completed;
        }
        if (data.terminal || status === 'FAILED') throw new Error(data.error || '生成任务未能完成');
        setTask((current) => ({ ...current, status, size: data.size || current.size }));
        retryCount = 0;
        await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL));
      } catch (pollError) {
        if (isTransientPollError(pollError) && retryCount < MAX_POLL_RETRIES) {
          const delay = pollRetryDelay({ count: retryCount, retryAfter: pollError.retryAfter }, POLL_INTERVAL);
          retryCount += 1;
          await new Promise((resolve) => window.setTimeout(resolve, delay));
          continue;
        }
        throw pollError;
      }
    }
    throw new Error('项目连续执行已停止');
  }

  async function executeProjectQueue() {
    if (!selectedProject || isGenerating || isProjectRunning) return;
    const projectEntities = [...projectCharacters, ...projectScenes];
    const pendingEntities = projectEntities.filter((entity) => !assets.some((asset) => asset.type === 'image' && asset.relatedAssetIds.includes(entity.id)));
    const pendingShots = projectShots.filter((shot) => !assets.some((asset) => asset.type === projectOutputType && asset.relatedAssetIds.includes(shot.id)));
    if (!pendingShots.length && !pendingEntities.length) {
      setError('当前项目的所有镜头都已有生成素材，可在资产中心查看版本或继续编辑。');
      return;
    }
    const token = projectRunToken.current + 1;
    projectRunToken.current = token;
    projectQueuePauseRequested.current = false;
    setError('');
    setProjectRun({ status: 'RUNNING', shotIds: pendingShots.map((shot) => shot.id), completedShotIds: [], failedShotId: '', error: '' });
    setProjectWorkflow(selectedProject.id, {
      status: 'running',
      currentStepId: 'generate',
      paused: false,
      lastEvent: `开始准备 ${pendingEntities.length} 个人物/场景资产，并生成 ${pendingShots.length} 个待生成镜头。`,
      stepUpdates: [
        { id: 'assets', status: pendingEntities.length ? 'active' : 'completed', detail: pendingEntities.length ? `正在生成 ${pendingEntities.length} 个人物/场景设定图。` : '人物与场景设定图已齐备。' },
        { id: 'generate', status: pendingShots.length ? 'active' : 'pending', detail: pendingShots.length ? `正在按顺序执行 ${pendingShots.length} 个待生成镜头。` : '等待设定图准备完成。' },
        { id: 'review', status: 'pending', detail: '全部镜头生成后等待人工查看。' },
      ],
    });
    appendTrace({ state: 'active', title: '开始连续执行项目', detail: `将按顺序审核并生成 ${pendingShots.length} 个待生成镜头；每个结果会自动归档后再继续。` });

    for (const entity of pendingEntities) {
      if (projectQueuePauseRequested.current || projectRunToken.current !== token) {
        setProjectRun((current) => ({ ...current, status: 'PAUSED' }));
        setProjectWorkflow(selectedProject.id, { status: 'paused', currentStepId: 'assets', paused: true, lastEvent: '已暂停人物/场景资产准备，已完成结果均已保存。', stepUpdates: [{ id: 'assets', status: 'paused', detail: '设定图准备已暂停，可继续剩余项目任务。' }] });
        return;
      }
      appendTrace({ state: 'active', title: `生成 ${entity.title} 设定图`, detail: '使用 LLM 提取的图片提示词生成可复用的人物或场景资产。' });
      try {
        const entityPrompt = entity.source?.prompt || entity.content || entity.title;
        const planData = await requestJson('/api/agent/plan', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'image', assetRole: 'intermediate', source: 'script', prompt: entityPrompt, style: visualStyle, ratio, duration: 5, promptPrepared: true }),
        });
        const entityPlan = { ...planData.agentPlan, planId: planData.planId };
        const result = await requestJson('/api/agent/generate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: entityPlan.planId }),
        });
        const started = { ...createInitialAgentTask(), taskId: result.taskId || '', provider: result.provider || '', videoId: result.videoId || '', kind: 'image', plan: result.agentPlan || entityPlan, status: result.status || 'PENDING', imageUrls: result.imageUrls || [], error: '', projectId: selectedProject.id, shotId: '' };
        setTask(started);
        const immediate = started.status === 'SUCCEEDED' && started.imageUrls.length;
        if (!immediate && !started.taskId) throw new Error('设定图服务没有返回任务编号或结果地址');
        const completed = immediate ? started : await waitForProjectTask(started, token);
        archiveProjectEntityResult(completed, entity);
      } catch (entityError) {
        if (projectRunToken.current !== token) return;
        const message = entityError.message || '人物/场景设定图生成失败';
        setProjectRun((current) => ({ ...current, status: 'FAILED', error: message }));
        setProjectWorkflow(selectedProject.id, { status: 'blocked', currentStepId: 'assets', paused: false, lastEvent: `${entity.title} 未完成：${message}`, stepUpdates: [{ id: 'assets', status: 'blocked', detail: `${entity.title} 未完成，等待重试。` }] });
        appendTrace({ state: 'error', title: `${entity.title} 设定图生成失败`, detail: `${message}。队列已暂停。` });
        return;
      }
    }
    if (pendingEntities.length) {
      setProjectWorkflow(selectedProject.id, { status: 'running', currentStepId: 'generate', paused: false, lastEvent: '人物与场景设定图已准备完成，开始生成分镜。', stepUpdates: [{ id: 'assets', status: 'completed', detail: '人物与场景设定图已归档。' }, { id: 'generate', status: pendingShots.length ? 'active' : 'pending', detail: pendingShots.length ? `正在执行 ${pendingShots.length} 个待生成镜头。` : '没有待生成镜头。' }] });
    }

    for (const shot of pendingShots) {
      if (projectQueuePauseRequested.current) {
        setProjectRun((current) => ({ ...current, status: 'PAUSED' }));
        setProjectWorkflow(selectedProject.id, {
          status: 'paused', currentStepId: 'generate', paused: true,
          lastEvent: '已暂停后续镜头，已完成的结果和当前项目状态均已保存。',
          stepUpdates: [{ id: 'generate', status: 'paused', detail: '已暂停后续镜头，可随时继续。' }],
        });
        appendTrace({ state: 'completed', title: '后续镜头已暂停', detail: '不会再提交新的镜头任务；已完成结果保留在资产中心。' });
        return;
      }
      if (projectRunToken.current !== token) return;
      const shotParameters = shot.source?.parameters || {};
      const shotDuration = Number(shotParameters.duration) || 5;
      const imagePrompt = shotParameters.imagePrompt || shot.content;
      const videoPrompt = shotParameters.videoPrompt || shot.content;
      const queueInput = {
        target: AGENT_TARGET,
        source: 'script',
        prompt: videoPrompt,
        style: visualStyle,
        ratio,
        duration: shotDuration,
        promptPrepared: true,
        preferLongestDuration: true,
      };
      setShotId(shot.id);
      const hasShotAsset = assets.some((asset) => asset.type === 'image' && asset.relatedAssetIds.includes(shot.id));
      let referenceImageUrl = assets.find((asset) => asset.type === 'image' && asset.isCurrent !== false && asset.relatedAssetIds.includes(shot.id) && asset.previewUrl)?.previewUrl || '';
      appendTrace({ state: 'active', title: `审核 ${shot.title}`, detail: '正在根据镜头需求选择兼容模型与输出参数。' });
      try {
        if (!hasShotAsset) {
          appendTrace({ state: 'active', title: `生成 ${shot.title} 的镜头资产`, detail: '先生成关键画面资产，再继续生成视频镜头。' });
          const assetPlanData = await requestJson('/api/agent/plan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...queueInput, target: 'image', assetRole: 'intermediate', prompt: imagePrompt, images: [] }),
          });
          if (!assetPlanData.agentPlan || !assetPlanData.planId) throw new Error('Agent 没有返回镜头资产计划');
          const assetPlan = { ...assetPlanData.agentPlan, planId: assetPlanData.planId };
          const assetResult = await requestJson('/api/agent/generate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: assetPlan.planId }),
          });
          const effectiveAssetPlan = assetResult.agentPlan || assetPlan;
          const assetTask = {
            ...createInitialAgentTask(), taskId: assetResult.taskId || '', provider: assetResult.provider || '', videoId: assetResult.videoId || '', kind: 'image', plan: effectiveAssetPlan,
            status: assetResult.status || 'PENDING', imageUrls: assetResult.imageUrls || [], error: '', projectId: selectedProject.id, shotId: shot.id,
          };
          setTask(assetTask);
          const hasImmediateAsset = assetTask.status === 'SUCCEEDED' && assetTask.imageUrls.length;
          if (!hasImmediateAsset && !assetTask.taskId) throw new Error('镜头资产服务没有返回任务编号或结果地址');
          const completedAsset = hasImmediateAsset ? assetTask : await waitForProjectTask(assetTask, token);
          if (projectRunToken.current !== token) return;
          archiveAgentTaskResult({ ...completedAsset, fromProjectQueue: true });
          referenceImageUrl = completedAsset.imageUrls?.[0] || referenceImageUrl;
          setProjectWorkflow(selectedProject.id, {
            status: 'running', currentStepId: 'generate', paused: false,
            lastEvent: `${shot.title} 的镜头资产已生成，正在生成视频镜头。`,
            stepUpdates: [{ id: 'assets', status: 'completed', detail: '镜头关键画面资产已归档。' }],
          });
          appendTrace({ state: 'completed', title: `${shot.title} 镜头资产已归档`, detail: '关键画面已保存到资产中心，开始生成对应视频镜头。' });
        }
        if (referenceImageUrl) {
          queueInput.images = [{ source: referenceImageUrl, role: 'first_frame' }];
        }
        const planData = await requestJson('/api/agent/plan', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(queueInput),
        });
        if (!planData.agentPlan || !planData.planId) throw new Error('Agent 没有返回可执行计划');
        const lockedPlan = { ...planData.agentPlan, planId: planData.planId };
        setServerPlan(lockedPlan);
        appendTrace({ state: 'completed', title: `${shot.title} 计划已确认`, detail: `${lockedPlan.summary}。` });
        setTask({ ...createInitialAgentTask(), status: 'PENDING', kind: lockedPlan.kind, plan: lockedPlan, projectId: selectedProject.id, shotId: shot.id });
        const result = await requestJson('/api/agent/generate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: lockedPlan.planId }),
        });
        const effectivePlan = result.agentPlan || lockedPlan;
        const startedTask = {
          ...createInitialAgentTask(), taskId: result.taskId || '', provider: result.provider || '', videoId: result.videoId || '', kind: effectivePlan.kind, plan: effectivePlan,
          status: result.status || 'PENDING', videoUrl: result.videoUrl || '', imageUrls: result.imageUrls || [], error: '', size: '', projectId: selectedProject.id, shotId: shot.id,
        };
        setTask(startedTask);
        appendTrace({ state: 'active', title: `正在生成 ${shot.title}`, detail: `已提交 ${result.provider || effectivePlan.provider || '模型服务'} 任务。` });
        const hasImmediateResult = startedTask.status === 'SUCCEEDED' && (startedTask.kind === 'video' ? startedTask.videoUrl : startedTask.imageUrls.length);
        if (!hasImmediateResult && !startedTask.taskId) throw new Error('生成服务没有返回任务编号或结果地址');
        const completedTask = hasImmediateResult ? startedTask : await waitForProjectTask(startedTask, token);
        if (projectRunToken.current !== token) return;
        archiveAgentTaskResult({ ...completedTask, fromProjectQueue: true });
        setProjectRun((current) => ({ ...current, completedShotIds: [...current.completedShotIds, shot.id] }));
        setProjectWorkflow(selectedProject.id, {
          status: 'running', currentStepId: 'generate', paused: false,
          lastEvent: `${shot.title} 已完成，正在等待下一镜头或用户暂停。`,
          stepUpdates: [{ id: 'generate', status: 'active', detail: `${shot.title} 已完成，继续执行后续镜头。` }],
        });
        appendTrace({ state: 'completed', title: `${shot.title} 已完成`, detail: '结果已归档，继续执行下一个待生成镜头。' });
      } catch (runError) {
        if (projectRunToken.current !== token) return;
        const message = runError.message || '镜头生成未能完成';
        setTask((current) => ({ ...current, status: 'FAILED', error: message, projectId: selectedProject.id, shotId: shot.id }));
        setProjectRun((current) => ({ ...current, status: 'FAILED', failedShotId: shot.id, error: message }));
        setProjectWorkflow(selectedProject.id, {
          status: 'blocked', currentStepId: 'generate', paused: false,
          lastEvent: `${shot.title} 未完成：${message}`,
          stepUpdates: [{ id: 'generate', status: 'blocked', detail: `${shot.title} 未完成，等待重新审核或继续。` }],
        });
        appendTrace({ state: 'error', title: `${shot.title} 执行失败`, detail: `${message}。队列已暂停，等待选择重试或重新审核。` });
        return;
      }
    }
    if (projectRunToken.current !== token) return;
    setProjectRun((current) => ({ ...current, status: 'SUCCEEDED' }));
    setProjectWorkflow(selectedProject.id, {
      status: 'waiting_review', currentStepId: 'review', paused: false,
      lastEvent: '待生成镜头已完成，等待人工查看项目结果。',
      stepUpdates: [
        { id: 'generate', status: 'completed', detail: '待生成镜头已完成，结果已归档。' },
        { id: 'review', status: 'waiting_review', detail: '请查看镜头结果；可修改镜头资料后生成新版本。' },
      ],
    });
    appendTrace({ state: 'completed', title: '项目连续执行完成', detail: '待生成镜头已完成并沉淀到资产中心，可继续编辑或查看版本。' });
  }

  function pauseProjectQueue() {
    if (projectRun.status !== 'RUNNING') return;
    projectQueuePauseRequested.current = true;
    setProjectRun((current) => ({ ...current, status: 'PAUSE_REQUESTED' }));
    setProjectWorkflow(selectedProject?.id, {
      status: 'running', currentStepId: 'generate', paused: false,
      lastEvent: '将在当前镜头完成后暂停后续镜头。',
      stepUpdates: [{ id: 'generate', status: 'active', detail: '将在当前镜头完成后暂停后续镜头。' }],
    });
    appendTrace({ state: 'active', title: '已请求暂停后续镜头', detail: '正在执行的供应商任务不会被中断；当前镜头结束后不再提交新的镜头。' });
  }

  useEffect(() => {
    if (!isRecoverableStudioTask(task)) return;
    const token = pollToken.current + 1;
    pollToken.current = token;
    pollTask(task.taskId, task.kind, task.provider, task.videoId, token);
  }, []);

  async function createProject() {
    if (!prompt.trim()) {
      setError(`先写下${source === 'script' ? '剧本或分镜' : '创作灵感'}，才能建立项目`);
      return;
    }
    if (planningProject || isGenerating || isProjectRunning) return;
    setPlanningProject(true);
    setError('');
    appendTrace({ state: 'active', title: 'LLM 正在整理创作方案', detail: '正在提取故事、主要人物、场景，并为每个分镜生成中间关键画面提示词和视频提示词。' });
    try {
      const data = await requestJson('/api/agent/project-plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), source, target, style: visualStyle, ratio, duration }),
      });
      if (!data.creativePlan) throw new Error('Agent 没有返回结构化创作方案');
      const project = onCreateProject({
        brief: prompt.trim(), source, style: visualStyle, ratio, duration,
        target: data.creativePlan.target,
        creativePlan: data.creativePlan,
      });
      setProjectId(project.id);
      setShotId(project.shotIds[0] || '');
      setServerPlan(null);
      appendTrace({
        state: 'completed',
        title: 'LLM 创作方案已落库',
        detail: `已创建“${project.title}”，提取 ${data.creativePlan.characters?.length || 0} 位人物、${data.creativePlan.scenes?.length || 0} 个场景和 ${project.shotIds.length} 个可编辑分镜。`,
      });
    } catch (projectError) {
      setError(projectError.message);
      appendTrace({ state: 'error', title: '创作方案整理失败', detail: projectError.message });
    } finally {
      setPlanningProject(false);
    }
  }

  function archiveProjectEntityResult(resultTask, entity) {
    const hasResult = resultTask?.status === 'SUCCEEDED' && resultTask.imageUrls?.length;
    if (!hasResult || !resultTask.taskId || !onSaveAssets || archivedTaskIds.current.has(resultTask.taskId)) return;
    archivedTaskIds.current.add(resultTask.taskId);
    onSaveAssets(resultTask.imageUrls.filter(Boolean).map((url, index) => ({
      projectId: resultTask.projectId,
      type: 'image',
      category: entity.category,
      title: `${entity.title} · 设定图 ${index + 1}`,
      previewUrl: url,
      tags: ['Agent', 'LLM', entity.category === 'character' ? '人物设定' : '场景设定'],
      relatedAssetIds: [entity.id],
      versionGroupId: `entity:${entity.id}:image:variant:${index + 1}`,
      source: {
        provider: resultTask.provider || resultTask.plan?.provider || '',
        model: resultTask.plan?.modelId || '',
        workflow: resultTask.plan?.workflow || 'text-to-image',
        prompt: resultTask.plan?.request?.prompt || entity.source?.prompt || '',
        parameters: { ...(resultTask.plan?.output || resultTask.plan?.request || {}), taskId: resultTask.taskId, entityId: entity.id, assetRole: 'intermediate' },
      },
    })));
    appendTrace({ state: 'completed', title: `${entity.title} 图片资产已归档`, detail: `已根据 LLM 提示词生成并关联 ${resultTask.imageUrls.length} 张${entity.category === 'character' ? '人物' : '场景'}设定图。` });
  }

  function chooseProject(nextProjectId) {
    setProjectId(nextProjectId);
    const project = projects.find((item) => item.id === nextProjectId);
    setShotId(project?.shotIds[0] || '');
    setServerPlan(null);
    if (project) appendTrace({ state: 'completed', title: '切换当前项目', detail: `当前项目为“${project.title}”，已选择第一个待执行镜头。` });
  }

  function saveShotEdit() {
    if (!selectedShot || !onUpdateAsset) return;
    const nextContent = shotDraft.trim();
    if (!nextContent) {
      setError('镜头内容不能为空');
      return;
    }
    if (nextContent === selectedShot.content) return;
    onUpdateAsset(selectedShot.id, { content: nextContent });
    setServerPlan(null);
    setError('');
    setProjectWorkflow(selectedProject?.id, {
      status: 'ready', currentStepId: 'generate', paused: false,
      lastEvent: `${selectedShot.title} 已更新，已有结果会保留为历史版本。`,
      stepUpdates: [
        { id: 'generate', status: 'ready', detail: `${selectedShot.title} 已修改，等待重新审核生成路径。` },
        { id: 'review', status: 'pending', detail: '修改后可生成新版本，再进行人工查看。' },
      ],
    });
    appendTrace({ state: 'completed', title: `${selectedShot.title} 已更新`, detail: '已保留历史生成结果；重新审核后会为该镜头创建新的素材版本。' });
  }

  async function requestPlan() {
    if (!canPlan) return;
    setPlanning(true);
    setError('');
    appendTrace({
      state: 'active',
      title: '正在审核模型路径',
      detail: `正在根据${selectedShot?.title || '当前创作描述'}核对可用模型、生成方式和输出参数。`,
    });
    try {
      const data = await requestJson('/api/agent/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(agentInput),
      });
      if (!data.agentPlan || !data.planId) throw new Error('Agent 没有返回可执行计划');
      setServerPlan({ ...data.agentPlan, planId: data.planId });
      appendTrace({
        state: 'completed',
        title: '服务端计划已确认',
        detail: `${data.agentPlan.summary}。计划已锁定，确认生成时不会重新选择模型。`,
      });
    } catch (planError) {
      setError(planError.message);
      appendTrace({ state: 'error', title: '计划审核失败', detail: planError.message });
    } finally {
      setPlanning(false);
    }
  }

  async function generate() {
    if (!canGenerate) return;
    const token = pollToken.current + 1;
    pollToken.current = token;
    window.clearTimeout(pollTimer.current);
    setError('');
    setTask({ ...createInitialAgentTask(), status: 'PENDING', kind: serverPlan.kind, plan: serverPlan, projectId, shotId });
    appendTrace({
      state: 'active',
      title: '正在提交真实生成任务',
      detail: `${serverPlan.summary}。当前调用会使用服务端密钥，不会把密钥发送到浏览器。`,
    });
    try {
      const data = await requestJson('/api/agent/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: serverPlan.planId }),
      });
      const plan = data.agentPlan || serverPlan;
      const nextTask = {
        ...createInitialAgentTask(), taskId: data.taskId || '', provider: data.provider || '', videoId: data.videoId || '', kind: plan.kind, plan,
        status: data.status || 'PENDING', videoUrl: data.videoUrl || '', imageUrls: data.imageUrls || [], error: '', size: '', projectId, shotId,
      };
      saveStudioTask(window.localStorage, 'agent', nextTask);
      if (pollToken.current !== token) return;
      setTask(nextTask);
      appendTrace({
        state: 'active',
        title: '生成任务已创建',
        detail: `已提交给 ${data.provider || plan.provider || '模型服务'}，任务编号为 ${data.taskId || '同步结果'}。`,
      });
      if (data.status === 'SUCCEEDED' && (plan.kind === 'video' ? data.videoUrl : data.imageUrls?.length)) return;
      if (!data.taskId) throw new Error('生成服务没有返回任务编号或结果地址');
      pollTask(data.taskId, plan.kind, data.provider, data.videoId, token);
    } catch (requestError) {
      if (pollToken.current === token) {
        setTask((current) => ({ ...current, status: 'FAILED', error: requestError.message }));
        appendTrace({ state: 'error', title: '生成任务提交失败', detail: requestError.message });
      }
    }
  }

  function reset() {
    pollToken.current += 1;
    window.clearTimeout(pollTimer.current);
    setSource('inspiration');
    setPrompt('');
    setVisualStyle('2D 动漫');
    setRatio('9:16');
    setDuration(5);
    setProjectId('');
    setShotId('');
    setError('');
    setPlanningProject(false);
    setServerPlan(null);
    setTask(createInitialAgentTask());
    tracedTaskState.current = '';
    clearAgentTrace(window.localStorage);
    setTrace([]);
  }

  async function download(url, kind, index = 0) {
    try {
      const endpoint = kind === 'video' ? '/api/video-download?url=' : '/api/image-download?url=';
      const response = await fetch(endpoint + encodeURIComponent(url));
      if (!response.ok) throw new Error('下载失败');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = kind === 'video' ? 'agent-video.mp4' : `agent-image-${index + 1}.png`;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      setError(downloadError.message);
    }
  }

  async function composeProjectVideos() {
    if (!selectedProject || projectVideoClips.length < 2 || composition.status === 'RUNNING') return;
    setComposition({ status: 'RUNNING', videoUrl: '', error: '', clipCount: projectVideoClips.length });
    setError('');
    appendTrace({ state: 'active', title: '正在合并项目镜头', detail: `将按分镜顺序拼接 ${projectVideoClips.length} 段已完成视频，并裁切为 ${selectedProject.duration} 秒。` });
    try {
      const data = await requestJson('/api/video-compositions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          videoUrls: projectVideoClips.map((asset) => asset.previewUrl),
          targetDuration: selectedProject.duration,
        }),
      });
      if (!data.videoUrl) throw new Error('视频拼接器没有返回成片地址');
      setComposition({ status: 'SUCCEEDED', videoUrl: data.videoUrl, error: '', clipCount: Number(data.clipCount) || projectVideoClips.length });
      onSaveAssets?.([{
        projectId: selectedProject.id,
        type: 'video',
        category: 'final',
        title: `Agent 成片 · ${selectedProject.title}`,
        previewUrl: data.videoUrl,
        tags: ['Agent 成片', '镜头拼接', selectedProject.creativeState?.plan?.label].filter(Boolean),
        relatedAssetIds: selectedProject.shotIds,
        versionGroupId: `project:${selectedProject.id}:final:agent`,
        source: { provider: 'local-ffmpeg', model: 'ffmpeg', workflow: 'video-concatenation', prompt: selectedProject.brief, parameters: { compositionId: data.compositionId || '', clipCount: Number(data.clipCount) || projectVideoClips.length } },
      }]);
      setProjectWorkflow(selectedProject.id, {
        status: 'complete', currentStepId: 'review', paused: false,
        lastEvent: `已按分镜顺序合并 ${Number(data.clipCount) || projectVideoClips.length} 段视频，成片为 ${Number(data.targetDuration) || selectedProject.duration} 秒并已归档。`,
        stepUpdates: [{ id: 'review', status: 'completed', detail: '成片已生成并归档，可查看或下载。' }],
      });
      appendTrace({ state: 'completed', title: '项目成片已生成', detail: `已拼接 ${Number(data.clipCount) || projectVideoClips.length} 段镜头并裁切为 ${Number(data.targetDuration) || selectedProject.duration} 秒，已归档为最终视频资产。` });
    } catch (composeError) {
      const message = composeError.message || '视频拼接失败';
      setComposition({ status: 'FAILED', videoUrl: '', error: message, clipCount: projectVideoClips.length });
      setError(message);
      appendTrace({ state: 'error', title: '项目成片生成失败', detail: message });
    }
  }

  const requirement = !agentInput.prompt
    ? `先写下${source === 'script' ? '剧本或分镜' : '创作灵感'}，再由 Agent 规划生成路径`
    : isShotDirty
      ? '请先保存镜头修改，再审核新的生成路径'
    : planningProject
      ? 'LLM 正在提取人物、场景并生成分镜提示词'
      : planning
        ? 'Agent 正在核对当前可用模型与输出参数'
        : isGenerating
          ? '任务已提交，结果会自动写入资产中心'
          : serverPlan
            ? '服务端计划已确认，执行后才会调用真实生成服务'
            : selectedShot
              ? `将审核 ${selectedShot.title} 的真实模型路径`
              : '先审核生成计划，确认后再开始真实生成';

  function submitAgentAction() {
    if (serverPlan) generate();
    else requestPlan();
  }

  function reopenPlan() {
    setServerPlan(null);
    setError('');
    appendTrace({ state: 'completed', title: '重新打开计划审核', detail: '将根据当前镜头和最新模型可用性重新审核执行路径，尚未调用生成服务。' });
  }

  function workflowStepClass(step, index) {
    if (!selectedProject) {
      const stepNumber = index + 1;
      return stepNumber < currentStep ? 'done' : stepNumber === currentStep ? 'active' : '';
    }
    if (step.status === 'completed') return 'done';
    if (step.status === 'blocked') return 'blocked';
    if (step.status === 'paused') return 'paused';
    if (step.status === 'waiting_review') return 'review';
    if (step.id === selectedProject.creativeState?.currentStepId) return 'active';
    if (step.status === 'ready') return 'ready';
    return '';
  }

  return (
    <main className="app-shell agent-app-shell">
      <header className="topbar">
        <div className="brand-block"><p>SHORT VIDEO STUDIO</p><h1>创作 Agent</h1></div>
        <div className="topbar-controls">
          <div className="studio-switch" role="tablist" aria-label="创作类型">
            <button type="button" onClick={onOpenHome} role="tab" aria-selected="false"><Home size={16} /><span>首页</span></button>
            <button type="button" className="active" role="tab" aria-selected="true"><Bot size={16} /><span>Agent</span></button>
            <button type="button" onClick={onOpenVideo} role="tab" aria-selected="false"><Video size={16} /><span>视频</span></button>
            <button type="button" onClick={onOpenImage} role="tab" aria-selected="false"><ImageIcon size={16} /><span>图片</span></button>
            <button type="button" onClick={onOpenAssets} role="tab" aria-selected="false"><Archive size={16} /><span>资产</span></button>
          </div>
          <button type="button" className="topbar-icon-action" onClick={refreshAvailability} disabled={availabilityLoading || isGenerating} aria-label="刷新模型状态" title="刷新模型状态"><RefreshCw className={availabilityLoading ? 'spin' : ''} size={16} /></button>
          <div className="service-metrics" aria-label="Agent 服务状态">
            <div><span>项目</span><strong>{projects.length}</strong></div>
            <div><span>可用模型</span><strong>{videoModels.length + imageModels.length}</strong></div>
            <div className={'status-strip ' + (task.status === 'FAILED' ? 'error' : '')}><span>{statusLabel(task.status)}</span><strong>{resultKind === 'video' ? 'VID' : resultKind === 'image' ? 'IMG' : '--'}</strong></div>
          </div>
        </div>
      </header>

      <section className="workspace">
        <section className="control-panel">
          <ol className="agent-workflow-steps" style={{ '--workflow-step-count': projectWorkflow.length }} aria-label="创作项目流程">
            {projectWorkflow.map((step, index) => {
              const stepNumber = index + 1;
              return <li className={workflowStepClass(step, index)} key={step.id}><span>{String(stepNumber).padStart(2, '0')}</span><div><strong>{step.label}</strong><small>{step.detail || step.summary}</small></div></li>;
            })}
          </ol>

          <section className="task-console" aria-labelledby="agent-brief-title">
            <div className="section-heading"><span>01</span><div><h2 id="agent-brief-title">创作立项</h2><p>说出想法或粘贴剧本。建立项目后，LLM 会整理故事、人物、场景与可执行分镜。</p></div></div>
            <div className="agent-source-tabs" role="tablist" aria-label="创作来源">
              {SOURCES.map((item) => <button type="button" key={item.id} className={source === item.id ? 'active' : ''} onClick={() => setSource(item.id)} role="tab" aria-selected={source === item.id} disabled={isGenerating}>{item.id === 'script' ? <FileText size={16} /> : <Sparkles size={16} />}<span><strong>{item.label}</strong><small>{item.summary}</small></span></button>)}
            </div>
            <p className="agent-video-only-note"><Video size={16} />Agent 仅输出视频成片；人物、场景和关键画面图会自动作为图生视频的中间资产。</p>
            <label className="field prompt-field agent-prompt-field"><span>{selectedShot ? `${selectedShot.title} 内容` : (source === 'script' ? '剧本或分镜' : '创作灵感')}</span><textarea value={selectedShot ? shotDraft : prompt} onChange={(event) => selectedShot ? setShotDraft(event.target.value) : setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); selectedShot ? saveShotEdit() : submitAgentAction(); } }} placeholder={source === 'script' ? '例如：30 秒雨夜书店短片。女孩推开门，纸飞机从书页间飞出，镜头跟随它穿过暖光。' : '例如：30 秒 2D 动漫短片，纸飞机穿过霓虹夜城，镜头向上跟随。'} maxLength={5000} disabled={isGenerating} /><small>{(selectedShot ? shotDraft : prompt).length}/5000</small></label>
          </section>

          <section className="input-console" aria-labelledby="agent-direction-title">
            <div className="section-heading"><span>02</span><div><h2 id="agent-direction-title">项目与视觉设定</h2><p>时长、风格和比例由你选择；LLM 会据此拆分分镜并保持视觉连续性。</p></div></div>
            <div className="agent-settings-grid">
              <label className="field"><span><Palette size={14} />视觉风格</span><select value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)} disabled={isGenerating}>{VISUAL_STYLES.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="field"><span><Clapperboard size={14} />视频比例</span><select value={ratio} onChange={(event) => setRatio(event.target.value)} disabled={isGenerating}>{VIDEO_RATIOS.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="field"><span><Video size={14} />项目时长</span><input type="number" min={PROJECT_DURATION_MIN} max={PROJECT_DURATION_MAX} step="1" value={duration} onChange={(event) => setDuration(event.target.value === '' ? '' : Math.min(PROJECT_DURATION_MAX, Math.max(PROJECT_DURATION_MIN, Number(event.target.value))))} onBlur={() => setDuration((current) => Number.isFinite(Number(current)) ? Math.min(PROJECT_DURATION_MAX, Math.max(PROJECT_DURATION_MIN, Math.round(Number(current)))) : 5)} inputMode="numeric" disabled={isGenerating || planningProject} aria-describedby="agent-project-duration-help" /><small id="agent-project-duration-help">输入 {PROJECT_DURATION_MIN}-{PROJECT_DURATION_MAX} 秒。超过单次模型上限时，自动按最大合法时长分段生成、拼接并裁切为此时长。</small></label>
            </div>
            <div className="agent-project-strip">
              <div className="agent-project-label"><FolderKanban size={16} /><div><span>当前项目</span><strong>{selectedProject?.title || '尚未建立项目'}</strong></div></div>
              <select value={projectId} onChange={(event) => chooseProject(event.target.value)} disabled={isGenerating}><option value="">不绑定项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select>
              {selectedProject && <span className="agent-project-progress">{projectProgressState.complete}/{projectProgressState.total} 镜头已生成</span>}
            </div>
            {selectedProject && <section className="creative-state-panel" aria-label="项目创作状态"><div><span>创作状态</span><strong>{selectedProject.creativeState?.lastEvent || '等待下一步。'}</strong></div><small>{selectedProject.creativeState?.status === 'waiting_review' ? '等待人工审核' : selectedProject.creativeState?.status === 'paused' ? '后续镜头已暂停' : selectedProject.creativeState?.status === 'blocked' ? '需要处理失败任务' : '状态会随项目执行自动保存'}</small></section>}
            {selectedProject && <div className="agent-entity-summary" aria-label="LLM 提取的创作实体"><span><strong>{projectCharacters.length}</strong> 位人物</span><span><strong>{projectScenes.length}</strong> 个场景</span><span><strong>{projectShots.length}</strong> 个分镜</span><small>提示词已写入分镜脚本与资产中心</small></div>}
            {selectedProject && <div className="agent-shot-list" role="tablist" aria-label="项目镜头">{projectShots.map((shot, index) => <button type="button" key={shot.id} className={shotId === shot.id ? 'active' : ''} onClick={() => { setShotId(shot.id); setServerPlan(null); }} disabled={isGenerating} role="tab" aria-selected={shotId === shot.id}><span>SHOT {String(index + 1).padStart(2, '0')}</span><strong>{shot.content}</strong></button>)}</div>}
            {selectedShot && <div className="agent-shot-editor"><span>修改镜头后，重新审核会为该镜头创建新版本，历史结果保留。</span><button type="button" className="secondary-action" onClick={saveShotEdit} disabled={isGenerating || !shotDraft.trim() || shotDraft.trim() === selectedShot.content}><FileText size={14} />保存镜头修改</button></div>}
            {selectedProject && <section className={'agent-project-queue ' + (projectRun.status === 'FAILED' ? 'failed' : projectRun.status === 'SUCCEEDED' ? 'completed' : '')} aria-label="Agent 项目执行队列">
              <div><span>项目执行队列</span><strong>{isProjectRunning ? `已完成 ${projectRun.completedShotIds.length}/${projectRun.shotIds.length} 个视频镜头` : projectRun.status === 'SUCCEEDED' ? '视频镜头已完成' : projectRun.status === 'PAUSED' ? '后续任务已暂停' : `${pendingProjectEntityCount ? `${pendingProjectEntityCount} 个中间实体资产、` : ''}${pendingProjectShotCount} 个视频镜头待生成`}</strong><small>{projectRun.status === 'FAILED' ? `${failedProjectShot?.title || '当前任务'}：${projectRun.error}` : projectRun.status === 'PAUSED' ? '可以继续剩余视频镜头；已完成结果已归档。' : projectRun.status === 'PAUSE_REQUESTED' ? '当前镜头完成后会暂停后续镜头。' : '会先准备人物、场景和镜头关键画面，再逐镜头生成视频。'}</small></div>
              <div className="agent-project-actions"><button type="button" className="secondary-action" onClick={executeProjectQueue} disabled={isGenerating || isProjectRunning || (!pendingProjectShotCount && !pendingProjectEntityCount)}>{isProjectRunning ? <Loader2 className="spin" size={14} /> : projectRun.status === 'PAUSED' ? <Play size={14} /> : <Clapperboard size={14} />}{projectRun.status === 'FAILED' ? '从待生成任务继续' : projectRun.status === 'PAUSED' ? '继续剩余任务' : '连续执行待生成任务'}</button>{projectRun.status === 'RUNNING' && <button type="button" className="secondary-action" onClick={pauseProjectQueue}><Pause size={14} />暂停后续镜头</button>}</div>
            </section>}
            {selectedProject && projectShots.length > 0 && <section className={'agent-composition-panel ' + composition.status.toLowerCase()} aria-label="项目成片合并">
              <div><span>项目成片</span><strong>{composition.status === 'SUCCEEDED' ? `已合并 ${composition.clipCount} 段镜头` : `已完成 ${projectVideoClips.length}/${projectShots.length} 段视频镜头`}</strong><small>{composition.status === 'FAILED' ? composition.error : composition.status === 'SUCCEEDED' ? '成片已归档到资产中心。' : '本地运行时会使用 FFmpeg 按分镜顺序合并已完成镜头。'}</small></div>
              <div className="agent-composition-actions"><button type="button" className="secondary-action" onClick={composeProjectVideos} disabled={projectVideoClips.length < 2 || composition.status === 'RUNNING'}>{composition.status === 'RUNNING' ? <Loader2 className="spin" size={14} /> : <Clapperboard size={14} />}{composition.status === 'RUNNING' ? '正在合并镜头' : '合并为项目成片'}</button>{composition.videoUrl && <a className="secondary-action" href={composition.videoUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />打开成片</a>}</div>
            </section>}
            <div className="agent-pipeline-note"><span><Check size={13} />项目文档与分镜</span><strong>{selectedProject ? '已建立' : '创建项目后建立'}</strong><span><Bot size={13} />中间图像资产</span><strong>自动生成并用于图生视频</strong><span><Clapperboard size={13} />项目视频成片</span><strong>镜头完成后自动拼接</strong></div>
          </section>

          <section className="model-console" aria-labelledby="agent-plan-title">
            <div className="section-heading"><span>03</span><div><h2 id="agent-plan-title">审核当前执行计划</h2><p>{freeOnly ? '仅选择免费白名单中的可用模型' : '仅选择当前服务端可用的模型'}</p></div></div>
            {plannedAgent ? (
              <div className="agent-plan-stack" aria-live="polite">
                <div className="agent-brief-readout"><div><span>执行对象</span><strong>{selectedShot?.title || '单次创作'}</strong></div><div><span>视觉设定</span><strong>{plannedAgent.brief?.style || visualStyle}</strong></div><div><span>审核状态</span><strong>{serverPlan ? '服务端已确认' : '本地预览'}</strong></div></div>
                <div className="agent-plan-readout"><div><span>生成方式</span><strong>{plannedAgent.kind === 'video' ? '视频' : '图片'} / {plannedAgent.workflow}</strong></div><div><span>兼容模型</span><strong>{plannedAgent.modelLabel}</strong><small>{plannedAgent.modelId}</small></div><div><span>输出设置</span><strong>{planOutput(plannedAgent)}</strong></div><div><span>执行路径</span><strong>{plannedAgent.summary}</strong><small>{serverPlan ? '等待确认后调用真实服务' : '尚未调用生成服务'}</small></div></div>
              </div>
            ) : <p className="empty-model-state">填写立项信息后，Agent 会先展示可审核的生成计划。</p>}
          </section>

          {taskError && <p className="error-message" role="alert"><AlertTriangle size={16} />{taskError}</p>}
          {task.status === 'FAILED' && <div className="task-recovery" aria-label="失败恢复操作"><span>任务未完成</span><button type="button" className="secondary-action" onClick={generate} disabled={!serverPlan?.planId || isProjectRunning}>重新提交</button><button type="button" className="secondary-action" onClick={reopenPlan} disabled={isProjectRunning}>重新审核路径</button><button type="button" className="secondary-action" onClick={onOpenVideo}>改用视频工作台</button></div>}
          <section className="action-row agent-action-row">
            <button type="button" className="secondary-action agent-project-action" onClick={createProject} disabled={!prompt.trim() || planningProject || isGenerating}><FolderKanban size={16} />{planningProject ? 'LLM 正在整理分镜' : '创建项目与分镜'}</button>
            <div className="primary-action-wrap"><button type="button" className="primary-action" onClick={submitAgentAction} disabled={serverPlan ? !canGenerate : !canPlan} title={requirement}>{planning || planningProject || isGenerating ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}{planningProject ? '正在整理创作方案' : planning ? '正在审核计划' : isGenerating ? 'Agent 正在生成' : serverPlan ? '确认并开始生成' : '审核生成计划'}</button><p className={'action-note ' + ((canPlan || canGenerate) ? 'ready' : 'warning')} aria-live="polite">{requirement}</p></div>
            <button type="button" className="icon-action" onClick={reset} aria-label="新建创作项目" title="新建创作项目"><RefreshCw size={18} /></button>
          </section>
        </section>

        <section className="preview-panel agent-preview-panel" aria-label="Agent 生成结果">
          <div className="preview-toolbar"><div className="panel-heading"><Bot size={18} /><div><h2>项目输出</h2><span>{task.plan?.modelLabel || displayPlan?.modelLabel || '等待审核计划'}</span></div></div><div className={'preview-model-state ' + statusTone(task.status)} aria-live="polite">{planning || isGenerating ? <Loader2 className="spin" size={15} /> : task.status === 'FAILED' ? <AlertTriangle size={15} /> : <Check size={15} />}<span>{planning ? '正在审核计划' : statusLabel(task.status)}</span></div><div className="toolbar-actions"><button type="button" className="icon-action" onClick={onOpenAssets} aria-label="查看资产中心" title="查看资产中心"><Archive size={17} /></button></div></div>
          <div className={'agent-result-stage ' + (task.videoUrl ? 'has-result' : '')}>
            {task.videoUrl ? <div className="agent-video-result"><video src={task.videoUrl} controls autoPlay loop playsInline /><div><span>视频结果</span><section><a className="icon-action" href={task.videoUrl} target="_blank" rel="noreferrer" aria-label="打开生成视频" title="在新窗口打开视频"><ExternalLink size={16} /></a><button type="button" className="icon-action" onClick={() => download(task.videoUrl, 'video')} aria-label="下载生成视频" title="下载视频"><Download size={16} /></button></section></div></div> : <div className="image-empty-state"><Bot size={36} /><span className="result-eyebrow">{task.kind === 'image' ? '正在准备视频中间资产' : isGenerating ? 'Agent 正在生成视频镜头' : planning ? 'Agent 正在审核模型能力' : serverPlan ? '视频计划已确认，等待开始生成' : selectedProject ? '选择镜头并审核视频计划' : '等待视频创作立项'}</span><strong>{task.kind === 'image' ? '关键画面将自动作为首帧提交给视频模型。' : (isGenerating ? (task.plan?.summary || '正在生成视频') : (selectedShot?.content || prompt.trim() || '从一个灵感或一段剧本，开始新的视频项目。'))}</strong><span>{displayPlan?.summary || '建立项目后，Agent 会生成可编辑的故事、角色、场景、分镜与最终视频。'}</span></div>}
          </div>
          <section className="agent-trace-panel" aria-labelledby="agent-trace-title">
            <div className="agent-trace-heading"><div><BrainCircuit size={17} /><div><h2 id="agent-trace-title">Agent 思考与执行</h2><span>显示可解释决策和真实接口动作</span></div></div><Clock3 size={15} /></div>
            <div className="agent-trace-current"><span>当前判断</span><strong>{decisionSummary}</strong></div>
            <ol className="agent-trace-list" aria-live="polite">
              {traceEvents.map((event) => {
                const TraceIcon = event.state === 'completed' ? CircleCheck : event.state === 'error' ? CircleX : CircleDot;
                return <li key={event.id} className={event.state}><TraceIcon size={15} /><div><strong>{event.title}</strong><span>{event.detail}</span></div><time dateTime={new Date(event.at).toISOString()}>{traceTime(event.at)}</time></li>;
              })}
              {!traceEvents.length && <li className="pending"><CircleDot size={15} /><div><strong>等待执行</strong><span>创建项目、审核计划或提交生成后，工作记录会显示在这里。</span></div></li>}
            </ol>
          </section>
          <div className="result-readout"><div><span>项目</span><strong>{selectedProject?.title || '未归档'}</strong></div><div><span>当前镜头</span><strong>{selectedShot?.title || '--'}</strong></div><div><span>输出</span><strong>{planOutput(task.plan || plannedAgent)}</strong></div><div><span>状态</span><strong>{statusLabel(task.status)}</strong></div></div>
        </section>
      </section>
    </main>
  );
}
