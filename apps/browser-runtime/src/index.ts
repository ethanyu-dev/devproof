#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, hostname, platform, release } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_PROTOCOL,
  USER_PROFILE_INACTIVITY_TTL_SECONDS,
  runtimeCommandPayloadSchema,
  runtimeServerMessageSchema,
  type ReconcileAction,
  type BrowserHumanInputEvent,
  type RuntimeArtifactPayload,
  type RuntimeCommandType,
  type RuntimeHumanPreviewFrame,
  type RuntimeServerMessage,
} from "@devproof/runtime-protocol";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type FrameLocator,
  type Locator,
  type Page,
  type Response,
  type Route,
} from "playwright";

import { parseHostAllowlist } from "./ip-rules.js";
import { startSsrfProxy, type SsrfProxy } from "./ssrf-proxy.js";

interface PersistedSession {
  fencingToken: string;
  leaseToken: string;
  profileKey: string;
  profileMode: "PERSISTENT" | "EPHEMERAL";
  profileRetention?: UserProfileRetention;
  sessionId: string;
  state: "OPEN" | "HUMAN_CONTROL" | "INTERRUPTED";
}

interface UserProfileRetention {
  /** @deprecated Accepted and echoed only while rolling forward from v1.8. */
  allowedHostnamePatterns?: string[] | undefined;
  inactivityTtlSeconds: typeof USER_PROFILE_INACTIVITY_TTL_SECONDS;
  kind: "USER";
}

interface UserProfileMetadata extends UserProfileRetention {
  lastUsedAt: string;
  profileKey: string;
  schemaVersion: 2;
}

interface PendingProfileLifecycleEvent {
  eventId: string;
  kind: "PROFILE_EXPIRED";
  lastUsedAt: string;
  profileKey: string;
  purgedAt: string;
  type: "profile.lifecycle";
}

interface RuntimeState {
  apiUrl: string;
  gatewayUrl: string;
  runtimeId: string;
  runtimeToken: string;
  sessions: PersistedSession[];
}

interface LiveSession extends PersistedSession {
  browser?: Browser;
  consoleEntries: Array<Record<string, unknown>>;
  context: BrowserContext;
  networkEntries: Array<Record<string, unknown>>;
  pendingNetworkCaptures: Map<Promise<void>, string>;
  networkFaultHits: Array<{
    action: string;
    generation: string;
    hitAt: string;
    method: string;
    policyId: string;
    url: string;
  }>;
  networkFaultPolicies: Map<
    string,
    {
      action: "PAUSE" | "ABORT" | "FULFILL_STATUS";
      armedAt: string;
      generation: string;
      maxPauseMs?: number;
      method?: string;
      policyId: string;
      status?: number;
      urlPattern: string;
    }
  >;
  pausedRoutes: Map<string, Set<(released: boolean) => void>>;
  page: Page;
  pageIds: Map<Page, string>;
  pressedButtons: Set<"left" | "middle" | "right">;
  pressedKeys: Set<string>;
  stepFrames: StepFrame[];
  stepSequence: number;
}

interface StepFrame {
  capturedAt: string;
  commandType: string;
  data: Buffer;
  height: number;
  index: number;
  title: string;
  url: string;
  width: number;
}

interface RuntimeCommand {
  commandId: string;
  commandType: RuntimeCommandType;
  deadlineAt: string;
  fencingToken: string;
  leaseToken: string;
  payload: Record<string, unknown>;
  sessionId: string;
  type: "command.execute";
}

type BufferedRuntimeMessageType =
  | "command.result"
  | "human.input.result"
  | "runtime.event"
  | "profile.lifecycle";

export const runtimeVersion = packageVersion();
const stateDirectory =
  process.env.DEVPROOF_RUNTIME_HOME ??
  join(homedir(), ".devproof-browser-runtime");
const statePath = join(stateDirectory, "runtime.json");
const profileRoot = join(stateDirectory, "profiles");
const recordingRoot = join(stateDirectory, "recordings");
const USER_PROFILE_METADATA_FILE = ".devproof-user-profile.json";
const PROFILE_LIFECYCLE_FILE_PREFIX = ".devproof-profile-lifecycle-";
const PROFILE_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const DIRECT_CONTENT_MAX_BYTES = 256 * 1_024;
const INLINE_SCREENSHOT_MAX_BYTES = 1_250 * 1_024;
const RUNTIME_ARTIFACT_SAFE_MAX_BYTES = 9 * 1_024 * 1_024;
const MAX_RECORDED_STEP_FRAMES = 120;
const MAX_STEP_VIDEO_DURATION_MS = 45_000;
const MAX_STEP_VIDEO_FRAME_DURATION_MS = 750;
const STEP_SCREENSHOT_COMMANDS = new Set<RuntimeCommandType>([
  "page.open",
  "page.navigate",
  "page.back",
  "page.forward",
  "page.reload",
  "page.click",
  "page.fill",
  "page.type",
  "page.press",
  "page.check",
  "page.uncheck",
  "page.select",
  "page.scroll",
  "page.hover",
  "page.drag",
  "page.resize",
  "page.wait",
  "tab.new",
  "tab.switch",
  "tab.close",
  "frame.click",
  "frame.fill",
  "human.release",
]);
const OBSERVED_ENTRY_MAX_BYTES = 64 * 1_024;
const OBSERVED_URL_MAX_BYTES = 4_000;
const NETWORK_RESPONSE_BODY_MAX_BYTES = 64 * 1_024;
const NETWORK_RESPONSE_BODY_MAX_ENTRIES = 32;
const NETWORK_RESPONSE_BODY_READ_LIMIT = 256 * 1_024;
const SENSITIVE_KEY =
  /(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|credential|session(?:id)?)$/iu;

function packageVersion() {
  const metadata = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new Error("Browser Runtime package version is unavailable.");
  }
  return metadata.version;
}

function runtimeLog(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
  error?: unknown,
) {
  const configuredLevel = process.env.OBSERVABILITY_LOG_LEVEL ?? "info";
  const priority = { debug: 10, info: 20, warn: 30, error: 40 } as const;
  const minimum =
    configuredLevel in priority
      ? priority[configuredLevel as keyof typeof priority]
      : priority.info;
  if (priority[level] < minimum) return;
  const record = {
    event,
    level,
    service: "devproof-browser-runtime",
    timestamp: new Date().toISOString(),
    ...(redactValue(fields) as Record<string, unknown>),
    ...(error
      ? {
          error: {
            message: redactText(
              error instanceof Error ? error.message : String(error),
            ),
          },
        }
      : {}),
  };
  const stream =
    level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(record)}\n`);
}

type RuntimeLocator =
  { ref: string } | { frameSelector?: string | undefined; selector: string };

function codedError(code: string, message: string, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

export async function purgePersistentProfileDirectory(
  root: string,
  profileKey: string,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(profileKey)) {
    throw codedError(
      "PROFILE_KEY_INVALID",
      "Persistent profile key is invalid.",
    );
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const profilePath = join(root, profileKey);
  const tombstonePath = join(root, `.purge-${profileKey}`);
  await rm(tombstonePath, { force: true, recursive: true });
  let existed = true;
  try {
    await rename(profilePath, tombstonePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
  }
  await rm(tombstonePath, { force: true, recursive: true });
  return { existed, profileKey, purged: true };
}

function validProfileKey(profileKey: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(profileKey);
}

function profileKeyFingerprint(profileKey: string) {
  return createHash("sha256").update(profileKey).digest("hex").slice(0, 12);
}

export async function touchUserProfileMetadata(
  root: string,
  profileKey: string,
  lastUsedAt = new Date(),
) {
  if (!validProfileKey(profileKey)) {
    throw codedError(
      "PROFILE_KEY_INVALID",
      "Persistent profile key is invalid.",
    );
  }
  const profilePath = join(root, profileKey);
  await mkdir(profilePath, { recursive: true, mode: 0o700 });
  const metadata: UserProfileMetadata = {
    inactivityTtlSeconds: USER_PROFILE_INACTIVITY_TTL_SECONDS,
    kind: "USER",
    lastUsedAt: lastUsedAt.toISOString(),
    profileKey,
    schemaVersion: 2,
  };
  const target = join(profilePath, USER_PROFILE_METADATA_FILE);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(metadata), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
  return metadata;
}

function parseUserProfileMetadata(value: unknown): UserProfileMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    ![1, 2].includes(record.schemaVersion as number) ||
    record.kind !== "USER" ||
    (record.schemaVersion === 1 &&
      !Array.isArray(record.allowedHostnamePatterns)) ||
    record.inactivityTtlSeconds !== USER_PROFILE_INACTIVITY_TTL_SECONDS ||
    typeof record.profileKey !== "string" ||
    !validProfileKey(record.profileKey) ||
    typeof record.lastUsedAt !== "string" ||
    !Number.isFinite(Date.parse(record.lastUsedAt))
  ) {
    return null;
  }
  return {
    inactivityTtlSeconds: USER_PROFILE_INACTIVITY_TTL_SECONDS,
    kind: "USER",
    lastUsedAt: record.lastUsedAt as string,
    profileKey: record.profileKey as string,
    schemaVersion: 2,
  };
}

export async function cleanupExpiredUserProfiles(
  root: string,
  activeProfileKeys: ReadonlySet<string>,
  now = new Date(),
  reserveProfileKey?: (profileKey: string) => (() => void) | null,
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const purged: PendingProfileLifecycleEvent[] = [];
  for (const pending of await readPendingProfileLifecycleEvents(root)) {
    if (activeProfileKeys.has(pending.profileKey)) continue;
    const release = reserveProfileKey?.(pending.profileKey);
    if (reserveProfileKey && !release) continue;
    try {
      await purgePersistentProfileDirectory(root, pending.profileKey);
      purged.push(pending);
    } finally {
      release?.();
    }
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".purge-")) {
      await rm(join(root, entry.name), { force: true, recursive: true });
      continue;
    }
    if (!validProfileKey(entry.name) || activeProfileKeys.has(entry.name)) {
      continue;
    }
    let metadata: UserProfileMetadata | null = null;
    try {
      metadata = parseUserProfileMetadata(
        JSON.parse(
          await readFile(
            join(root, entry.name, USER_PROFILE_METADATA_FILE),
            "utf8",
          ),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        runtimeLog(
          "warn",
          "runtime.profile.metadata_invalid",
          { profileFingerprint: profileKeyFingerprint(entry.name) },
          error,
        );
      }
      continue;
    }
    if (!metadata || metadata.profileKey !== entry.name) continue;
    const expiresAt =
      Date.parse(metadata.lastUsedAt) + metadata.inactivityTtlSeconds * 1_000;
    if (expiresAt > now.getTime()) continue;
    if (purged.some((event) => event.profileKey === entry.name)) continue;
    const release = reserveProfileKey?.(entry.name);
    if (reserveProfileKey && !release) continue;
    const event: PendingProfileLifecycleEvent = {
      eventId: randomUUID(),
      kind: "PROFILE_EXPIRED",
      lastUsedAt: metadata.lastUsedAt,
      profileKey: entry.name,
      purgedAt: now.toISOString(),
      type: "profile.lifecycle",
    };
    try {
      await persistProfileLifecycleEvent(root, event);
      await purgePersistentProfileDirectory(root, entry.name);
      purged.push(event);
    } finally {
      release?.();
    }
  }
  return purged;
}

export async function readPendingProfileLifecycleEvents(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await readdir(root, { withFileTypes: true });
  const events: PendingProfileLifecycleEvent[] = [];
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(PROFILE_LIFECYCLE_FILE_PREFIX) ||
      !entry.name.endsWith(".json")
    ) {
      continue;
    }
    try {
      const value = JSON.parse(
        await readFile(join(root, entry.name), "utf8"),
      ) as Record<string, unknown>;
      if (
        typeof value.eventId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(value.eventId) &&
        value.kind === "PROFILE_EXPIRED" &&
        typeof value.lastUsedAt === "string" &&
        Number.isFinite(Date.parse(value.lastUsedAt)) &&
        typeof value.profileKey === "string" &&
        validProfileKey(value.profileKey) &&
        typeof value.purgedAt === "string" &&
        Number.isFinite(Date.parse(value.purgedAt)) &&
        value.type === "profile.lifecycle"
      ) {
        events.push(value as unknown as PendingProfileLifecycleEvent);
      }
    } catch (error) {
      runtimeLog(
        "warn",
        "runtime.profile.lifecycle_file_invalid",
        { fileName: entry.name },
        error,
      );
    }
  }
  return events.sort((left, right) =>
    left.purgedAt.localeCompare(right.purgedAt),
  );
}

export async function assertUserProfileCanOpen(
  root: string,
  profileKey: string,
) {
  const pending = await readPendingProfileLifecycleEvents(root);
  if (pending.some((event) => event.profileKey === profileKey)) {
    throw codedError(
      "PROFILE_EXPIRED",
      "The user Browser Profile expired and must be prepared again.",
    );
  }
}

async function persistProfileLifecycleEvent(
  root: string,
  event: PendingProfileLifecycleEvent,
) {
  const target = profileLifecyclePath(root, event.eventId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(event), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

export function removePendingProfileLifecycleEvent(
  root: string,
  eventId: string,
) {
  return rm(profileLifecyclePath(root, eventId), { force: true });
}

function profileLifecyclePath(root: string, eventId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(eventId)) {
    throw new Error("Profile lifecycle event id is invalid.");
  }
  return join(root, `${PROFILE_LIFECYCLE_FILE_PREFIX}${eventId}.json`);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (
        SENSITIVE_KEY.test(key) ||
        /(?:secret|token|credential)/iu.test(key)
      ) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactText(value: string): string {
  return value
    .replace(
      /\b(authorization|cookie|set-cookie)\s*([:=])\s*[^\r\n]*/giu,
      "$1$2 [REDACTED]",
    )
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+/=-]+/giu, "$1 [REDACTED]")
    .replace(
      /\b(password|passwd|secret|session(?:id)?|(?:access[_-]?)?token|api[-_]?key)(\s*[=:]\s*|["']?\s*:\s*["'])([^\s,;&"'<>}]+)/giu,
      "$1$2[REDACTED]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => redactUrl(candidate));
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item),
      ]),
    );
  }
  return value;
}

export function sanitizeDom(value: string): string {
  return redactText(value)
    .replace(/<input\b[^>]*>/giu, (tag) =>
      /\b(?:type\s*=\s*(?:["']password["']|password\b)|(?:name|id|autocomplete)\s*=\s*(?:["'][^"']*(?:password|passwd|secret|token)[^"']*["']|[^\s>]*(?:password|passwd|secret|token)[^\s>]*))/iu.test(
        tag,
      )
        ? tag.replace(
            /\bvalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/giu,
            'value="[REDACTED]"',
          )
        : tag,
    )
    .replace(
      /(<textarea\b[^>]*(?:name|id|autocomplete)\s*=\s*(?:["'][^"']*(?:password|passwd|secret|token)[^"']*["']|[^\s>]*(?:password|passwd|secret|token)[^\s>]*)[^>]*>)[\s\S]*?(<\/textarea>)/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /(\b(?:authorization|cookie|password|secret|session(?:id)?|token|api[-_]?key)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]*)/giu,
      '$1"[REDACTED]"',
    );
}

async function serializePageDom(page: Page) {
  const documentContent = await page.content();
  const shadowRoots = await page.evaluate(() => {
    const result: Array<{ host: string; html: string }> = [];
    const describe = (element: Element) => {
      const id = element.getAttribute("id");
      const name = element.getAttribute("name");
      const dataId = element.getAttribute("data-wujie-id");
      return [
        element.tagName.toLowerCase(),
        id ? `#${id}` : "",
        name ? `[name=${name}]` : "",
        dataId ? `[data-wujie-id=${dataId}]` : "",
      ].join("");
    };
    const visit = (root: Document | ShadowRoot) => {
      for (const element of Array.from(root.querySelectorAll("*"))) {
        if (!element.shadowRoot) continue;
        result.push({
          host: describe(element),
          html: element.shadowRoot.innerHTML,
        });
        visit(element.shadowRoot);
      }
    };
    visit(document);
    return result;
  });
  if (shadowRoots.length === 0) {
    return { content: documentContent, shadowRootCount: 0 };
  }
  const serialized = shadowRoots
    .map(
      (root) =>
        `<template data-devproof-shadow-root="${escapeHtmlAttribute(root.host)}">${root.html}</template>`,
    )
    .join("\n");
  return {
    content: `${documentContent}\n<!-- DEVPROOF_OPEN_SHADOW_ROOTS -->\n${serialized}`,
    shadowRootCount: shadowRoots.length,
  };
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function withoutResponseBody(entry: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(entry).filter(
      ([key]) =>
        !key.startsWith("responseBody") && key !== "responseContentType",
    ),
  );
}

