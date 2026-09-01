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
  assert.match(created.assets.find((asset) => asset.category === 'shot').content, /5 秒镜头/);
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

