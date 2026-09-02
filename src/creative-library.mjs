export const CREATIVE_LIBRARY_STORAGE_KEY = 'short-video-studio:creative-library:v1';

const LIBRARY_VERSION = 1;
const ASSET_TYPES = new Set(['image', 'video', 'audio', 'document']);
const ASSET_CATEGORIES = new Set([
  'idea',
  'story',
  'storyboard',
  'character',
  'scene',
  'prompt',
  'reference',
  'shot',
  'material',
  'final',
]);
const CREATIVE_TARGETS = new Set(['image', 'video']);
const CREATIVE_STATE_STATUSES = new Set(['planned', 'ready', 'running', 'waiting_review', 'paused', 'blocked', 'complete']);
const WORKFLOW_STEP_STATUSES = new Set(['pending', 'ready', 'active', 'completed', 'waiting_review', 'paused', 'blocked']);

function createId(prefix, idFactory) {
  if (typeof idFactory === 'function') return idFactory(prefix);
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function asText(value, maxLength = 5000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => asText(value, 80)).filter(Boolean))];
}

function nowIso(now) {
  return new Date(now).toISOString();
}

function creativeTarget(value) {
  return CREATIVE_TARGETS.has(value) ? value : 'video';
}

function workflowDefinition(target) {
  const shared = [
    { id: 'brief', label: '创作立项', detail: '已记录创作目标', status: 'completed' },
    { id: 'assets', label: '角色与场景', detail: '已建立可编辑的角色、场景资料', status: 'ready' },
  ];
  if (target === 'image') {
    return [...shared,
      { id: 'generate', label: '生成图片', detail: '等待审核生成路径', status: 'pending' },
      { id: 'review', label: '结果审核', detail: '等待生成结果', status: 'pending' },
    ];
  }
  return [...shared,
    { id: 'storyboard', label: '分镜规划', detail: '已创建可编辑的镜头草案', status: 'ready' },
    { id: 'generate', label: '生成镜头', detail: '等待审核生成路径', status: 'pending' },
    { id: 'review', label: '结果审核', detail: '等待生成结果', status: 'pending' },
  ];
}

function createCreativeState(input = {}) {
  const target = creativeTarget(input.target);
  const workflow = workflowDefinition(target);
  return {
    version: 1,
    target,
    status: 'ready',
    currentStepId: target === 'image' ? 'assets' : 'storyboard',
    paused: false,
    lastEvent: '项目资料已建立，等待确认下一步。',
    workflow,
  };
}

function normalizeWorkflowStep(step, fallback) {
  const base = fallback || {};
  return {
    id: asText(step?.id, 80) || base.id,
    label: asText(step?.label, 120) || base.label,
    detail: asText(step?.detail, 500) || base.detail || '',
    status: WORKFLOW_STEP_STATUSES.has(step?.status) ? step.status : (base.status || 'pending'),
  };
}

function normalizeCreativeState(value, project) {
  const fallback = createCreativeState({ target: value?.target || project?.creativeState?.target });
  if (!value || typeof value !== 'object') return fallback;
  const fallbackSteps = new Map(fallback.workflow.map((step) => [step.id, step]));
  const supplied = Array.isArray(value.workflow) ? value.workflow : [];
  const workflow = fallback.workflow.map((step) => {
    const match = supplied.find((item) => item?.id === step.id);
    return normalizeWorkflowStep(match, step);
  });
  return {
    version: 1,
    target: creativeTarget(value.target),
    status: CREATIVE_STATE_STATUSES.has(value.status) ? value.status : fallback.status,
    currentStepId: fallbackSteps.has(asText(value.currentStepId, 80)) ? asText(value.currentStepId, 80) : fallback.currentStepId,
    paused: value.paused === true,
    lastEvent: asText(value.lastEvent, 500) || fallback.lastEvent,
    workflow,
  };
}

