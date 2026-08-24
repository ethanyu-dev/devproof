import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:4433";
  try {
    const response = await fetch(`${apiBaseUrl}/ready`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const ready = response.ok;
    const upstream = (await response.json().catch(() => null)) as {
      status?: string;
    } | null;
    const degraded = ready && upstream?.status === "DEGRADED";
    return NextResponse.json(
      {
        checks: {
          api: {
            durationMs: Date.now() - started,
            status: ready ? (degraded ? "DEGRADED" : "UP") : "DOWN",
          },
        },
        service: "devproof-web",
        status: ready ? (degraded ? "DEGRADED" : "READY") : "NOT_READY",
        timestamp: new Date().toISOString(),
      },
      { status: ready ? 200 : 503 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        checks: {
          api: {
            durationMs: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
            status: "DOWN",
          },
        },
        service: "devproof-web",
        status: "NOT_READY",
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
