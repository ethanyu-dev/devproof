import { spawn, type ChildProcess } from "node:child_process";

type Inhibitor = Pick<ChildProcess, "once" | "kill" | "unref">;

/** Keep an unattended Mac awake while browsers are opening or still owned.
 * The assertion also ends if the runtime dies; it never changes power settings.
 */
export class SessionWakeLock {
  private readonly sessions = new Set<string>();
  private child: Inhibitor | undefined;

  constructor(
    private readonly warn: (error: unknown) => void,
    private readonly platform = process.platform,
    private readonly launch: () => Inhibitor = () =>
      spawn("/usr/bin/caffeinate", ["-i", "-s", "-w", String(process.pid)], {
        stdio: "ignore",
      }),
  ) {}

  acquire(sessionId: string) {
    if (this.platform !== "darwin") return;
    this.sessions.add(sessionId);
    if (this.child) return;
    try {
      const child = this.launch();
      this.child = child;
      child.unref();
      child.once("error", (error) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.warn(error);
      });
      child.once("exit", (code, signal) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.warn(new Error(`Sleep inhibitor exited: ${code ?? signal}`));
      });
    } catch (error) {
      this.warn(error);
    }
  }

  release(sessionId: string) {
    this.sessions.delete(sessionId);
    if (this.sessions.size || !this.child) return;
    const child = this.child;
    this.child = undefined;
    child.kill();
  }
}
