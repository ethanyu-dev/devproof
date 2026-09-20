import { proxyApiRequest } from "./api-proxy";

/** Public docs use explicit Bearer auth; never inherit the console session. */
export async function proxyPublicApiRequest(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  const response = await proxyApiRequest(new Request(request, { headers }));
  response.headers.delete("set-cookie");
  return response;
}
