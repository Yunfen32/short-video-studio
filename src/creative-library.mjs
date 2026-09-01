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

function createDocument({ id, projectId, category, title, content, tags, relatedAssetIds, createdAt }) {
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
    source: null,
    version: 1,
    versionGroupId: `asset:${id}`,
    isCurrent: true,
    createdAt,
    updatedAt: createdAt,
  };
}

export function createCreativeProject(input = {}, { now = Date.now(), idFactory } = {}) {
  const brief = asText(input.brief || input.prompt);
  if (!brief) throw new Error('请先填写创作灵感或剧本');
  const createdAt = nowIso(now);
  const projectId = createId('project', idFactory);
  const duration = durationFromBrief(brief, input.duration || 5);
  const shotCount = Math.max(1, Math.ceil(duration / 5));
  const title = asText(input.title, 120) || projectTitleFromBrief(brief);
  const sharedTags = uniqueStrings([input.style, input.ratio, input.source === 'script' ? '剧本' : '灵感']);
  const projectDocs = [
    createDocument({
      id: createId('asset', idFactory), projectId, category: 'idea', title: '创作立项', content: brief, tags: sharedTags, relatedAssetIds: [], createdAt,
    }),
    createDocument({
      id: createId('asset', idFactory), projectId, category: 'story', title: '故事', content: brief, tags: sharedTags, relatedAssetIds: [], createdAt,
    }),
    createDocument({
      id: createId('asset', idFactory), projectId, category: 'character', title: '角色设定', content: '', tags: sharedTags, relatedAssetIds: [], createdAt,
    }),
    createDocument({
      id: createId('asset', idFactory), projectId, category: 'scene', title: '场景设定', content: '', tags: sharedTags, relatedAssetIds: [], createdAt,
    }),
    createDocument({
      id: createId('asset', idFactory), projectId, category: 'prompt', title: '创作提示词', content: brief, tags: sharedTags, relatedAssetIds: [], createdAt,
    }),
  ];
  const shotAssets = Array.from({ length: shotCount }, (_, index) => {
    const start = index * 5;
    const remaining = Math.max(1, duration - start);
    const shotDuration = Math.min(5, remaining);
    return createDocument({
      id: createId('asset', idFactory),
      projectId,
      category: 'shot',
      title: `镜头 ${String(index + 1).padStart(2, '0')}`,
      content: `${shotDuration} 秒镜头（第 ${index + 1}/${shotCount} 镜）：${brief}`,
      tags: [...sharedTags, '分镜', `${shotDuration}秒`],
      relatedAssetIds: projectDocs.map((asset) => asset.id),
      createdAt,
    });
  });
  const storyboard = createDocument({
    id: createId('asset', idFactory),
    projectId,
    category: 'storyboard',
    title: '分镜脚本',
    content: shotAssets.map((shot) => `${shot.title}\n${shot.content}`).join('\n\n'),
    tags: [...sharedTags, '分镜'],
    relatedAssetIds: shotAssets.map((asset) => asset.id),
    createdAt,
  });
  const assets = [...projectDocs, storyboard, ...shotAssets];
  const project = {
    id: projectId,
    title,
    brief,
    style: asText(input.style, 120),
    ratio: asText(input.ratio, 32),
    duration,
    status: 'planned',
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
  const completedShotIds = new Set((assets || []).filter((asset) => asset.type !== 'document' && asset.relatedAssetIds.some((id) => shotIds.includes(id))).flatMap((asset) => asset.relatedAssetIds));
  return { complete: shotIds.filter((id) => completedShotIds.has(id)).length, total: shotIds.length };
}

