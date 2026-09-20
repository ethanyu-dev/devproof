import { proxyPublicApiRequest } from "@/lib/public-api-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = proxyPublicApiRequest;
export const HEAD = proxyPublicApiRequest;
export const POST = proxyPublicApiRequest;
export const DELETE = proxyPublicApiRequest;
