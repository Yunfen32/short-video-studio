import { handleVideoApiRequest } from "../shared/video-api.mjs";

function assetRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return new Request(url, request);
}

function createStorage(bucket) {
  if (!bucket) return null;
  return {
    async getJSON(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      try {
        return JSON.parse(await object.text());
      } catch {
        return null;
      }
    },
    setJSON(key, value) {
      return bucket.put(key, JSON.stringify(value), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
      });
    },
    put(key, body, metadata = {}) {
      return bucket.put(key, body, {
        httpMetadata: { contentType: metadata.contentType || "application/octet-stream" },
        customMetadata: { createdAt: String(Number(metadata.createdAt) || Date.now()) },
      });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType,
        createdAt: Number(object.customMetadata?.createdAt) || 0,
      };
    },
    async cleanupExpired(prefix, cutoff) {
      const listing = await bucket.list({ prefix, limit: 100, include: ["customMetadata"] });
      const expired = listing.objects
        .filter((object) => Number(object.customMetadata?.createdAt) < cutoff)
        .map((object) => object.key);
      if (expired.length) await bucket.delete(expired);
    },
  };
}

export default {
  async fetch(request, env, context) {
    const apiResponse = await handleVideoApiRequest(request, {
      platform: "sites",
      getEnv: (key) => env?.[key] || "",
      storage: createStorage(env?.VIDEO_STORAGE),
      fetch: globalThis.fetch,
      clientId: request.headers.get("cf-connecting-ip") || "",
      waitUntil: context?.waitUntil?.bind(context),
    });
    if (apiResponse) return apiResponse;

    const url = new URL(request.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!env?.ASSETS?.fetch) return new Response("Not found", { status: 404 });

    let response = await env.ASSETS.fetch(assetRequest(request, pathname));
    if (response.status === 404 && !pathname.includes(".")) {
      response = await env.ASSETS.fetch(assetRequest(request, "/index.html"));
    }
    return response;
  },
};
