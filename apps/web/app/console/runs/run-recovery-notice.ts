export function runRecoveryNotice(
  run: {
    lifecycle: string;
    executionDisposition: string | null;
    verdict: string | null;
  },
  recovery: { closureState: string; writeOutcomeState: string },
) {
  const needsWriteReview = ["UNKNOWN", "UNASSESSED"].includes(
    recovery.writeOutcomeState,
  );
  const completed =
    run.lifecycle === "COMPLETED" &&
    run.executionDisposition === "EXECUTED" &&
    ["PASSED", "FAILED", "INCONCLUSIVE"].includes(run.verdict ?? "");
  const diagnosticOnly =
    completed && recovery.closureState === "VERIFIED" && needsWriteReview;
  return {
    needsWriteReview,
    diagnosticOnly,
    title: diagnosticOnly
      ? "执行收尾记录"
      : needsWriteReview
        ? recovery.closureState === "VERIFIED"
          ? "浏览器已关闭，业务结果待核实"
          : "浏览器关闭与业务结果待核实"
        : "浏览器会话需要恢复处理",
    guidance: diagnosticOnly
      ? "本次验证已结束。写入审计仍有待核实项，可能来自导航或点击超时；不表示已发生业务写入，也不改变上方验收结论。可展开查看记录，核对相关业务结果。"
      : "已停止自动重试。写入审计尚无法确认是否产生业务写入，不表示已发生业务提交；执行停止原因见上方。核对相关业务数据后，可在恢复记录中记录结果，或点击“重试用例”确认重试。",
  };
}
