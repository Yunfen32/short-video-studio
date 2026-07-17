export function defaultImageRole(workflowId, index, currentRole) {
  if (workflowId === 'first-frame') return 'first_frame';
  if (workflowId === 'first-last-frame') return index === 0 ? 'first_frame' : 'last_frame';
  if (workflowId === 'keyframes') return 'keyframe';
  if (workflowId === 'video-continuation') return 'last_frame';
  if (workflowId === 'motion-transfer') return 'character';
  if (workflowId === 'character-replace') return 'replacement_character';
  if (workflowId === 'multi-reference' || workflowId === 'video-edit') {
    return currentRole === 'background' ? 'background' : 'character';
  }
  return currentRole || 'character';
}

export function normalizeImageRoles(images, workflowId) {
  return images.map((image, index) => ({
    ...image,
    role: defaultImageRole(workflowId, index, image.role),
  }));
}

function roleOrdinal(images, index, role) {
  if (!Array.isArray(images) || !images.length) return index + 1;
  return images.slice(0, index + 1).filter((image) => image.role === role).length;
}

export function imageRoleLabel(workflowId, image, index, images = []) {
  if (workflowId === 'first-frame') return '首帧图';
  if (workflowId === 'first-last-frame') return index === 0 ? '首帧图' : '尾帧图';
  if (workflowId === 'keyframes') return '关键帧 ' + (index + 1);
  if (workflowId === 'video-continuation') return '尾帧图';
  if (workflowId === 'motion-transfer') return '人物图';
  if (workflowId === 'character-replace') return '替换人物图';
  const role = image.role === 'background' ? 'background' : 'character';
  const ordinal = roleOrdinal(images, index, role);
  return role === 'background' ? '背景参考 ' + ordinal : '人物参考 ' + ordinal;
}

export function imageMentionToken(workflowId, image, index, images = []) {
  if (workflowId === 'first-frame') return '@首帧';
  if (workflowId === 'first-last-frame') return index === 0 ? '@首帧' : '@尾帧';
  if (workflowId === 'keyframes') return '@关键帧' + (index + 1);
  if (workflowId === 'video-continuation') return '@尾帧';
  if (workflowId === 'motion-transfer') return '@人物';
  if (workflowId === 'character-replace') return '@替换人物';
  const role = image.role === 'background' ? 'background' : 'character';
  const ordinal = roleOrdinal(images, index, role);
  return role === 'background' ? '@背景' + ordinal : '@人物' + ordinal;
}

export function remapImageMentions(prompt, workflowId, before, after) {
  let next = prompt;
  const placeholders = before.map((image, index) => ({
    id: image.id,
    value: '__MEDIA_REFERENCE_' + index + '__',
    tokens: [imageMentionToken(workflowId, image, index, before), '@参考图' + (index + 1)],
  }));
  placeholders.forEach((item) => {
    item.tokens.forEach((token) => {
      next = next.split(token).join(item.value);
    });
  });
  placeholders.forEach((item) => {
    const nextIndex = after.findIndex((image) => image.id === item.id);
    const replacement = nextIndex === -1 ? '' : imageMentionToken(workflowId, after[nextIndex], nextIndex, after);
    next = next.split(item.value).join(replacement);
  });
  return next.replace(/ {2,}/g, ' ').trimStart();
}

export function stripImageMentions(prompt) {
  return prompt
    .replace(/@(参考图|人物|背景|关键帧)\s*\d+/g, '')
    .replace(/@(首帧|尾帧|替换人物|人物)(?!\s*\d)/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function findImageMentionTrigger(value, cursor = value.length) {
  const trigger = value.slice(0, cursor).match(/@([^\s@]*)$/);
  return trigger
    ? { start: cursor - trigger[0].length, end: cursor, query: trigger[1] }
    : null;
}

export function insertImageMention(prompt, mention, token) {
  const suffix = prompt.slice(mention.end);
  const spacer = suffix.startsWith(' ') ? '' : ' ';
  return {
    prompt: prompt.slice(0, mention.start) + token + spacer + suffix,
    cursor: mention.start + token.length + spacer.length,
  };
}

export function composeVideoPrompt(prompt, style, maxLength = 5000) {
  const base = String(prompt || '').trim();
  if (!base) return '';
  const suffix = style ? `。视觉风格：${String(style).trim()}。` : '';
  const baseLimit = Math.max(0, maxLength - suffix.length);
  return (base.slice(0, baseLimit) + suffix).slice(0, maxLength);
}
