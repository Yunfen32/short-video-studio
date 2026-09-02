import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  Check,
  Clapperboard,
  Download,
  ExternalLink,
  Film,
  Home,
  Image as ImageIcon,
  ImagePlus,
  Layers3,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Trash2,
  Type,
  Users,
  Video,
  Volume2,
  Wand2,
} from 'lucide-react';
import {
  getModelsForWorkflow,
  getVideoWorkflow,
  getWorkflowCapability,
  supportsWorkflow,
  VIDEO_MODELS,
  VIDEO_WORKFLOW_GROUPS,
  VIDEO_WORKFLOWS,
} from '../shared/video-models.mjs';
import {
  createInitialTaskState,
  createTaskSnapshot,
  isTransientPollError,
  mergeUnavailableModels,
  outputDurationLabel,
  pollRetryDelay,
  reduceTaskState,
} from './video-task-state.mjs';
import {
  defaultImageRole,
  composeVideoPrompt,
  findImageMentionTrigger,
  imageMentionToken,
  imageRoleLabel,
  insertImageMention,
  normalizeImageRoles,
  remapImageMentions,
  stripImageMentions,
} from './video-ui-state.mjs';
import { isFreeVideoModel } from '../shared/free-models.mjs';
import { getVideoExample } from '../shared/video-examples.mjs';
import { isRecoverableStudioTask, readStudioTask, saveStudioTask } from './task-session.mjs';
import './styles.css';
import ImageStudio from './image-studio.jsx';
import AgentStudio from './agent-studio.jsx';
import AssetsStudio from './assets-studio.jsx';
import HomeStudio from './home-studio.jsx';
import {
  addAssetsToCreativeLibrary,
  assignCreativeAssetToProject,
  createCreativeProject,
  deleteCreativeAsset,
  insertCreativeProject,
  loadCreativeLibrary,
  saveCreativeLibrary,
  setCreativeAssetCurrentVersion,
  setCreativeAssetRelations,
  updateCreativeAsset,
  updateCreativeProjectState,
} from './creative-library.mjs';

const STYLES = ['写实广告', '电影感', '产品展示', '动画短片'];
const POLL_INTERVAL = Number(import.meta.env.VITE_POLL_INTERVAL) || 15000;
const MAX_POLL_RETRIES = 3;
const VIDEO_TASK_STORAGE_KEY = 'video';
const GROUP_ICONS = {
  text: Type,
  image: ImageIcon,
  reference: Users,
  video: Clapperboard,
};

function authorizedHeaders(headers = {}) {
  return headers;
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: authorizedHeaders(options.headers),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '请求失败，请稍后重试');
    Object.assign(error, data, {
      status: response.status,
      retryAfter: Number(response.headers.get('retry-after')) || data.retryAfter || 0,
    });
    throw error;
  }
  return data;
}

async function uploadReferenceImage(file) {
  const response = await fetch('/api/reference-images', {
    method: 'POST',
    headers: authorizedHeaders({ 'Content-Type': file.type }),
    body: file,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.url) throw new Error(data.error || '图片上传失败');
  return data.url;
}

function progressFor(status) {
  if (status === 'PENDING') return 12;
  if (status === 'RUNNING') return 58;
  if (status === 'SUCCEEDED') return 100;
  return 0;
}

function restoredVideoTask() {
  const stored = readStudioTask(window.localStorage, VIDEO_TASK_STORAGE_KEY);
  if (!stored) return createInitialTaskState();
  return {
    ...createInitialTaskState(stored.token || 0),
    ...stored,
    actual: { ...createInitialTaskState().actual, ...(stored.actual || {}) },
  };
}

function groupModelsByFamily(models) {
  return models.reduce((groups, model) => {
    const key = model.provider + ':' + model.family;
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.variants.push(model);
    else groups.push({ key, family: model.family, familyLabel: model.familyLabel, providerLabel: model.providerLabel, variants: [model] });
    return groups;
  }, []).map((group) => ({
    ...group,
    variants: [...group.variants].sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured))),
  }));
}

function durationLabel(model) {
  if (!model) return '';
  if (model.durationMode === 'source') return '跟随源视频';
  if (model.durationMode === 'truncate') return '保留或截取 2-10 秒';
  const values = model.durations;
  const isContinuous = values.every((value, index) => index === 0 || value === values[index - 1] + 1);
  if (!isContinuous) return values.join(' / ') + ' 秒';
  return values.length === 1 ? values[0] + ' 秒' : values[0] + '-' + values[values.length - 1] + ' 秒';
}

function audioLabel(capability) {
  if (capability.audioMode === 'voice_reference') return '人物音色';
  if (capability.audioMode === 'driving_audio') return '驱动音频';
  if (capability.audioMode === 'required_input_audio') return '必需人声音频';
  if (capability.audioMode === 'input_audio') return '音频输入';
  if (capability.audioMode === 'output_audio' || capability.outputAudio) return '模型生成声音';
  return '无外部音频';
}

function imageSectionTitle(workflowId) {
  return {
    'first-frame': '首帧图',
    'first-last-frame': '首尾帧',
    keyframes: '关键帧',
    'multi-reference': '人物 / 背景参考',
    'video-continuation': '可选尾帧',
    'video-edit': '编辑参考图',
    'motion-transfer': '人物图',
    'character-replace': '替换人物图',
  }[workflowId] || '图片素材';
}

function nextImageLabel(workflowId, count) {
  if (workflowId === 'first-frame') return '添加首帧';
  if (workflowId === 'first-last-frame') return count === 0 ? '添加首帧' : '添加尾帧';
  if (workflowId === 'keyframes') return '添加关键帧 ' + (count + 1);
  if (workflowId === 'video-continuation') return '添加尾帧';
  if (workflowId === 'motion-transfer') return '添加人物图';
  if (workflowId === 'character-replace') return '添加替换人物';
  return '添加参考图';
}

function videoFieldLabel(capability, workflowId) {
  if (capability.videoMode === 'optional_reference') return '动作 / 镜头参考视频 URL（可选）';
  if (capability.videoMode === 'required_first_clip') return '起始视频 URL';
  if (capability.videoMode === 'required_driver') return '动作参考视频 URL';
  if (workflowId === 'character-replace') return '原视频 URL';
  return '原视频 URL';
}

function audioFieldLabel(capability) {
  if (capability.audioMode === 'voice_reference') return '人物音色参考 URL（绑定第一个人物）';
  if (capability.audioMode === 'driving_audio') return '驱动音频 URL（可选）';
  if (capability.audioMode === 'required_input_audio') return '人物音频 URL（必填）';
  return '音频输入 URL（可选）';
}

