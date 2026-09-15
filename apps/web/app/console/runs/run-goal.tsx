import { ChevronRight } from "lucide-react";

/** Keep the objective readable while preserving the original execution contract. */
export function RunGoal({ goal }: { goal: string }) {
  const [title = "", ...lines] = goal.trim().split(/\r?\n/);
  const titleIsTruncated = title.length > 240;
  const summary = titleIsTruncated ? `${title.slice(0, 240)}…` : title;
  const description = titleIsTruncated ? goal : lines.join("\n").trim();
  return (
    <>
      <p className="dp-run-goal-copy">{summary}</p>
      {description && (
        <details className="dp-run-goal-details">
          <summary>
            <ChevronRight aria-hidden="true" />
            查看完整执行说明
          </summary>
          <div className="dp-run-goal-description">{description}</div>
        </details>
      )}
    </>
  );
}
