import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail } from "./task-types";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ consoleApi: api }));
vi.mock("react", () => ({
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: (initial: unknown) => ({ current: initial }),
}));
import { useTaskActions } from "./use-task-actions";

describe("single Case rerun requests", () => {
  beforeEach(() => api.mockReset());

  it("updates the original task and uses the same request key after uncertain failures", async () => {
    const onRerun = vi.fn();
    const onUpdated = vi.fn();
    const actions = useTaskActions({ id: "original-task", onRerun, onUpdated });
    api.mockRejectedValueOnce(new Error("请求超时"));
    await actions.rerunCase("selected-case");
    api.mockResolvedValueOnce({ id: "original-task" } as TaskDetail);
    await actions.rerunCase("selected-case");
    expect(api.mock.calls[0]).toEqual(api.mock.calls[1]);
    expect(api.mock.calls[1]![0]).toBe(
      "/tasks/original-task/cases/selected-case/rerun",
    );
    expect(JSON.parse(api.mock.calls[1]![1].body).idempotencyKey).toMatch(
      /^case-rerun:/,
    );
    expect(onUpdated).toHaveBeenCalledWith({ id: "original-task" });
    expect(onRerun).not.toHaveBeenCalled();
    api.mockResolvedValueOnce({ id: "original-task" });
    await actions.rerunCase("selected-case");
    expect(api.mock.calls[2]![1].body).not.toEqual(api.mock.calls[1]![1].body);
  });

  it("ignores a second click while creation is pending", async () => {
    let complete!: (task: TaskDetail) => void;
    api.mockImplementationOnce(
      () =>
        new Promise<TaskDetail>((resolve) => {
          complete = resolve;
        }),
    );
    const actions = useTaskActions({
      id: "task",
      onRerun: vi.fn(),
      onUpdated: vi.fn(),
    });
    const pending = actions.rerunCase("case");
    await actions.rerunCase("case");
    expect(api).toHaveBeenCalledTimes(1);
    complete({ id: "original-task" } as TaskDetail);
    await pending;
  });
});
