import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

async function collectStaticAssets(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const assets = [];
  for (const entry of entries) {
    if (entry.name === 'server' || entry.name === '.openai') continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...await collectStaticAssets(absolute, root));
      continue;
    }
    if (!entry.isFile()) continue;
    const pathname = '/' + relative(root, absolute).split(sep).join('/');
    const body = await readFile(absolute);
    assets.push({
      pathname,
      contentType: contentTypes[extname(absolute).toLowerCase()] || 'application/octet-stream',
      body: body.toString('base64'),
    });
  }
  return assets;
}

await mkdir('dist/server', { recursive: true });
await mkdir('dist/server/shared', { recursive: true });

const workerSource = await readFile('worker/index.js', 'utf8');
const serverEntry = workerSource.replace(
  '../shared/video-api.mjs',
  './shared/video-api.mjs',
).replace(
  'function embeddedAssetResponse() {\n  return null;\n}',
  'import { embeddedAssetResponse } from "./embedded-assets.mjs";',
);

if (serverEntry === workerSource || !serverEntry.includes('embedded-assets.mjs')) {
  throw new Error('Worker build substitutions were not found');
}

await writeFile('dist/server/index.js', serverEntry);

const staticAssets = await collectStaticAssets('dist');
await writeFile('dist/server/embedded-assets.mjs', `const assets = ${JSON.stringify(staticAssets)};

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function embeddedAssetResponse(pathname, method = 'GET') {
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const asset = assets.find((item) => item.pathname === normalizedPath);
  if (!asset) return null;
  return new Response(method === 'HEAD' ? null : decodeBase64(asset.body), {
    headers: { 'content-type': asset.contentType },
  });
}
`);

const sharedModules = (await readdir('shared'))
  .filter((file) => file.endsWith('.mjs'));

await Promise.all(sharedModules.map((file) => (
  copyFile(`shared/${file}`, `dist/server/shared/${file}`)
)));
