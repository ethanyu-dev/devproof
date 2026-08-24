const DEFAULT_API_BASE_URL = "http://localhost:4433";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type StreamingRequestInit = RequestInit & { duplex?: "half" };

function removeConnectionHeaders(headers: Headers) {
  const connectionHeaders = headers.get("connection")?.split(",") ?? [];
  for (const name of connectionHeaders) {
    headers.delete(name.trim());
  }
  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }
}

function upstreamRequestHeaders(request: Request) {
  const headers = new Headers(request.headers);
  removeConnectionHeaders(headers);

  for (const name of [...headers.keys()]) {
    if (
      name.startsWith("cf-") ||
      name.startsWith("x-forwarded-") ||
      name === "cdn-loop" ||
      name === "forwarded" ||
      name === "host" ||
      name === "via" ||
      name === "x-real-ip"
    ) {
      headers.delete(name);
    }
  }

  // Node fetch transparently decompresses upstream responses. Requesting the
  // identity representation keeps the response headers and streamed body in
  // agreement when they are passed back to the browser.
  headers.set("accept-encoding", "identity");
  headers.delete("content-length");
  return headers;
}

function downstreamResponseHeaders(upstream: Response) {
  const headers = new Headers(upstream.headers);
  removeConnectionHeaders(headers);
  headers.delete("content-length");
  return headers;
}

function apiUrl(request: Request) {
  const incoming = new URL(request.url);
  const baseUrl = new URL(
    process.env.API_BASE_URL?.trim() || DEFAULT_API_BASE_URL,
  );
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("API_BASE_URL must use HTTP or HTTPS.");
  }
  return new URL(incoming.pathname + incoming.search, baseUrl);
}

export async function proxyApiRequest(request: Request) {
  try {
    const init: StreamingRequestInit = {
      cache: "no-store",
      headers: upstreamRequestHeaders(request),
      method: request.method,
      redirect: "manual",
      signal: request.signal,
    };

    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      init.body = request.body;
      init.duplex = "half";
    }

    const upstream = await fetch(apiUrl(request), init);
    return new Response(upstream.body, {
      headers: downstreamResponseHeaders(upstream),
      status: upstream.status,
      statusText: upstream.statusText,
    });
  } catch (error) {
    console.error("DevProof API proxy request failed", error);
    return Response.json(
      { message: "DevProof API is unavailable." },
      { status: 502 },
    );
  }
}
