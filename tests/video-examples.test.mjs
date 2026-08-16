import test from 'node:test';
import assert from 'node:assert/strict';
import { FREE_VIDEO_MODEL_IDS } from '../shared/free-models.mjs';
import { getVideoExample, VIDEO_EXAMPLES } from '../shared/video-examples.mjs';

test('每个免费视频模型都有可重复的 5 秒 2D 动漫案例', () => {
  assert.deepEqual(Object.keys(VIDEO_EXAMPLES).sort(), [...FREE_VIDEO_MODEL_IDS].sort());
  for (const modelId of FREE_VIDEO_MODEL_IDS) {
    const example = getVideoExample(modelId);
    assert.equal(example.workflow, 'text-to-video');
    assert.equal(example.duration, 5);
    assert.equal(example.style, '动画短片');
    assert.match(example.prompt, /2D 动漫/);
    assert.ok(example.prompt.length > 20);
  }
});

test('案例只匹配支持的生成方式', () => {
  assert.equal(getVideoExample('agnes-video-v2.0', 'first-frame'), null);
  assert.equal(getVideoExample('unknown-model'), null);
});
