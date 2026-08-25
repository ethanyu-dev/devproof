export const supportsDetachedProcessTrees = process.platform !== "win32";

export function signalProcessTree(
  child,
  signal,
  detached = supportsDetachedProcessTrees,
) {
  if (!child.pid) return;
  try {
    if (detached) process.kill(-child.pid, signal);
    else if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  } catch {
    // The process tree may have exited between the state check and signal.
  }
}

export function isProcessTreeRunning(
  child,
  detached = supportsDetachedProcessTrees,
) {
  if (!child.pid) return false;
  if (!detached) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function waitForProcessTrees(
  processes,
  timeoutMs,
  detached = supportsDetachedProcessTrees,
) {
  const deadline = Date.now() + timeoutMs;
  while (
    processes.some((child) => isProcessTreeRunning(child, detached)) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
