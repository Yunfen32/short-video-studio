import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeVideoPrompt,
  findImageMentionTrigger,
  imageMentionToken,
  insertImageMention,
  normalizeImageRoles,
  remapImageMentions,
  stripImageMentions,
} from '../src/video-ui-state.mjs';

const images = [
  { id: 'person', role: 'character' },
  { id: 'scene', role: 'background' },
  { id: 'second-person', role: 'character' },
];

test('输入 @ 后可连续插入多张人物和背景参考图', () => {
  const mention = findImageMentionTrigger('让@背', 3);
  assert.deepEqual(mention, { start: 1, end: 3, query: '背' });
  const inserted = insertImageMention('让@背', mention, imageMentionToken('multi-reference', images[1], 1, images));
  assert.equal(inserted.prompt, '让@背景1 ');

  const nextMention = findImageMentionTrigger(inserted.prompt + '和@', inserted.prompt.length + 2);
  const second = insertImageMention(
    inserted.prompt + '和@',
    nextMention,
    imageMentionToken('multi-reference', images[2], 2, images),
  );
  assert.equal(second.prompt, '让@背景1 和@人物2 ');
});

test('删除或改序图片时同步更新语义标签和旧 @参考图 标签', () => {
  const after = [images[1], images[2]];
  const remapped = remapImageMentions(
    '@人物1走进@背景1，@参考图3随后出现',
    'multi-reference',
    images,
    after,
  );
  assert.equal(remapped, '走进@背景1，@人物1随后出现');
  assert.equal(stripImageMentions(remapped), '走进，随后出现');
});

test('首尾帧、关键帧和替换人物使用固定素材语义', () => {
  assert.deepEqual(
    normalizeImageRoles(images.slice(0, 2), 'first-last-frame').map((item) => item.role),
    ['first_frame', 'last_frame'],
  );
  assert.equal(imageMentionToken('keyframes', images[1], 1), '@关键帧2');
  assert.equal(imageMentionToken('character-replace', images[0], 0), '@替换人物');
});

test('提交提示词保留风格且不会超过服务端长度上限', () => {
  const prompt = composeVideoPrompt('镜头缓慢推进', '电影感');
  assert.equal(prompt, '镜头缓慢推进。视觉风格：电影感。');

  const maximum = composeVideoPrompt('画'.repeat(5000), '写实广告');
  assert.equal(maximum.length, 5000);
  assert.match(maximum, /视觉风格：写实广告。$/);
});
