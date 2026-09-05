import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface BrowserProcessIdentity {
  pid: number;
  marker: string;
  processGroupId?: number;
  startedAt?: string;
}

interface ObservedProcess {
  pid: number;
  parentPid: number;
  groupId: number;
  startedAt: string;
  command: string;
}
export interface BrowserProcessScope {
  marker: string;
  processes: ObservedProcess[];
  groupIds: number[];
}

export function browserProcessMarker(sessionId: string) {
  return `--devproof-session-id=${sessionId}`;
}

async function processes() {
  const { stdout } = await execute(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,state=,lstart=,command="],
    {
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    },
  );
  return stdout.split("\n").flatMap((line): ObservedProcess[] => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/u.exec(
        line,
      );
    // A zombie has exited and cannot execute or retain a socket. Waiting for an
    // unrelated parent/init to reap it must not invalidate physical closure.
    if (!match || match[4]!.startsWith("Z")) return [];
    return [
      {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        groupId: Number(match[3]),
        startedAt: match[5]!,
        command: match[6]!,
      },
    ];
  });
}

function validateMarker(marker: string) {
  if (!/^--devproof-session-id=[a-f\d-]{36}$/u.test(marker))
    throw new Error("Invalid browser process identity.");
}

function hasMarker(row: ObservedProcess, marker: string) {
  return row.command.split(/\s+/u).includes(marker);
}
function sameProcess(left: ObservedProcess, right: ObservedProcess) {
  return (
    left.pid === right.pid &&
    left.startedAt === right.startedAt &&
    left.command === right.command
  );
}

/** The random exact argv marker protects against PID reuse, including after restart. */
export async function discoverBrowserProcess(sessionId: string) {
  const marker = browserProcessMarker(sessionId);
  validateMarker(marker);
  const found = (await processes()).find((row) => hasMarker(row, marker));
  return found
    ? {
        pid: found.pid,
        marker,
        processGroupId: found.groupId,
        startedAt: found.startedAt,
      }
    : null;
}

/** Snapshot the complete, dedicated Chromium process groups before closing their leaders. */
export async function captureBrowserProcessScope(
  marker: string,
): Promise<BrowserProcessScope> {
  validateMarker(marker);
  const inventory = await processes();
  const roots = inventory.filter((row) => hasMarker(row, marker));
  const ownGroup = inventory.find((row) => row.pid === process.pid)?.groupId;
  const groupIds = [
    ...new Set(
      roots
        .filter(
          (root) => root.groupId === root.pid && root.groupId !== ownGroup,
        )
        .map((root) => root.groupId),
    ),
  ];
  const owned = new Set(roots.map((root) => root.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of inventory)
      if (
        !owned.has(row.pid) &&
        (owned.has(row.parentPid) || groupIds.includes(row.groupId))
      ) {
        owned.add(row.pid);
        changed = true;
      }
  }
  return {
    marker,
    processes: inventory.filter((row) => owned.has(row.pid)),
    groupIds,
  };
}

export async function closeBrowserProcessScope(scope: BrowserProcessScope) {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const deadline = Date.now() + (signal === "SIGTERM" ? 2_000 : 1_000);
    do {
      const inventory = await processes();
      const remaining = inventory.filter(
        (row) =>
          scope.processes.some((previous) => sameProcess(row, previous)) ||
          hasMarker(row, scope.marker),
      );
      // Children may appear while the leader is shutting down. Only adopt them
      // while a previously observed parent is still alive, never by a reused PID.
      for (const row of inventory)
        if (
          remaining.some((parent) => parent.pid === row.parentPid) &&
          !remaining.some((owned) => owned.pid === row.pid)
        ) {
          remaining.push(row);
          scope.processes.push(row);
        }
      if (!remaining.length) {
        if (!inventory.some((row) => scope.groupIds.includes(row.groupId)))
          return;
        // A child can change its argv while shutting down. Do not signal an
        // unidentified process; give the known group the same bounded exit
        // window, then fail closed if it still contains any live process.
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      for (const row of remaining) {
        if (row.pid === process.pid)
          throw new Error("Refusing to terminate the Runtime process.");
        try {
          process.kill(row.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
  }
  throw Object.assign(
    new Error("Browser process closure could not be confirmed."),
    { code: "CLOSURE_UNVERIFIED" },
  );
}

export async function closeOrphanBrowser(identity: BrowserProcessIdentity) {
  const scope = await captureBrowserProcessScope(identity.marker);
  if (!scope.processes.length && identity.processGroupId) {
    if (
      (await processes()).some((row) => row.groupId === identity.processGroupId)
    ) {
      throw Object.assign(
        new Error("The persisted browser group has no verifiable leader."),
        { code: "CLOSURE_UNVERIFIED" },
      );
    }
  }
  await closeBrowserProcessScope(scope);
}