function normalizeAsset(asset) {
  if (!asset || typeof asset !== 'object' || !asText(asset.id, 160)) return null;
  return {
    id: asText(asset.id, 160),
    projectId: asText(asset.projectId, 160) || null,
    type: ASSET_TYPES.has(asset.type) ? asset.type : 'document',
    category: ASSET_CATEGORIES.has(asset.category) ? asset.category : 'material',
    title: asText(asset.title, 120) || '未命名资产',
    content: asText(asset.content, 12000),
    previewUrl: asText(asset.previewUrl, 3000),
    tags: uniqueStrings(asset.tags),
    relatedAssetIds: uniqueStrings(asset.relatedAssetIds),
    source: asset.source && typeof asset.source === 'object' ? {
      provider: asText(asset.source.provider, 120),
      model: asText(asset.source.model, 160),
      workflow: asText(asset.source.workflow, 120),
      prompt: asText(asset.source.prompt, 5000),
      parameters: asset.source.parameters && typeof asset.source.parameters === 'object' ? asset.source.parameters : {},
    } : null,
    version: Number.isInteger(asset.version) && asset.version > 0 ? asset.version : 1,
    versionGroupId: asText(asset.versionGroupId, 220) || `asset:${asText(asset.id, 160)}`,
    isCurrent: asset.isCurrent !== false,
    createdAt: asText(asset.createdAt, 80) || new Date(0).toISOString(),
    updatedAt: asText(asset.updatedAt, 80) || new Date(0).toISOString(),
  };
}

function normalizeProject(project, assetIds) {
  if (!project || typeof project !== 'object' || !asText(project.id, 160)) return null;
  return {
    id: asText(project.id, 160),
    title: asText(project.title, 120) || '未命名创作项目',
    brief: asText(project.brief, 5000),
    style: asText(project.style, 120),
    ratio: asText(project.ratio, 32),
    duration: Number.isFinite(Number(project.duration)) ? Math.max(1, Number(project.duration)) : 5,
    status: ['planned', 'in_progress', 'complete'].includes(project.status) ? project.status : 'planned',
    creativeState: normalizeCreativeState(project.creativeState, project),
    assetIds: uniqueStrings(project.assetIds).filter((id) => assetIds.has(id)),
    shotIds: uniqueStrings(project.shotIds).filter((id) => assetIds.has(id)),
    createdAt: asText(project.createdAt, 80) || new Date(0).toISOString(),
    updatedAt: asText(project.updatedAt, 80) || new Date(0).toISOString(),
  };
}

export function createEmptyCreativeLibrary() {
  return { version: LIBRARY_VERSION, projects: [], assets: [] };
}

