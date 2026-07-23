import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

await mkdir('dist/server', { recursive: true });
await mkdir('dist/server/shared', { recursive: true });

const workerSource = await readFile('worker/index.js', 'utf8');
const serverEntry = workerSource.replace(
  '../shared/video-api.mjs',
  './shared/video-api.mjs',
);

if (serverEntry === workerSource) {
  throw new Error('Worker shared API import was not found');
}

await writeFile('dist/server/index.js', serverEntry);

const sharedModules = (await readdir('shared'))
  .filter((file) => file.endsWith('.mjs'));

await Promise.all(sharedModules.map((file) => (
  copyFile(`shared/${file}`, `dist/server/shared/${file}`)
)));
