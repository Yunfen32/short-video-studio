import { getStore } from "@netlify/blobs";

import { handleVideoApiRequest } from "../../shared/video-api.mjs";

function createStorage() {
  const state = getStore({ name: "video-platform-state", consistency: "strong" });
  const assets = getStore({ name: "video-reference-images", consistency: "strong" });

  return {
    getJSON(key) {
      return state.get(key, { type: "json" });
    },
    setJSON(key, value) {
      return state.setJSON(key, value);
    },
    async put(key, body, metadata = {}) {
      await assets.set(key, body, {
        metadata: {
          contentType: metadata.contentType || "application/octet-stream",
          createdAt: Number(metadata.createdAt) || Date.now(),
        },
      });
    },
    async get(key) {
      const result = await assets.getWithMetadata(key, { type: "arrayBuffer" });
      if (!result) return null;
      return {
        body: result.data,
        contentType: result.metadata?.contentType,
        createdAt: Number(result.metadata?.createdAt) || 0,
      };
    },
    async cleanupExpired(prefix, cutoff) {
      const { blobs } = await assets.list({ prefix });
      const candidates = blobs.slice(0, 100);
      await Promise.all(candidates.map(async ({ key }) => {
        const metadata = await assets.getMetadata(key);
        if (Number(metadata?.metadata?.createdAt) < cutoff) await assets.delete(key);
      }));
    },
  };
}

export default async function handler(request, context) {
  const response = await handleVideoApiRequest(request, {
    platform: "netlify",
    getEnv: (key) => globalThis.Netlify?.env?.get?.(key) || process.env[key] || "",
    storage: createStorage(),
    fetch: globalThis.fetch,
    clientId: context?.ip || "",
    waitUntil: context?.waitUntil?.bind(context),
  });
  return response || Response.json({ error: "未找到请求的接口" }, { status: 404 });
}

export const config = {
  path: [
    "/api/models",
    "/api/videos",
    "/api/videos/:taskId",
    "/api/reference-images",
    "/api/reference-images/:key",
    "/api/reference-images/*",
    "/api/video-download",
  ],
};
