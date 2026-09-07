/** Abort superseded reads and ignore responses even if a transport ignores abort. */
export class RecoveryRequest {
  private controller: AbortController | null = null;
  begin() {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      current: () =>
        this.controller === controller && !controller.signal.aborted,
    };
  }
  cancel() {
    this.controller?.abort();
    this.controller = null;
  }
}
