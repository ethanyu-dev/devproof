import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { RuntimeModelCandidate } from "@devproof/agent-runtime-protocol";

import { runtimeConfig } from "./config.js";
import { ControlPlaneClient } from "./control-plane.client.js";
import {
  createModelFetch,
  parseModelHostAllowlist,
} from "./model-network-policy.js";
import { AgentRuntimeWorker } from "./worker.js";
import type { ModelResponse } from "./browser-verification.executor.js";

const config = runtimeConfig();
const controlPlane = new ControlPlaneClient(
  config.DEVPROOF_API_URL,
  config.DEVPROOF_AGENT_RUNTIME_TOKEN,
  config.DEVPROOF_AGENT_RUNTIME_POOL,
);
const modelFetch = createModelFetch(
  parseModelHostAllowlist(config.DEVPROOF_AGENT_MODEL_HOST_ALLOWLIST),
);
const worker = new AgentRuntimeWorker(
  config,
  controlPlane,
  (candidate: RuntimeModelCandidate) => {
    const client = new OpenAI({
      apiKey: candidate.apiKey,
      baseURL: candidate.baseUrl,
      fetch: modelFetch,
    });
    return {
      responses: {
        create: async (request, options) => {
          const response = await client.responses.create(
            request as ResponseCreateParamsNonStreaming,
            options,
          );
          return {
            id: response.id,
            output: response.output as ModelResponse["output"],
            ...(response.usage
              ? {
                  usage: response.usage as unknown as Record<string, unknown>,
                }
              : {}),
          };
        },
      },
    };
  },
);
const controller = new AbortController();

process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

await worker.run(controller.signal);
