import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface BrowserProcessIdentity {
  pid: number;
  marker: string;
}

export function browserProcessMarker(sessionId: string) {
  return `--devproof-session-id=${sessionId}`;
}

async function matchingProcesses(marker: string) {
  if (!/^--devproof-session-id=[a-f\d-]{36}$/u.test(marker))
    throw new Error("Invalid browser process identity.");
  const { stdout } = await execute("ps", ["-axo", "pid=,command="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (!match || !match[2]!.split(/\s+/u).includes(marker)) return [];
    return [{ pid: Number(match[1]), marker }];
  });
}

/** The random exact argv marker protects against PID reuse, including after restart. */
export async function discoverBrowserProcess(sessionId: string) {
  const matches = await matchingProcesses(browserProcessMarker(sessionId));
  return matches[0] ?? null;
}

export async function closeOrphanBrowser(identity: BrowserProcessIdentity) {
  let matches = await matchingProcesses(identity.marker);
  for (const match of matches) {
    if (match.pid === process.pid)
      throw new Error("Refusing to terminate the Runtime process.");
    try {
      process.kill(match.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 2_000;
  while (matches.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    matches = await matchingProcesses(identity.marker);
  }
  for (const match of matches) {
    try {
      process.kill(match.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (let retry = 0; retry < 20; retry += 1) {
    if (!(await matchingProcesses(identity.marker)).length) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Object.assign(
    new Error("Browser process closure could not be confirmed."),
    { code: "CLOSURE_UNVERIFIED" },
  );
}
