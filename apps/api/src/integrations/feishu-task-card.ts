export type FeishuTaskCard = {
  config: { update_multi: true };
  elements: Array<Record<string, unknown>>;
  header: {
    template: string;
    title: { content: string; tag: "plain_text" };
  };
};

export function buildFeishuTaskCard(
  payload: Record<string, unknown>,
  consoleUrl: string,
  taskTitle?: string,
): FeishuTaskCard {
  const presentation = feishuTaskCardPresentation(payload);
  const title = compactText(taskTitle ?? payload.goal, "DevProof 任务", 120);

  return {
    config: { update_multi: true },
    elements: [
      {
        tag: "div",
        text: {
          content: `${title}\n${presentation.summary}`,
          tag: "plain_text",
        },
      },
      {
        actions: [
          {
            tag: "button",
            text: {
              content: presentation.actionLabel,
              tag: "plain_text",
            },
            type: presentation.actionType,
            url: consoleUrl,
          },
        ],
        tag: "action",
      },
    ],
    header: {
      template: presentation.template,
      title: { content: presentation.label, tag: "plain_text" },
    },
  };
}

export function feishuTaskCardPresentation(payload: Record<string, unknown>) {
  if (payload.notificationKind === "TASK_COMPLETED") {
    return completionPresentation(payload);
  }
  if (payload.notificationKind === "TASK_CREATED") {
    return {
      actionLabel: "查看任务",
      actionType: "default",
      label: "DevProof · 任务已创建",
      summary: "正在准备验证",
      template: "blue",
    } as const;
  }
  if (payload.notificationKind === "HITL_RESOLVED") {
    return {
      actionLabel: "查看进度",
      actionType: "default",
      label: "DevProof · 人工操作已完成",
      summary: "已收到反馈，验证正在继续",
      template: "blue",
    } as const;
  }
  if (payload.notificationKind === "HITL_EXPIRED") {
    return {
      actionLabel: "查看详情",
      actionType: "default",
      label: "DevProof · 人工操作已超时",
      summary: "未在有效期内完成，请查看任务状态",
      template: "grey",
    } as const;
  }
  if (payload.notificationKind === "TASK_WAITING_INPUT") {
    return {
      actionLabel: "前往补充",
      actionType: "primary",
      label: "DevProof · 等待补充信息",
      summary: "请完成所需配置后继续验证",
      template: "orange",
    } as const;
  }
  return {
    actionLabel: "前往处理",
    actionType: "primary",
    label: "DevProof · 等待人工操作",
    summary: "完成操作后请在 DevProof 中确认",
    template: "orange",
  } as const;
}

function completionPresentation(payload: Record<string, unknown>) {
  const verdict = typeof payload.verdict === "string" ? payload.verdict : null;
  const lifecycle =
    typeof payload.lifecycle === "string" ? payload.lifecycle : null;
  const counts = record(payload.counts);
  const total = countValue(counts.total);
  const passed = countValue(counts.passed);
  const failed = countValue(counts.failed);

  if (verdict === "PASSED") {
    return {
      actionLabel: "查看结果",
      actionType: "default",
      label: "DevProof · 验证通过",
      summary: total > 0 ? `${passed}/${total} 个场景通过` : "任务执行成功",
      template: "green",
    } as const;
  }
  if (verdict === "FAILED") {
    return {
      actionLabel: "查看结果",
      actionType: "default",
      label: "DevProof · 验证失败",
      summary: failed > 0 ? `${failed}/${total} 个场景未通过` : "任务执行失败",
      template: "red",
    } as const;
  }
  if (lifecycle === "CANCELLED") {
    return {
      actionLabel: "查看任务",
      actionType: "default",
      label: "DevProof · 任务已取消",
      summary: "任务未继续执行",
      template: "grey",
    } as const;
  }
  if (lifecycle === "TIMED_OUT") {
    return {
      actionLabel: "查看结果",
      actionType: "default",
      label: "DevProof · 验证超时",
      summary: "请前往控制台查看详情",
      template: "red",
    } as const;
  }
  return {
    actionLabel: "查看结果",
    actionType: "default",
    label: "DevProof · 结果未确定",
    summary: "请前往控制台查看详情",
    template: "orange",
  } as const;
}

function compactText(value: unknown, fallback: string, maxLength: number) {
  if (typeof value !== "string") return fallback;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact) return fallback;
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 1)}…`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function countValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
