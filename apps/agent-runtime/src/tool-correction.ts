import {
  getRuntimeActionCommandSchema,
  type runtimeActionCommandInputSchema,
} from "@devproof/runtime-protocol";
import { z } from "zod";

interface CorrectionIssue {
  path: string;
  expected: string;
}

export interface ToolCorrection {
  accepted: false;
  code:
    "INVALID_JSON" | "INVALID_ARGUMENTS" | "UNKNOWN_COMMAND" | "UNKNOWN_TOOL";
  error: string;
  issues: CorrectionIssue[];
  suggestions: string[];
  nextAction: string;
  retryable: true;
}

const MAX_CORRECTION_BYTES = 2 * 1_024;
const commandSuggestions = new Map<string, string[]>([
  ["page.content", ["page.get_text", "page.dom"]],
  ["element.click", ["page.click"]],
  ["element.fill", ["page.fill"]],
  ["page.goto", ["page.navigate"]],
]);
const recoveryInputSchema = z.object({
  locatorRecoveryToken: z.string().min(1).max(240).optional(),
});

/** All strings supplied here are application messages, never raw Zod messages. */
export function toolCorrection(
  error: string,
  options: {
    code?: ToolCorrection["code"];
    issues?: CorrectionIssue[];
    suggestions?: string[];
    nextAction?: string;
  } = {},
): ToolCorrection {
  const result: ToolCorrection = {
    accepted: false,
    code: options.code ?? "INVALID_ARGUMENTS",
    error: boundedText(error, 600),
    issues: (options.issues ?? []).slice(0, 3).map((issue) => ({
      path: boundedText(issue.path, 120),
      expected: boundedText(issue.expected, 300),
    })),
    suggestions: (options.suggestions ?? [])
      .filter((name) => getRuntimeActionCommandSchema(name))
      .slice(0, 2),
    nextAction: boundedText(
      options.nextAction ?? "请根据问题说明修正参数，再提交一次工具调用。",
      300,
    ),
    retryable: true,
  };
  // Count the actual JSON representation, including escaping. Drop optional
  // details before shortening the message; never slice serialized JSON.
  while (Buffer.byteLength(JSON.stringify(result)) > MAX_CORRECTION_BYTES) {
    if (result.issues.length > 1) result.issues.pop();
    else if (result.suggestions.length) result.suggestions.pop();
    else if (result.nextAction) result.nextAction = "";
    else if (result.error.length > 100)
      result.error = boundedText(result.error, 100);
    else result.issues = [];
  }
  return result;
}

export function schemaCorrection(error: z.ZodError): ToolCorrection {
  const issues = error.issues.slice(0, 3).map((issue) => {
    // Unknown property names and submitted values can contain secrets. Show
    // the owning object, not the keys or Zod's interpolated input message.
    return { path: issuePath(issue.path), expected: expectation(issue) };
  });
  const unique = issues.filter(
    (issue, index) =>
      issues.findIndex(
        (candidate) =>
          candidate.path === issue.path &&
          candidate.expected === issue.expected,
      ) === index,
  );
  return toolCorrection("工具参数不符合要求。", { issues: unique });
}

export function parseBrowserCommand(raw: Record<string, unknown>):
  | {
      success: true;
      command: z.infer<typeof runtimeActionCommandInputSchema>;
      locatorRecoveryToken?: string;
    }
  | { success: false; correction: ToolCorrection } {
  const { locatorRecoveryToken, ...command } = raw;
  if (typeof command.commandType !== "string") {
    return {
      success: false,
      correction: toolCorrection("必须提供浏览器命令名。", {
        issues: [{ path: "commandType", expected: "已公布的命令名称字符串" }],
      }),
    };
  }
  const schema = getRuntimeActionCommandSchema(command.commandType);
  if (!schema) {
    const suggestions = commandSuggestions.get(command.commandType) ?? [];
    return {
      success: false,
      correction: toolCorrection("未知浏览器命令。", {
        code: "UNKNOWN_COMMAND",
        issues: [{ path: "commandType", expected: "已公布的浏览器命令" }],
        suggestions,
        nextAction:
          command.commandType === "page.content"
            ? "读取可见文本使用 page.get_text；获取 HTML 证据使用 page.dom。"
            : "请从 browser_command 的定义中选择正确命令；本次没有执行浏览器操作。",
      }),
    };
  }
  const parsed = schema.safeParse(command);
  if (!parsed.success)
    return { success: false, correction: schemaCorrection(parsed.error) };
  const recovery = recoveryInputSchema.safeParse({ locatorRecoveryToken });
  if (!recovery.success)
    return { success: false, correction: schemaCorrection(recovery.error) };
  return {
    success: true,
    command: parsed.data,
    ...(recovery.data.locatorRecoveryToken === undefined
      ? {}
      : { locatorRecoveryToken: recovery.data.locatorRecoveryToken }),
  };
}

function issuePath(path: PropertyKey[]): string {
  return (
    path
      .slice(0, 8)
      .map((part) =>
        typeof part === "number"
          ? String(part)
          : typeof part === "string" &&
              /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/u.test(part)
            ? part
            : "[字段]",
      )
      .join(".") || "$"
  );
}

function expectation(
  issue: z.core.$ZodIssue,
  depth = 0,
  prefix: PropertyKey[] = [],
): string {
  switch (issue.code) {
    case "invalid_type":
      return `需要 ${issue.expected} 类型。`;
    case "too_small":
      return `${issue.origin} 的长度、数量或值应${issue.inclusive ? "至少为" : "大于"} ${issue.minimum}。`;
    case "too_big":
      return `${issue.origin} 的长度、数量或值应${issue.inclusive ? "最多为" : "小于"} ${issue.maximum}。`;
    case "invalid_value":
      return `请选择：${issue.values.slice(0, 6).map(String).join("、")}${issue.values.length > 6 ? "等已公布的值" : ""}。`;
    case "invalid_format":
      if (issue.path.at(-1) === "ref")
        return "使用最新 snapshot 中完整的 eN/fNeN ref，不要自行编造或截断。";
      return `需要合法的 ${issue.format} 格式。`;
    case "unrecognized_keys":
      return "移除未定义字段，仅使用该操作声明的参数。";
    case "invalid_union": {
      if (depth >= 2 || !issue.errors.length)
        return "按工具定义选择一种合法的参数形式。";
      const alternatives = issue.errors.slice(0, 3).map((branch) =>
        branch
          .slice(0, 2)
          .map(
            (child) =>
              `${issuePath([...prefix, ...issue.path, ...child.path])}：${expectation(child, depth + 1, [...prefix, ...issue.path])}`,
          )
          .join(" "),
      );
      return `满足其中一种形式：${[...new Set(alternatives)].join(" 或 ")}`;
    }
    case "custom":
      if (issue.path.at(-1) === "urlIncludes")
        return "includeResponseBodies=true 时必须提供 urlIncludes，限定响应范围。";
      if (issue.path.at(-1) === "url")
        return "导航 URL 必须使用 HTTP(S)，且不能包含用户名或密码。";
      if (issue.path.at(-1) === "verdict")
        return "PASSED 要求所有标准通过；FAILED 要求至少一条标准失败。";
      return "参数不符合该操作的约束，请检查工具定义。";
    default:
      return "参数不符合该操作的约束，请检查工具定义。";
  }
}

function boundedText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
