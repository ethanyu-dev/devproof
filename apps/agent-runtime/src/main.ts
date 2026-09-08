import type { RuntimeModelCandidate } from "@devproof/agent-runtime-protocol";

import { runtimeConfig } from "./config.js";
import { ControlPlaneClient } from "./control-plane.client.js";
import {
  createModelFetch,
  parseModelHostAllowlist,
} from "./model-network-policy.js";
import { AgentRuntimeWorker } from "./worker.js";
import { createResponsesClient } from "./model-client.js";

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
  (candidate: RuntimeModelCandidate) =>
    createResponsesClient(candidate, modelFetch),
);
const controller = new AbortController();

process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

await worker.run(controller.signal);
