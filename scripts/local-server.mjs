import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

import { createServer as createViteServer } from 'vite';

import { handleVideoApiRequest } from '../shared/video-api.mjs';

function loadLocalEnv(root) {
  let source = '';
  try {
    source = readFileSync(resolve(root, '.env'), 'utf8');
  } catch {
    return;
  }

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const divider = trimmed.indexOf('=');
    if (divider <= 0) continue;
    const key = trimmed.slice(0, divider).trim();
    const rawValue = trimmed.slice(divider + 1).trim();
    const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function createMemoryStorage() {
  const values = new Map();

  return {
    async getJSON(key) {
      const value = values.get(key);
      if (!value || value.kind !== 'json') return null;
      return JSON.parse(value.data);
    },
    async setJSON(key, value) {
      values.set(key, { kind: 'json', data: JSON.stringify(value) });
    },
    async put(key, body, metadata = {}) {
      const bytes = body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : body instanceof Uint8Array
          ? new Uint8Array(body)
          : new Uint8Array(await new Response(body).arrayBuffer());
      values.set(key, {
        kind: 'asset',
        body: bytes,
        contentType: metadata.contentType || 'application/octet-stream',
        createdAt: Number(metadata.createdAt) || Date.now(),
        accessToken: metadata.accessToken || '',
      });
    },
    async get(key) {
      const value = values.get(key);
      if (!value || value.kind !== 'asset') return null;
      return {
        body: value.body,
        contentType: value.contentType,
        createdAt: value.createdAt,
        accessToken: value.accessToken,
      };
    },
    async cleanupExpired(prefix, cutoff) {
      for (const [key, value] of values) {
        if (key.startsWith(prefix) && value.kind === 'asset' && value.createdAt < cutoff) values.delete(key);
      }
    },
  };
}

function runProcess(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim().slice(-1600) || `${command} 执行失败（退出码 ${code}）`));
    });
  });
}

async function probeVideoDimensions(filePath) {
  const probe = process.env.FFPROBE_PATH || 'ffprobe';
  return new Promise((resolvePromise, reject) => {
    const child = spawn(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', filePath], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      const [width, height] = stdout.trim().split('x').map(Number);
      if (code === 0 && Number.isFinite(width) && Number.isFinite(height)) resolvePromise({ width, height });
      else reject(new Error(stderr.trim() || '无法读取视频尺寸'));
    });
  });
}

async function composeLocalVideos(videoUrls, { targetDuration = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'short-video-compose-'));
  try {
    const files = [];
    for (const [index, url] of videoUrls.entries()) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`第 ${index + 1} 段视频下载失败`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength) throw new Error(`第 ${index + 1} 段视频为空`);
      const filePath = join(directory, `clip-${index + 1}.mp4`);
      await writeFile(filePath, bytes);
      files.push(filePath);
    }
    const source = await probeVideoDimensions(files[0]);
    const portrait = source.height > source.width;
    const target = portrait ? { width: 720, height: 1280 } : { width: 1280, height: 720 };
    const filters = files.map((_, index) => `[${index}:v]fps=30,scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`).join(';');
    const output = join(directory, 'final.mp4');
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    await runProcess(ffmpeg, [
      '-y', ...files.flatMap((filePath) => ['-i', filePath]),
      '-filter_complex', `${filters};${files.map((_, index) => `[v${index}]`).join('')}concat=n=${files.length}:v=1:a=0[video]`,
      '-map', '[video]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      ...(Number.isFinite(Number(targetDuration)) && Number(targetDuration) > 0 ? ['-t', String(Number(targetDuration))] : []),
      '-movflags', '+faststart', output,
    ]);
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function requestFromNode(request) {
  const method = request.method || 'GET';
  const origin = `http://${request.headers.host || '127.0.0.1:5173'}`;
  const init = { method, headers: request.headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(request);
    init.duplex = 'half';
  }
  return new Request(new URL(request.url || '/', origin), init);
}

async function respondToNode(response, nodeResponse) {
  const headers = Object.fromEntries(response.headers.entries());
  nodeResponse.writeHead(response.status, headers);
  if (!response.body) return nodeResponse.end();
  Readable.fromWeb(response.body).pipe(nodeResponse);
}

export async function createLocalServer({ root = process.cwd(), host = '127.0.0.1', port = 5173 } = {}) {
  loadLocalEnv(root);
  const storage = createMemoryStorage();
  const apiMiddleware = (request, response, next) => {
    if (!request.url?.startsWith('/api/')) return next();
    const runtime = {
      platform: 'local',
      getEnv: (key) => process.env[key] || '',
      storage,
      inlineReferenceImages: true,
      fetch: globalThis.fetch,
      clientId: request.socket.remoteAddress || 'local',
      composeVideos: composeLocalVideos,
      waitUntil: (promise) => Promise.resolve(promise).catch(() => undefined),
    };
    void handleVideoApiRequest(requestFromNode(request), runtime)
      .then((apiResponse) => apiResponse ? respondToNode(apiResponse, response) : next())
      .catch(next);
  };

  const vite = await createViteServer({
    root,
    server: { host, port, strictPort: true },
    plugins: [{ name: 'local-video-api', configureServer(server) { server.middlewares.use(apiMiddleware); } }],
  });

  await vite.listen();
  return vite;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.LOCAL_PORT) || 5173;
  const vite = await createLocalServer({ port });
  const hasProvider = Boolean(process.env.DASHSCOPE_API_KEY || process.env.AGNES_API_KEY || process.env.ZHIPU_API_KEY || process.env.SUB2API_API_KEY || process.env.SILICONFLOW_API_KEY);
  console.log(`真实服务已启动：${vite.resolvedUrls?.local?.[0] || `http://127.0.0.1:${port}/`}`);
  console.log(hasProvider
    ? '已读取本地服务密钥；生成请求将直接发送给对应供应商。'
    : '未发现服务密钥。请先在 .env 中配置至少一个供应商密钥。');
}

