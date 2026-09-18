import styles from "./step-context.module.css";

/** Collapse presentation, never truncate the persisted or downloadable context. */
export function ValueView({
  value,
  depth = 0,
}: {
  value: unknown;
  depth?: number;
}) {
  if (value === null || value === undefined)
    return <p className={styles.muted}>本轮未提供此项。</p>;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object")
        return <ValueView value={parsed} depth={depth} />;
    } catch {
      /* DOM and prose stay verbatim. */
    }
    if (/^data:image\/(png|jpeg|webp);base64,/u.test(value))
      return (
        <img
          className={styles.contextImage}
          src={value}
          alt="本轮发送给模型的页面截图"
        />
      );
    return <pre className={styles.text}>{value || "（空字符串）"}</pre>;
  }
  if (typeof value !== "object") return <code>{String(value)}</code>;
  const entries = Object.entries(value);
  if (!entries.length)
    return (
      <p className={styles.muted}>
        {Array.isArray(value) ? "空列表" : "空对象"}
      </p>
    );
  return (
    <div className={styles.valueTree}>
      {entries.map(([key, child]) => {
        const label = Array.isArray(value) ? `#${Number(key) + 1}` : key;
        const simple =
          child === null ||
          typeof child === "number" ||
          typeof child === "boolean" ||
          (typeof child === "string" &&
            child.length <= 180 &&
            !/^\s*[\[{]/u.test(child) &&
            !child.startsWith("data:image/"));
        if (simple)
          return (
            <div key={key} className={styles.valueLeaf}>
              <span>{label}</span>
              <span>
                {child === null ? "null" : String(child) || "（空字符串）"}
              </span>
            </div>
          );
        return (
          <details
            key={key}
            open={depth === 0 && entries.length <= 4}
            className={styles.valueNode}
          >
            <summary>
              <span>{label}</span>
              <small>
                {typeof child === "string"
                  ? `${child.length.toLocaleString()} 字符`
                  : Array.isArray(child)
                    ? `${child.length} 项`
                    : child && typeof child === "object"
                      ? `${Object.keys(child).length} 字段`
                      : String(child)}
              </small>
            </summary>
            <ValueView value={child} depth={depth + 1} />
          </details>
        );
      })}
    </div>
  );
}
