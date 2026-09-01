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
  RefreshCw,
  Sparkles,
  Video,
} from 'lucide-react';
import { buildCreativeAgentPlan } from '../shared/creative-agent.mjs';
import { IMAGE_MODELS } from '../shared/image-models.mjs';
import { VIDEO_MODELS } from '../shared/video-models.mjs';
import { projectProgress } from './creative-library.mjs';
import { appendAgentTrace, clearAgentTrace, readAgentTrace, saveAgentTrace } from './agent-trace.mjs';
import { isTransientPollError, pollRetryDelay } from './video-task-state.mjs';
import { isRecoverableStudioTask, readStudioTask, saveStudioTask } from './task-session.mjs';

const POLL_INTERVAL = Number(import.meta.env.VITE_POLL_INTERVAL) || 5000;
const MAX_POLL_RETRIES = 3;
const TARGETS = [
  { id: 'auto', label: '自动判断', summary: '让 Agent 判断图片或视频路径' },
  { id: 'image', label: '生成图片', summary: '构图、风格与画面细节' },
  { id: 'video', label: '生成视频', summary: '动作、镜头与短片时长' },
];
const SOURCES = [
  { id: 'inspiration', label: '灵感', summary: '从一句想法开始' },
  { id: 'script', label: '剧本', summary: '粘贴已有剧情或分镜' },
];
const VISUAL_STYLES = ['2D 动漫', '电影感', '写实质感', '产品展示'];
const VIDEO_RATIOS = ['9:16', '16:9', '1:1', '4:3', '3:4'];
const VIDEO_DURATIONS = [5, 10, 15, 30];
const PROJECT_STEPS = [
  { id: 'brief', label: '创作立项', summary: '灵感与目标' },
  { id: 'storyboard', label: '分镜资料', summary: '故事、角色、场景' },
  { id: 'review', label: '镜头审核', summary: '模型与参数' },
  { id: 'generate', label: '生成素材', summary: '图片或视频' },
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
  launchDraft,
  projects = [],
  assets = [],
}) {
  const [target, setTarget] = useState('auto');
  const [source, setSource] = useState('inspiration');
  const [prompt, setPrompt] = useState('');
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
  const [task, setTask] = useState(() => readStudioTask(window.localStorage, 'agent') || createInitialAgentTask());
  const [error, setError] = useState('');
  const [trace, setTrace] = useState(() => readAgentTrace(window.localStorage));
  const [projectRun, setProjectRun] = useState(createInitialProjectRun);
  const pollToken = useRef(0);
  const pollTimer = useRef(0);
  const tracedTaskState = useRef('');
  const projectRunToken = useRef(0);
  const archivedTaskIds = useRef(new Set());
  const handledLaunchId = useRef('');

  function appendTrace(input) {
    setTrace((current) => appendAgentTrace(current, input));
  }

  const selectedProject = projects.find((project) => project.id === projectId) || null;
  const selectedShot = assets.find((asset) => asset.id === shotId && asset.projectId === projectId) || null;
  const projectShots = useMemo(() => selectedProject
    ? selectedProject.shotIds.map((id) => assets.find((asset) => asset.id === id)).filter(Boolean)
    : [], [assets, selectedProject]);
  const activePrompt = selectedShot?.content || prompt.trim();
  const activeDuration = selectedShot ? 5 : duration;
  const agentInput = useMemo(() => ({
    target,
    source,
    prompt: activePrompt,
    style: visualStyle,
    ratio,
    duration: activeDuration,
  }), [activeDuration, activePrompt, ratio, source, target, visualStyle]);
  const draftPlan = useMemo(() => {
    if (!agentInput.prompt) return null;
    try {
      return buildCreativeAgentPlan(agentInput, { videoModels, imageModels });
    } catch (planError) {
      return { error: planError.message };
    }
  }, [agentInput, imageModels, videoModels]);
  const plannedAgent = serverPlan || (draftPlan?.error ? null : draftPlan);
  const displayPlan = task.plan || plannedAgent;
  const isGenerating = task.status === 'PENDING' || task.status === 'RUNNING';
  const isProjectRunning = projectRun.status === 'RUNNING';
  const canPlan = Boolean(agentInput.prompt && plannedAgent && !planning && !isGenerating && !isProjectRunning);
  const canGenerate = Boolean(serverPlan?.planId && !isGenerating && !isProjectRunning);
  const taskError = error || task.error;
  const resultKind = task.kind || plannedAgent?.kind || '';
  const projectProgressState = selectedProject ? projectProgress(selectedProject, assets) : { complete: 0, total: 0 };
  const pendingProjectShotCount = selectedProject
    ? projectShots.filter((shot) => !assets.some((asset) => asset.type !== 'document' && asset.relatedAssetIds.includes(shot.id))).length
    : 0;
  const failedProjectShot = projectRun.failedShotId ? projectShots.find((shot) => shot.id === projectRun.failedShotId) : null;
  const decisionSummary = !activePrompt
    ? '等待创作描述。填写灵感或剧本后，Agent 会先给出可审核的模型路径。'
    : selectedShot
      ? `${selectedShot.title} 已设为当前执行镜头；${draftPlan?.summary || '正在匹配模型能力。'}`
      : `${target === 'auto' ? '将根据内容自动判断图片或视频路径' : `已指定${target === 'video' ? '视频' : '图片'}路径`}；${draftPlan?.summary || '正在匹配模型能力。'}`;
  const traceEvents = [...trace].reverse();
  const currentStep = task.status === 'SUCCEEDED'
    ? 5
    : task.status !== 'IDLE'
      ? 4
      : (serverPlan || planning)
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
    const urls = resultTask.kind === 'video' ? [resultTask.videoUrl] : resultTask.imageUrls;
    const shot = assets.find((asset) => asset.id === resultTask.shotId);
    appendTrace({
      state: 'completed',
      title: '生成结果已归档',
      detail: `${urls.filter(Boolean).length} 个${resultTask.kind === 'video' ? '视频' : '图片'}结果已关联${shot ? `到${shot.title}` : '到资产中心'}。`,
    });
    onSaveAssets(urls.filter(Boolean).map((url, index) => ({
      projectId: resultTask.projectId || null,
      type: resultTask.kind === 'video' ? 'video' : 'image',
      category: resultTask.projectId ? 'shot' : 'material',
      title: `${resultTask.plan?.modelLabel || 'Agent 生成'} · ${shot?.title || `${resultTask.kind === 'video' ? '视频' : '图片'} ${index + 1}`}`,
      previewUrl: url,
      tags: [resultTask.plan?.brief?.style, resultTask.plan?.workflow, shot?.title].filter(Boolean),
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
        parameters: { ...(resultTask.plan?.output || resultTask.plan?.request || {}), taskId: resultTask.taskId },
      },
    })));
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
    setTarget(['auto', 'image', 'video'].includes(launchDraft.target) ? launchDraft.target : (launchDraft.kind === 'image' ? 'image' : 'video'));
    setPrompt(launchDraft.prompt || '继续完成当前创作。');
    if (VISUAL_STYLES.includes(launchDraft.style)) setVisualStyle(launchDraft.style);
    if (VIDEO_RATIOS.includes(launchDraft.ratio)) setRatio(launchDraft.ratio);
    if (VIDEO_DURATIONS.includes(Number(launchDraft.duration))) setDuration(Number(launchDraft.duration));
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
    if (!selectedProject || shotId || !projectShots[0]) return;
    setShotId(projectShots[0].id);
  }, [projectShots, selectedProject, shotId]);

  useEffect(() => {
    const hasResult = task.status === 'SUCCEEDED' && (task.videoUrl || task.imageUrls.length);
    if (!hasResult) return;
    archiveAgentTaskResult(task);
  }, [assets, task]);

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
    const pendingShots = projectShots.filter((shot) => !assets.some((asset) => asset.type !== 'document' && asset.relatedAssetIds.includes(shot.id)));
    if (!pendingShots.length) {
      setError('当前项目的所有镜头都已有生成素材，可在资产中心查看版本或继续编辑。');
      return;
    }
    const token = projectRunToken.current + 1;
    projectRunToken.current = token;
    setError('');
    setProjectRun({ status: 'RUNNING', shotIds: pendingShots.map((shot) => shot.id), completedShotIds: [], failedShotId: '', error: '' });
    appendTrace({ state: 'active', title: '开始连续执行项目', detail: `将按顺序审核并生成 ${pendingShots.length} 个待生成镜头；每个结果会自动归档后再继续。` });

    for (const shot of pendingShots) {
      if (projectRunToken.current !== token) return;
      const queueInput = { target: target === 'image' ? 'image' : 'video', source: 'script', prompt: shot.content, style: visualStyle, ratio, duration: 5 };
      setShotId(shot.id);
      appendTrace({ state: 'active', title: `审核 ${shot.title}`, detail: '正在根据镜头需求选择兼容模型与输出参数。' });
      try {
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
        archiveAgentTaskResult(completedTask);
        setProjectRun((current) => ({ ...current, completedShotIds: [...current.completedShotIds, shot.id] }));
        appendTrace({ state: 'completed', title: `${shot.title} 已完成`, detail: '结果已归档，继续执行下一个待生成镜头。' });
      } catch (runError) {
        if (projectRunToken.current !== token) return;
        const message = runError.message || '镜头生成未能完成';
        setTask((current) => ({ ...current, status: 'FAILED', error: message, projectId: selectedProject.id, shotId: shot.id }));
        setProjectRun((current) => ({ ...current, status: 'FAILED', failedShotId: shot.id, error: message }));
        appendTrace({ state: 'error', title: `${shot.title} 执行失败`, detail: `${message}。队列已暂停，等待选择重试或重新审核。` });
        return;
      }
    }
    if (projectRunToken.current !== token) return;
    setProjectRun((current) => ({ ...current, status: 'SUCCEEDED' }));
    appendTrace({ state: 'completed', title: '项目连续执行完成', detail: '待生成镜头已完成并沉淀到资产中心，可继续编辑、生成音频或查看版本。' });
  }

  useEffect(() => {
    if (!isRecoverableStudioTask(task)) return;
    const token = pollToken.current + 1;
    pollToken.current = token;
    pollTask(task.taskId, task.kind, task.provider, task.videoId, token);
  }, []);

  function createProject() {
    if (!prompt.trim()) {
      setError(`先写下${source === 'script' ? '剧本或分镜' : '创作灵感'}，才能建立项目`);
      return;
    }
    try {
      const project = onCreateProject({ brief: prompt.trim(), source, style: visualStyle, ratio, duration });
      setProjectId(project.id);
      setShotId(project.shotIds[0] || '');
      setServerPlan(null);
      setError('');
      appendTrace({
        state: 'completed',
        title: '已建立创作项目',
        detail: `已创建“${project.title}”，并生成 ${project.shotIds.length} 个可编辑的 5 秒分镜及项目文档。`,
      });
    } catch (projectError) {
      setError(projectError.message);
    }
  }

  function chooseProject(nextProjectId) {
    setProjectId(nextProjectId);
    const project = projects.find((item) => item.id === nextProjectId);
    setShotId(project?.shotIds[0] || '');
    setServerPlan(null);
    if (project) appendTrace({ state: 'completed', title: '切换当前项目', detail: `当前项目为“${project.title}”，已选择第一个待执行镜头。` });
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
    setTarget('auto');
    setSource('inspiration');
    setPrompt('');
    setVisualStyle('2D 动漫');
    setRatio('9:16');
    setDuration(5);
    setProjectId('');
    setShotId('');
    setError('');
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

  const requirement = !agentInput.prompt
    ? `先写下${source === 'script' ? '剧本或分镜' : '创作灵感'}，再由 Agent 规划生成路径`
    : draftPlan?.error
      ? draftPlan.error
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
          <ol className="agent-workflow-steps" aria-label="创作项目流程">
            {PROJECT_STEPS.map((step, index) => {
              const stepNumber = index + 1;
              const state = stepNumber < currentStep ? 'done' : stepNumber === currentStep ? 'active' : '';
              return <li className={state} key={step.id}><span>{String(stepNumber).padStart(2, '0')}</span><div><strong>{step.label}</strong><small>{step.summary}</small></div></li>;
            })}
          </ol>

          <section className="task-console" aria-labelledby="agent-brief-title">
            <div className="section-heading"><span>01</span><div><h2 id="agent-brief-title">创作立项</h2><p>说出想法或粘贴剧本。建立项目后，Agent 会按 5 秒镜头沉淀资料和素材。</p></div></div>
            <div className="agent-source-tabs" role="tablist" aria-label="创作来源">
              {SOURCES.map((item) => <button type="button" key={item.id} className={source === item.id ? 'active' : ''} onClick={() => setSource(item.id)} role="tab" aria-selected={source === item.id} disabled={isGenerating}>{item.id === 'script' ? <FileText size={16} /> : <Sparkles size={16} />}<span><strong>{item.label}</strong><small>{item.summary}</small></span></button>)}
            </div>
            <div className="task-tabs agent-target-tabs" role="tablist" aria-label="生成目标">
              {TARGETS.map((item) => <button type="button" key={item.id} className={target === item.id ? 'active' : ''} onClick={() => setTarget(item.id)} role="tab" aria-selected={target === item.id} disabled={isGenerating}><strong>{item.label}</strong><span>{item.summary}</span><em>{item.id === 'auto' ? '推荐' : '指定'}</em></button>)}
            </div>
            <label className="field prompt-field agent-prompt-field"><span>{source === 'script' ? '剧本或分镜' : '创作灵感'}</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submitAgentAction(); } }} placeholder={source === 'script' ? '例如：30 秒雨夜书店短片。女孩推开门，纸飞机从书页间飞出，镜头跟随它穿过暖光。' : '例如：30 秒 2D 动漫短片，纸飞机穿过霓虹夜城，镜头向上跟随。'} maxLength={5000} disabled={isGenerating} /><small>{prompt.length}/5000</small></label>
          </section>

          <section className="input-console" aria-labelledby="agent-direction-title">
            <div className="section-heading"><span>02</span><div><h2 id="agent-direction-title">项目与视觉设定</h2><p>项目时长用于拆分镜头；每次真实调用只执行当前镜头，并按模型能力自动回退输出参数。</p></div></div>
            <div className="agent-settings-grid">
              <label className="field"><span><Palette size={14} />视觉风格</span><select value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)} disabled={isGenerating}>{VISUAL_STYLES.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="field"><span><Clapperboard size={14} />视频比例</span><select value={ratio} onChange={(event) => setRatio(event.target.value)} disabled={isGenerating}>{VIDEO_RATIOS.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label className="field"><span><Video size={14} />项目时长</span><select value={duration} onChange={(event) => setDuration(Number(event.target.value))} disabled={isGenerating}>{VIDEO_DURATIONS.map((item) => <option key={item} value={item}>{item} 秒</option>)}</select></label>
            </div>
            <div className="agent-project-strip">
              <div className="agent-project-label"><FolderKanban size={16} /><div><span>当前项目</span><strong>{selectedProject?.title || '尚未建立项目'}</strong></div></div>
              <select value={projectId} onChange={(event) => chooseProject(event.target.value)} disabled={isGenerating}><option value="">不绑定项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}</select>
              {selectedProject && <span className="agent-project-progress">{projectProgressState.complete}/{projectProgressState.total} 镜头已生成</span>}
            </div>
            {selectedProject && <div className="agent-shot-list" role="tablist" aria-label="项目镜头">{projectShots.map((shot, index) => <button type="button" key={shot.id} className={shotId === shot.id ? 'active' : ''} onClick={() => { setShotId(shot.id); setServerPlan(null); }} disabled={isGenerating} role="tab" aria-selected={shotId === shot.id}><span>SHOT {String(index + 1).padStart(2, '0')}</span><strong>{shot.content}</strong></button>)}</div>}
            {selectedProject && <section className={'agent-project-queue ' + (projectRun.status === 'FAILED' ? 'failed' : projectRun.status === 'SUCCEEDED' ? 'completed' : '')} aria-label="Agent 项目执行队列">
              <div><span>项目执行队列</span><strong>{isProjectRunning ? `已完成 ${projectRun.completedShotIds.length}/${projectRun.shotIds.length} 个镜头` : projectRun.status === 'SUCCEEDED' ? '待生成镜头已完成' : `${pendingProjectShotCount} 个镜头待生成`}</strong><small>{projectRun.status === 'FAILED' ? `${failedProjectShot?.title || '当前镜头'}：${projectRun.error}` : '连续执行会逐镜头调用真实服务，并在每个结果归档后继续。'}</small></div>
              <button type="button" className="secondary-action" onClick={executeProjectQueue} disabled={isGenerating || isProjectRunning || !pendingProjectShotCount}>{isProjectRunning ? <Loader2 className="spin" size={14} /> : <Clapperboard size={14} />}{projectRun.status === 'FAILED' ? '从待生成镜头继续' : '连续执行待生成镜头'}</button>
            </section>}
            <div className="agent-pipeline-note"><span><Check size={13} />项目文档与分镜</span><strong>{selectedProject ? '已建立' : '创建项目后建立'}</strong><span><Bot size={13} />图片 / 视频素材</span><strong>{selectedShot ? '可执行当前镜头' : '审核后执行'}</strong><span><Clapperboard size={13} />音频与成片</span><strong>待接入音频和剪辑服务</strong></div>
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
            <button type="button" className="secondary-action agent-project-action" onClick={createProject} disabled={!prompt.trim() || isGenerating}><FolderKanban size={16} />创建项目与分镜</button>
            <div className="primary-action-wrap"><button type="button" className="primary-action" onClick={submitAgentAction} disabled={serverPlan ? !canGenerate : !canPlan} title={requirement}>{planning || isGenerating ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}{planning ? '正在审核计划' : isGenerating ? 'Agent 正在生成' : serverPlan ? '确认并开始生成' : '审核生成计划'}</button><p className={'action-note ' + ((canPlan || canGenerate) ? 'ready' : 'warning')} aria-live="polite">{requirement}</p></div>
            <button type="button" className="icon-action" onClick={reset} aria-label="新建创作项目" title="新建创作项目"><RefreshCw size={18} /></button>
          </section>
        </section>

        <section className="preview-panel agent-preview-panel" aria-label="Agent 生成结果">
          <div className="preview-toolbar"><div className="panel-heading"><Bot size={18} /><div><h2>项目输出</h2><span>{task.plan?.modelLabel || displayPlan?.modelLabel || '等待审核计划'}</span></div></div><div className={'preview-model-state ' + statusTone(task.status)} aria-live="polite">{planning || isGenerating ? <Loader2 className="spin" size={15} /> : task.status === 'FAILED' ? <AlertTriangle size={15} /> : <Check size={15} />}<span>{planning ? '正在审核计划' : statusLabel(task.status)}</span></div><div className="toolbar-actions"><button type="button" className="icon-action" onClick={onOpenAssets} aria-label="查看资产中心" title="查看资产中心"><Archive size={17} /></button></div></div>
          <div className={'agent-result-stage ' + (task.videoUrl || task.imageUrls.length ? 'has-result' : '')}>
            {task.videoUrl ? <div className="agent-video-result"><video src={task.videoUrl} controls autoPlay loop playsInline /><div><span>视频结果</span><section><a className="icon-action" href={task.videoUrl} target="_blank" rel="noreferrer" aria-label="打开生成视频" title="在新窗口打开视频"><ExternalLink size={16} /></a><button type="button" className="icon-action" onClick={() => download(task.videoUrl, 'video')} aria-label="下载生成视频" title="下载视频"><Download size={16} /></button></section></div></div> : task.imageUrls.length ? task.imageUrls.map((url, index) => <figure className="generated-image" key={url}><img src={url} alt={'Agent 生成图片 ' + (index + 1)} /><figcaption><span>图片 {index + 1}</span><div><a className="icon-action" href={url} target="_blank" rel="noreferrer" aria-label={'打开生成图片 ' + (index + 1)} title="在新窗口打开图片"><ExternalLink size={16} /></a><button type="button" className="icon-action" onClick={() => download(url, 'image', index)} aria-label={'下载生成图片 ' + (index + 1)} title="下载图片"><Download size={16} /></button></div></figcaption></figure>) : <div className="image-empty-state"><Bot size={36} /><span className="result-eyebrow">{isGenerating ? 'Agent 正在执行已确认计划' : planning ? 'Agent 正在审核模型能力' : serverPlan ? '计划已确认，等待开始生成' : selectedProject ? '选择镜头并审核计划' : '等待创作立项'}</span><strong>{isGenerating ? (task.plan?.summary || '正在生成') : (selectedShot?.content || prompt.trim() || '从一个灵感或一段剧本，开始新的创作项目。')}</strong><span>{displayPlan?.summary || '建立项目后，会生成可编辑的故事、角色、场景和分镜资产。'}</span></div>}
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
