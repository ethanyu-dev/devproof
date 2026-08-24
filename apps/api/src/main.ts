import "reflect-metadata";

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Transform } from "node:stream";

import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { RUNTIME_MAX_FRAME_BYTES } from "@devproof/runtime-protocol";
import type WebSocket from "ws";

import { AppModule } from "./app.module.js";
import { env } from "./config/env.js";
import { RuntimeGatewayService } from "./runtime/runtime-gateway.service.js";
import { MetricsService } from "./observability/metrics.service.js";
import {
  ObservabilityService,
  redactText,
} from "./observability/observability.service.js";
import { JsonLogger } from "./observability/json-logger.js";

async function bootstrap() {
  const config = env();
  const adapter = new FastifyAdapter({
    bodyLimit: 1024 * 1024,
    genReqId: (request: IncomingMessage) => {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && supplied.length <= 200
        ? supplied
        : randomUUID();
    },
    logger: {
      level: config.OBSERVABILITY_LOG_LEVEL,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    },
    trustProxy: true,
  });
  const rawFastify = adapter.getInstance();
  await rawFastify.register(
    websocket as unknown as Parameters<typeof rawFastify.register>[0],
    { options: { maxPayload: RUNTIME_MAX_FRAME_BYTES } },
  );
  let runtimeGateway: RuntimeGatewayService | undefined;
  const websocketRoutes = rawFastify as unknown as {
    get: (
      path: string,
      options: { websocket: true },
      handler: (socket: WebSocket) => void,
    ) => void;
  };
  websocketRoutes.get("/runtime/connect", { websocket: true }, (socket) => {
    if (!runtimeGateway) {
      socket.close(1013, "Runtime Gateway is starting.");
      return;
    }
    runtimeGateway.accept(socket);
  });
  const jsonLogger = new JsonLogger(config.OBSERVABILITY_LOG_LEVEL);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    adapter,
    { logger: jsonLogger },
  );
  runtimeGateway = app.get(RuntimeGatewayService);
  const observability = app.get(ObservabilityService);
  jsonLogger.setContextProvider(() => {
    const current = observability.current();
    return current ? { ...current } : undefined;
  });
  const metrics = app.get(MetricsService);
  // @fastify/cookie augments FastifyInstance itself. Nest's generic register
  // signature sees the pre-augmentation instance, so keep the framework type
  // cast at this single boundary.
  await app.register(
    cookie as unknown as Parameters<NestFastifyApplication["register"]>[0],
  );
  app.enableCors({
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    origin: config.WEB_ORIGIN,
  });
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook("preParsing", (request, _reply, payload, done) => {
    if (!request.url.startsWith("/integrations/feishu/events")) {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    const capture = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        const bytes = Buffer.from(chunk);
        chunks.push(bytes);
        (
          capture as Transform & { receivedEncodedLength: number }
        ).receivedEncodedLength += bytes.byteLength;
        callback(null, chunk);
      },
      flush(callback) {
        (request as typeof request & { rawBody?: Buffer }).rawBody =
          Buffer.concat(chunks);
        callback();
      },
    }) as Transform & { receivedEncodedLength: number };
    capture.receivedEncodedLength = 0;
    done(null, payload.pipe(capture));
  });
  fastify.addHook("onRequest", (request, reply, done) => {
    const context = observability.root({
      requestId: request.id,
      ...(request.headers.traceparent
        ? { traceparent: request.headers.traceparent }
        : {}),
    });
    observability.run(context, () => {
      reply.header("traceparent", observability.traceparent(context));
      reply.header("x-request-id", context.requestId);
      done();
    });
  });
  fastify.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions.url ?? "unmatched";
    const labels = {
      method: request.method,
      route,
      status_class: `${Math.floor(reply.statusCode / 100)}xx`,
    };
    metrics.increment(
      "devproof_http_requests_total",
      "HTTP requests by method, route and status class.",
      labels,
    );
    metrics.observe(
      "devproof_http_request_duration_seconds",
      "HTTP request duration in seconds.",
      reply.elapsedTime / 1_000,
      { method: request.method, route },
    );
    done();
  });
  fastify.addHook("onError", (request, reply, error, done) => {
    observability.log(
      "error",
      "http.request.failed",
      {
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        statusCode: reply.statusCode,
      },
      error,
    );
    done();
  });
  fastify.addHook("onSend", (request, reply, payload, done) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    if (
      request.url.startsWith("/auth") ||
      request.url.startsWith("/console") ||
      request.url.startsWith("/v1") ||
      request.url.startsWith("/mcp")
    ) {
      reply.header("cache-control", "no-store");
    }
    done(null, payload);
  });
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, "0.0.0.0");
  Logger.log("DevProof API listening on port " + config.API_PORT, "Bootstrap");
}

void bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      error: redactText(error instanceof Error ? error.message : String(error)),
      event: "api.bootstrap.failed",
      level: "error",
      service: "devproof-api",
      timestamp: new Date().toISOString(),
    })}\n`,
  );
  process.exitCode = 1;
});
