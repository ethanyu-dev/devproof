import OpenAI from "openai";

import { runtimeConfig } from "./config.js";
import { ControlPlaneClient } from "./control-plane.client.js";
import { AgentRuntimeWorker } from "./worker.js";

const config = runtimeConfig();
const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
  ...(config.OPENAI_BASE_URL ? { baseURL: config.OPENAI_BASE_URL } : {}),
});
const controlPlane = new ControlPlaneClient(
  config.DEVPROOF_API_URL,
  config.DEVPROOF_AGENT_RUNTIME_TOKEN,
);
const worker = new AgentRuntimeWorker(config, controlPlane, openai);
const controller = new AbortController();

process.on("SIGINT", () => controller.abort());
process.on("SIGTERM", () => controller.abort());

await worker.run(controller.signal);
