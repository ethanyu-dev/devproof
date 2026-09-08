export interface ModelContextOptions {
  mode?: "BOUNDED" | "LEGACY";
  maxBytes?: number;
}

export class ContextBudgetExceeded extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super("任务要求与必要执行状态超过模型输入预算，无法安全压缩。");
  }
}

/** Retain complete response groups, never a call without its output. */
export class ModelContext {
  private readonly turns: unknown[][] = [];
  private compactedTurns = 0;
  readonly bounded: boolean;
  private readonly maxBytes: number;

  constructor(
    private readonly initial: unknown[],
    options: ModelContextOptions = {},
  ) {
    this.initial = structuredClone(initial);
    this.bounded = options.mode !== "LEGACY";
    this.maxBytes = options.maxBytes ?? 96 * 1_024;
  }

  completeTurn(output: unknown[], results: Array<Record<string, unknown>>) {
    const calls = output
      .filter((item): item is Record<string, unknown> =>
        Boolean(
          item &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "function_call",
        ),
      )
      .map((item) => item.call_id);
    const replies = results
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id);
    if (
      new Set(calls).size !== calls.length ||
      calls.length !== replies.length ||
      calls.some((id) => replies.filter((reply) => reply === id).length !== 1)
    ) {
      throw new Error("Cannot retain an incomplete model/tool response group.");
    }
    this.turns.push(structuredClone([...output, ...results]));
  }

  build(baseRequest: Record<string, unknown>, state: unknown) {
    const input = () => [
      ...this.initial,
      ...(this.bounded
        ? [
            {
              role: "user",
              content: JSON.stringify({
                kind: "browser_working_state",
                data: state,
              }),
            },
          ]
        : []),
      ...this.turns.flat(),
    ];
    if (this.bounded) {
      while (this.turns.length > 4) {
        this.turns.shift();
        this.compactedTurns += 1;
      }
    }
    let view = input();
    let bytes = jsonBytes({ ...baseRequest, input: view });
    while (this.bounded && bytes > this.maxBytes && this.turns.length > 1) {
      this.turns.shift();
      this.compactedTurns += 1;
      view = input();
      bytes = jsonBytes({ ...baseRequest, input: view });
    }
    if (this.bounded && bytes > this.maxBytes)
      throw new ContextBudgetExceeded(bytes, this.maxBytes);
    return {
      input: structuredClone(view),
      metrics: {
        requestBytes: bytes,
        toolSchemaBytes: jsonBytes(baseRequest.tools ?? []),
        retainedTurns: this.turns.length,
        compactedTurns: this.compactedTurns,
      },
    };
  }
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