function trimNetworkResponseBodies(entries: Array<Record<string, unknown>>) {
  let retained = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!("responseBody" in entry)) continue;
    retained += 1;
    if (retained <= NETWORK_RESPONSE_BODY_MAX_ENTRIES) continue;
    delete entry.responseBody;
    delete entry.responseBodyOriginalByteSize;
    delete entry.responseBodyTruncated;
    delete entry.responseContentType;
    entry.responseBodyOmitted = "retention_limit";
  }
}

export function boundedUtf8Buffer(value: string, maxBytes: number) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return {
      data: encoded,
      originalByteSize: encoded.byteLength,
      truncated: false,
    };
  }
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return {
    data: encoded.subarray(0, end),
    originalByteSize: encoded.byteLength,
    truncated: true,
  };
}

function boundedUtf8Text(value: string, maxBytes: number): string {
  return boundedUtf8Buffer(value, maxBytes).data.toString("utf8");
}

function safeObservedUrl(value: string): string {
  return boundedUtf8Text(redactText(value), OBSERVED_URL_MAX_BYTES);
}

export function boundedJsonArray(
  values: unknown[],
  maxBytes = RUNTIME_ARTIFACT_SAFE_MAX_BYTES,
) {
  const parts: string[] = [];
  let byteSize = 2;
  for (const value of values) {
    const part = JSON.stringify(value);
    const additionalBytes =
      Buffer.byteLength(part) + (parts.length > 0 ? 1 : 0);
    if (byteSize + additionalBytes > maxBytes) break;
    parts.push(part);
    byteSize += additionalBytes;
  }
  const content = `[${parts.join(",")}]`;
  return {
    content,
    data: Buffer.from(content, "utf8"),
    includedItems: parts.length,
    truncated: parts.length < values.length,
  };
}

function pageText(
  text: string,
  input: {
    cursor?: number | undefined;
    maxChars?: number | undefined;
  },
) {
  const cursor = input.cursor ?? 0;
  const maxChars = Math.min(
    input.maxChars ?? 96 * 1_024,
    DIRECT_CONTENT_MAX_BYTES,
  );
  const content = text.slice(cursor, cursor + maxChars);
  const nextCursor = cursor + content.length;
  return {
    content,
    cursor,
    nextCursor: nextCursor < text.length ? nextCursor : null,
    totalChars: text.length,
    truncated: nextCursor < text.length,
  };
}

function remainingTimeout(command: RuntimeCommand): number {
  return Math.max(1, new Date(command.deadlineAt).getTime() - Date.now());
}

function matchesUrlPattern(url: string, pattern: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "u").test(url);
}

function classifyCommandError(
  error: unknown,
  commandType: RuntimeCommandType,
  cancelled: boolean,
) {
  const typed = error as Error & { code?: string; retryable?: boolean };
  if (typed.code) {
    return {
      code: typed.code,
      message: typed.message,
      retryable: typed.retryable ?? false,
    };
  }
  const message = typed.message || "Browser command failed.";
  if (cancelled) return { code: "CANCELLED", message, retryable: false };
  if (
    /target page, context or browser has been closed|page closed/iu.test(
      message,
    )
  ) {
    return { code: "STALE_PAGE", message, retryable: true };
  }
  if (
    /frame was detached|frame .*not found|failed to find frame/iu.test(message)
  ) {
    return { code: "FRAME_NOT_FOUND", message, retryable: true };
  }
  if (
    /ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|403 Forbidden/iu.test(
      message,
    )
  ) {
    return { code: "NETWORK_BLOCKED", message, retryable: false };
  }
  if (typed.name === "TimeoutError" || /timeout.*exceeded/iu.test(message)) {
    return {
      code: [
        "page.open",
        "page.navigate",
        "page.back",
        "page.forward",
        "page.reload",
      ].includes(commandType)
        ? "NAVIGATION_TIMEOUT"
        : commandType === "page.wait"
          ? "WAIT_TIMEOUT"
          : "ACTION_TIMEOUT",
      message,
      retryable: true,
    };
  }
  return { code: "COMMAND_FAILED", message, retryable: false };
}

function argument(name: string, argv = process.argv): string | undefined {
  const index = argv.indexOf("--" + name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function pairingTokenFromInputs(
  argv: string[],
  input: Readable,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (argv.includes("--token-stdin")) {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      input.setEncoding("utf8");
      input.on("data", (chunk: string) => {
        value += chunk;
      });
      input.once("end", () => resolve(value.trimEnd()));
      input.once("error", reject);
    });
  }
  return argument("token", argv) ?? environment.DEVPROOF_PAIRING_TOKEN;
}

function maxConcurrency() {
  const value = Number(process.env.DEVPROOF_MAX_CONCURRENCY ?? "1");
  if (!Number.isInteger(value) || value < 1 || value > 32) {
    throw new Error(
      "DEVPROOF_MAX_CONCURRENCY must be an integer from 1 to 32.",
    );
  }
  return value;
}

function stringPayload(payload: Record<string, unknown>, key: string): string;
function stringPayload(
  payload: Record<string, unknown>,
  key: string,
  required: false,
): string | undefined;
function stringPayload(
  payload: Record<string, unknown>,
  key: string,
  required = true,
): string | undefined {
  const value = payload[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (!required) {
    return undefined;
  }
  throw new Error("Command payload requires a non-empty " + key + ".");
}

class StateStore {
  constructor(private state: RuntimeState) {}

  static async load() {
    let serialized: string;
    try {
      serialized = await readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "Browser Runtime is not paired. Open DevProof Console > 接入配置 > 浏览器执行节点, select 注册, run the generated pair command, then start again. Expected state file: " +
            statePath,
        );
      }
      throw error;
    }
    const state = JSON.parse(serialized) as RuntimeState;
    state.sessions ??= [];
    state.sessions = state.sessions.map((session) => ({
      ...session,
      state: "INTERRUPTED",
    }));
    return new StateStore(state);
  }

  value() {
    return this.state;
  }

  async replaceSession(session: PersistedSession) {
    this.state.sessions = this.state.sessions.filter(
      (row) => row.sessionId !== session.sessionId,
    );
    this.state.sessions.push(session);
    await this.save();
  }

  async removeSession(sessionId: string) {
    this.state.sessions = this.state.sessions.filter(
      (row) => row.sessionId !== sessionId,
    );
    await this.save();
  }

  async save() {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = statePath + "." + process.pid + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(this.state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, statePath);
  }
}

