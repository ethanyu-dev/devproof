import type { AuthSnapshotVerification } from "@devproof/runtime-protocol";
import { chromium, type BrowserContext } from "playwright";
import { browserProcessMarker } from "./browser-processes.js";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export const ISOLATED_BROWSER_ARGS = [
  "--proxy-bypass-list=<-loopback>",
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

function matches(url: string, pattern: string) {
  const expression = pattern
    .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${expression}$`, "u").test(url);
}

export async function probeAuthSnapshot(input: {
  state: StorageState;
  sessionId: string;
  verification: AuthSnapshotVerification;
  concurrency: number;
  proxyServer: string;
  timeoutMs: number;
}) {
  const browser = await chromium.launch({
    args: [...ISOLATED_BROWSER_ARGS, browserProcessMarker(input.sessionId)],
    channel: "chromium",
    headless: process.env.DEVPROOF_HEADLESS !== "false",
    proxy: { server: input.proxyServer },
  });
  try {
    await Promise.all(
      Array.from({ length: input.concurrency }, async () => {
        const context = await browser.newContext({
          storageState: input.state,
          serviceWorkers: "block",
        });
        try {
          const page = await context.newPage();
          const response = await page.goto(input.verification.url, {
            waitUntil: "domcontentloaded",
            timeout: input.timeoutMs,
          });
          const actual = page.url();
          const success = input.verification.successUrlPatterns ?? [];
          const target = new URL(input.verification.url);
          const location = new URL(actual);
          if (
            (response && response.status() >= 400) ||
            (input.verification.loginUrlPatterns ?? []).some((pattern) =>
              matches(actual, pattern),
            ) ||
            (success.length
              ? !success.some((pattern) => matches(actual, pattern))
              : location.origin !== target.origin ||
                location.pathname.replace(/\/$/u, "") !==
                  target.pathname.replace(/\/$/u, ""))
          ) {
            throw new Error(
              "An isolated browser did not reach the authenticated verification page.",
            );
          }
          if (input.verification.authenticatedSelector) {
            await page
              .locator(input.verification.authenticatedSelector)
              .first()
              .waitFor({ state: "visible", timeout: input.timeoutMs });
          }
        } finally {
          await context.close().catch(() => undefined);
        }
      }),
    );
  } catch {
    throw Object.assign(
      new Error(
        "Authentication could not be verified in every isolated browser context.",
      ),
      {
        code: "AUTH_SNAPSHOT_PROBE_FAILED",
        retryable: false,
      },
    );
  } finally {
    await browser.close();
  }
}
