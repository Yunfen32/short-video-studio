import http from 'node:http';
import { Readable } from 'node:stream';

const port = Number(process.env.BROWSER_FIXTURE_PORT) || 4174;
const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://127.0.0.1:4173';
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP8z8DAwMDAxMDAwMAAAAsAAQFhY7sAAAAASUVORK5CYII=',
  'base64',
);
let uploadCount = 0;
let pollCount = 0;
let imagePollCount = 0;
let lastVideoRequest = null;
let lastImageRequest = null;

function json(response, data, status = 200) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname === '/api/models') {
    json(response, {
      availableCount: 34,
      unavailable: [],
      accessRequired: false,
      accessConfigured: true,
      directAccess: true,
      checkedAt: Date.now(),
    });
    return;
  }
  if (url.pathname === '/__test__/state') {
    json(response, { pollCount, imagePollCount, lastVideoRequest, lastImageRequest });
    return;
  }
  if (url.pathname.startsWith('/mock/image-')) {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(pixel);
    return;
  }
  if (url.pathname === '/mock/result.mp4') {
    response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '0' });
    response.end();
    return;
  }
  if (url.pathname === '/mock/result.png') {
    response.writeHead(200, { 'content-type': 'image/png' });
    response.end(pixel);
    return;
  }
  if (url.pathname === '/api/reference-images' && request.method === 'POST') {
    for await (const _chunk of request) {
      // Drain the upload body so browser behavior matches a real endpoint.
    }
    uploadCount += 1;
    json(response, { url: `http://127.0.0.1:${port}/mock/image-${uploadCount}.png` }, 201);
    return;
  }
  if (url.pathname === '/api/videos' && request.method === 'POST') {
    lastVideoRequest = await readJson(request);
    pollCount = 0;
    json(response, {
      taskId: 'browser-task-12345678',
      videoId: 'browser-video-12345678',
      provider: 'agnes',
      modelId: lastVideoRequest.model,
      status: 'PENDING',
    }, 202);
    return;
  }
  if (url.pathname === '/api/images' && request.method === 'POST') {
    lastImageRequest = await readJson(request);
    imagePollCount = 0;
    json(response, {
      taskId: 'browser-image-task-12345678',
      provider: 'dashscope',
      modelId: lastImageRequest.model,
      status: 'PENDING',
    }, 202);
    return;
  }
  if (url.pathname === '/api/videos/browser-task-12345678') {
    pollCount += 1;
    if (pollCount === 1) {
      json(response, { taskId: 'browser-task-12345678', status: 'RUNNING', progress: 48, terminal: false });
      return;
    }
    json(response, {
      taskId: 'browser-task-12345678',
      status: 'SUCCEEDED',
      progress: 100,
      terminal: true,
      videoUrl: `http://127.0.0.1:${port}/mock/result.mp4`,
      size: '1280x720',
      seconds: '5.0',
    });
    return;
  }
  if (url.pathname === '/api/images/browser-image-task-12345678') {
    imagePollCount += 1;
    if (imagePollCount === 1) {
      json(response, { taskId: 'browser-image-task-12345678', status: 'RUNNING', progress: 48, terminal: false });
      return;
    }
    json(response, {
      taskId: 'browser-image-task-12345678',
      status: 'SUCCEEDED',
      progress: 100,
      terminal: true,
      imageUrls: [`http://127.0.0.1:${port}/mock/result.png`],
      size: '2K',
    });
    return;
  }
  if (url.pathname === '/api/video-download') {
    response.writeHead(200, {
      'content-disposition': 'attachment; filename="generated-video.mp4"',
      'content-type': 'video/mp4',
    });
    response.end('browser-fixture-video');
    return;
  }
  if (url.pathname === '/api/image-download') {
    response.writeHead(200, { 'content-disposition': 'attachment; filename="generated-image.png"', 'content-type': 'image/png' });
    response.end(pixel);
    return;
  }

  const upstream = await fetch(new URL(url.pathname + url.search, frontendOrigin), {
    method: request.method,
    headers: request.headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : Readable.toWeb(request),
    duplex: 'half',
  });
  response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
  else response.end();
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Browser fixture available at http://127.0.0.1:${port}`);
});