export class BrowserSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly openingProfileKeys = new Set<string>();
  private profileCleanupTimer: NodeJS.Timeout | undefined;
  private readonly previewStreams = new Map<
    string,
    {
      capturing: boolean;
      consecutiveFailures: number;
      sessionId: string;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly store: StateStore,
    private readonly proxyServer: string,
    private readonly emitEvent: (
      session: LiveSession,
      kind:
        | "PAGE_CHANGED"
        | "CONSOLE_ERROR"
        | "NETWORK_ERROR"
        | "NETWORK_FAULT_HIT"
        | "HUMAN_INPUT"
        | "SESSION_INTERRUPTED",
      payload: Record<string, unknown>,
    ) => void,
    private readonly emitPreview: (frame: RuntimeHumanPreviewFrame) => void,
    private readonly emitProfileLifecycle: (
      event: PendingProfileLifecycleEvent,
    ) => void = () => undefined,
  ) {}

  startProfileCleanup() {
    if (this.profileCleanupTimer) return;
    void this.cleanupExpiredProfiles();
    this.profileCleanupTimer = setInterval(
      () => void this.cleanupExpiredProfiles(),
      PROFILE_CLEANUP_INTERVAL_MS,
    );
    this.profileCleanupTimer.unref();
  }

  stopProfileCleanup() {
    if (this.profileCleanupTimer) clearInterval(this.profileCleanupTimer);
    this.profileCleanupTimer = undefined;
  }

  async cleanupExpiredProfiles(now = new Date()) {
    const active = new Set(this.openingProfileKeys);
    for (const session of this.store.value().sessions) {
      if (session.profileMode === "PERSISTENT") {
        active.add(session.profileKey);
      }
    }
    for (const session of this.sessions.values()) {
      if (session.profileMode === "PERSISTENT") {
        active.add(session.profileKey);
      }
    }
    try {
      const purged = await cleanupExpiredUserProfiles(
        profileRoot,
        active,
        now,
        (profileKey) => {
          if (
            this.openingProfileKeys.has(profileKey) ||
            Array.from(this.sessions.values()).some(
              (session) =>
                session.profileMode === "PERSISTENT" &&
                session.profileKey === profileKey,
            )
          ) {
            return null;
          }
          this.openingProfileKeys.add(profileKey);
          return () => this.openingProfileKeys.delete(profileKey);
        },
      );
      for (const event of purged) {
        runtimeLog("info", "runtime.profile.expired", {
          eventId: event.eventId,
          kind: event.kind,
          lastUsedAt: event.lastUsedAt,
          profileFingerprint: profileKeyFingerprint(event.profileKey),
          purgedAt: event.purgedAt,
        });
        this.emitProfileLifecycle(event);
      }
      return purged;
    } catch (error) {
      runtimeLog("error", "runtime.profile.cleanup_failed", {}, error);
      return [];
    }
  }

  descriptors() {
    return Array.from(this.sessions.values()).map((session) =>
      this.descriptor(session),
    );
  }

  async applyReconcile(actions: ReconcileAction[]) {
    for (const action of actions) {
      if (action.action === "CLOSE_LOCAL") {
        await this.close(action.sessionId);
        continue;
      }
      if (action.action === "ADOPT") {
        const session = this.sessions.get(action.sessionId);
        if (session) {
          session.fencingToken = action.fencingToken;
          session.leaseToken = action.leaseToken;
          await this.store.replaceSession(this.descriptor(session));
        }
        continue;
      }
      await this.open({
        fencingToken: action.fencingToken,
        leaseToken: action.leaseToken,
        profileKey: action.profileKey,
        profileMode: action.profileMode,
        ...(action.profileRetention
          ? { profileRetention: action.profileRetention }
          : {}),
        sessionId: action.sessionId,
        state: "OPEN",
      });
    }
  }

  async execute(command: RuntimeCommand) {
    const result = (await this.executeCommand(command)) ?? {};
    if (!STEP_SCREENSHOT_COMMANDS.has(command.commandType)) return result;
    try {
      const stepArtifact = await this.captureStepArtifact(
        command.sessionId,
        command.commandType,
      );
      if (!stepArtifact) return result;
      const artifacts = (result as { artifacts?: RuntimeArtifactPayload[] })
        .artifacts;
      return {
        ...result,
        artifacts: [
          ...(Array.isArray(artifacts) ? artifacts : []),
          stepArtifact,
        ],
      };
    } catch (error) {
      runtimeLog(
        "warn",
        "runtime.step_screenshot.capture_failed",
        {
          commandId: command.commandId,
          commandType: command.commandType,
          sessionId: command.sessionId,
        },
        error,
      );
      return result;
    }
  }

  private async executeCommand(command: RuntimeCommand) {
    if (new Date(command.deadlineAt).getTime() <= Date.now()) {
      throw Object.assign(new Error("Command deadline already expired."), {
        code: "DEADLINE_EXPIRED",
      });
    }
    if (command.commandType === "session.open") {
      const parsed = runtimeCommandPayloadSchema.parse({
        commandType: command.commandType,
        payload: command.payload,
      });
      if (parsed.commandType !== "session.open") {
        throw codedError("COMMAND_FAILED", "Invalid session open payload.");
      }
      const profileMode = parsed.payload.profileMode;
      if (profileMode !== "PERSISTENT" && profileMode !== "EPHEMERAL") {
        throw new Error("profileMode must be PERSISTENT or EPHEMERAL.");
      }
      const session = await this.open({
        fencingToken: command.fencingToken,
        leaseToken: command.leaseToken,
        profileKey: parsed.payload.profileKey,
        profileMode,
        ...(parsed.payload.profileRetention
          ? { profileRetention: parsed.payload.profileRetention }
          : {}),
        sessionId: command.sessionId,
        state: "OPEN",
      });
      return { result: { url: safeObservedUrl(session.page.url()) } };
    }

    if (command.commandType === "profile.purge") {
      const parsed = runtimeCommandPayloadSchema.parse({
        commandType: command.commandType,
        payload: command.payload,
      });
      if (parsed.commandType !== "profile.purge") {
        throw codedError("COMMAND_FAILED", "Invalid profile purge payload.");
      }
      return {
        result: await this.purgeProfile(parsed.payload.profileKey),
      };
    }

    const session = this.sessions.get(command.sessionId);
    if (!session) {
      throw codedError("SESSION_LOST", "Runtime session is not open.", true);
    }
    if (
      session.leaseToken !== command.leaseToken ||
      session.fencingToken !== command.fencingToken
    ) {
      throw codedError(
        "SESSION_LOST",
        "Runtime command owns a stale session lease.",
        true,
      );
    }

    const parsed = runtimeCommandPayloadSchema.parse({
      commandType: command.commandType,
      payload: command.payload,
    });
    const timeout = remainingTimeout(command);
    switch (parsed.commandType) {
      case "session.close": {
        const finalScreenshot = await this.captureStepArtifact(
          command.sessionId,
          "session.complete",
        ).catch((error: unknown) => {
          runtimeLog(
            "warn",
            "runtime.step_screenshot.final_capture_failed",
            { sessionId: command.sessionId },
            error,
          );
          return null;
        });
        const video = await this.composeStepVideo(session).catch(
          (error: unknown) => {
            runtimeLog(
              "warn",
              "runtime.step_video.compose_failed",
              { sessionId: command.sessionId },
              error,
            );
            return null;
          },
        );
        const frameCount = session.stepFrames.length;
        await this.close(command.sessionId);
        return {
          artifacts: [finalScreenshot, video].filter(
            (artifact): artifact is RuntimeArtifactPayload => artifact !== null,
          ),
          result: {
            closed: true,
            stepFrameCount: frameCount,
            videoCreated: video !== null,
          },
        };
      }
      case "page.open":
      case "page.navigate": {
        const response = await session.page.goto(parsed.payload.url, {
          timeout,
          waitUntil: parsed.payload.waitUntil ?? "domcontentloaded",
        });
        return {
          result: {
            status: response?.status() ?? null,
            title: boundedUtf8Text(await session.page.title(), 1_000),
            url: safeObservedUrl(session.page.url()),
          },
        };
      }
      case "page.back":
      case "page.forward":
      case "page.reload": {
        const options = {
          timeout,
          waitUntil: parsed.payload.waitUntil ?? "domcontentloaded",
        } as const;
        const response =
          parsed.commandType === "page.back"
            ? await session.page.goBack(options)
            : parsed.commandType === "page.forward"
              ? await session.page.goForward(options)
              : await session.page.reload(options);
        return {
          result: {
            status: response?.status() ?? null,
            title: boundedUtf8Text(await session.page.title(), 1_000),
            url: safeObservedUrl(session.page.url()),
          },
        };
      }
      case "page.snapshot": {
        const locator = parsed.payload.target
          ? this.locator(session, parsed.payload.target)
          : session.page.locator("body").first();
        if (parsed.payload.target) {
          const count = await locator.count();
          if (count === 0) {
            throw codedError(
              "ELEMENT_NOT_FOUND",
              "Snapshot target was not found.",
              true,
            );
          }
          if (count > 1) {
            throw codedError(
              "LOCATOR_AMBIGUOUS",
              `Snapshot target matched ${count} elements; use a more precise selector.`,
            );
          }
        }
        const snapshot = redactText(
          await locator.ariaSnapshot({
            boxes: parsed.payload.includeBoxes ?? false,
            depth: parsed.payload.depth ?? 12,
            mode: "ai",
            timeout,
          }),
        );
        return {
          result: {
            ...pageText(snapshot, parsed.payload),
            title: boundedUtf8Text(await session.page.title(), 1_000),
            url: safeObservedUrl(session.page.url()),
          },
        };
      }
      case "page.get_text": {
        const text = redactText(
          parsed.payload.target
            ? await this.locator(session, parsed.payload.target).innerText({
                timeout,
              })
            : await session.page.locator("body").first().innerText({ timeout }),
        );
        return {
          result: {
            ...pageText(text, parsed.payload),
            url: safeObservedUrl(session.page.url()),
          },
        };
      }
      case "page.get_url":
        return { result: { url: safeObservedUrl(session.page.url()) } };
      case "page.get_title":
        return {
          result: {
            title: boundedUtf8Text(
              await session.page.title(),
              DIRECT_CONTENT_MAX_BYTES,
            ),
          },
        };
      case "page.errors": {
        const kind = parsed.payload.kind ?? "ALL";
        const consoleErrors = session.consoleEntries.filter(
          (entry) => entry.type === "error",
        );
        const networkErrors = session.networkEntries.filter(
          (entry) =>
            "errorText" in entry ||
            (typeof entry.status === "number" && entry.status >= 400),
        );
        const all = [
          ...(kind === "NETWORK" ? [] : consoleErrors),
          ...(kind === "CONSOLE" ? [] : networkErrors),
        ];
        const cursor = parsed.payload.cursor ?? 0;
        const requestedEntries = all.slice(
          cursor,
          cursor + (parsed.payload.maxItems ?? 100),
        );
        const bounded = boundedJsonArray(
          requestedEntries,
          DIRECT_CONTENT_MAX_BYTES,
        );
        const entries = requestedEntries.slice(0, bounded.includedItems);
        const nextCursor = cursor + entries.length;
        return {
          result: {
            entries: redactValue(entries),
            nextCursor: nextCursor < all.length ? nextCursor : null,
            total: all.length,
            truncated: nextCursor < all.length,
          },
        };
      }
      case "page.screenshot": {
        const format = parsed.payload.format ?? "jpeg";
        const data = await this.screenshot(session.page, {
          format,
          fullPage: parsed.payload.fullPage ?? false,
          quality: parsed.payload.quality ?? 70,
        });
        const contentType = format === "png" ? "image/png" : "image/jpeg";
        return {
          artifacts: [
            this.artifact("SCREENSHOT", contentType, data, {
              inlineEligible: data.byteLength <= INLINE_SCREENSHOT_MAX_BYTES,
              url: safeObservedUrl(session.page.url()),
            }),
          ],
          result: {
            byteSize: data.byteLength,
            contentType,
            url: safeObservedUrl(session.page.url()),
          },
        };
      }
      case "page.dom": {
        const serialized = await serializePageDom(session.page);
        const content = sanitizeDom(serialized.content);
        const bounded = boundedUtf8Buffer(
          content,
          RUNTIME_ARTIFACT_SAFE_MAX_BYTES,
        );
        return {
          artifacts: [
            this.artifact("DOM", "text/html; charset=utf-8", bounded.data, {
              originalByteSize: bounded.originalByteSize,
              shadowRootCount: serialized.shadowRootCount,
              truncated: bounded.truncated,
              url: safeObservedUrl(session.page.url()),
            }),
          ],
          result: {
            ...pageText(content, parsed.payload),
            url: safeObservedUrl(session.page.url()),
          },
        };
      }
      case "page.console": {
        const bounded = boundedJsonArray(
          redactValue(session.consoleEntries) as unknown[],
        );
        return {
          artifacts: [
            this.artifact("CONSOLE", "application/json", bounded.data, {
              count: session.consoleEntries.length,
              includedItems: bounded.includedItems,
              truncated: bounded.truncated,
            }),
          ],
          result: {
            count: session.consoleEntries.length,
            includedItems: bounded.includedItems,
            ...pageText(bounded.content, parsed.payload),
          },
        };
      }
      case "page.network": {
        if (parsed.payload.includeResponseBodies) {
          await this.waitForNetworkResponseBodies(
            session,
            parsed.payload.urlIncludes,
          );
        }
        const selected = session.networkEntries
          .filter(
            (entry) =>
              !parsed.payload.urlIncludes ||
              (typeof entry.url === "string" &&
                entry.url.includes(parsed.payload.urlIncludes)),
          )
          .map((entry) =>
            parsed.payload.includeResponseBodies
              ? entry
              : withoutResponseBody(entry),
          );
        const bounded = boundedJsonArray(redactValue(selected) as unknown[]);
        const responseBodyCount = selected.filter(
          (entry) => "responseBody" in entry,
        ).length;
        return {
          artifacts: [
            this.artifact("NETWORK", "application/json", bounded.data, {
              count: selected.length,
              includedItems: bounded.includedItems,
              responseBodyCount,
              truncated: bounded.truncated,
              urlIncludes: parsed.payload.urlIncludes ?? null,
            }),
          ],
          result: {
            count: selected.length,
            includedItems: bounded.includedItems,
            responseBodyCount,
            ...pageText(bounded.content, parsed.payload),
          },
        };
      }
      case "page.click": {
        if ("target" in parsed.payload) {
          const locator = await this.actionableLocator(
            session,
            parsed.payload.target,
            timeout,
          );
          await locator.click({ timeout });
        } else {
          await session.page.mouse.click(
            parsed.payload.point.x,
            parsed.payload.point.y,
          );
        }
        this.emitHumanInput(session, command, { command: "click" });
        return { result: { url: safeObservedUrl(session.page.url()) } };
      }
      case "page.fill": {
        const locator = await this.actionableLocator(
          session,
          parsed.payload.target,
          timeout,
        );
        await locator.fill(parsed.payload.text, { timeout });
        this.emitHumanInput(session, command, {
          command: "fill",
          textLength: parsed.payload.text.length,
        });
        return { result: { filled: true } };
      }
      case "page.type": {
        const locator = await this.actionableLocator(
          session,
          parsed.payload.target,
          timeout,
        );
        await locator.pressSequentially(parsed.payload.text, {
          delay: parsed.payload.delayMs ?? 0,
          timeout,
        });
        this.emitHumanInput(session, command, {
          command: "type",
          textLength: parsed.payload.text.length,
        });
        return { result: { typed: true } };
      }
      case "page.press": {
        if (parsed.payload.target) {
          await (
            await this.actionableLocator(
              session,
              parsed.payload.target,
              timeout,
            )
          ).press(parsed.payload.key, { timeout });
        } else {
          await session.page.keyboard.press(parsed.payload.key);
        }
        this.emitHumanInput(session, command, { key: parsed.payload.key });
        return { result: { pressed: parsed.payload.key } };
      }
      case "page.check":
      case "page.uncheck":
      case "page.hover": {
        const locator = await this.actionableLocator(
          session,
          parsed.payload.target,
          timeout,
        );
        if (parsed.commandType === "page.check")
          await locator.check({ timeout });
        else if (parsed.commandType === "page.uncheck")
          await locator.uncheck({ timeout });
        else await locator.hover({ timeout });
        return { result: { ok: true } };
      }
      case "page.select": {
        const values = await (
          await this.actionableLocator(session, parsed.payload.target, timeout)
        ).selectOption(parsed.payload.values, { timeout });
        return { result: { values } };
      }
      case "page.scroll": {
        if (parsed.payload.target) {
          await this.locator(session, parsed.payload.target).evaluate(
            (element, delta) => element.scrollBy(delta.x, delta.y),
            { x: parsed.payload.deltaX, y: parsed.payload.deltaY },
          );
        } else {
          await session.page.mouse.wheel(
            parsed.payload.deltaX,
            parsed.payload.deltaY,
          );
        }
        return { result: { scrolled: true } };
      }
      case "page.drag": {
        const source = await this.actionableLocator(
          session,
          parsed.payload.source,
          timeout,
        );
        const target = await this.actionableLocator(
          session,
          parsed.payload.target,
          timeout,
        );
        await source.dragTo(target, { timeout });
        return { result: { dragged: true } };
      }
      case "page.resize":
        await session.page.setViewportSize({
          height: parsed.payload.height,
          width: parsed.payload.width,
        });
        return { result: { ...parsed.payload } };
      case "page.wait": {
        if (parsed.payload.kind === "selector") {
          await this.locator(session, parsed.payload.target).waitFor({
            state: parsed.payload.state,
            timeout: Math.min(timeout, parsed.payload.timeoutMs),
          });
        } else if (parsed.payload.kind === "text") {
          await session.page
            .getByText(parsed.payload.text, { exact: parsed.payload.exact })
            .first()
            .waitFor({
              state: "visible",
              timeout: Math.min(timeout, parsed.payload.timeoutMs),
            });
        } else {
          try {
            await session.page.waitForLoadState(parsed.payload.state, {
              timeout: Math.min(timeout, parsed.payload.timeoutMs),
            });
          } catch (error) {
            if (parsed.payload.state !== "networkidle") throw error;
            throw codedError(
              "WAIT_TIMEOUT",
              "The page did not reach networkidle. SPA and micro-frontend pages often keep background requests open; wait for a specific selector or text instead.",
              true,
            );
          }
        }
        return { result: { waited: true } };
      }
      case "tab.new": {
        if (session.context.pages().length >= 100) {
          throw codedError(
            "TAB_LIMIT_REACHED",
            "Browser session cannot open more than 100 tabs.",
          );
        }
        const page = await session.context.newPage();
        session.page = page;
        if (parsed.payload.url) {
          await page.goto(parsed.payload.url, {
            timeout,
            waitUntil: "domcontentloaded",
          });
        }
        return {
          result: {
            tabId: this.pageId(session, page),
            url: safeObservedUrl(page.url()),
          },
        };
      }
      case "tab.list":
        return {
          result: {
            tabs: await Promise.all(
              session.context.pages().map(async (page, index) => ({
                active: page === session.page,
                index,
                tabId: this.pageId(session, page),
                title: boundedUtf8Text(await page.title(), 1_000),
                url: safeObservedUrl(page.url()),
              })),
            ),
          },
        };
      case "tab.switch": {
        const pages = session.context.pages();
        const tabId = "tabId" in parsed.payload ? parsed.payload.tabId : null;
        const page =
          "index" in parsed.payload
            ? pages[parsed.payload.index]
            : pages.find(
                (candidate) => this.pageId(session, candidate) === tabId,
              );
        if (!page) throw codedError("STALE_PAGE", "Browser tab was not found.");
        session.page = page;
        await page.bringToFront();
        return {
          result: {
            tabId: this.pageId(session, page),
            url: safeObservedUrl(page.url()),
          },
        };
      }
      case "tab.close": {
        const page = parsed.payload.tabId
          ? session.context
              .pages()
              .find(
                (candidate) =>
                  this.pageId(session, candidate) === parsed.payload.tabId,
              )
          : session.page;
        if (!page) throw codedError("STALE_PAGE", "Browser tab was not found.");
        await page.close();
        const replacement =
          session.context.pages()[0] ?? (await session.context.newPage());
        session.page = replacement;
        return { result: { activeTabId: this.pageId(session, replacement) } };
      }
      case "frame.snapshot": {
        const content = redactText(
          await this.frameLocator(session, parsed.payload.frame)
            .locator("body")
            .ariaSnapshot({ mode: "ai", timeout }),
        );
        return { result: pageText(content, parsed.payload) };
      }
      case "frame.click": {
        const frame = this.frameLocator(session, parsed.payload.frame);
        const locator = await this.actionableLocator(
          session,
          parsed.payload.target,
          timeout,
          frame,
        );
        await locator.click({ timeout });
        return { result: { clicked: true } };
      }
      case "frame.fill": {
        const frame = this.frameLocator(session, parsed.payload.frame);
        const locator = await this.actionableLocator(
          session,
          parsed.payload.target,
          timeout,
          frame,
        );
        await locator.fill(parsed.payload.text, { timeout });
        return { result: { filled: true } };
      }
      case "element.state": {
        const locator = this.locator(session, parsed.payload.target);
        const count = await locator.count();
        if (count === 0) {
          throw codedError("ELEMENT_NOT_FOUND", "Element was not found.", true);
        }
        return {
          result: {
            checked: await locator
              .first()
              .isChecked()
              .catch(() => null),
            count,
            disabled: await locator
              .first()
              .isDisabled()
              .catch(() => null),
            editable: await locator
              .first()
              .isEditable()
              .catch(() => null),
            enabled: await locator
              .first()
              .isEnabled()
              .catch(() => null),
            visible: await locator.first().isVisible(),
          },
        };
      }
      case "locator.count":
        return {
          result: {
            count: await this.locator(session, parsed.payload.target).count(),
          },
        };
      case "network.arm":
        if (session.networkFaultPolicies.has(parsed.payload.policyId)) {
          throw codedError(
            "FAULT_POLICY_EXISTS",
            `Network fault policy ${parsed.payload.policyId} is already armed.`,
          );
        }
        if (session.networkFaultPolicies.size >= 100) {
          throw codedError(
            "FAULT_POLICY_LIMIT_REACHED",
            "Browser session cannot arm more than 100 network fault policies.",
          );
        }
        const generation = randomUUID();
        session.networkFaultPolicies.set(parsed.payload.policyId, {
          action: parsed.payload.action,
          armedAt: new Date().toISOString(),
          generation,
          ...(parsed.payload.action === "PAUSE"
            ? { maxPauseMs: parsed.payload.maxPauseMs }
            : {}),
          ...(parsed.payload.method ? { method: parsed.payload.method } : {}),
          policyId: parsed.payload.policyId,
          ...(parsed.payload.action === "FULFILL_STATUS"
            ? { status: parsed.payload.status }
            : {}),
          urlPattern: parsed.payload.urlPattern,
        });
        return {
          result: {
            action: parsed.payload.action,
            armed: true,
            generation,
            policyId: parsed.payload.policyId,
          },
        };
      case "network.wait_for_hit": {
        const policy = session.networkFaultPolicies.get(
          parsed.payload.policyId,
        );
        if (!policy) {
          throw codedError(
            "FAULT_POLICY_NOT_FOUND",
            `Network fault policy ${parsed.payload.policyId} is not armed.`,
          );
        }
        const deadline = Math.min(
          Date.now() + parsed.payload.timeoutMs,
          new Date(command.deadlineAt).getTime(),
        );
        while (Date.now() < deadline) {
          const hit = [...session.networkFaultHits]
            .reverse()
            .find(
              (item) =>
                item.policyId === parsed.payload.policyId &&
                item.generation === policy.generation,
            );
          if (hit) return { result: { hit, status: "HIT" } };
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw codedError(
          "WAIT_TIMEOUT",
          `Network fault policy ${parsed.payload.policyId} was not hit before the deadline.`,
          true,
        );
      }
      case "network.status": {
        const policies = Array.from(session.networkFaultPolicies.values())
          .filter(
            (policy) =>
              !parsed.payload.policyId ||
              policy.policyId === parsed.payload.policyId,
          )
          .map((policy) => ({
            ...policy,
            hitCount: session.networkFaultHits.filter(
              (hit) =>
                hit.policyId === policy.policyId &&
                hit.generation === policy.generation,
            ).length,
            pausedCount: session.pausedRoutes.get(policy.policyId)?.size ?? 0,
          }));
        return { result: { policies } };
      }
      case "network.release": {
        const released = this.releaseNetworkFault(
          session,
          parsed.payload.policyId,
        );
        return {
          result: { policyId: parsed.payload.policyId, released },
        };
      }
      case "human.takeover":
        session.state = "HUMAN_CONTROL";
        await this.store.replaceSession(this.descriptor(session));
        return { result: { humanControl: true } };
      case "human.release":
        await this.releaseHumanInput(session);
        this.stopPreviewsForSession(session.sessionId);
        session.state = "OPEN";
        await this.store.replaceSession(this.descriptor(session));
        return { result: { humanControl: false } };
      case "session.open":
        throw codedError("COMMAND_FAILED", "Session is already open.");
    }
  }

  async cancel(sessionId: string, commandType?: RuntimeCommandType) {
    const page = this.sessions.get(sessionId)?.page;
    if (!page) {
      return;
    }
    if (
      commandType &&
      [
        "page.open",
        "page.navigate",
        "page.back",
        "page.forward",
        "page.reload",
      ].includes(commandType)
    ) {
      await page.evaluate(() => window.stop()).catch(() => undefined);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  async close(sessionId: string) {
    this.stopPreviewsForSession(sessionId);
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      for (const policyId of session.networkFaultPolicies.keys()) {
        this.releaseNetworkFault(session, policyId, false);
      }
      await session.context
        .unrouteAll({ behavior: "ignoreErrors" })
        .catch(() => undefined);
      if (session.browser) {
        await session.browser.close().catch(() => undefined);
      } else {
        await session.context.close().catch(() => undefined);
      }
      if (
        session.profileMode === "PERSISTENT" &&
        session.profileRetention?.kind === "USER"
      ) {
        await touchUserProfileMetadata(
          profileRoot,
          session.profileKey,
          new Date(),
        ).catch((error) =>
          runtimeLog(
            "error",
            "runtime.profile.last_used_update_failed",
            {
              profileFingerprint: profileKeyFingerprint(session.profileKey),
            },
            error,
          ),
        );
      }
    }
    await this.store.removeSession(sessionId);
    await rm(join(recordingRoot, sessionId), {
      force: true,
      recursive: true,
    }).catch(() => undefined);
  }

  private async purgeProfile(profileKey: string) {
    if (
      this.openingProfileKeys.has(profileKey) ||
      Array.from(this.sessions.values()).some(
        (session) =>
          session.profileMode === "PERSISTENT" &&
          session.profileKey === profileKey,
      )
    ) {
      throw codedError(
        "PROFILE_IN_USE",
        "Persistent profile is still used by an active session.",
        true,
      );
    }
    this.openingProfileKeys.add(profileKey);
    try {
      return await purgePersistentProfileDirectory(profileRoot, profileKey);
    } finally {
      this.openingProfileKeys.delete(profileKey);
    }
  }

  private async open(descriptor: PersistedSession) {
    const existing = this.sessions.get(descriptor.sessionId);
    if (existing) {
      if (
        existing.leaseToken !== descriptor.leaseToken ||
        existing.fencingToken !== descriptor.fencingToken
      ) {
        await this.close(descriptor.sessionId);
      } else {
        return existing;
      }
    }
    const tracksUserProfile =
      descriptor.profileMode === "PERSISTENT" &&
      descriptor.profileRetention?.kind === "USER";
    if (descriptor.profileMode === "PERSISTENT") {
      if (
        this.openingProfileKeys.has(descriptor.profileKey) ||
        (tracksUserProfile &&
          Array.from(this.sessions.values()).some(
            (session) =>
              session.profileMode === "PERSISTENT" &&
              session.profileKey === descriptor.profileKey,
          ))
      ) {
        throw codedError(
          "PROFILE_IN_USE",
          "Persistent profile is already open, being opened, or being purged.",
          true,
        );
      }
      this.openingProfileKeys.add(descriptor.profileKey);
    }
    try {
      const headless = process.env.DEVPROOF_HEADLESS !== "false";
      let browser: Browser | undefined;
      let context: BrowserContext;
      if (descriptor.profileMode === "PERSISTENT") {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(descriptor.profileKey)) {
          throw new Error("Persistent profile key is invalid.");
        }
        const profilePath = join(profileRoot, descriptor.profileKey);
        if (tracksUserProfile) {
          await assertUserProfileCanOpen(profileRoot, descriptor.profileKey);
        }
        await mkdir(profilePath, { recursive: true, mode: 0o700 });
        if (tracksUserProfile) {
          await touchUserProfileMetadata(
            profileRoot,
            descriptor.profileKey,
            new Date(),
          );
        }
        context = await chromium.launchPersistentContext(profilePath, {
          args: ["--proxy-bypass-list=<-loopback>"],
          channel: "chromium",
          headless,
          proxy: { server: this.proxyServer },
          serviceWorkers: "block",
        });
      } else {
        browser = await chromium.launch({
          args: ["--proxy-bypass-list=<-loopback>"],
          channel: "chromium",
          headless,
          proxy: { server: this.proxyServer },
        });
        context = await browser.newContext({ serviceWorkers: "block" });
      }
      let liveSession: LiveSession | undefined;
      await context.route("**/*", async (route) => {
        if (liveSession && (await this.applyNetworkFault(liveSession, route))) {
          return;
        }
        await route.continue();
      });
      const page = context.pages()[0] ?? (await context.newPage());
      const stepFrames = await this.loadStepFrames(descriptor.sessionId);
      const session: LiveSession = {
        ...descriptor,
        ...(browser ? { browser } : {}),
        consoleEntries: [],
        context,
        networkEntries: [],
        pendingNetworkCaptures: new Map(),
        networkFaultHits: [],
        networkFaultPolicies: new Map(),
        page,
        pageIds: new Map([[page, randomUUID()]]),
        pausedRoutes: new Map(),
        pressedButtons: new Set(),
        pressedKeys: new Set(),
        state: "OPEN",
        stepFrames,
        stepSequence: stepFrames.at(-1)?.index ?? 0,
      };
      liveSession = session;
      this.attachObservers(session, page);
      context.on("page", (createdPage) => {
        session.pageIds.set(createdPage, randomUUID());
        this.attachObservers(session, createdPage);
      });
      this.sessions.set(session.sessionId, session);
      await this.store.replaceSession(this.descriptor(session));
      return session;
    } finally {
      if (descriptor.profileMode === "PERSISTENT") {
        this.openingProfileKeys.delete(descriptor.profileKey);
      }
    }
  }

  private attachObservers(session: LiveSession, page: Page) {
    page.on("download", (download) => {
      void download.cancel();
      this.emitEvent(session, "NETWORK_ERROR", {
        errorText: "UNAUTHORIZED_DOWNLOAD_BLOCKED",
        timestamp: new Date().toISOString(),
        url: safeObservedUrl(download.url()),
      });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.emitEvent(session, "PAGE_CHANGED", {
          tabId: this.pageId(session, page),
          url: safeObservedUrl(frame.url()),
        });
      }
    });
    page.on("console", (message) => {
      const location = message.location();
      const entry = redactValue({
        location: {
          ...location,
          url: safeObservedUrl(location.url),
        },
        text: boundedUtf8Text(message.text(), OBSERVED_ENTRY_MAX_BYTES),
        timestamp: new Date().toISOString(),
        type: message.type(),
      }) as Record<string, unknown>;
      session.consoleEntries.push(entry);
      session.consoleEntries.splice(
        0,
        Math.max(0, session.consoleEntries.length - 1000),
      );
      if (message.type() === "error") {
        this.emitEvent(session, "CONSOLE_ERROR", entry);
      }
    });
    page.on("response", (response) => {
      const entry = redactValue({
        method: response.request().method(),
        status: response.status(),
        timestamp: new Date().toISOString(),
        url: safeObservedUrl(response.url()),
      }) as Record<string, unknown>;
      session.networkEntries.push(entry);
      session.networkEntries.splice(
        0,
        Math.max(0, session.networkEntries.length - 2000),
      );
      const capture = this.captureNetworkResponseBody(
        session,
        page,
        response,
        entry,
      );
      session.pendingNetworkCaptures.set(capture, response.url());
      void capture.finally(() =>
        session.pendingNetworkCaptures.delete(capture),
      );
    });
    page.on("requestfailed", (request) => {
      const entry = redactValue({
        errorText: boundedUtf8Text(
          request.failure()?.errorText ?? "unknown",
          OBSERVED_ENTRY_MAX_BYTES,
        ),
        method: request.method(),
        timestamp: new Date().toISOString(),
        url: safeObservedUrl(request.url()),
      }) as Record<string, unknown>;
      session.networkEntries.push(entry);
      this.emitEvent(session, "NETWORK_ERROR", entry);
    });
    page.on("close", () => {
      session.pageIds.delete(page);
      if (session.page === page) {
        const replacement = session.context.pages()[0];
        if (replacement) session.page = replacement;
      }
    });
  }

  private pageId(session: LiveSession, page: Page): string {
    const existing = session.pageIds.get(page);
    if (existing) return existing;
    const id = randomUUID();
    session.pageIds.set(page, id);
    return id;
  }

  private async captureNetworkResponseBody(
    session: LiveSession,
    page: Page,
    response: Response,
    entry: Record<string, unknown>,
  ) {
    try {
      const responseUrl = new URL(response.url());
      const pageUrl = new URL(page.url());
      const contentType = response.headers()["content-type"] ?? "";
      if (
        responseUrl.origin !== pageUrl.origin ||
        !/(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/iu.test(contentType)
      ) {
        return;
      }
      const declaredLength = Number(response.headers()["content-length"]);
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > NETWORK_RESPONSE_BODY_READ_LIMIT
      ) {
        entry.responseBodyOmitted = "declared_size_limit";
        return;
      }
      const raw = await response.text();
      const originalByteSize = Buffer.byteLength(raw);
      if (originalByteSize > NETWORK_RESPONSE_BODY_READ_LIMIT) {
        entry.responseBodyOmitted = "size_limit";
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        entry.responseBodyOmitted = "invalid_json";
        return;
      }
      const redacted = JSON.stringify(redactValue(parsed));
      const bounded = boundedUtf8Buffer(
        redacted,
        NETWORK_RESPONSE_BODY_MAX_BYTES,
      );
      if (!session.networkEntries.includes(entry)) return;
      entry.responseBody = bounded.truncated
        ? bounded.data.toString("utf8")
        : (JSON.parse(bounded.data.toString("utf8")) as unknown);
      entry.responseBodyOriginalByteSize = originalByteSize;
      entry.responseBodyTruncated = bounded.truncated;
      entry.responseContentType = boundedUtf8Text(contentType, 200);
      trimNetworkResponseBodies(session.networkEntries);
    } catch {
      // Response bodies are optional evidence enrichment. Metadata remains usable.
    }
  }

  private async waitForNetworkResponseBodies(
    session: LiveSession,
    urlIncludes: string | undefined,
  ) {
    const pending = [...session.pendingNetworkCaptures]
      .filter(([, url]) => !urlIncludes || url.includes(urlIncludes))
      .map(([capture]) => capture);
    if (pending.length === 0) return;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
  }

  private async applyNetworkFault(
    session: LiveSession,
    route: Route,
  ): Promise<boolean> {
    const request = route.request();
    const policy = Array.from(session.networkFaultPolicies.values()).find(
      (candidate) =>
        (!candidate.method || candidate.method === request.method()) &&
        matchesUrlPattern(request.url(), candidate.urlPattern),
    );
    if (!policy) return false;
    const hit = {
      action: policy.action,
      generation: policy.generation,
      hitAt: new Date().toISOString(),
      method: request.method(),
      policyId: policy.policyId,
      url: safeObservedUrl(request.url()),
    };
    session.networkFaultHits.push(hit);
    session.networkFaultHits.splice(
      0,
      Math.max(0, session.networkFaultHits.length - 2_000),
    );
    this.emitEvent(session, "NETWORK_FAULT_HIT", hit);
    if (policy.action === "ABORT") {
      await route.abort("failed");
      return true;
    }
    if (policy.action === "FULFILL_STATUS") {
      await route.fulfill({
        body: "",
        contentType: "text/plain; charset=utf-8",
        status: policy.status ?? 500,
      });
      return true;
    }

    const resolvers =
      session.pausedRoutes.get(policy.policyId) ??
      new Set<(released: boolean) => void>();
    session.pausedRoutes.set(policy.policyId, resolvers);
    const released = await new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => {
        clearTimeout(timer);
        resolvers.delete(finish);
        resolve(value);
      };
      const timer = setTimeout(
        () => finish(false),
        policy.maxPauseMs ?? 30_000,
      );
      resolvers.add(finish);
    });
    if (released) await route.continue();
    else await route.abort("timedout");
    return true;
  }

  private releaseNetworkFault(
    session: LiveSession,
    policyId: string,
    continueRequests = true,
  ): number {
    session.networkFaultPolicies.delete(policyId);
    const resolvers = session.pausedRoutes.get(policyId);
    session.pausedRoutes.delete(policyId);
    if (!resolvers) return 0;
    const count = resolvers.size;
    for (const resolve of resolvers) resolve(continueRequests);
    return count;
  }

  private locator(
    session: LiveSession,
    target: RuntimeLocator,
    scope?: Page | FrameLocator,
  ): Locator {
    const root = scope ?? session.page;
    if ("ref" in target) return root.locator(`aria-ref=${target.ref}`);
    if (target.frameSelector) {
      return root.frameLocator(target.frameSelector).locator(target.selector);
    }
    return root.locator(target.selector);
  }

  private frameLocator(
    session: LiveSession,
    target: RuntimeLocator,
  ): FrameLocator {
    if ("ref" in target) {
      return session.page.locator(`aria-ref=${target.ref}`).contentFrame();
    }
    if (target.frameSelector) {
      return session.page
        .frameLocator(target.frameSelector)
        .locator(target.selector)
        .contentFrame();
    }
    return session.page.frameLocator(target.selector);
  }

  private async actionableLocator(
    session: LiveSession,
    target: RuntimeLocator,
    timeout: number,
    scope?: Page | FrameLocator,
  ): Promise<Locator> {
    const locator = this.locator(session, target, scope);
    try {
      await locator.first().waitFor({ state: "attached", timeout });
    } catch {
      throw codedError("ELEMENT_NOT_FOUND", "Element was not found.", true);
    }
    const count = await locator.count();
    if (count > 1) {
      throw codedError(
        "LOCATOR_AMBIGUOUS",
        `Locator matched ${count} elements; use an accessibility ref or a more precise selector.`,
      );
    }
    try {
      await locator.waitFor({ state: "visible", timeout });
    } catch {
      throw codedError("ELEMENT_NOT_VISIBLE", "Element is not visible.", true);
    }
    return locator;
  }

  private async captureStepArtifact(
    sessionId: string,
    commandType: string,
  ): Promise<RuntimeArtifactPayload | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.page.isClosed?.()) return null;
    if (commandType !== "session.complete") {
      await session.page.waitForTimeout(100).catch(() => undefined);
    }
    const data = await this.screenshot(session.page, {
      format: "jpeg",
      fullPage: false,
      quality: 58,
    });
    const viewport = session.page.viewportSize() ?? {
      height: 720,
      width: 1280,
    };
    const frame: StepFrame = {
      capturedAt: new Date().toISOString(),
      commandType,
      data,
      height: viewport.height,
      index: ++session.stepSequence,
      title: boundedUtf8Text(await session.page.title(), 1_000),
      url: safeObservedUrl(session.page.url()),
      width: viewport.width,
    };
    const includedInVideo =
      session.stepFrames.length < MAX_RECORDED_STEP_FRAMES;
    if (includedInVideo) {
      session.stepFrames.push(frame);
      await this.persistStepFrames(session).catch((error: unknown) =>
        runtimeLog(
          "warn",
          "runtime.step_screenshot.persist_failed",
          { sessionId },
          error,
        ),
      );
    }
    return this.artifact("SCREENSHOT", "image/jpeg", data, {
      captureKind: "STEP",
      capturedAt: frame.capturedAt,
      commandType,
      includedInVideo,
      stepIndex: frame.index,
      title: frame.title,
      url: frame.url,
    });
  }

  private async composeStepVideo(
    session: LiveSession,
  ): Promise<RuntimeArtifactPayload | null> {
    if (session.stepFrames.length === 0) return null;
    const frameDurationMs = Math.max(
      180,
      Math.min(
        MAX_STEP_VIDEO_FRAME_DURATION_MS,
        Math.floor(MAX_STEP_VIDEO_DURATION_MS / session.stepFrames.length),
      ),
    );
    const composer = await session.context.newPage();
    try {
      const encoded = await composer.evaluate(
        async ({ durationMs, frameDurationMs, frames }) => {
          if (typeof MediaRecorder === "undefined") {
            throw new Error("Chromium MediaRecorder is unavailable.");
          }
          const mimeType = [
            "video/webm;codecs=vp9",
            "video/webm;codecs=vp8",
            "video/webm",
          ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
          if (!mimeType) throw new Error("No WebM encoder is available.");

          const loadImage = async (dataBase64: string) => {
            const image = new Image();
            image.src = `data:image/jpeg;base64,${dataBase64}`;
            await image.decode();
            return image;
          };
          const firstImage = await loadImage(frames[0]!.dataBase64);
          const width = firstImage.naturalWidth;
          const height = firstImage.naturalHeight;
          if (width <= 0 || height <= 0) {
            throw new Error("Step video frame dimensions are invalid.");
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas 2D context is unavailable.");
          const stream = canvas.captureStream(10);
          const maximumEncodedBytes = 8 * 1024 * 1024;
          const videoBitsPerSecond = Math.min(
            6_000_000,
            Math.max(
              800_000,
              Math.floor(
                (maximumEncodedBytes * 8 * 0.9) /
                  Math.max(0.7, durationMs / 1_000),
              ),
            ),
          );
          const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond,
          });
          const chunks: Blob[] = [];
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) chunks.push(event.data);
          };
          const stopped = new Promise<void>((resolve, reject) => {
            recorder.onerror = () =>
              reject(new Error("Video encoding failed."));
            recorder.onstop = () => resolve();
          });
          const sleep = (milliseconds: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
          recorder.start(250);

          for (const [index, frame] of frames.entries()) {
            const image =
              index === 0 ? firstImage : await loadImage(frame.dataBase64);
            context.fillStyle = "#070b12";
            context.fillRect(0, 0, width, height);
            const scale = Math.min(
              width / image.naturalWidth,
              height / image.naturalHeight,
            );
            const renderedWidth = image.naturalWidth * scale;
            const renderedHeight = image.naturalHeight * scale;
            context.drawImage(
              image,
              (width - renderedWidth) / 2,
              (height - renderedHeight) / 2,
              renderedWidth,
              renderedHeight,
            );
            await sleep(
              frames.length === 1
                ? Math.max(700, frameDurationMs)
                : frameDurationMs,
            );
          }

          await sleep(120);
          recorder.stop();
          await stopped;
          stream.getTracks().forEach((track) => track.stop());
          const blob = new Blob(chunks, { type: mimeType });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          const chunkSize = 0x8000;
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(
              ...bytes.subarray(offset, offset + chunkSize),
            );
          }
          return {
            dataBase64: btoa(binary),
            height,
            mimeType: blob.type || "video/webm",
            width,
          };
        },
        {
          durationMs: Math.max(
            700,
            session.stepFrames.length * frameDurationMs,
          ),
          frameDurationMs,
          frames: session.stepFrames.map((frame) => ({
            dataBase64: frame.data.toString("base64"),
          })),
        },
      );
      const data = Buffer.from(encoded.dataBase64, "base64");
      if (data.byteLength === 0) {
        throw new Error("Chromium produced an empty step video.");
      }
      if (data.byteLength > RUNTIME_ARTIFACT_SAFE_MAX_BYTES) {
        throw codedError(
          "ARTIFACT_TOO_LARGE",
          "Step video exceeds the Runtime artifact limit.",
        );
      }
      return this.artifact("VIDEO", "video/webm", data, {
        durationMs: Math.max(700, session.stepFrames.length * frameDurationMs),
        format: "STEP_SCREENSHOT_SLIDESHOW",
        frameCount: session.stepFrames.length,
        height: encoded.height,
        width: encoded.width,
      });
    } finally {
      await composer.close().catch(() => undefined);
    }
  }

  private async loadStepFrames(sessionId: string): Promise<StepFrame[]> {
    try {
      const directory = join(recordingRoot, sessionId);
      const raw = JSON.parse(
        await readFile(join(directory, "manifest.json"), "utf8"),
      ) as unknown;
      if (!Array.isArray(raw)) return [];
      const frames: StepFrame[] = [];
      for (const value of raw.slice(0, MAX_RECORDED_STEP_FRAMES)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          continue;
        }
        const row = value as Record<string, unknown>;
        const fileName = row.fileName;
        if (
          typeof fileName !== "string" ||
          !/^step-\d{4}\.jpg$/u.test(fileName) ||
          typeof row.capturedAt !== "string" ||
          typeof row.commandType !== "string" ||
          typeof row.height !== "number" ||
          typeof row.index !== "number" ||
          typeof row.title !== "string" ||
          typeof row.url !== "string" ||
          typeof row.width !== "number"
        ) {
          continue;
        }
        frames.push({
          capturedAt: row.capturedAt,
          commandType: row.commandType,
          data: await readFile(join(directory, fileName)),
          height: row.height,
          index: row.index,
          title: row.title,
          url: row.url,
          width: row.width,
        });
      }
      return frames.sort((left, right) => left.index - right.index);
    } catch {
      return [];
    }
  }

  private async persistStepFrames(session: LiveSession) {
    const directory = join(recordingRoot, session.sessionId);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const frame = session.stepFrames.at(-1);
    if (!frame) return;
    const fileName = `step-${String(frame.index).padStart(4, "0")}.jpg`;
    await writeFile(join(directory, fileName), frame.data, { mode: 0o600 });
    const manifest = session.stepFrames.map((item) => ({
      capturedAt: item.capturedAt,
      commandType: item.commandType,
      fileName: `step-${String(item.index).padStart(4, "0")}.jpg`,
      height: item.height,
      index: item.index,
      title: item.title,
      url: item.url,
      width: item.width,
    }));
    const temporaryPath = join(directory, `manifest.${process.pid}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(manifest), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, join(directory, "manifest.json"));
  }

  private async screenshot(
    page: Page,
    input: { format: "jpeg" | "png"; fullPage: boolean; quality: number },
  ): Promise<Buffer> {
    if (input.format === "png") {
      const data = await page.screenshot({
        fullPage: input.fullPage,
        type: "png",
      });
      if (data.byteLength > RUNTIME_ARTIFACT_SAFE_MAX_BYTES) {
        throw codedError(
          "ARTIFACT_TOO_LARGE",
          "PNG screenshot exceeds the Runtime artifact limit; capture a viewport JPEG instead.",
        );
      }
      return data;
    }
    let data = await page.screenshot({
      fullPage: input.fullPage,
      quality: input.quality,
      type: "jpeg",
    });
    if (data.byteLength > INLINE_SCREENSHOT_MAX_BYTES && input.quality > 45) {
      data = await page.screenshot({
        fullPage: input.fullPage,
        quality: 45,
        type: "jpeg",
      });
    }
    if (data.byteLength > INLINE_SCREENSHOT_MAX_BYTES && input.fullPage) {
      data = await page.screenshot({
        fullPage: false,
        quality: 45,
        type: "jpeg",
      });
    }
    if (data.byteLength > RUNTIME_ARTIFACT_SAFE_MAX_BYTES) {
      throw codedError(
        "ARTIFACT_TOO_LARGE",
        "Screenshot exceeds the Runtime artifact limit; reduce the viewport or capture a viewport JPEG.",
      );
    }
    return data;
  }

  private descriptor(session: LiveSession): PersistedSession {
    return {
      fencingToken: session.fencingToken,
      leaseToken: session.leaseToken,
      profileKey: session.profileKey,
      profileMode: session.profileMode,
      ...(session.profileRetention
        ? { profileRetention: session.profileRetention }
        : {}),
      sessionId: session.sessionId,
      state: session.state,
    };
  }

  private artifact(
    kind: RuntimeArtifactPayload["kind"],
    contentType: string,
    data: Buffer,
    metadata: Record<string, unknown>,
  ): RuntimeArtifactPayload {
    return { contentType, dataBase64: data.toString("base64"), kind, metadata };
  }

  private emitHumanInput(
    session: LiveSession,
    command: RuntimeCommand,
    payload: Record<string, unknown>,
  ) {
    if (session.state === "HUMAN_CONTROL") {
      this.emitEvent(session, "HUMAN_INPUT", {
        commandType: command.commandType,
        ...payload,
      });
    }
  }

  startPreview(
    message: Extract<RuntimeServerMessage, { type: "human.preview.subscribe" }>,
  ) {
    const session = this.ownedPreviewSession(message);
    this.stopPreview(message.streamId);
    const stream = {
      capturing: false,
      consecutiveFailures: 0,
      sessionId: session.sessionId,
      timer: setInterval(
        () => void this.capturePreview(message),
        message.intervalMs,
      ),
    };
    stream.timer.unref();
    this.previewStreams.set(message.streamId, stream);
    void this.capturePreview(message);
  }

  stopPreview(streamId: string) {
    const stream = this.previewStreams.get(streamId);
    if (!stream) return;
    clearInterval(stream.timer);
    this.previewStreams.delete(streamId);
  }

  stopAllPreviews() {
    for (const streamId of this.previewStreams.keys()) {
      this.stopPreview(streamId);
    }
  }

  async humanInput(
    message: Extract<RuntimeServerMessage, { type: "human.input.dispatch" }>,
  ) {
    const session = this.ownedHumanSession(message);
    for (const event of message.events) {
      await this.applyHumanInput(session, event);
    }
  }

  private ownedHumanSession(input: {
    fencingToken: string;
    leaseToken: string;
    sessionId: string;
  }) {
    const session = this.ownedPreviewSession(input);
    if (session.state !== "HUMAN_CONTROL") {
      throw new Error("Browser session is not in human control.");
    }
    return session;
  }

  private ownedPreviewSession(input: {
    fencingToken: string;
    leaseToken: string;
    sessionId: string;
  }) {
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error("Runtime session is not open.");
    if (
      session.leaseToken !== input.leaseToken ||
      session.fencingToken !== input.fencingToken
    ) {
      throw new Error("Human control owns a stale browser lease.");
    }
    if (!["OPEN", "HUMAN_CONTROL"].includes(session.state)) {
      throw new Error("Browser session is unavailable for preview.");
    }
    return session;
  }

  private async capturePreview(
    message: Extract<RuntimeServerMessage, { type: "human.preview.subscribe" }>,
  ) {
    const stream = this.previewStreams.get(message.streamId);
    if (!stream || stream.capturing) return;
    stream.capturing = true;
    try {
      const session = this.ownedPreviewSession(message);
      const viewport = session.page.viewportSize() ?? {
        height: 720,
        width: 1280,
      };
      const data = await this.screenshot(session.page, {
        format: "jpeg",
        fullPage: false,
        quality: message.quality,
      });
      this.emitPreview({
        capturedAt: new Date().toISOString(),
        dataBase64: data.toString("base64"),
        fencingToken: session.fencingToken,
        height: viewport.height,
        leaseToken: session.leaseToken,
        sessionId: session.sessionId,
        streamId: message.streamId,
        title: boundedUtf8Text(await session.page.title(), 1_000),
        type: "human.preview.frame",
        url: safeObservedUrl(session.page.url()),
        width: viewport.width,
      });
      stream.consecutiveFailures = 0;
    } catch (error) {
      const current = this.previewStreams.get(message.streamId);
      if (!current) return;
      current.consecutiveFailures += 1;
      const text = error instanceof Error ? error.message : String(error);
      if (
        current.consecutiveFailures === 1 ||
        current.consecutiveFailures % 5 === 0
      ) {
        runtimeLog("warn", "human.preview.capture_failed", {
          consecutiveFailures: current.consecutiveFailures,
          message: text,
          sessionId: current.sessionId,
        });
      }
      if (terminalPreviewError(text)) this.stopPreview(message.streamId);
    } finally {
      const current = this.previewStreams.get(message.streamId);
      if (current) current.capturing = false;
    }
  }

  private async applyHumanInput(
    session: LiveSession,
    event: BrowserHumanInputEvent,
  ) {
    const viewport = session.page.viewportSize() ?? {
      height: 720,
      width: 1280,
    };
    if (event.type === "pointer") {
      await session.page.mouse.move(
        Math.round(event.x * viewport.width),
        Math.round(event.y * viewport.height),
      );
      if (event.button === "none" || event.phase === "move") return;
      if (event.phase === "down") {
        await session.page.mouse.down({ button: event.button });
        session.pressedButtons.add(event.button);
      } else {
        await session.page.mouse.up({ button: event.button });
        session.pressedButtons.delete(event.button);
      }
      return;
    }
    if (event.type === "wheel") {
      await session.page.mouse.move(
        Math.round(event.x * viewport.width),
        Math.round(event.y * viewport.height),
      );
      await session.page.mouse.wheel(event.deltaX, event.deltaY);
      return;
    }
    if (event.type === "text") {
      await session.page.keyboard.insertText(event.text);
      return;
    }
    if (event.type === "key") {
      if (event.phase === "down") {
        await session.page.keyboard.down(event.key);
        session.pressedKeys.add(event.key);
      } else {
        await session.page.keyboard.up(event.key);
        session.pressedKeys.delete(event.key);
      }
      return;
    }
    await this.releaseHumanInput(session);
  }

  private async releaseHumanInput(session: LiveSession) {
    for (const key of session.pressedKeys) {
      await session.page.keyboard.up(key).catch(() => undefined);
    }
    for (const button of session.pressedButtons) {
      await session.page.mouse.up({ button }).catch(() => undefined);
    }
    session.pressedKeys.clear();
    session.pressedButtons.clear();
  }

  private stopPreviewsForSession(sessionId: string) {
    for (const [streamId, stream] of this.previewStreams) {
      if (stream.sessionId === sessionId) this.stopPreview(streamId);
    }
  }
}

function terminalPreviewError(message: string) {
  return [
    "Runtime session is not open.",
    "Human control owns a stale browser lease.",
    "Browser session is not in human control.",
    "Browser session is unavailable for preview.",
  ].some((value) => message.includes(value));
}

export class RuntimeClient {
  private socket: WebSocket | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private reconnectAttempt = 0;
  private connectionReady = false;
  private deliveryAcknowledgements = false;
  private readonly outbox: Array<{
    bytes: number;
    message: unknown;
    messageId: string;
    messageType: BufferedRuntimeMessageType;
    sent: boolean;
  }> = [];
  private outboxBytes = 0;
  private droppedMessages = 0;
  private readonly pending = new Map<
    string,
    { commandType: RuntimeCommandType; controller: AbortController }
  >();
  private readonly manager: BrowserSessionManager;

  constructor(
    private readonly store: StateStore,
    private readonly proxy: SsrfProxy,
  ) {
    this.manager = new BrowserSessionManager(
      store,
      proxy.server,
      (session, kind, payload) => {
        this.send({
          eventId: randomUUID(),
          fencingToken: session.fencingToken,
          kind,
          leaseToken: session.leaseToken,
          payload,
          sessionId: session.sessionId,
          timestamp: new Date().toISOString(),
          type: "runtime.event",
        });
      },
      (frame) => this.send(frame),
      (event) => this.send(event),
    );
  }

  async start() {
    await this.restoreProfileLifecycleEvents();
    this.manager.startProfileCleanup();
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.reconnectAttempt = 0;
      } catch (error) {
        runtimeLog(
          "warn",
          "runtime.gateway.connection_failed",
          {
            reconnectAttempt: this.reconnectAttempt,
          },
          error,
        );
      }
      if (!this.stopped) {
        const delay = Math.min(
          30_000,
          500 * 2 ** Math.min(this.reconnectAttempt, 6),
        );
        this.reconnectAttempt += 1;
        runtimeLog("info", "runtime.gateway.reconnect_scheduled", {
          attempt: this.reconnectAttempt,
          delayMs: delay,
          queuedMessages: this.outbox.length,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  stop() {
    this.stopped = true;
    this.manager.stopProfileCleanup();
    this.socket?.close(1000, "Runtime is stopping.");
  }

  private async restoreProfileLifecycleEvents() {
    const interruptedProfileKeys = new Set(
      this.store
        .value()
        .sessions.filter((session) => session.profileMode === "PERSISTENT")
        .map((session) => session.profileKey),
    );
    for (const event of await readPendingProfileLifecycleEvents(profileRoot)) {
      if (interruptedProfileKeys.has(event.profileKey)) continue;
      await purgePersistentProfileDirectory(profileRoot, event.profileKey);
      this.send(event);
    }
  }

  private connectOnce() {
    return new Promise<void>((resolve, reject) => {
      const state = this.store.value();
      const socket = new WebSocket(state.gatewayUrl);
      this.socket = socket;
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        runtimeLog("info", "runtime.gateway.socket_opened", {
          runtimeId: state.runtimeId,
        });
        this.send({
          activeSessions:
            this.manager.descriptors().length > 0
              ? this.manager.descriptors()
              : state.sessions,
          instanceNonce: randomUUID() + randomUUID(),
          protocol: RUNTIME_PROTOCOL,
          runtimeId: state.runtimeId,
          runtimeToken: state.runtimeToken,
          sentAt: new Date().toISOString(),
          type: "runtime.hello",
          version: runtimeVersion,
        });
      });
      socket.addEventListener("message", (event) => {
        void this.handleMessage(String(event.data)).catch((error: Error) => {
          runtimeLog("error", "runtime.gateway.message_failed", {}, error);
          socket.close(1011, "Runtime failed to process server message.");
        });
      });
      socket.addEventListener("error", () => {
        if (!opened) {
          reject(new Error("Runtime Gateway connection failed."));
        }
      });
      socket.addEventListener("close", (event) => {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = undefined;
        }
        this.manager.stopAllPreviews();
        this.socket = undefined;
        this.connectionReady = false;
        this.deliveryAcknowledgements = false;
        for (const queued of this.outbox) queued.sent = false;
        runtimeLog("warn", "runtime.gateway.socket_closed", {
          code: event.code,
          queuedMessages: this.outbox.length,
          reason: event.reason,
          runtimeId: state.runtimeId,
        });
        if (event.code === 4003) {
          this.stopped = true;
          reject(new Error("Runtime credential or protocol was rejected."));
        } else {
          resolve();
        }
      });
    });
  }

  private async handleMessage(raw: string) {
    const message = runtimeServerMessageSchema.parse(JSON.parse(raw));
    if (message.type === "runtime.hello.rejected") {
      throw new Error(message.code + ": " + message.message);
    }
    if (message.type === "runtime.hello.accepted") {
      this.deliveryAcknowledgements = message.protocol.minor >= 3;
      this.connectionReady = true;
      this.applyNetworkPolicy(message.networkAllowlist, "gateway_handshake");
      await this.manager.applyReconcile(message.reconcile);
      void this.manager.cleanupExpiredProfiles();
      runtimeLog("info", "runtime.gateway.online", {
        protocolMajor: message.protocol.major,
        protocolMinor: message.protocol.minor,
        runtimeId: this.store.value().runtimeId,
      });
      this.flushOutbox();
      this.heartbeatTimer = setInterval(
        () => this.heartbeat(),
        message.heartbeatIntervalMs,
      );
      this.heartbeatTimer.unref();
      this.heartbeat();
      return;
    }
    if (message.type === "runtime.network_policy.updated") {
      this.applyNetworkPolicy(message.networkAllowlist, "console_update");
      return;
    }
    if (message.type === "runtime.delivery.ack") {
      this.acknowledgeOutbox(message.messageId, message.messageType);
      return;
    }
    if (message.type === "runtime.heartbeat.ack") {
      for (const sessionId of message.closeSessions) {
        await this.manager.close(sessionId);
      }
      return;
    }
    if (message.type === "command.cancel") {
      const pending = this.pending.get(message.commandId);
      pending?.controller.abort(new Error(message.reason));
      await this.manager.cancel(message.sessionId, pending?.commandType);
      return;
    }
    if (message.type === "human.preview.subscribe") {
      this.manager.startPreview(message);
      return;
    }
    if (message.type === "human.preview.unsubscribe") {
      this.manager.stopPreview(message.streamId);
      return;
    }
    if (message.type === "human.input.dispatch") {
      try {
        await this.manager.humanInput(message);
        this.send({
          dispatchId: message.dispatchId,
          fencingToken: message.fencingToken,
          leaseToken: message.leaseToken,
          ok: true,
          sessionId: message.sessionId,
          type: "human.input.result",
        });
      } catch (error) {
        this.send({
          dispatchId: message.dispatchId,
          error: error instanceof Error ? error.message : "Input failed.",
          fencingToken: message.fencingToken,
          leaseToken: message.leaseToken,
          ok: false,
          sessionId: message.sessionId,
          type: "human.input.result",
        });
      }
      return;
    }
    await this.executeCommand(message);
  }

  private applyNetworkPolicy(networkAllowlist: string[], source: string) {
    const allowlist = parseHostAllowlist(networkAllowlist.join(","));
    this.proxy.setAllowlist(allowlist);
    runtimeLog("info", "runtime.network_policy.applied", {
      allowlistEntries: allowlist.size,
      source,
    });
  }

  private async executeCommand(command: RuntimeCommand) {
    const started = Date.now();
    const controller = new AbortController();
    this.pending.set(command.commandId, {
      commandType: command.commandType,
      controller,
    });
    runtimeLog("info", "runtime.command.started", {
      commandId: command.commandId,
      commandType: command.commandType,
      sessionId: command.sessionId,
    });
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason ?? new Error("Cancelled.")),
          { once: true },
        );
      });
      const result = await Promise.race([
        this.manager.execute(command),
        aborted,
      ]);
      const commandResult = (result ?? {}) as {
        artifacts?: RuntimeArtifactPayload[];
        result?: Record<string, unknown>;
      };
      this.send({
        artifacts: commandResult.artifacts ?? [],
        commandId: command.commandId,
        fencingToken: command.fencingToken,
        leaseToken: command.leaseToken,
        ok: true,
        result: commandResult.result ?? {},
        sessionId: command.sessionId,
        type: "command.result",
      });
      runtimeLog("info", "runtime.command.completed", {
        commandId: command.commandId,
        commandType: command.commandType,
        durationMs: Date.now() - started,
        sessionId: command.sessionId,
        status: "SUCCEEDED",
      });
    } catch (error) {
      const classified = classifyCommandError(
        error,
        command.commandType,
        controller.signal.aborted,
      );
      this.send({
        artifacts: [],
        commandId: command.commandId,
        error: classified,
        fencingToken: command.fencingToken,
        leaseToken: command.leaseToken,
        ok: false,
        sessionId: command.sessionId,
        type: "command.result",
      });
      runtimeLog(
        controller.signal.aborted ? "warn" : "error",
        "runtime.command.completed",
        {
          commandId: command.commandId,
          commandType: command.commandType,
          durationMs: Date.now() - started,
          errorCode: classified.code,
          sessionId: command.sessionId,
          status: controller.signal.aborted ? "CANCELLED" : "FAILED",
        },
        error,
      );
    } finally {
      this.pending.delete(command.commandId);
    }
  }

  private heartbeat() {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.send({
      activeSessions: this.manager.descriptors().map((session) => ({
        fencingToken: session.fencingToken,
        leaseToken: session.leaseToken,
        sessionId: session.sessionId,
        state: session.state,
      })),
      maxConcurrency: maxConcurrency(),
      sentAt: new Date().toISOString(),
      type: "runtime.heartbeat",
    });
  }

  private send(message: unknown) {
    const serialized = JSON.stringify(message);
    const type =
      message && typeof message === "object" && "type" in message
        ? String(message.type)
        : "unknown";
    const identity = this.deliveryIdentity(message, type);
    if (identity) {
      if (
        this.connectionReady &&
        this.socket?.readyState === WebSocket.OPEN &&
        !this.deliveryAcknowledgements
      ) {
        this.socket.send(serialized);
        return;
      }
      this.enqueueOutbox(
        message,
        serialized,
        identity.messageId,
        identity.type,
      );
      this.flushOutbox();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(serialized);
      return;
    }
    if (type !== "human.preview.frame" && type !== "runtime.heartbeat") {
      this.recordDrop(type, "not_bufferable");
    }
  }

  private enqueueOutbox(
    message: unknown,
    serialized: string,
    messageId: string,
    messageType: BufferedRuntimeMessageType,
  ) {
    if (
      this.outbox.some(
        (queued) =>
          queued.messageId === messageId && queued.messageType === messageType,
      )
    ) {
      return;
    }
    const bytes = Buffer.byteLength(serialized);
    const maxBytes = 10 * 1_024 * 1_024;
    const maxMessages = 500;
    if (bytes > maxBytes) {
      this.recordDrop(messageType, "message_too_large");
      return;
    }
    while (
      this.outbox.length > 0 &&
      (this.outbox.length >= maxMessages || this.outboxBytes + bytes > maxBytes)
    ) {
      const removed = this.outbox.shift()!;
      this.outboxBytes -= removed.bytes;
      this.recordDrop(removed.messageType, "outbox_capacity");
    }
    this.outbox.push({ bytes, message, messageId, messageType, sent: false });
    this.outboxBytes += bytes;
    runtimeLog("warn", "runtime.message.buffered", {
      bytes,
      messageType,
      queuedBytes: this.outboxBytes,
      queuedMessages: this.outbox.length,
    });
  }

  private flushOutbox() {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      this.outbox.length === 0
    ) {
      return;
    }
    let sentMessages = 0;
    for (const queued of [...this.outbox]) {
      if (this.socket.readyState !== WebSocket.OPEN || queued.sent) continue;
      try {
        this.socket.send(JSON.stringify(queued.message));
        sentMessages += 1;
        if (this.deliveryAcknowledgements) {
          queued.sent = true;
        } else {
          const index = this.outbox.indexOf(queued);
          if (index >= 0) this.outbox.splice(index, 1);
          this.outboxBytes -= queued.bytes;
        }
      } catch (error) {
        runtimeLog(
          "warn",
          "runtime.outbox.send_failed",
          { messageId: queued.messageId, messageType: queued.messageType },
          error,
        );
        break;
      }
    }
    runtimeLog("info", "runtime.outbox.sent", {
      acknowledgementRequired: this.deliveryAcknowledgements,
      remainingMessages: this.outbox.length,
      sentMessages,
    });
  }

  private acknowledgeOutbox(
    messageId: string,
    messageType: BufferedRuntimeMessageType,
  ) {
    const index = this.outbox.findIndex(
      (queued) =>
        queued.messageId === messageId && queued.messageType === messageType,
    );
    if (index < 0) return;
    const [acknowledged] = this.outbox.splice(index, 1);
    this.outboxBytes -= acknowledged!.bytes;
    if (messageType === "profile.lifecycle") {
      void removePendingProfileLifecycleEvent(profileRoot, messageId).catch(
        (error) =>
          runtimeLog(
            "warn",
            "runtime.profile.lifecycle_ack_cleanup_failed",
            { eventId: messageId },
            error,
          ),
      );
    }
    runtimeLog("debug", "runtime.outbox.acknowledged", {
      messageId,
      messageType,
      remainingMessages: this.outbox.length,
    });
    this.flushOutbox();
  }

  private deliveryIdentity(message: unknown, type: string) {
    if (!message || typeof message !== "object") return undefined;
    if (type === "command.result" && "commandId" in message) {
      return {
        messageId: String(message.commandId),
        type: "command.result" as const,
      };
    }
    if (type === "human.input.result" && "dispatchId" in message) {
      return {
        messageId: String(message.dispatchId),
        type: "human.input.result" as const,
      };
    }
    if (type === "runtime.event" && "eventId" in message) {
      return {
        messageId: String(message.eventId),
        type: "runtime.event" as const,
      };
    }
    if (type === "profile.lifecycle" && "eventId" in message) {
      return {
        messageId: String(message.eventId),
        type: "profile.lifecycle" as const,
      };
    }
    return undefined;
  }

  private recordDrop(messageType: string, reason: string) {
    this.droppedMessages += 1;
    if (this.droppedMessages === 1 || this.droppedMessages % 10 === 0) {
      runtimeLog("error", "runtime.message.dropped", {
        droppedMessages: this.droppedMessages,
        messageType,
        reason,
      });
    }
  }
}

async function pair() {
  const apiUrl = argument("api") ?? process.env.DEVPROOF_API_URL;
  const pairingToken = await pairingTokenFromInputs(
    process.argv,
    process.stdin,
    process.env,
  );
  if (!apiUrl || !pairingToken) {
    throw new Error("pair requires --api and a pairing token.");
  }
  const normalizedApiUrl = apiUrl.replace(/\/$/u, "");
  const response = await fetch(normalizedApiUrl + "/runtime/pair", {
    body: JSON.stringify({
      capabilities: [
        "playwright",
        "screenshots",
        "dom",
        "network",
        "console",
        "accessibility-snapshot",
        "tabs",
        "frames",
        "network-fault-injection",
        "strict-command-schema",
        "ssrf-proxy",
        "persistent-profile",
        "ephemeral-profile",
        "human-control",
      ],
      deviceInfo: platform() + " " + release(),
      instanceKey:
        process.env.DEVPROOF_INSTANCE_KEY ?? hostname() + "-" + platform(),
      maxConcurrency: maxConcurrency(),
      name: process.env.DEVPROOF_RUNTIME_NAME ?? hostname(),
      pairingToken,
      version: runtimeVersion,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      "Runtime pairing failed: " +
        response.status +
        " " +
        (await response.text()),
    );
  }
  const result = (await response.json()) as {
    gatewayUrl: string;
    runtimeId: string;
    runtimeToken: string;
  };
  const store = new StateStore({
    apiUrl: normalizedApiUrl,
    gatewayUrl: result.gatewayUrl,
    runtimeId: result.runtimeId,
    runtimeToken: result.runtimeToken,
    sessions: [],
  });
  await store.save();
  runtimeLog("info", "runtime.paired", { runtimeId: result.runtimeId });
}

async function start() {
  const store = await StateStore.load();
  const proxy = await startSsrfProxy();
  const client = new RuntimeClient(store, proxy);
  const stop = () => client.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await client.start();
  } finally {
    await proxy.stop();
  }
}

async function install() {
  const require = createRequire(import.meta.url);
  const playwrightCli = join(
    dirname(require.resolve("playwright/package.json")),
    "cli.js",
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [playwrightCli, "install", "--no-shell", "chromium"],
      {
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            "Playwright browser installation failed with " +
              (signal ? "signal " + signal : "exit code " + code) +
              ".",
          ),
        );
      }
    });
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "pair") {
    await pair();
  } else if (command === "install") {
    await install();
  } else if (command === "start") {
    await start();
  } else {
    runtimeLog("error", "runtime.cli.invalid_command", {
      usage:
        "devproof-browser-runtime <install | pair --api URL (--token TOKEN | --token-stdin) | start>",
    });
    process.exitCode = 1;
  }
}

export function isMainModule(
  entryPath = process.argv[1],
  moduleUrl = import.meta.url,
): boolean {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    const detail =
      process.env.DEVPROOF_DEBUG === "true" && error instanceof Error
        ? (error.stack ?? error.message)
        : error instanceof Error
          ? error.message
          : String(error);
    runtimeLog("error", "runtime.failed", { detail });
    process.exitCode = 1;
  }
}
