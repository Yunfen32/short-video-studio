function assetRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return new Request(url, request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    if (!env?.ASSETS?.fetch) {
      return new Response("Not found", { status: 404 });
    }

    let response = await env.ASSETS.fetch(assetRequest(request, pathname));

    if (response.status === 404 && !pathname.includes(".")) {
      response = await env.ASSETS.fetch(assetRequest(request, "/index.html"));
    }

    return response;
  },
};
