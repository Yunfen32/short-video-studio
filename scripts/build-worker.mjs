import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/server', { recursive: true });
await mkdir('dist/shared', { recursive: true });
await copyFile('worker/index.js', 'dist/server/index.js');
await copyFile('shared/video-api.mjs', 'dist/shared/video-api.mjs');
await copyFile('shared/video-models.mjs', 'dist/shared/video-models.mjs');