function VideoStudio({ onOpenHome, onOpenImage, onOpenAgent, onOpenAssets, onSaveAssets, onContinueWithAgent, projects = [], assets = [] }) {
  const [workflowId, setWorkflowId] = useState('text-to-video');
  const [modelId, setModelId] = useState('wan2.7-t2v');
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState('9:16');
  const [duration, setDuration] = useState(5);
  const [style, setStyle] = useState('电影感');
  const [resolution, setResolution] = useState('720P');
  const [watermark, setWatermark] = useState(false);
  const [promptExtend, setPromptExtend] = useState(true);
  const [negativePrompt, setNegativePrompt] = useState('');
  const [seed, setSeed] = useState('');
  const [images, setImages] = useState([]);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [audioUrl, setAudioUrl] = useState('');
  const [videoInputUrl, setVideoInputUrl] = useState('');
  const [animationMode, setAnimationMode] = useState('wan-std');
  const [audioSetting, setAudioSetting] = useState('auto');
  const [task, dispatchTask] = useReducer(reduceTaskState, undefined, restoredVideoTask);
  const [error, setError] = useState('');
  const [mention, setMention] = useState(null);
  const [unavailableModels, setUnavailableModels] = useState([]);
  const [modelCatalog, setModelCatalog] = useState(VIDEO_MODELS);
  const [freeOnly, setFreeOnly] = useState(false);
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [loadedExampleId, setLoadedExampleId] = useState('');
  const [assetProjectId, setAssetProjectId] = useState('');
  const [savedAssetKeys, setSavedAssetKeys] = useState([]);
  const videoRef = useRef(null);
  const promptRef = useRef(null);
  const activeTaskRef = useRef(task.token || 0);
  const activeUploadRef = useRef(0);
  const pollTimerRef = useRef(0);
  const mountedRef = useRef(true);

  const taskStatus = task.status;
  const taskId = task.taskId;
  const videoUrl = task.videoUrl;

  const unavailableIds = useMemo(
    () => new Set(unavailableModels.map((item) => item.modelId)),
    [unavailableModels],
  );
  const availableModels = useMemo(
    () => modelCatalog.filter((item) => (!freeOnly || isFreeVideoModel(item)) && !unavailableIds.has(item.id)),
    [freeOnly, modelCatalog, unavailableIds],
  );
  const currentWorkflow = getVideoWorkflow(workflowId);
  const workflowGroupId = currentWorkflow?.groupId || 'text';
  const groupWorkflows = VIDEO_WORKFLOWS.filter((workflow) => workflow.groupId === workflowGroupId);
  const workflowModels = getModelsForWorkflow(workflowId, availableModels);
  const modelFamilies = groupModelsByFamily(workflowModels);
  const unavailableModelFamilies = useMemo(
    () => groupModelsByFamily(getModelsForWorkflow(
      workflowId,
      modelCatalog.filter((item) => (!freeOnly || isFreeVideoModel(item)) && unavailableIds.has(item.id)),
    )),
    [freeOnly, modelCatalog, unavailableIds, workflowId],
  );
  const selectedModel = workflowModels.find((item) => item.id === modelId)
    || workflowModels.find((item) => item.featured)
    || workflowModels[0]
    || null;
  const selectedCapability = selectedModel
    ? getWorkflowCapability(selectedModel, workflowId)
    : {
      imageMin: 0,
      imageMax: 0,
      imageMode: 'none',
      videoMode: 'none',
      audioMode: 'none',
      promptOptional: false,
      requiresAnyReference: false,
      durationMode: 'output',
      ratioOptions: [],
      supportsWatermark: false,
      supportsPromptExtend: false,
      supportsNegativePrompt: false,
      supportsSeed: false,
      supportsAudioSetting: false,
      outputAudio: false,
    };
  const isGenerating = taskStatus === 'PENDING' || taskStatus === 'RUNNING';
  const progress = task.progress || progressFor(taskStatus);
  const imageLimit = selectedCapability.imageMax || 0;
  const activeImages = images.slice(0, imageLimit);
  const canUseImages = imageLimit > 0;
  const canUseVideo = selectedCapability.videoMode !== 'none';
  const canUseAudio = ['input_audio', 'voice_reference', 'driving_audio', 'required_input_audio'].includes(selectedCapability.audioMode);
  const availableRatios = selectedModel?.protocol === 't2vLegacy' && resolution === '480P'
    ? selectedCapability.ratioOptions.filter((item) => ['16:9', '9:16', '1:1'].includes(item))
    : selectedCapability.ratioOptions;
  const availableDurations = (selectedModel?.durations || []).filter((item) => (
    !videoInputUrl.trim()
    || !selectedCapability.durationWithVideoMax
    || item <= selectedCapability.durationWithVideoMax
  ));

  function readinessMessage() {
    if (!selectedModel) return '当前生成方式暂无可用模型';
    if (uploadingCount > 0) return '图片正在上传';
    if (!selectedCapability.promptOptional && !prompt.trim()) return '请填写视频描述';
    if (activeImages.length < selectedCapability.imageMin) {
      if (workflowId === 'first-frame') return '请上传首帧图';
      if (workflowId === 'first-last-frame') return activeImages.length === 0 ? '请上传首帧图和尾帧图' : '请上传尾帧图';
      if (workflowId === 'keyframes') return '请至少上传 2 个关键帧';
      if (workflowId === 'motion-transfer') return '请上传人物图';
      if (workflowId === 'character-replace') return '请上传替换人物图';
      return '请补充所需图片素材';
    }
    if (selectedCapability.videoMode.startsWith('required_') && !videoInputUrl.trim()) {
      if (workflowId === 'motion-transfer') return '请填写动作参考视频 URL';
      if (workflowId === 'video-continuation') return '请填写起始视频 URL';
      return '请填写原视频 URL';
    }
    if (selectedCapability.requiresAnyReference && activeImages.length === 0 && !videoInputUrl.trim()) {
      return '请添加参考图或参考视频';
    }
    if (
      selectedCapability.audioMode === 'voice_reference'
      && audioUrl.trim()
      && !activeImages.some((image) => image.role === 'character')
    ) {
      return '音色参考需要至少一张人物参考图';
    }
    if (selectedCapability.audioMode === 'required_input_audio' && !audioUrl.trim()) {
      return '请填写人物音频 URL';
    }
    return '';
  }

  const missingRequirement = readinessMessage();
  const canGenerate = !missingRequirement && !isGenerating;
  const mentionOptions = mention
    ? activeImages.map((image, index) => ({ image, index })).filter(({ image, index }) => {
      const haystack = imageMentionToken(workflowId, image, index, activeImages) + imageRoleLabel(workflowId, image, index, activeImages);
      return haystack.toLowerCase().includes(mention.query.toLowerCase());
    })
    : [];

  async function refreshAvailability() {
    try {
      const data = await apiRequest('/api/models');
      setUnavailableModels(Array.isArray(data.unavailable) ? data.unavailable : []);
      if (Array.isArray(data.videoModels)) setModelCatalog(data.videoModels);
      setFreeOnly(data.freeOnly === true);
      if (data.freeOnly === false) setError('当前服务未启用免费模型保护');
    } catch (availabilityError) {
      setError('模型状态暂时无法读取，请稍后重试');
    } finally {
      setAvailabilityLoading(false);
    }
  }

  useEffect(() => {
    refreshAvailability();
    const timer = window.setInterval(refreshAvailability, 5 * 60 * 1000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    };
  }, []);

  useEffect(() => {
    saveStudioTask(window.localStorage, VIDEO_TASK_STORAGE_KEY, task);
  }, [task]);

  const workflowModelIds = workflowModels.map((item) => item.id).join('|');
  useEffect(() => {
    if (!workflowModels.length || workflowModels.some((item) => item.id === modelId)) return;
    const previous = modelCatalog.find((item) => item.id === modelId);
    const fallback = workflowModels.find((item) => item.family === previous?.family)
      || workflowModels.find((item) => item.featured)
      || workflowModels[0];
    selectModel(fallback);
  }, [workflowId, workflowModelIds, modelId, modelCatalog]);

  useEffect(() => {
    if (!selectedModel) return;
    if (selectedCapability.durationMode === 'truncate') setDuration(0);
    else if (selectedCapability.durationMode === 'output' && !selectedModel.durations.includes(duration)) {
      setDuration(selectedModel.durations[0]);
    }
    if (!selectedModel.resolutions.includes(resolution)) setResolution(selectedModel.resolutions[0]);
    if (selectedCapability.ratioOptions.includes('source')) setRatio('source');
    else if (selectedCapability.ratioOptions.length && !selectedCapability.ratioOptions.includes(ratio)) {
      setRatio(selectedCapability.ratioOptions[0]);
    }
    setAudioSetting('auto');
    setMention(null);
  }, [selectedModel?.id]);

  useEffect(() => {
    if (availableRatios.length && !availableRatios.includes(ratio)) setRatio(availableRatios[0]);
  }, [selectedModel?.id, resolution]);

  useEffect(() => {
    if (selectedCapability.durationMode !== 'output' || !availableDurations.length || availableDurations.includes(duration)) return;
    setDuration(availableDurations[availableDurations.length - 1]);
  }, [selectedModel?.id, videoInputUrl]);

  function invalidateUploads() {
    activeUploadRef.current += 1;
    setUploadingCount(0);
  }

  function clearImages() {
    setImages([]);
  }

  function invalidateTask() {
    activeTaskRef.current += 1;
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = 0;
    dispatchTask({ type: 'reset', token: activeTaskRef.current });
  }

  function selectWorkflow(nextWorkflowId) {
    if (nextWorkflowId === workflowId) return;
    const nextModels = getModelsForWorkflow(nextWorkflowId, availableModels);
    const nextModel = nextModels.find((item) => item.featured) || nextModels[0];
    setWorkflowId(nextWorkflowId);
    if (nextModel) setModelId(nextModel.id);
    setPrompt((current) => stripImageMentions(current));
    clearImages();
    setAudioUrl('');
    setVideoInputUrl('');
    setMention(null);
    setError('');
    invalidateUploads();
  }

  function selectGroup(groupId) {
    const group = VIDEO_WORKFLOW_GROUPS.find((item) => item.id === groupId);
    if (!group) return;
    const nextWorkflowId = group.workflowIds.find((id) => getModelsForWorkflow(id, availableModels).length > 0)
      || group.workflowIds[0];
    selectWorkflow(nextWorkflowId);
  }

  function selectModel(nextModel) {
    if (!nextModel || !supportsWorkflow(nextModel, workflowId)) return;
    if (nextModel.id !== modelId) invalidateUploads();
    const nextCapability = getWorkflowCapability(nextModel, workflowId);
    if (images.length > nextCapability.imageMax) {
      const before = images;
      const after = normalizeImageRoles(images.slice(0, nextCapability.imageMax), workflowId);
      setPrompt((current) => remapImageMentions(current, workflowId, before, after));
      setImages(after);
      setError('该变体最多使用 ' + nextCapability.imageMax + ' 张图片，已保留前面的素材');
    } else {
      setError('');
    }
    setLoadedExampleId('');
    setModelId(nextModel.id);
  }

  function loadModelExample(model) {
    const example = getVideoExample(model?.id, workflowId);
    if (!model || !example) return;
    selectModel(model);
    setPrompt(example.prompt);
    setStyle(example.style);
    setDuration(example.duration);
    setRatio(example.ratio);
    setResolution(model.resolutions.includes(example.resolution) ? example.resolution : model.resolutions[0]);
    setAudioUrl('');
    setVideoInputUrl('');
    setMention(null);
    setError('');
    setLoadedExampleId(model.id);
    window.requestAnimationFrame(() => promptRef.current?.focus());
  }

  function handlePromptChange(event) {
    const value = event.target.value;
    const cursor = event.target.selectionStart ?? value.length;
    const trigger = findImageMentionTrigger(value, cursor);
    setPrompt(value);
    setMention(canUseImages && activeImages.length > 0 && trigger
      ? trigger
      : null);
  }

  function insertReferenceMention(index) {
    if (!mention) return;
    const token = imageMentionToken(workflowId, activeImages[index], index, activeImages);
    const insertion = insertImageMention(prompt, mention, token);
    setPrompt(insertion.prompt);
    setMention(null);
    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(insertion.cursor, insertion.cursor);
    });
  }

  async function addImages(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;

    const available = imageLimit - images.length;
    const selected = files.slice(0, Math.max(available, 0));
    const invalid = selected.find((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024);
    if (invalid) {
      setError('图片需为 JPG、PNG 或 WEBP，单张不超过 4MB');
      return;
    }
    if (!selected.length) {
      setError('当前生成方式最多使用 ' + imageLimit + ' 张图片');
      return;
    }

    const uploadToken = activeUploadRef.current + 1;
    activeUploadRef.current = uploadToken;
    try {
      setUploadingCount(selected.length);
      const uploaded = await Promise.all(selected.map((file) => uploadReferenceImage(file)));
      if (activeUploadRef.current !== uploadToken) return;
      setImages((current) => {
        const startIndex = current.length;
        const additions = uploaded.map((source, index) => ({
          id: Date.now().toString(36) + '-' + index + '-' + Math.random().toString(36).slice(2),
          source,
          role: defaultImageRole(workflowId, startIndex + index, 'character'),
        }));
        return normalizeImageRoles([...current, ...additions].slice(0, imageLimit), workflowId);
      });
      setError(files.length > available ? '当前生成方式最多使用 ' + imageLimit + ' 张图片' : '');
    } catch (uploadError) {
      if (activeUploadRef.current === uploadToken) setError(uploadError.message);
    } finally {
      if (activeUploadRef.current === uploadToken) setUploadingCount(0);
    }
  }

  function removeImage(index) {
    const before = images;
    const after = normalizeImageRoles(images.filter((_, itemIndex) => itemIndex !== index), workflowId);
    setPrompt((current) => remapImageMentions(current, workflowId, before, after));
    setImages(after);
    setMention(null);
  }

  function changeImageRole(index, role) {
    const before = images;
    const after = images.map((image, itemIndex) => itemIndex === index ? { ...image, role } : image);
    setPrompt((current) => remapImageMentions(current, workflowId, before, after));
    setImages(after);
  }

  function schedulePoll(callback, delay = POLL_INTERVAL) {
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    pollTimerRef.current = window.setTimeout(callback, delay);
  }

  async function pollTask(nextTaskId, taskToken, provider, videoId, retryCount = 0) {
    if (activeTaskRef.current !== taskToken) return;
    const query = new URLSearchParams({ provider: provider || 'dashscope' });
    if (videoId) query.set('video_id', videoId);

    let data;
    try {
      data = await apiRequest(
        '/api/videos/' + encodeURIComponent(nextTaskId) + '?' + query,
        {},
      );
    } catch (pollError) {
      if (activeTaskRef.current !== taskToken) return;
      if (isTransientPollError(pollError) && retryCount < MAX_POLL_RETRIES) {
        schedulePoll(
          () => pollTask(nextTaskId, taskToken, provider, videoId, retryCount + 1),
          pollRetryDelay({ count: retryCount, retryAfter: pollError.retryAfter }, POLL_INTERVAL),
        );
        return;
      }
      dispatchTask({ type: 'failed', token: taskToken, error: pollError.message });
      return;
    }

    if (activeTaskRef.current !== taskToken) return;
    dispatchTask({
      type: 'polled',
      token: taskToken,
      status: data.status,
      progress: data.progress,
      videoUrl: data.videoUrl,
      error: data.error,
      size: data.size,
      seconds: data.seconds,
    });

    if (data.status === 'SUCCEEDED' && data.videoUrl) return;
    if (data.terminal) {
      dispatchTask({ type: 'failed', token: taskToken, error: data.error || '视频任务未能完成' });
      return;
    }
    schedulePoll(() => pollTask(nextTaskId, taskToken, provider, videoId, 0));
  }

  useEffect(() => {
    if (!isRecoverableStudioTask(task)) return;
    const taskToken = task.token || activeTaskRef.current + 1;
    activeTaskRef.current = taskToken;
    pollTask(task.taskId, taskToken, task.provider, task.videoId);
  }, []);

  async function generateVideo() {
    if (!canGenerate) {
      setError(missingRequirement || '当前任务正在生成');
      return;
    }

    setError('');
    const taskToken = activeTaskRef.current + 1;
    activeTaskRef.current = taskToken;
    if (pollTimerRef.current) window.clearTimeout(pollTimerRef.current);
    const submittedPrompt = composeVideoPrompt(prompt, style);
    const snapshot = createTaskSnapshot({
      workflowId,
      workflowLabel: currentWorkflow?.label,
      modelId: selectedModel.id,
      modelLabel: selectedModel.label,
      familyLabel: selectedModel.familyLabel,
      variantLabel: selectedModel.variantLabel,
      provider: selectedModel.provider,
      ratio: selectedCapability.ratioOptions.includes(ratio) ? ratio : '',
      resolution,
      duration,
      durationMode: selectedCapability.durationMode,
      routeInput,
      prompt: submittedPrompt,
      projectId: assetProjectId,
    });
    const startedTask = {
      ...createInitialTaskState(taskToken),
      status: 'PENDING',
      progress: progressFor('PENDING'),
      snapshot,
    };
    saveStudioTask(window.localStorage, VIDEO_TASK_STORAGE_KEY, startedTask);
    dispatchTask({ type: 'start', token: taskToken, snapshot });

    try {
      const data = await apiRequest('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflow: workflowId,
          model: selectedModel.id,
          prompt: submittedPrompt,
          images: canUseImages ? activeImages.map(({ source, role }) => ({ source, role })) : [],
          audioUrl: canUseAudio ? audioUrl.trim() : '',
          videoUrl: canUseVideo ? videoInputUrl.trim() : '',
          ratio: selectedCapability.ratioOptions.includes(ratio) ? ratio : '',
          duration: selectedCapability.durationMode === 'source' ? 0 : duration,
          resolution,
          watermark: selectedCapability.supportsWatermark ? watermark : false,
          promptExtend: selectedCapability.supportsPromptExtend ? promptExtend : false,
          negativePrompt: selectedCapability.supportsNegativePrompt ? negativePrompt.trim() : '',
          seed: selectedCapability.supportsSeed && seed !== '' ? Number(seed) : null,
          animationMode,
          audioSetting,
        }),
      });
      const createdTask = {
        ...startedTask,
        taskId: data.taskId || '',
        provider: data.provider || '',
        videoId: data.videoId || '',
        status: data.status || 'PENDING',
      };
      saveStudioTask(window.localStorage, VIDEO_TASK_STORAGE_KEY, createdTask);
      if (!mountedRef.current || activeTaskRef.current !== taskToken) return;
      dispatchTask({
        type: 'created',
        token: taskToken,
        taskId: data.taskId,
        provider: data.provider,
        videoId: data.videoId,
        status: data.status,
      });
      if (!data.taskId) throw new Error('视频服务没有返回任务编号，请稍后重试');
      pollTask(data.taskId, taskToken, data.provider, data.videoId);
    } catch (requestError) {
      const failedTask = {
        ...startedTask,
        status: 'FAILED',
        progress: 0,
        error: requestError.message,
      };
      saveStudioTask(window.localStorage, VIDEO_TASK_STORAGE_KEY, failedTask);
      if (!mountedRef.current || activeTaskRef.current !== taskToken) return;
      dispatchTask({ type: 'failed', token: taskToken, error: requestError.message });
      if (requestError.modelUnavailable) {
        const unavailable = Array.isArray(requestError.unavailable) && requestError.unavailable.length
          ? requestError.unavailable
          : requestError.modelId ? [{
            modelId: requestError.modelId,
            until: requestError.unavailableUntil,
            reason: requestError.message,
          }] : [];
        setUnavailableModels((current) => mergeUnavailableModels(current, unavailable));
      }
    }
  }

  function reset() {
    invalidateTask();
    invalidateUploads();
    setPrompt('');
    setMention(null);
    clearImages();
    setAudioUrl('');
    setVideoInputUrl('');
    setNegativePrompt('');
    setSeed('');
    setPromptExtend(true);
    setAudioSetting('auto');
    setLoadedExampleId('');
    setError('');
  }

  async function downloadVideo() {
    if (!videoUrl || downloading) return;
    setDownloading(true);
    setError('');
    try {
      const response = await fetch('/api/video-download?url=' + encodeURIComponent(videoUrl), {
        headers: authorizedHeaders({}),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '视频下载失败');
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = 'generated-video.mp4';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      setError(downloadError.message);
    } finally {
      setDownloading(false);
    }
  }

  function saveVideoToAssets() {
    if (!videoUrl || !onSaveAssets) return;
    const key = `${task.taskId || 'direct'}:${videoUrl}`;
    const alreadySaved = assets.some((asset) => asset.previewUrl === videoUrl && asset.source?.parameters?.taskId === (task.taskId || ''));
    if (savedAssetKeys.includes(key) || alreadySaved) return;
    const snapshot = task.snapshot || {};
    onSaveAssets([{
      projectId: snapshot.projectId || null,
      type: 'video',
      category: snapshot.workflowId === 'text-to-video' ? 'material' : 'shot',
      title: `${snapshot.workflowLabel || '视频生成'} · ${snapshot.modelLabel || '视频'}`,
      previewUrl: videoUrl,
      tags: [snapshot.workflowLabel, snapshot.familyLabel, snapshot.variantLabel].filter(Boolean),
      versionGroupId: snapshot.projectId
        ? `project:${snapshot.projectId}:video:${snapshot.workflowId || 'video'}`
        : `video:${snapshot.workflowId || 'video'}:${snapshot.prompt || ''}`,
      source: {
        provider: task.provider || snapshot.provider,
        model: snapshot.modelId || snapshot.modelLabel,
        workflow: snapshot.workflowId || '',
        prompt: snapshot.prompt || '',
        parameters: {
          ratio: previewRatio,
          resolution: previewResolution,
          duration: previewDuration,
          taskId: task.taskId || '',
        },
      },
    }]);
    setSavedAssetKeys((current) => [...current, key]);
  }

  function retryWithAnotherModel() {
    if (workflowModels.length < 2) return;
    const currentIndex = workflowModels.findIndex((model) => model.id === selectedModel?.id);
    const next = workflowModels[(currentIndex + 1) % workflowModels.length];
    selectModel(next);
    setError('');
  }

  function continueFromVideo(nextWorkflowId) {
    if (!videoUrl) return;
    const sourcePrompt = task.snapshot?.prompt || prompt;
    selectWorkflow(nextWorkflowId);
    setVideoInputUrl(videoUrl);
    setPrompt(sourcePrompt);
    setError('');
  }

  function continueWithAgent() {
    onContinueWithAgent?.({
      kind: 'video',
      prompt: task.snapshot?.prompt || prompt,
      projectId: task.snapshot?.projectId || assetProjectId,
      detail: videoUrl ? '已有视频结果，可继续拆解后续镜头、补充 BGM 或生成下一段。' : '视频任务未完成，需要改用兼容模型继续处理。',
    });
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  const statusLabels = {
    IDLE: '待生成',
    PENDING: '排队中',
    RUNNING: '生成中',
    SUCCEEDED: '已完成',
    FAILED: '生成失败',
    CANCELED: '已取消',
    UNKNOWN: '状态未知',
  };
  const routeInput = workflowId === 'keyframes' && activeImages.length > 0
    ? activeImages.length + ' 个关键帧 + 视频描述'
    : currentWorkflow?.inputLabel || '视频描述';
  const routeModel = selectedModel?.familyLabel || '暂无可用模型';
  const routeOutput = selectedModel
    ? outputDurationLabel(selectedCapability.durationMode, duration) + ' / ' + resolution
    : '--';
  const previewSnapshot = task.snapshot;
  const previewWorkflowLabel = previewSnapshot?.workflowLabel || currentWorkflow?.label || '--';
  const previewModelLabel = previewSnapshot?.modelLabel || selectedModel?.label || '暂无可用模型';
  const previewVariantLabel = previewSnapshot?.variantLabel || selectedModel?.variantLabel || '--';
  const previewFamilyLabel = previewSnapshot?.familyLabel || routeModel;
  const previewResolution = task.actual.size || previewSnapshot?.resolution || resolution;
  const previewDuration = task.actual.seconds
    ? Number(task.actual.seconds).toFixed(Number(task.actual.seconds) % 1 ? 1 : 0) + ' 秒'
    : outputDurationLabel(previewSnapshot?.durationMode || selectedCapability.durationMode, previewSnapshot?.duration ?? duration);
  const submittedRatio = previewSnapshot?.ratio || (selectedCapability.ratioOptions.includes(ratio) ? ratio : '16:9');
  const previewRatio = submittedRatio === 'source' ? '16:9' : submittedRatio;
  const isPortrait = previewRatio === '9:16' || previewRatio === '3:4';
  const isSquare = previewRatio === '1:1';
  const errorMessage = error || task.error;
  const previewStatusTone = taskStatus === 'SUCCEEDED'
    ? 'status-success'
    : taskStatus === 'FAILED'
      ? 'status-error'
      : isGenerating
        ? 'status-active'
        : '';

  return (
    <main className="app-shell video-app-shell">
      <header className="topbar">
        <div className="brand-block">
          <p>SHORT VIDEO STUDIO</p>
          <h1>视频创作</h1>
        </div>
        <div className="topbar-controls">
          <div className="studio-switch" role="tablist" aria-label="创作类型">
            <button type="button" onClick={onOpenHome} role="tab" aria-selected="false"><Home size={16} /><span>首页</span></button>
            <button type="button" onClick={onOpenAgent} role="tab" aria-selected="false"><Wand2 size={16} /><span>Agent</span></button>
            <button type="button" className="active" role="tab" aria-selected="true"><Video size={16} /><span>视频</span></button>
            <button type="button" onClick={onOpenImage} role="tab" aria-selected="false"><ImageIcon size={16} /><span>图片</span></button>
            <button type="button" onClick={onOpenAssets} role="tab" aria-selected="false"><Archive size={16} /><span>资产</span></button>
          </div>
          <button
            type="button"
            className="topbar-icon-action"
            onClick={refreshAvailability}
            disabled={availabilityLoading || isGenerating}
            aria-label="刷新模型状态"
            title="刷新模型状态"
          >
            <RefreshCw className={availabilityLoading ? 'spin' : ''} size={16} />
          </button>
          <div className="service-metrics" aria-label="模型服务状态">
            <div><span>可用变体</span><strong>{availableModels.length}</strong></div>
            <div><span>额度暂停</span><strong>{unavailableModels.length}</strong></div>
            <div className={'status-strip ' + (taskStatus === 'FAILED' ? 'error' : '')}>
              <span>{statusLabels[taskStatus] || taskStatus}</span>
              <strong>{String(progress).padStart(3, '0')}%</strong>
            </div>
          </div>
        </div>
      </header>

      <nav className="workflow-groups" aria-label="创作入口">
        {VIDEO_WORKFLOW_GROUPS.map((group) => {
          const Icon = GROUP_ICONS[group.id];
          const availableTasks = group.workflowIds.filter((id) => getModelsForWorkflow(id, availableModels).length > 0).length;
          return (
            <button
              type="button"
              key={group.id}
              className={workflowGroupId === group.id ? 'active' : ''}
              aria-current={workflowGroupId === group.id ? 'page' : undefined}
              onClick={() => selectGroup(group.id)}
              disabled={availableTasks === 0}
            >
              <Icon size={18} />
              <span>{group.label}</span>
              <strong>{availableTasks}/{group.workflowIds.length}</strong>
            </button>
          );
        })}
      </nav>

      <section className="workspace">
        <aside className="control-panel">
          <section className="task-console" aria-labelledby="task-title">
            <div className="section-heading">
              <span>01</span>
              <div><h2 id="task-title">生成方式</h2><p>{VIDEO_WORKFLOW_GROUPS.find((item) => item.id === workflowGroupId)?.label}</p></div>
            </div>
            <div className="task-tabs" role="tablist" aria-label="具体生成方式">
              {groupWorkflows.map((workflow) => {
                const compatibleModels = getModelsForWorkflow(workflow.id, availableModels);
                const familyCount = groupModelsByFamily(compatibleModels).length;
                return (
                  <button
                    type="button"
                    key={workflow.id}
                    data-workflow-id={workflow.id}
                    className={workflowId === workflow.id ? 'active' : ''}
                    onClick={() => selectWorkflow(workflow.id)}
                    role="tab"
                    aria-selected={workflowId === workflow.id}
                    disabled={compatibleModels.length === 0}
                  >
                    <strong>{workflow.label}</strong>
                    <span>{workflow.summary}</span>
                    <em>{familyCount} 个模型系列</em>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="model-console" aria-labelledby="model-title">
            <div className="section-heading">
              <span>02</span>
              <div><h2 id="model-title">兼容模型</h2><p>{currentWorkflow?.label}</p></div>
            </div>
            <div className="model-family-list" role="listbox" aria-label="兼容模型系列">
              {modelFamilies.map((family) => {
                const isActive = family.variants.some((item) => item.id === selectedModel?.id);
                const displayModel = isActive ? selectedModel : (family.variants.find((item) => item.featured) || family.variants[0]);
                const capability = getWorkflowCapability(displayModel, workflowId);
                const example = getVideoExample(displayModel.id, workflowId);
                return (
                  <div className={'model-family-row ' + (isActive ? 'active' : '')} key={family.key}>
                    <button
                      type="button"
                      className="model-family-main"
                      data-model-id={displayModel.id}
                      onClick={() => selectModel(displayModel)}
                      role="option"
                      aria-selected={isActive}
                    >
                        <span className="provider-name">{family.providerLabel} · {freeOnly ? '免费' : 'API'}</span>
                      <strong>{family.familyLabel}</strong>
                      <p>适用：{currentWorkflow?.label}</p>
                      <small className="model-feature-note">{displayModel.summary}</small>
                      <div className="model-capabilities">
                        <span>{durationLabel(displayModel)}</span>
                        <span>{displayModel.resolutions.join(' / ')}</span>
                        <span>{audioLabel(capability)}</span>
                        {capability.imageMax > 0 && <span>{capability.imageMin}-{capability.imageMax} 图</span>}
                      </div>
                    </button>
                    <div className="variant-select">
                      <span>变体</span>
                      <select
                        value={displayModel.id}
                        onChange={(event) => selectModel(family.variants.find((item) => item.id === event.target.value))}
                        aria-label={family.familyLabel + ' 模型变体'}
                      >
                        {family.variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.variantLabel}</option>)}
                      </select>
                      <small>{displayModel.id}</small>
                    </div>
                    {example && (
                      <div className="model-example">
                        <div className="model-example-copy">
                          <span>5 秒 · 2D 动漫案例</span>
                          <strong>{example.title}</strong>
                          <small title={example.prompt}>{example.prompt}</small>
                        </div>
                        <button
                          type="button"
                          className="example-load"
                          onClick={() => loadModelExample(displayModel)}
                          disabled={isGenerating}
                        >
                          <Wand2 size={13} />
                          {loadedExampleId === displayModel.id ? '已载入' : '载入案例'}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {unavailableModelFamilies.length > 0 && (
                <details className="quota-collapsed">
                  <summary>额度暂不可用 <span>{unavailableModelFamilies.reduce((count, family) => count + family.variants.length, 0)} 个模型</span></summary>
                  <div className="quota-collapsed-list">
                    {unavailableModelFamilies.map((family) => {
                      const model = family.variants[0];
                      const status = unavailableModels.find((item) => item.modelId === model.id);
                      return (
                        <div className="model-family-row unavailable" key={family.key}>
                          <div className="model-family-main">
                            <span className="provider-name">{family.providerLabel} · 暂停</span>
                            <strong>{family.familyLabel}</strong>
                            <p>额度暂不可用，恢复后可重新选择</p>
                            <small className="model-feature-note">{status?.reason || '服务商额度暂时耗尽'}</small>
                          </div>
                          <div className="variant-select"><span>状态</span><small>{family.variants.length} 个变体暂停</small></div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}
              {modelFamilies.length === 0 && <p className="empty-model-state">该生成方式的模型暂不可用</p>}
            </div>
          </section>

          <section className="route-strip" aria-label="本次生成路径">
            <div><span>输入</span><strong>{routeInput}</strong></div>
            <ArrowRight size={17} />
            <div><span>模型</span><strong>{routeModel}</strong></div>
            <ArrowRight size={17} />
            <div><span>输出</span><strong>{routeOutput}</strong></div>
          </section>

          <section className="input-console" aria-labelledby="input-title">
            <div className="section-heading">
              <span>03</span>
              <div><h2 id="input-title">描述与素材</h2><p>{currentWorkflow?.summary}</p></div>
            </div>

            {canUseVideo && (
              <label className="field">
                <span>{videoFieldLabel(selectedCapability, workflowId)}</span>
                <div className="input-with-icon">
                  <Video size={16} />
                  <input
                    type="url"
                    value={videoInputUrl}
                    onChange={(event) => setVideoInputUrl(event.target.value)}
                    placeholder="https://example.com/source.mp4"
                  />
                </div>
              </label>
            )}

            {canUseImages && (
              <section className="asset-field">
                <div className="field-label">
                  <div><span>{imageSectionTitle(workflowId)}</span><small>{currentWorkflow?.summary}</small></div>
                  <strong>{activeImages.length}/{imageLimit}</strong>
                </div>
                <div className="reference-grid">
                  {activeImages.map((image, index) => (
                    <div className="reference-item" key={image.id}>
                      <img src={image.source} alt={imageRoleLabel(workflowId, image, index, activeImages)} />
                      <div className="reference-meta">
                        <span>{imageMentionToken(workflowId, image, index, activeImages)}</span>
                        {(workflowId === 'multi-reference' || workflowId === 'video-edit') ? (
                          <select
                            value={image.role}
                            onChange={(event) => changeImageRole(index, event.target.value)}
                            aria-label={imageRoleLabel(workflowId, image, index, activeImages) + '用途'}
                          >
                            <option value="character">人物</option>
                            <option value="background">背景</option>
                          </select>
                        ) : <em>{imageRoleLabel(workflowId, image, index, activeImages)}</em>}
                      </div>
                      <button type="button" onClick={() => removeImage(index)} aria-label={'删除' + imageRoleLabel(workflowId, image, index, activeImages)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  {activeImages.length < imageLimit && (
                    <label className="upload-tile" aria-label={nextImageLabel(workflowId, activeImages.length)}>
                      {uploadingCount > 0 ? <Loader2 className="spin" size={22} /> : <ImagePlus size={22} />}
                      <span>{uploadingCount > 0 ? '上传 ' + uploadingCount : nextImageLabel(workflowId, activeImages.length)}</span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        multiple={imageLimit - activeImages.length > 1}
                        onChange={addImages}
                        disabled={uploadingCount > 0}
                      />
                    </label>
                  )}
                </div>
              </section>
            )}

            <label className="field prompt-field">
              <span>{selectedCapability.promptOptional ? '视频描述（可选）' : '视频描述'}</span>
              <textarea
                ref={promptRef}
                data-testid="video-prompt"
                value={prompt}
                maxLength={5000}
                onChange={handlePromptChange}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setMention(null);
                }}
                placeholder={selectedCapability.promptOptional ? '补充动作、镜头或编辑要求' : '描述主体、动作、场景、镜头和声音；输入 @ 可引用图片'}
              />
              <small>{prompt.length}/5000</small>
            </label>

            {mention && mentionOptions.length > 0 && (
              <div className="reference-mention-menu" role="listbox" aria-label="选择图片素材">
                <div className="reference-mention-track">
                  {mentionOptions.map(({ image, index }) => (
                    <button
                      type="button"
                      className="reference-mention-option"
                      key={image.id + '-mention'}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => insertReferenceMention(index)}
                      role="option"
                      aria-label={'插入' + imageMentionToken(workflowId, image, index, activeImages)}
                    >
                      <img src={image.source} alt="" />
                      <span>{imageMentionToken(workflowId, image, index, activeImages)}</span>
                      <small>{imageRoleLabel(workflowId, image, index, activeImages)}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {canUseAudio && (
              <label className="field">
                <span>{audioFieldLabel(selectedCapability)}</span>
                <div className="input-with-icon">
                  {selectedCapability.audioMode === 'voice_reference' ? <Volume2 size={16} /> : <Layers3 size={16} />}
                  <input type="url" value={audioUrl} onChange={(event) => setAudioUrl(event.target.value)} placeholder="https://example.com/audio.mp3" />
                </div>
              </label>
            )}
          </section>

          <section className="settings-console" aria-labelledby="settings-title">
            <div className="section-heading">
              <span>04</span>
              <div><h2 id="settings-title">输出设置</h2><p>{selectedModel?.variantLabel || '--'}</p></div>
            </div>
            {(workflowId === 'motion-transfer' || workflowId === 'character-replace') && (
              <label className="field">
                <span>生成模式</span>
                <select value={animationMode} onChange={(event) => setAnimationMode(event.target.value)}>
                  <option value="wan-std">标准模式</option>
                  <option value="wan-pro">专业模式</option>
                </select>
              </label>
            )}
            <div className="settings-grid">
              {availableRatios.length > 0 && (
                <label className="field">
                  <span>比例</span>
                  <select value={ratio} onChange={(event) => setRatio(event.target.value)}>
                    {availableRatios.map((item) => (
                      <option key={item} value={item}>{item === 'source' ? '跟随原视频' : item}</option>
                    ))}
                  </select>
                </label>
              )}
              {selectedCapability.durationMode === 'source' ? (
                <div className="field static-setting">
                  <span>时长</span>
                  <strong>跟随源视频</strong>
                </div>
              ) : (
                <label className="field">
                  <span>{selectedCapability.durationMode === 'truncate' ? '截断时长' : '时长'}</span>
                  <select value={duration} onChange={(event) => setDuration(Number(event.target.value))} disabled={!selectedModel}>
                    {availableDurations.map((item) => (
                      <option key={item} value={item}>{item === 0 ? '保留原时长' : item + ' 秒'}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                <span>清晰度</span>
                <select value={resolution} onChange={(event) => setResolution(event.target.value)} disabled={!selectedModel}>
                  {(selectedModel?.resolutions || []).map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <label className="field">
                <span>风格</span>
                <select value={style} onChange={(event) => setStyle(event.target.value)}>
                  {STYLES.map((item) => <option key={item}>{item}</option>)}
                </select>
              </label>
              <label className="field">
                <span>归属项目</span>
                <select value={assetProjectId} onChange={(event) => setAssetProjectId(event.target.value)}>
                  <option value="">未归档</option>
                  {projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}
                </select>
              </label>
              {selectedCapability.supportsAudioSetting && (
                <label className="field">
                  <span>声音处理</span>
                  <select value={audioSetting} onChange={(event) => setAudioSetting(event.target.value)}>
                    <option value="auto">模型自动处理</option>
                    <option value="origin">保留原视频声音</option>
                  </select>
                </label>
              )}
            </div>

            {selectedCapability.supportsWatermark && (
              <label className="toggle-field">
                <input type="checkbox" checked={watermark} onChange={(event) => setWatermark(event.target.checked)} />
                <span>添加 AI 生成水印</span>
              </label>
            )}

            {(selectedCapability.supportsNegativePrompt || selectedCapability.supportsSeed || selectedCapability.supportsPromptExtend) && (
              <details className="advanced-settings">
                <summary>高级设置</summary>
                {selectedCapability.supportsNegativePrompt && (
                  <label className="field">
                    <span>负面提示词</span>
                    <textarea value={negativePrompt} maxLength={500} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="不希望出现的内容" />
                  </label>
                )}
                {selectedCapability.supportsSeed && (
                  <label className="field">
                    <span>随机种子（可选）</span>
                    <input type="number" min="0" max="2147483647" step="1" value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="0 - 2147483647" />
                  </label>
                )}
                {selectedCapability.supportsPromptExtend && (
                  <label className="toggle-field">
                    <input type="checkbox" checked={promptExtend} onChange={(event) => setPromptExtend(event.target.checked)} />
                    <span>启用提示词扩写</span>
                  </label>
                )}
              </details>
            )}
          </section>

          {errorMessage && <p className="error-message" role="alert"><AlertTriangle size={15} />{errorMessage}</p>}
          {taskStatus === 'FAILED' && <div className="task-recovery" aria-label="失败恢复操作"><span>任务未完成</span><button type="button" className="secondary-action" onClick={generateVideo} disabled={!canGenerate}>重新提交</button><button type="button" className="secondary-action" onClick={retryWithAnotherModel} disabled={workflowModels.length < 2}>换兼容模型</button><button type="button" className="secondary-action" onClick={continueWithAgent}>让 Agent 处理</button></div>}

          <div className="action-row">
            <div className="primary-action-wrap">
              <button className="primary-action" onClick={generateVideo} disabled={!canGenerate} data-testid="generate-video" title={missingRequirement || '提交视频生成任务'} aria-describedby="generation-requirement">
                {isGenerating ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
                {isGenerating ? '正在生成' : '生成视频'}
              </button>
              <p id="generation-requirement" className={missingRequirement ? 'action-note warning' : 'action-note ready'} aria-live="polite">
                {isGenerating ? '任务已提交，可在右侧查看状态' : (missingRequirement || '输入完整，可以生成')}
              </p>
            </div>
            <button className="icon-action" onClick={reset} aria-label="重置" title="重置当前任务"><RefreshCw size={18} /></button>
          </div>
        </aside>

        <section className="preview-panel">
          <div className="preview-toolbar">
            <div className="panel-heading"><Film size={18} /><div><h2>生成结果</h2><span>{previewWorkflowLabel}</span></div></div>
            <div className={'preview-model-state ' + previewStatusTone} data-testid="preview-model" aria-live="polite">
              {isGenerating ? <Loader2 className="spin" size={14} /> : taskStatus === 'FAILED' ? <AlertTriangle size={14} /> : <Check size={14} />}
              <span>{previewModelLabel} · {statusLabels[taskStatus] || taskStatus}</span>
            </div>
            <div className="toolbar-actions">
              <button className="icon-action" onClick={togglePlayback} disabled={!videoUrl} aria-label="播放或暂停" title="播放或暂停"><Play size={18} /></button>
              <a className={'icon-action ' + (!videoUrl ? 'disabled' : '')} href={videoUrl || undefined} target="_blank" rel="noreferrer" aria-label="在新窗口打开视频" title="在新窗口打开视频"><ExternalLink size={18} /></a>
              <button className="icon-action" onClick={downloadVideo} disabled={!videoUrl || downloading} aria-label="下载视频" title="下载视频">
                {downloading ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
              </button>
              <button className="icon-action" onClick={saveVideoToAssets} disabled={!videoUrl || savedAssetKeys.includes(`${taskId || 'direct'}:${videoUrl}`) || assets.some((asset) => asset.previewUrl === videoUrl && asset.source?.parameters?.taskId === (taskId || ''))} aria-label="保存到资产" title="保存到资产"><Archive size={18} /></button>
            </div>
          </div>

          <div className="video-stage">
            <div
              className={'video-frame ' + (videoUrl ? 'has-video ' : '') + (isPortrait ? 'portrait ' : '') + (isSquare ? 'square' : '')}
              style={{ '--video-ratio': previewRatio.replace(':', ' / ') }}
            >
              {videoUrl ? (
                <video ref={videoRef} src={videoUrl} controls autoPlay loop playsInline />
              ) : (
                <>
                  <div className="frame-number">TASK {taskStatus}</div>
                  <div className="frame-crosshair" aria-hidden="true" />
                  <div className="subject-block">
                    <span>{previewFamilyLabel} / {previewResolution} / {previewDuration}</span>
                    <strong>{isGenerating ? previewModelLabel + ' 正在生成' : (previewSnapshot?.prompt || prompt.trim() || currentWorkflow?.summary)}</strong>
                  </div>
                  <div className="timeline"><span style={{ width: (progress || 4) + '%' }} /></div>
                </>
              )}
            </div>
          </div>

          <div className="result-readout">
            <div><span>生成方式</span><strong>{previewWorkflowLabel}</strong></div>
            <div><span>模型变体</span><strong>{previewVariantLabel}</strong></div>
            <div><span>任务编号</span><strong>{taskId || '--'}</strong></div>
            <div data-testid="task-status"><span>结果状态</span><strong>{statusLabels[taskStatus] || taskStatus}</strong></div>
          </div>
          {taskStatus === 'SUCCEEDED' && videoUrl && <div className="result-continuation" aria-label="继续创作"><span>继续创作</span><button type="button" className="secondary-action" onClick={generateVideo} disabled={!canGenerate}>重新生成</button><button type="button" className="secondary-action" onClick={() => continueFromVideo('video-edit')}>修改这个镜头</button><button type="button" className="secondary-action" onClick={() => continueFromVideo('video-continuation')}>延长视频</button><button type="button" className="secondary-action" onClick={continueWithAgent}>让 Agent 继续</button></div>}
        </section>
      </section>
    </main>
  );
}

function App() {
  const [studio, setStudio] = useState('home');
  const [library, setLibrary] = useState(() => loadCreativeLibrary(window.localStorage));
  const [agentLaunch, setAgentLaunch] = useState(null);

  useEffect(() => {
    saveCreativeLibrary(window.localStorage, library);
  }, [library]);

  function createProject(input) {
    const created = createCreativeProject(input);
    setLibrary((current) => insertCreativeProject(current, created));
    return created.project;
  }

  function saveAssets(drafts) {
    setLibrary((current) => addAssetsToCreativeLibrary(current, drafts).library);
  }

  function openAgent(draft) {
    if (draft?.prompt) setAgentLaunch({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...draft });
    setStudio('agent');
  }

  if (studio === 'assets') return <AssetsStudio
    library={library}
    onOpenHome={() => setStudio('home')}
    onOpenVideo={() => setStudio('video')}
    onOpenImage={() => setStudio('image')}
    onOpenAgent={() => setStudio('agent')}
    onUpdateAsset={(assetId, patch) => setLibrary((current) => updateCreativeAsset(current, assetId, patch))}
    onDeleteAsset={(assetId) => setLibrary((current) => deleteCreativeAsset(current, assetId))}
    onSetRelations={(assetId, relationIds) => setLibrary((current) => setCreativeAssetRelations(current, assetId, relationIds))}
    onAssignProject={(assetId, projectId) => setLibrary((current) => assignCreativeAssetToProject(current, assetId, projectId))}
    onSetCurrentVersion={(assetId) => setLibrary((current) => setCreativeAssetCurrentVersion(current, assetId))}
  />;
  if (studio === 'agent') return <AgentStudio
    projects={library.projects}
    assets={library.assets}
    onCreateProject={createProject}
    onSaveAssets={saveAssets}
    onUpdateAsset={(assetId, patch) => setLibrary((current) => updateCreativeAsset(current, assetId, patch))}
    onUpdateProjectState={(projectId, patch) => setLibrary((current) => updateCreativeProjectState(current, projectId, patch))}
    launchDraft={agentLaunch}
    onOpenHome={() => setStudio('home')}
    onOpenVideo={() => setStudio('video')}
    onOpenImage={() => setStudio('image')}
    onOpenAssets={() => setStudio('assets')}
  />;
  if (studio === 'image') return <ImageStudio
    projects={library.projects}
    assets={library.assets}
    onSaveAssets={saveAssets}
    onContinueWithAgent={openAgent}
    onOpenHome={() => setStudio('home')}
    onOpenVideo={() => setStudio('video')}
    onOpenAgent={openAgent}
    onOpenAssets={() => setStudio('assets')}
  />;
  if (studio === 'home') return <HomeStudio
    projects={library.projects}
    assets={library.assets}
    onOpenAgent={openAgent}
    onOpenVideo={() => setStudio('video')}
    onOpenImage={() => setStudio('image')}
    onOpenAssets={() => setStudio('assets')}
  />;
  return <VideoStudio
    projects={library.projects}
    assets={library.assets}
    onSaveAssets={saveAssets}
    onContinueWithAgent={openAgent}
    onOpenHome={() => setStudio('home')}
    onOpenImage={() => setStudio('image')}
    onOpenAgent={openAgent}
    onOpenAssets={() => setStudio('assets')}
  />;
}

createRoot(document.getElementById('root')).render(<App />);
