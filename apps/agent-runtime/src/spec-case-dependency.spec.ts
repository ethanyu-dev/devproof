import { describe, expect, it } from "vitest";
import { hasExternalCaseDependency } from "./spec-case-dependency.js";

describe("Case independence", () => {
  it.each([
    "不依赖其他 Case。",
    "不使用其他 Case 数据。",
    "无需已完成 Case 1。",
    "不要求已了解 ZDR 新增的完整操作路径。",
    "其他 Case 不是本用例的前提。",
    "具有管理员权限，独立检查参照界面。",
  ])("allows independent prerequisite: %s", (text) => {
    expect(hasExternalCaseDependency(text)).toBe(false);
  });
  it.each([
    "已完成 Case 1，确认目标类型可选。",
    "依赖其他用例创建的数据。",
    "已了解 ZDR 新增的完整操作路径。",
    "不依赖其他 Case，但使用 Case 2 创建的记录。",
  ])("rejects actual dependency: %s", (text) => {
    expect(hasExternalCaseDependency(text)).toBe(true);
  });
});