export function loadCreativeLibrary(storage) {
  if (!storage) return createEmptyCreativeLibrary();
  try {
    const raw = JSON.parse(storage.getItem(CREATIVE_LIBRARY_STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return createEmptyCreativeLibrary();
    const assets = (Array.isArray(raw.assets) ? raw.assets : []).map(normalizeAsset).filter(Boolean);
    const assetIds = new Set(assets.map((asset) => asset.id));
    const projects = (Array.isArray(raw.projects) ? raw.projects : []).map((project) => normalizeProject(project, assetIds)).filter(Boolean);
    const projectIds = new Set(projects.map((project) => project.id));
    return {
      version: LIBRARY_VERSION,
      projects: projects.map((project) => ({
        ...project,
        assetIds: project.assetIds.length ? project.assetIds : assets.filter((asset) => asset.projectId === project.id).map((asset) => asset.id),
      })),
      assets: assets.map((asset) => ({ ...asset, projectId: projectIds.has(asset.projectId) ? asset.projectId : null })),
    };
  } catch {
    storage.removeItem(CREATIVE_LIBRARY_STORAGE_KEY);
    return createEmptyCreativeLibrary();
  }
}

export function saveCreativeLibrary(storage, library) {
  if (!storage) return;
  storage.setItem(CREATIVE_LIBRARY_STORAGE_KEY, JSON.stringify(library || createEmptyCreativeLibrary()));
}

export function durationFromBrief(brief, fallback = 5) {
  const text = asText(brief);
  const matched = text.match(/(?:约|大约|时长为?|长度为?)?\s*(\d{1,3})\s*秒/);
  if (matched) return Math.max(1, Math.min(300, Number(matched[1])));
  if (/半分钟/.test(text)) return 30;
  return Math.max(1, Number(fallback) || 5);
}

export function projectTitleFromBrief(brief, fallback = '未命名创作项目') {
  const clean = asText(brief, 500).replace(/\s+/g, ' ');
  if (!clean) return fallback;
  const firstPart = clean.split(/[。！？!?\n]/)[0].trim();
  return (firstPart || clean).slice(0, 28);
}

function createDocument({ id, projectId, category, title, content, tags, relatedAssetIds, createdAt, source = null }) {
  return {
    id,
    projectId,
    type: 'document',
    category,
    title,
    content,
    previewUrl: '',
    tags: uniqueStrings(tags),
    relatedAssetIds: uniqueStrings(relatedAssetIds),
    source: source && typeof source === 'object' ? source : null,
    version: 1,
    versionGroupId: `asset:${id}`,
    isCurrent: true,
    createdAt,
    updatedAt: createdAt,
  };
}

function storyboardBeat(index, total) {
  if (total === 1) return { label: '完整镜头', detail: '在一个连贯镜头内交代主体、动作和结尾画面' };
  if (index === 0) return { label: '建立镜头', detail: '交代主体、空间与整体氛围' };
  if (index === total - 1) return { label: '收束镜头', detail: '突出关键结果并形成清晰结尾' };
  if (index === 1) return { label: '主体镜头', detail: '推进到核心主体，展示最重要的视觉信息' };
  if (index === total - 2) return { label: '转折镜头', detail: '强化动作、情绪或产品卖点，为结尾铺垫' };
  return { label: '发展镜头', detail: '延续动作与场景关系，保持视觉和叙事连贯' };
}

export function buildStoryboardShots({ brief, duration, shotCount }) {
  const safeBrief = asText(brief, 5000);
  const total = Math.max(1, Number(shotCount) || 1);
  return Array.from({ length: total }, (_, index) => {
    const start = index * 5;
    const remaining = Math.max(1, Number(duration) - start);
    const seconds = Math.min(5, remaining);
    const beat = storyboardBeat(index, total);
    return {
      title: `镜头 ${String(index + 1).padStart(2, '0')} · ${beat.label}`,
      seconds,
      content: `${seconds} 秒${beat.label}：${beat.detail}。项目目标：${safeBrief}`,
    };
  });
}

export function createCreativeProject(input = {}, { now = Date.now(), idFactory } = {}) {
  const brief = asText(input.brief || input.prompt);
  if (!brief) throw new Error('请先填写创作灵感或剧本');
  const createdAt = nowIso(now);
  const projectId = createId('project', idFactory);
  const plan = input.creativePlan && typeof input.creativePlan === 'object' ? input.creativePlan : null;
  const duration = plan?.target === 'video'
    ? Math.max(2, Number(plan.duration) || Number(input.duration) || 5)
    : durationFromBrief(brief, input.duration || 5);
  const title = asText(plan?.title, 120) || asText(input.title, 120) || projectTitleFromBrief(brief);
  const style = asText(plan?.style || input.style, 120);
  const ratio = asText(plan?.ratio || input.ratio, 32);
  const source = plan?.source || input.source;
  const sharedTags = uniqueStrings([style, ratio, source === 'script' ? '剧本' : '灵感', plan ? 'LLM规划' : 'legacy']);
  const projectDocs = [
    createDocument({
      id: createId('asset', idFactory), projectId, category: 'idea', title: '创作立项', content: brief, tags: sharedTags, relatedAssetIds: [], createdAt,
    }),
    createDocument({
      id: createId('asset', idFactory), projectId, category: 'story', title: '故事', content: asText(plan?.story || plan?.logline, 12000) || brief, tags: sharedTags, relatedAssetIds: [], createdAt,
    }),
    createDocument({
      id: createId('asset', idFactory), projectId, category: 'prompt', title: '视觉方向', content: asText(plan?.creativeDirection, 12000) || brief, tags: sharedTags, relatedAssetIds: [], createdAt,
    }),
  ];
  const characters = Array.isArray(plan?.characters) ? plan.characters : [];
  const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
  const planShots = Array.isArray(plan?.shots) && plan.shots.length
    ? plan.shots
    : buildStoryboardShots({ brief, duration, shotCount: Math.max(1, Math.ceil(duration / 5)) }).map((shot) => ({
      id: `legacy-${shot.title}`,
      title: shot.title,
      duration: shot.seconds,
      timelineDuration: shot.seconds,
      sceneId: scenes[0]?.id || 'scene-1',
      characterIds: [],
      storyBeat: shot.detail,
      visualDescription: shot.detail,
      action: shot.detail,
      camera: '',
      transition: '',
      audio: '',
      imagePrompt: shot.content,
      videoPrompt: shot.content,
      legacyContent: shot.content,
    }));
  const characterDocs = characters.map((character, index) => createDocument({
    id: createId('asset', idFactory), projectId, category: 'character', title: character.name || `人物 ${index + 1}`,
    content: [character.role, character.appearance, character.wardrobe, character.personality, character.continuityNotes].filter(Boolean).join('\n'),
    tags: [...sharedTags, '人物'], relatedAssetIds: [], createdAt,
    source: { provider: 'llm', workflow: 'character-extraction', prompt: asText(character.imagePrompt, 5000), parameters: { characterId: character.id } },
  }));
  const sceneDocs = scenes.map((scene, index) => createDocument({
    id: createId('asset', idFactory), projectId, category: 'scene', title: scene.name || `场景 ${index + 1}`,
    content: [scene.description, `光线：${scene.lighting}`, `色彩：${scene.palette}`, scene.continuityNotes].filter(Boolean).join('\n'),
    tags: [...sharedTags, '场景'], relatedAssetIds: [], createdAt,
    source: { provider: 'llm', workflow: 'scene-extraction', prompt: asText(scene.imagePrompt, 5000), parameters: { sceneId: scene.id } },
  }));
  const shotAssets = planShots.map((shot, index) => {
    const seconds = Math.max(1, Number(shot.duration) || 5);
    const timelineSeconds = Math.max(1, Math.min(seconds, Number(shot.timelineDuration) || seconds));
    const scene = scenes.find((item) => item.id === shot.sceneId);
    const characterNames = characters.filter((item) => (shot.characterIds || []).includes(item.id)).map((item) => item.name);
    const content = plan ? [
      `${timelineSeconds} 秒成片 · 生成 ${seconds} 秒 · ${asText(shot.title, 160) || `镜头 ${String(index + 1).padStart(2, '0')}`}`,
      `故事节拍：${asText(shot.storyBeat, 600)}`,
      `画面：${asText(shot.visualDescription, 1600)}`,
      `动作：${asText(shot.action, 1200)}`,
      `镜头：${asText(shot.camera, 800)}`,
      `场景：${scene?.name || shot.sceneId || '未指定'}`,
      characterNames.length ? `人物：${characterNames.join('、')}` : '',
      `转场：${asText(shot.transition, 500)}`,
      `声音：${asText(shot.audio, 800)}`,
    ].filter((line) => line && !line.endsWith('：')).join('\n') : asText(shot.legacyContent, 12000);
    return createDocument({
      id: createId('asset', idFactory),
      projectId,
      category: 'shot',
      title: asText(shot.title, 160) || `镜头 ${String(index + 1).padStart(2, '0')}`,
      content,
      tags: [...sharedTags, '分镜', `${timelineSeconds}秒成片`, `${seconds}秒生成`],
      relatedAssetIds: [...projectDocs, ...characterDocs, ...sceneDocs].map((asset) => asset.id),
      createdAt,
      source: { provider: plan ? 'llm' : 'legacy', workflow: 'storyboard', prompt: asText(shot.videoPrompt || shot.imagePrompt, 5000), parameters: {
        shotId: shot.id || `shot-${index + 1}`,
        duration: seconds,
        timelineDuration: timelineSeconds,
        sceneId: shot.sceneId || '',
        characterIds: Array.isArray(shot.characterIds) ? shot.characterIds : [],
        imagePrompt: asText(shot.imagePrompt, 5000),
        videoPrompt: asText(shot.videoPrompt || shot.imagePrompt, 5000),
      } },
    });
  });
  const storyboard = createDocument({
    id: createId('asset', idFactory),
    projectId,
    category: 'storyboard',
    title: '分镜脚本',
    content: [
      `# ${title}`,
      asText(plan?.logline, 1200),
      '',
      ...shotAssets.map((shot) => `## ${shot.title}\n${shot.content}\n图片提示词：${shot.source?.parameters?.imagePrompt || ''}\n视频提示词：${shot.source?.parameters?.videoPrompt || ''}`),
    ].filter(Boolean).join('\n\n'),
    tags: [...sharedTags, '分镜'],
    relatedAssetIds: shotAssets.map((asset) => asset.id),
    createdAt,
  });
  const assets = [...projectDocs, ...characterDocs, ...sceneDocs, storyboard, ...shotAssets];
  const project = {
    id: projectId,
    title,
    brief,
    style,
    ratio,
    duration,
    status: 'planned',
    creativeState: createCreativeState({ ...input, target: plan?.target || input.target }),
    assetIds: assets.map((asset) => asset.id),
    shotIds: shotAssets.map((asset) => asset.id),
    createdAt,
    updatedAt: createdAt,
  };
  return { project, assets };
}

export function addAssetsToCreativeLibrary(library, drafts, { now = Date.now(), idFactory } = {}) {
  const current = library || createEmptyCreativeLibrary();
  const createdAt = nowIso(now);
  const projectIds = new Set(current.projects.map((project) => project.id));
  const additions = (Array.isArray(drafts) ? drafts : []).map((draft, index) => {
    const type = ASSET_TYPES.has(draft?.type) ? draft.type : 'document';
    const category = ASSET_CATEGORIES.has(draft?.category) ? draft.category : 'material';
    const assetId = createId('asset', idFactory);
    const relatedAssetIds = uniqueStrings(draft?.relatedAssetIds);
    const fallbackGroup = relatedAssetIds.length
      ? `shot:${relatedAssetIds[0]}:${type}`
      : draft?.projectId
        ? `project:${draft.projectId}:${type}:${category}`
        : `asset:${assetId}`;
    return {
      id: assetId,
      projectId: projectIds.has(draft?.projectId) ? draft.projectId : null,
      type,
      category,
      title: asText(draft?.title, 120) || `${type === 'video' ? '视频' : type === 'image' ? '图片' : type === 'audio' ? '音频' : '文档'} ${index + 1}`,
      content: asText(draft?.content, 12000),
      previewUrl: asText(draft?.previewUrl, 3000),
      tags: uniqueStrings(draft?.tags),
      relatedAssetIds,
      source: draft?.source && typeof draft.source === 'object' ? {
        provider: asText(draft.source.provider, 120),
        model: asText(draft.source.model, 160),
        workflow: asText(draft.source.workflow, 120),
        prompt: asText(draft.source.prompt, 5000),
        parameters: draft.source.parameters && typeof draft.source.parameters === 'object' ? draft.source.parameters : {},
      } : null,
      version: 1,
      versionGroupId: asText(draft?.versionGroupId, 220) || fallbackGroup,
      isCurrent: true,
      createdAt,
      updatedAt: createdAt,
    };
  });
  const groupVersions = new Map();
  for (const asset of current.assets) {
    const groupId = asset.versionGroupId || `asset:${asset.id}`;
    groupVersions.set(groupId, Math.max(groupVersions.get(groupId) || 0, asset.version || 1));
  }
  const additionsWithVersions = additions.map((asset) => {
    const version = (groupVersions.get(asset.versionGroupId) || 0) + 1;
    groupVersions.set(asset.versionGroupId, version);
    return { ...asset, version };
  });
  const newestAdditionVersionByGroup = new Map();
  for (const asset of additionsWithVersions) {
    newestAdditionVersionByGroup.set(asset.versionGroupId, Math.max(newestAdditionVersionByGroup.get(asset.versionGroupId) || 0, asset.version));
  }
  const additionIds = new Set(additionsWithVersions.map((asset) => asset.id));
  const replacementGroups = new Set(additionsWithVersions.map((asset) => asset.versionGroupId));
  const assets = current.assets.map((asset) => {
    const relations = additionsWithVersions.filter((addition) => addition.relatedAssetIds.includes(asset.id)).map((addition) => addition.id);
    const isReplaced = replacementGroups.has(asset.versionGroupId || `asset:${asset.id}`);
    if (!relations.length && !isReplaced) return asset;
    return {
      ...asset,
      relatedAssetIds: relations.length ? uniqueStrings([...asset.relatedAssetIds, ...relations]) : asset.relatedAssetIds,
      isCurrent: isReplaced ? false : asset.isCurrent,
      updatedAt: createdAt,
    };
  }).concat(additionsWithVersions.map((asset) => ({
    ...asset,
    isCurrent: asset.version === newestAdditionVersionByGroup.get(asset.versionGroupId),
    relatedAssetIds: asset.relatedAssetIds.filter((id) => !additionIds.has(id) || id !== asset.id),
  })));
  const projects = current.projects.map((project) => {
    const projectAdditions = additionsWithVersions.filter((asset) => asset.projectId === project.id).map((asset) => asset.id);
    if (!projectAdditions.length) return project;
    return {
      ...project,
      status: 'in_progress',
      assetIds: uniqueStrings([...project.assetIds, ...projectAdditions]),
      updatedAt: createdAt,
    };
  });
  return { library: { version: LIBRARY_VERSION, projects, assets }, assets: additionsWithVersions };
}

export function insertCreativeProject(library, created) {
  const current = library || createEmptyCreativeLibrary();
  return {
    version: LIBRARY_VERSION,
    projects: [created.project, ...current.projects],
    assets: [...created.assets, ...current.assets],
  };
}

export function updateCreativeProjectState(library, projectId, patch, { now = Date.now() } = {}) {
  const current = library || createEmptyCreativeLibrary();
  const updatedAt = nowIso(now);
  return {
    ...current,
    projects: current.projects.map((project) => {
      if (project.id !== projectId) return project;
      const previous = normalizeCreativeState(project.creativeState, project);
      const proposed = typeof patch === 'function' ? patch(previous) : { ...previous, ...(patch || {}) };
      const creativeState = normalizeCreativeState(proposed, project);
      const projectStatus = creativeState.status === 'complete' ? 'complete' : creativeState.status === 'planned' ? 'planned' : 'in_progress';
      return { ...project, status: projectStatus, creativeState, updatedAt };
    }),
  };
}

export function updateCreativeAsset(library, assetId, patch, { now = Date.now() } = {}) {
  const current = library || createEmptyCreativeLibrary();
  const updatedAt = nowIso(now);
  return {
    ...current,
    assets: current.assets.map((asset) => {
      if (asset.id !== assetId) return asset;
      const next = {
        ...asset,
        title: patch?.title === undefined ? asset.title : asText(patch.title, 120) || asset.title,
        content: patch?.content === undefined ? asset.content : asText(patch.content, 12000),
        tags: patch?.tags === undefined ? asset.tags : uniqueStrings(patch.tags),
        relatedAssetIds: patch?.relatedAssetIds === undefined ? asset.relatedAssetIds : uniqueStrings(patch.relatedAssetIds).filter((id) => id !== asset.id),
        updatedAt,
      };
      return next;
    }),
  };
}

export function setCreativeAssetRelations(library, assetId, relatedAssetIds, { now = Date.now() } = {}) {
  const current = library || createEmptyCreativeLibrary();
  const target = current.assets.find((asset) => asset.id === assetId);
  if (!target) return current;
  const updatedAt = nowIso(now);
  const validIds = new Set(current.assets.map((asset) => asset.id));
  const nextRelations = uniqueStrings(relatedAssetIds).filter((id) => id !== assetId && validIds.has(id));
  const previousRelations = new Set(target.relatedAssetIds);
  return {
    ...current,
    assets: current.assets.map((asset) => {
      if (asset.id === assetId) return { ...asset, relatedAssetIds: nextRelations, updatedAt };
      const shouldAdd = nextRelations.includes(asset.id);
      const shouldRemove = previousRelations.has(asset.id) && !shouldAdd;
      if (!shouldAdd && !shouldRemove) return asset;
      return {
        ...asset,
        relatedAssetIds: shouldAdd
          ? uniqueStrings([...asset.relatedAssetIds, assetId])
          : asset.relatedAssetIds.filter((id) => id !== assetId),
        updatedAt,
      };
    }),
  };
}

export function assignCreativeAssetToProject(library, assetId, projectId, { now = Date.now() } = {}) {
  const current = library || createEmptyCreativeLibrary();
  const target = current.assets.find((asset) => asset.id === assetId);
  if (!target) return current;
  const nextProjectId = current.projects.some((project) => project.id === projectId) ? projectId : null;
  const updatedAt = nowIso(now);
  return {
    ...current,
    assets: current.assets.map((asset) => asset.id === assetId ? { ...asset, projectId: nextProjectId, updatedAt } : asset),
    projects: current.projects.map((project) => {
      const withoutAsset = project.assetIds.filter((id) => id !== assetId);
      if (project.id !== nextProjectId) return project.assetIds.length === withoutAsset.length ? project : { ...project, assetIds: withoutAsset, updatedAt };
      return { ...project, assetIds: uniqueStrings([...withoutAsset, assetId]), status: 'in_progress', updatedAt };
    }),
  };
}

export function setCreativeAssetCurrentVersion(library, assetId, { now = Date.now() } = {}) {
  const current = library || createEmptyCreativeLibrary();
  const target = current.assets.find((asset) => asset.id === assetId);
  if (!target) return current;
  const updatedAt = nowIso(now);
  const groupId = target.versionGroupId || `asset:${target.id}`;
  return {
    ...current,
    assets: current.assets.map((asset) => {
      const assetGroupId = asset.versionGroupId || `asset:${asset.id}`;
      if (assetGroupId !== groupId) return asset;
      return { ...asset, isCurrent: asset.id === assetId, updatedAt };
    }),
  };
}

export function deleteCreativeAsset(library, assetId) {
  const current = library || createEmptyCreativeLibrary();
  return {
    ...current,
    assets: current.assets.filter((asset) => asset.id !== assetId).map((asset) => ({
      ...asset,
      relatedAssetIds: asset.relatedAssetIds.filter((id) => id !== assetId),
    })),
    projects: current.projects.map((project) => ({
      ...project,
      assetIds: project.assetIds.filter((id) => id !== assetId),
      shotIds: project.shotIds.filter((id) => id !== assetId),
    })),
  };
}

export function projectProgress(project, assets) {
  const shotIds = project?.shotIds || [];
  if (!shotIds.length) return { complete: 0, total: 0 };
  const outputType = project?.creativeState?.target === 'image' ? 'image' : 'video';
  const completedShotIds = new Set((assets || []).filter((asset) => asset.type === outputType && asset.relatedAssetIds.some((id) => shotIds.includes(id))).flatMap((asset) => asset.relatedAssetIds));
  return { complete: shotIds.filter((id) => completedShotIds.has(id)).length, total: shotIds.length };
}
