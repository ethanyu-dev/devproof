import { bytesLabel } from "./context-display";
import styles from "./step-context.module.css";

const reasons: Record<string, string> = {
  OLDER_SUMMARY_BUDGET: "省略较早操作摘要",
  DETAIL_TO_SUMMARY: "详细操作改用摘要",
  PAGINATED_FOR_BUDGET: "当前页面改用分页",
  LOWER_PRIORITY_OBSERVATION_BUDGET: "省略部分历史验收观察",
  LOWER_PRIORITY_OBJECT_BUDGET: "省略部分对象证据",
};

/** Older archives lack these metrics; do not invent budgets for them. */
export function ContextBudget({ metrics }: { metrics: unknown }) {
  const data = object(metrics);
  if (
    typeof data.maxTextBytes !== "number" ||
    typeof data.textRequestBytes !== "number"
  )
    return null;
  const trims = Array.isArray(data.truncations)
    ? data.truncations.map(object)
    : [];
  const window = object(data.windowBudget);
  const unknown = Array.isArray(window.unconfiguredModels)
    ? window.unconfiguredModels
    : [];
  return (
    <details className={styles.raw}>
      <summary>
        上下文预算{" "}
        <span>
          {bytesLabel(data.textRequestBytes)} / {bytesLabel(data.maxTextBytes)}
        </span>
      </summary>
      {typeof data.configuredMaxTextBytes === "number" && (
        <p>
          Runtime 本次生效配置：{bytesLabel(data.configuredMaxTextBytes)}；
          模型窗口约束后的文本预算：{bytesLabel(data.maxTextBytes)}。
          配置来自执行进程；修改配置文件后需在新进程、新请求中核对生效值。
        </p>
      )}
      <p>
        本轮保留 {number(data.detailedTurns)} 轮详细事实、
        {number(data.summaryTurns)} 轮摘要，附带 {number(data.imageCount)}{" "}
        张图片。 文本预算包含工具定义和图片说明；图片像素单独计算。
      </p>
      {trims.length ? (
        <ul>
          {trims.map((trim, index) => (
            <li key={index}>
              {reasons[String(trim.reason)] ?? String(trim.reason)}：
              {number(trim.count)} 项
            </li>
          ))}
        </ul>
      ) : (
        <p>本轮未因总预算额外裁剪内容。</p>
      )}
      <p>
        {number(data.resultsWithOmissions)} 个工具结果带有截断或省略标记；
        未展示 {number(object(data.omitted).savedObservations)} 条历史观察、
        {number(object(data.omitted).objectBindings)} 条对象证据。
        已保存的证据仍可按引用读取。
      </p>
      <p>
        {unknown.length
          ? `未配置模型窗口：${unknown.join("、")}。这些模型仅按文本字节预算控制。`
          : "模型窗口按配置预留输出和图片空间，输入 token 使用保守估算；实际用量以模型返回值为准。"}
      </p>
    </details>
  );
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
