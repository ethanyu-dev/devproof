import { describe, expect, it } from "vitest";
import {
  defaultFilters,
  executionHref,
  executionReturnHref,
  readTaskListState,
  taskDetailHref,
  taskListHref,
  taskReturnHref,
} from "./task-navigation";

describe("task navigation", () => {
  it("restores the filtered page after visiting a task and an execution", () => {
    const filters = {
      ...defaultFilters,
      status: "WAITING_HUMAN" as const,
      kind: "ISSUE_SPEC" as const,
      period: "WEEK" as const,
      query: "登录 & 回跳",
    };
    const list = taskListHref(3, filters);
    const task = taskDetailHref("task-1", list);
    const execution = executionHref("run-1", task);
    const returnedTask = executionReturnHref(
      new URL(execution, "http://localhost").searchParams.get("returnTo"),
    );
    expect(returnedTask).toBe(task);
    const returnedList = taskReturnHref(
      new URL(returnedTask, "http://localhost").searchParams.get("returnTo"),
    );
    expect(returnedList).toBe(list);
    expect(
      readTaskListState(new URL(returnedList, "http://localhost").searchParams),
    ).toEqual({ page: 3, filters });
  });

  it("uses the list for direct visits without return context", () => {
    expect(taskDetailHref("task-1")).toBe("/console/runs/task-1");
    expect(taskReturnHref(null)).toBe("/console/runs");
    expect(executionReturnHref(null)).toBe("/console/runs");
  });

  it.each([
    "https://example.com",
    "//example.com",
    "/console/access",
    "/console/runs-other?status=PASSED",
  ])("rejects unrelated return destinations: %s", (value) => {
    expect(taskReturnHref(value)).toBe("/console/runs");
    expect(executionReturnHref(value)).toBe("/console/runs");
  });

  it("normalizes invalid page and filter values and removes old expansion state", () => {
    const query = new URLSearchParams(
      "page=-1&status=oops&kind=oops&period=oops&query=%20login%20&task=old",
    );
    const state = readTaskListState(query);
    expect(state).toEqual({
      page: 1,
      filters: { ...defaultFilters, query: "login" },
    });
    expect(taskListHref(state.page, state.filters)).toBe(
      "/console/runs?query=login",
    );
    expect(taskReturnHref("/console/runs?task=old&status=PASSED")).toBe(
      "/console/runs?status=PASSED",
    );
  });

  it("escapes task and execution identifiers as single route segments", () => {
    expect(taskDetailHref("task/with?reserved")).toBe(
      "/console/runs/task%2Fwith%3Freserved",
    );
    expect(executionHref("run/id", "/console/runs/task-1")).toMatch(
      /^\/console\/executions\/run%2Fid\?/,
    );
    expect(executionReturnHref("/console/runs/%invalid")).toBe("/console/runs");
  });
});
