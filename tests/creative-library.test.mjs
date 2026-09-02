import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREATIVE_LIBRARY_STORAGE_KEY,
  addAssetsToCreativeLibrary,
  createCreativeProject,
  insertCreativeProject,
  loadCreativeLibrary,
  projectProgress,
  setCreativeAssetCurrentVersion,
  setCreativeAssetRelations,
  updateCreativeProjectState,
} from '../src/creative-library.mjs';

function sequentialIds() {
  let value = 0;
  return (prefix) => `${prefix}-${++value}`;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('30 秒项目会创建可追溯的项目文档和六个 5 秒分镜', () => {
  const created = createCreativeProject({
    brief: '做一个 30 秒的赛博朋克短片，少女穿过雨夜街道。',
    style: '2D 动漫',
    ratio: '9:16',
  }, { now: 1_800_000_000_000, idFactory: sequentialIds() });

  assert.equal(created.project.duration, 30);
  assert.equal(created.project.shotIds.length, 6);
  assert.equal(created.assets.filter((asset) => asset.category === 'shot').length, 6);
  assert.equal(created.assets.find((asset) => asset.category === 'storyboard').relatedAssetIds.length, 6);
  assert.match(created.assets.find((asset) => asset.category === 'shot').content, /5 秒建立镜头/);
});

test('LLM 创作方案会落库为人物、场景、分镜脚本和可执行提示词资产', () => {
  const created = createCreativeProject({
    brief: '雨夜书店短片',
    style: '电影感',
    ratio: '16:9',
    target: 'video',
    creativePlan: {
      target: 'video', title: '雨夜纸飞机', duration: 10, style: '电影感', ratio: '16:9', source: 'script',
      logline: '纸飞机带少女进入书店', story: '少女在雨夜追随纸飞机。', creativeDirection: '蓝紫雨夜与暖黄室内光。',
      characters: [{ id: 'girl', name: '少女', role: '主角', appearance: '短黑发', wardrobe: '黄色雨衣', personality: '勇敢', continuityNotes: '红围巾始终出现', imagePrompt: '少女角色设定图' }],
      scenes: [{ id: 'street', name: '雨夜街道', description: '湿润街道', lighting: '蓝紫霓虹', palette: '蓝紫暖黄', continuityNotes: '中雨', imagePrompt: '雨夜街道设定图' }],
      shots: [{ id: 's1', title: '放飞', duration: 5, sceneId: 'street', characterIds: ['girl'], storyBeat: '引子', visualDescription: '少女放飞纸飞机', action: '纸飞机起飞', camera: '跟随', transition: '自然', audio: '雨声', imagePrompt: '少女放飞纸飞机关键帧', videoPrompt: '纸飞机穿过雨幕，镜头跟随' }, { id: 's2', title: '入店', duration: 5, sceneId: 'street', characterIds: ['girl'], storyBeat: '推进', visualDescription: '少女走向书店', action: '推门', camera: '推进', transition: '溶解', audio: '门铃', imagePrompt: '少女走到书店门口关键帧', videoPrompt: '少女推开书店门，镜头推进' }],
    },
  }, { idFactory: sequentialIds() });
  const character = created.assets.find((asset) => asset.category === 'character');
  const scene = created.assets.find((asset) => asset.category === 'scene');
  const storyboard = created.assets.find((asset) => asset.category === 'storyboard');
  const shot = created.assets.find((asset) => asset.category === 'shot');
  assert.equal(created.project.title, '雨夜纸飞机');
  assert.equal(character.source.prompt, '少女角色设定图');
  assert.equal(scene.source.prompt, '雨夜街道设定图');
  assert.match(storyboard.content, /图片提示词：少女放飞纸飞机关键帧/);
  assert.equal(shot.source.parameters.videoPrompt, '纸飞机穿过雨幕，镜头跟随');
  assert.equal(created.project.shotIds.length, 2);
});

test('生成媒体会保存模型来源并双向关联到项目镜头', () => {
  const created = createCreativeProject({ brief: '10 秒书店动画', duration: 10 }, { idFactory: sequentialIds() });
  const initial = insertCreativeProject(undefined, created);
  const shotId = created.project.shotIds[0];
  const result = addAssetsToCreativeLibrary(initial, [{
    projectId: created.project.id,
    type: 'video',
    category: 'shot',
    title: '万相镜头',
    previewUrl: 'https://media.example/shot.mp4',
    relatedAssetIds: [shotId],
    source: {
      provider: 'dashscope',
      model: 'wan2.7-t2v',
      workflow: 'text-to-video',
      prompt: '书店门口纸飞机起飞',
      parameters: { duration: 5, taskId: 'task-1' },
    },
  }], { idFactory: sequentialIds() });

  const media = result.assets[0];
  const shot = result.library.assets.find((asset) => asset.id === shotId);
  assert.equal(media.source.model, 'wan2.7-t2v');
  assert.equal(media.projectId, created.project.id);
  assert.ok(shot.relatedAssetIds.includes(media.id));
  assert.deepEqual(projectProgress(created.project, result.library.assets), { complete: 1, total: 2 });
});

test('资产关系可编辑并保持双向一致', () => {
  const created = createCreativeProject({ brief: '5 秒角色镜头' }, { idFactory: sequentialIds() });
  const library = insertCreativeProject(undefined, created);
  const [idea, story] = library.assets;
  const linked = setCreativeAssetRelations(library, idea.id, [story.id], { now: 1_800_000_000_000 });
  assert.ok(linked.assets.find((asset) => asset.id === idea.id).relatedAssetIds.includes(story.id));
  assert.ok(linked.assets.find((asset) => asset.id === story.id).relatedAssetIds.includes(idea.id));
});

test('同一镜头重新生成会形成版本链，并可恢复任一版本为当前版本', () => {
  const idFactory = sequentialIds();
  const created = createCreativeProject({ brief: '5 秒角色镜头' }, { idFactory });
  const initial = insertCreativeProject(undefined, created);
  const shotId = created.project.shotIds[0];
  const first = addAssetsToCreativeLibrary(initial, [{
    projectId: created.project.id,
    type: 'video',
    category: 'shot',
    title: '镜头版本',
    previewUrl: 'https://media.example/v1.mp4',
    relatedAssetIds: [shotId],
  }], { idFactory });
  const second = addAssetsToCreativeLibrary(first.library, [{
    projectId: created.project.id,
    type: 'video',
    category: 'shot',
    title: '镜头版本',
    previewUrl: 'https://media.example/v2.mp4',
    relatedAssetIds: [shotId],
  }], { idFactory });

  const [v2] = second.assets;
  const v1 = second.library.assets.find((asset) => asset.previewUrl === 'https://media.example/v1.mp4');
  assert.equal(v1.versionGroupId, v2.versionGroupId);
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(v1.isCurrent, false);
  assert.equal(v2.isCurrent, true);

  const restored = setCreativeAssetCurrentVersion(second.library, v1.id, { now: 1_800_000_000_000 });
  assert.equal(restored.assets.find((asset) => asset.id === v1.id).isCurrent, true);
  assert.equal(restored.assets.find((asset) => asset.id === v2.id).isCurrent, false);
});

test('损坏的本地资产数据会回退为空资产库', () => {
  const storage = memoryStorage();
  storage.setItem(CREATIVE_LIBRARY_STORAGE_KEY, '{bad-json');
  const library = loadCreativeLibrary(storage);
  assert.deepEqual(library.projects, []);
  assert.deepEqual(library.assets, []);
  assert.equal(storage.getItem(CREATIVE_LIBRARY_STORAGE_KEY), null);
});

test('项目会保存与创作目标匹配的工作流状态，并支持暂停后恢复', () => {
  const created = createCreativeProject({ brief: '做一张新品海报', target: 'image' }, { idFactory: sequentialIds() });
  assert.deepEqual(created.project.creativeState.workflow.map((step) => step.id), ['brief', 'assets', 'generate', 'review']);
  const initial = insertCreativeProject(undefined, created);
  const paused = updateCreativeProjectState(initial, created.project.id, (state) => ({
    ...state,
    status: 'paused',
    paused: true,
    currentStepId: 'generate',
    lastEvent: '等待用户继续。',
    workflow: state.workflow.map((step) => step.id === 'generate' ? { ...step, status: 'paused' } : step),
  }), { now: 1_800_000_000_000 });
  const project = paused.projects[0];
  assert.equal(project.status, 'in_progress');
  assert.equal(project.creativeState.status, 'paused');
  assert.equal(project.creativeState.paused, true);
  assert.equal(project.creativeState.workflow.find((step) => step.id === 'generate').status, 'paused');
});
