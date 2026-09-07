"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  RuntimeDrainOperationSummary,
  RuntimeDrainPreview,
  RuntimeDrainResumeToken,
  RuntimeRecoveryDetail,
  RuntimeRecoveryPage,
  RuntimeRecoveryResolveWriteOutcome,
  RuntimeRecoverySummary,
} from "@devproof/contracts";
import { Button } from "@/components/ui/button";
import { consoleApi } from "@/lib/api";
import {
  recoveryClosureLabel,
  recoveryWriteLabel,
} from "./runtime-recovery-display";

type ReviewForm = {
  note: string;
  evidence: string;
  outcome: RuntimeRecoveryResolveWriteOutcome["outcome"];
};
const emptyReview: ReviewForm = { note: "", evidence: "", outcome: "VERIFIED" };
const evidenceRefs = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const when = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN") : "—";
const runtimeApiUrl =
  process.env.NEXT_PUBLIC_RUNTIME_API_URL ?? "http://localhost:4433";
const shellQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\"'\"'") + "'";
const resumeCommand =
  '"$HOME/.local/bin/devproof-browser-runtime" pair --api ' +
  shellQuote(runtimeApiUrl) +
  " --token-stdin";

export function RuntimeRecoveryPanel() {
  const [page, setPage] = useState<RuntimeRecoveryPage>({
    items: [],
    nextCursor: null,
  });
  const [state, setState] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<Array<string | null>>(
    [],
  );
  const [selected, setSelected] = useState<RuntimeRecoveryDetail | null>(null);
  const [review, setReview] = useState<ReviewForm>(emptyReview);
  const [sessionId, setSessionId] = useState("");
  const [preview, setPreview] = useState<RuntimeDrainPreview | null>(null);
  const [drain, setDrain] = useState<RuntimeDrainOperationSummary | null>(null);
  const [drainNote, setDrainNote] = useState("");
  const [drainEvidence, setDrainEvidence] = useState("");
  const [terminated, setTerminated] = useState(false);
  const [resumeNote, setResumeNote] = useState("");
  const [resumeEvidence, setResumeEvidence] = useState("");
  const [profileStoragePreserved, setProfileStoragePreserved] = useState(false);
  // A resume credential is intentionally kept only in this component's memory.
  const [resumeToken, setResumeToken] =
    useState<RuntimeDrainResumeToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestKeys = useRef(new Map<string, { body: string; key: string }>());
  // Keep the same key after a lost response; refreshing data is not a new operation.
  function idempotencyKey(scope: string, body: unknown) {
    const encoded = JSON.stringify(body);
    const previous = requestKeys.current.get(scope);
    if (previous?.body === encoded) return previous.key;
    const key = crypto.randomUUID();
    requestKeys.current.set(scope, { body: encoded, key });
    return key;
  }
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await consoleApi<RuntimeRecoveryPage>(
        `/runtime-recoveries?limit=50${state ? `&state=${encodeURIComponent(state)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        signal ? { signal } : undefined,
      );
      setPage(result);
    },
    [state, cursor],
  );
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        await load(controller.signal);
      } catch (cause) {
        if (active) setError((cause as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    const openLinkedRecovery = () => {
      const id = window.location.hash.replace(/^#recovery-/u, "");
      if (/^[0-9a-f-]{36}$/iu.test(id))
        void detail(id).catch((cause: Error) => setError(cause.message));
    };
    openLinkedRecovery();
    window.addEventListener("hashchange", openLinkedRecovery);
    return () => window.removeEventListener("hashchange", openLinkedRecovery);
  }, []);
  useEffect(() => {
    if (!resumeToken) return;
    const timer = window.setTimeout(
      () => {
        setResumeToken(null);
        setNotice("恢复票据已过期，请重新签发后使用。");
      },
      Math.max(0, new Date(resumeToken.expiresAt).getTime() - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [resumeToken]);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function detail(id: string) {
    const item = await consoleApi<RuntimeRecoveryDetail>(
      `/runtime-recoveries/${id}`,
    );
    setSelected(item);
    setPreview(null);
    setDrain(null);
    setTerminated(false);
    setResumeToken(null);
    setResumeNote("");
    setResumeEvidence("");
    setProfileStoragePreserved(false);
  }
  async function requestRecovery() {
    const item = await consoleApi<RuntimeRecoverySummary>(
      `/runtime-sessions/${encodeURIComponent(sessionId.trim())}/recovery`,
      { method: "POST", body: "{}" },
    );
    await load();
    await detail(item.id);
    setSessionId("");
    setNotice("恢复请求已记录。关闭确认与业务结果核实会分别跟踪。");
  }
  async function resolve() {
    if (!selected) return;
    const body = {
      expectedVersion: selected.version,
      note: review.note.trim(),
      outcome: review.outcome,
      evidenceRefs: evidenceRefs(review.evidence),
    };
    await consoleApi(
      `/runtime-recoveries/${selected.id}/resolve-write-outcome`,
      {
        method: "POST",
        body: JSON.stringify({
          ...body,
          idempotencyKey: idempotencyKey(`resolve:${selected.id}`, body),
        }),
      },
    );
    await load();
    await detail(selected.id);
    setReview(emptyReview);
    setNotice("核实结果已保存，符合条件的数据保护已释放。");
  }
  async function drainPreview() {
    if (!selected) return;
    const result = await consoleApi<RuntimeDrainPreview>(
      `/runtimes/${selected.runtimeId}/drain-preview`,
    );
    setPreview(result);
    setDrain(result.existingDrain);
    setTerminated(false);
    setResumeToken((token) =>
      token &&
      token.runtimeId === result.runtimeId &&
      token.drainId === result.existingDrain?.id &&
      ["ATTESTED", "RESUMING"].includes(result.drainState)
        ? token
        : null,
    );
  }
  async function freeze() {
    if (!preview) return;
    const result = await consoleApi<RuntimeDrainOperationSummary>(
      `/runtimes/${preview.runtimeId}/drain`,
      {
        method: "POST",
        body: JSON.stringify({ snapshotDigest: preview.snapshotDigest }),
      },
    );
    setDrain(result);
    setPreview({ ...preview, drainState: result.state, existingDrain: result });
    setNotice("节点已冻结新准入。请按预览范围完成基础设施排空后提交证据。");
  }
  async function attest() {
    if (!preview || !drain || !selected) return;
    const body = {
      snapshotDigest: drain.snapshotDigest,
      note: drainNote.trim(),
      evidenceRefs: evidenceRefs(drainEvidence),
      infrastructureTerminated: true,
    };
    await consoleApi(
      `/runtimes/${preview.runtimeId}/drain/${drain.id}/attest`,
      {
        method: "POST",
        body: JSON.stringify({
          ...body,
          idempotencyKey: idempotencyKey(`drain:${drain.id}`, body),
        }),
      },
    );
    await load();
    await detail(selected.id);
    await drainPreview();
    setDrainNote("");
    setDrainEvidence("");
    setNotice("排空证明已提交。节点保持冻结，未知的业务写入仍需单独核实。");
  }
  async function issueResumeToken() {
    if (!preview || !drain || !profileStoragePreserved) return;
    // An uncertain response must not leave an older, possibly revoked token visible.
    setResumeToken(null);
    const result = await consoleApi<RuntimeDrainResumeToken>(
      `/runtimes/${preview.runtimeId}/drain/${drain.id}/resume-token`,
      {
        method: "POST",
        body: JSON.stringify({
          snapshotDigest: drain.snapshotDigest,
          note: resumeNote.trim(),
          evidenceRefs: evidenceRefs(resumeEvidence),
          profileStoragePreserved: true,
        }),
      },
    );
    setResumeToken(result);
    setNotice("恢复票据已签发，旧票据已废弃。请在 10 分钟内于原宿主使用。");
    await drainPreview();
  }
  return (
    <section className="dp-form" aria-label="会话恢复">
      <h3>会话恢复与业务结果核实</h3>
      <p>
        浏览器关闭后，结果未知的写入仍保留数据保护。恢复、排空和业务核实操作需要团队管理员权限。
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <label>
        关闭进度筛选
        <select
          value={state}
          disabled={busy}
          onChange={(event) => {
            setState(event.target.value);
            setCursor(null);
            setPreviousCursors([]);
          }}
        >
          <option value="">全部</option>
          {[
            "OBSERVED",
            "REQUESTED",
            "CLOSING",
            "RETRY_WAIT",
            "WAITING_RUNTIME",
            "NEEDS_OPERATOR",
            "VERIFIED",
          ].map((value) => (
            <option key={value} value={value}>
              {recoveryClosureLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <form
        className="dp-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(requestRecovery);
        }}
      >
        <label>
          请求恢复的会话 ID
          <input
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            placeholder="输入待恢复会话的完整 ID"
            maxLength={36}
            pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
            required
          />
        </label>
        <Button type="submit" disabled={busy || !sessionId.trim()}>
          请求安全恢复
        </Button>
      </form>
      {loading ? (
        <p>正在读取恢复状态…</p>
      ) : !page.items.length ? (
        <p>当前筛选下没有恢复记录。</p>
      ) : null}
      {page.items.map((item) => (
        <article className="dp-form" id={`recovery-${item.id}`} key={item.id}>
          <strong>
            {recoveryClosureLabel(item.closureState)} ·{" "}
            {recoveryWriteLabel(item.writeOutcomeState)}
          </strong>
          <p>
            会话 {item.sessionId.slice(0, 8)} · 节点{" "}
            {item.runtimeId.slice(0, 8)} · 恢复记录 {item.id}
          </p>
          <p>
            首次发现 {when(item.createdAt)} · 最近变化 {when(item.updatedAt)} ·
            已尝试 {item.attempts} 次
            {item.nextAttemptAt && !item.resolvedAt
              ? ` · 下次检查 ${when(item.nextAttemptAt)}`
              : ""}
          </p>
          {item.lastErrorCode ? <p>最近错误：{item.lastErrorCode}</p> : null}
          {item.sourceRunId ? (
            <Link href={`/console/executions/${item.sourceRunId}`}>
              查看关联执行
            </Link>
          ) : null}
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await detail(item.id);
                setReview(emptyReview);
              })
            }
          >
            查看恢复详情
          </Button>
        </article>
      ))}
      {previousCursors.length ? (
        <Button
          disabled={busy}
          onClick={() => {
            setCursor(previousCursors[previousCursors.length - 1] ?? null);
            setPreviousCursors((old) => old.slice(0, -1));
          }}
        >
          上一页
        </Button>
      ) : null}
      {page.nextCursor ? (
        <Button
          disabled={busy}
          onClick={() => {
            setPreviousCursors((old) => [...old, cursor]);
            setCursor(page.nextCursor);
          }}
        >
          下一页
        </Button>
      ) : null}
      {selected ? (
        <section className="dp-form" aria-label="恢复详情">
          <h4>恢复详情 · {selected.id}</h4>
          <p>
            {recoveryClosureLabel(selected.closureState)} ·{" "}
            {recoveryWriteLabel(selected.writeOutcomeState)} · 版本{" "}
            {selected.version}
          </p>
          <p>
            原因：{selected.reason} · 会话 {selected.sessionId}
          </p>
          <details>
            <summary>保护范围与证明摘要</summary>
            <pre>
              {JSON.stringify(
                {
                  scope: selected.scopeSnapshot,
                  evidence: selected.evidence,
                  guards: selected.guards,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <Button
            disabled={busy}
            onClick={() => void act(() => detail(selected.id))}
          >
            刷新详情
          </Button>
          <Button
            disabled={
              busy ||
              selected.closureState === "VERIFIED" ||
              selected.closureState === "OBSERVED"
            }
            onClick={() =>
              void act(async () => {
                await consoleApi(`/runtime-recoveries/${selected.id}/retry`, {
                  method: "POST",
                  body: JSON.stringify({ expectedVersion: selected.version }),
                });
                await load();
                await detail(selected.id);
                setNotice("已请求重新检查；关闭证明要求保持不变。");
              })
            }
          >
            条件变化后重试关闭
          </Button>
          {selected.closureState !== "VERIFIED" ? (
            <p>
              关闭尚未确认，业务核实暂不可提交。节点库存为空或服务重启不能代替关闭证明。
            </p>
          ) : null}
          <form
            className="dp-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(resolve);
            }}
          >
            <h4>核实业务写入结果</h4>
            <label>
              核实结果
              <select
                value={review.outcome}
                onChange={(event) =>
                  setReview((old) => ({
                    ...old,
                    outcome: event.target.value as ReviewForm["outcome"],
                  }))
                }
              >
                <option value="VERIFIED">已核对最终业务状态</option>
                <option value="NO_WRITE">已证实没有写入</option>
                <option value="COMPENSATED">已完成补偿并核对状态</option>
              </select>
            </label>
            <label>
              核实说明
              <textarea
                required
                minLength={10}
                maxLength={2000}
                value={review.note}
                onChange={(event) =>
                  setReview((old) => ({ ...old, note: event.target.value }))
                }
                placeholder="说明核对了哪些实际业务状态及结果。"
              />
            </label>
            <label>
              证据引用（每行一条）
              <textarea
                required
                value={review.evidence}
                onChange={(event) =>
                  setReview((old) => ({ ...old, evidence: event.target.value }))
                }
                placeholder="审计记录或运维工单引用；请勿填写口令、Cookie 或令牌。"
              />
            </label>
            <Button
              type="submit"
              disabled={
                busy ||
                selected.closureState !== "VERIFIED" ||
                Boolean(selected.resolvedAt) ||
                review.note.trim().length < 10 ||
                !evidenceRefs(review.evidence).length
              }
            >
              保存核实结果并释放相关数据保护
            </Button>
          </form>
          <Button disabled={busy} onClick={() => void act(drainPreview)}>
            查看节点排空与恢复
          </Button>
          {preview ? (
            <section className="dp-form" aria-label="节点排空预览">
              <h4>节点排空与恢复</h4>
              <p>
                节点 {preview.runtimeId} · 宿主{" "}
                {preview.hostInstanceId ?? "尚未登记"} · 当前状态{" "}
                {preview.drainState}
              </p>
              <Button disabled={busy} onClick={() => void act(drainPreview)}>
                刷新节点恢复状态
              </Button>
              {preview.drainState === "NONE" ? (
                <p>
                  节点当前未被排空流程冻结。冻结会阻止整个节点接收新任务；仍合法运行的任务需要先结束或由管理员另行取消。
                </p>
              ) : null}
              <ul>
                {preview.sessions.map((session) => (
                  <li key={session.sessionId}>
                    {session.sessionId} · {session.status}
                    {session.closureVerifiedAt
                      ? " · 已确认关闭"
                      : " · 关闭未确认"}
                  </li>
                ))}
              </ul>
              {preview.drainState === "NONE" ? (
                <Button disabled={busy} onClick={() => void act(freeze)}>
                  按此预览冻结节点准入
                </Button>
              ) : null}
              {drain ? (
                <>
                  <p>
                    {preview.drainState === "NONE"
                      ? "历史排空操作"
                      : "排空操作"}{" "}
                    {drain.id} · {drain.state}
                  </p>
                  {preview.drainState === "FROZEN" &&
                  drain.state === "FROZEN" ? (
                    <form
                      className="dp-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void act(attest);
                      }}
                    >
                      <p>
                        请先核验原宿主对应的专用容器、服务进程范围或虚拟机已停止或销毁，并阻止自动重启。提交证明后，节点仍保持冻结。
                      </p>
                      <label>
                        排空核验说明
                        <textarea
                          required
                          minLength={10}
                          maxLength={2000}
                          value={drainNote}
                          onChange={(event) => setDrainNote(event.target.value)}
                        />
                      </label>
                      <label>
                        基础设施证据引用（每行一条）
                        <textarea
                          required
                          value={drainEvidence}
                          onChange={(event) =>
                            setDrainEvidence(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={terminated}
                          onChange={(event) =>
                            setTerminated(event.target.checked)
                          }
                          required
                        />
                        已核实预览中原宿主的浏览器及网络进程范围已停止或销毁，且不会自动重启。
                      </label>
                      <Button
                        type="submit"
                        disabled={
                          busy ||
                          drain.state !== "FROZEN" ||
                          !terminated ||
                          drainNote.trim().length < 10 ||
                          !evidenceRefs(drainEvidence).length
                        }
                      >
                        提交管理员排空证明
                      </Button>
                    </form>
                  ) : null}
                  {drain.state === "ATTESTED" &&
                  ["ATTESTED", "RESUMING"].includes(preview.drainState) ? (
                    <section className="dp-form" aria-label="恢复原节点">
                      <h4>恢复原节点</h4>
                      <p>
                        {preview.drainState === "RESUMING"
                          ? "配对已受理，正在等待新的 Runtime 进程握手。请启动服务后刷新状态。"
                          : "排空证明已核验，节点尚未恢复准入。可由团队管理员签发一次性票据，在原宿主重新配对。"}
                      </p>
                      <p>
                        恢复节点不会自动将浏览器身份设为
                        READY，也不会解除未知业务写入的数据保护。浏览器身份验证与业务结果核实仍须分别完成。
                      </p>
                      <form
                        className="dp-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void act(issueResumeToken);
                        }}
                      >
                        <p>
                          签发前先停止原 Runtime
                          服务并确认节点离线，保留原安装的 HOME、instanceKey 和
                          Profile
                          目录。重新签发会立即废弃该排空操作之前的恢复票据。
                        </p>
                        <label>
                          恢复核验说明
                          <textarea
                            required
                            minLength={10}
                            maxLength={2000}
                            value={resumeNote}
                            onChange={(event) =>
                              setResumeNote(event.target.value)
                            }
                            placeholder="说明已停止的原服务、保留的安装目录及恢复计划。"
                          />
                        </label>
                        <label>
                          原宿主与存储核验证据（每行一条）
                          <textarea
                            required
                            value={resumeEvidence}
                            onChange={(event) =>
                              setResumeEvidence(event.target.value)
                            }
                            placeholder="填写运维工单、存储检查等证据引用；勿填写口令、Cookie 或令牌。"
                          />
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={profileStoragePreserved}
                            onChange={(event) =>
                              setProfileStoragePreserved(event.target.checked)
                            }
                            required
                          />
                          已核实原宿主的 Profile 存储完整保留，将使用原安装的
                          HOME 和 instanceKey 恢复。
                        </label>
                        <Button
                          type="submit"
                          disabled={
                            busy ||
                            !profileStoragePreserved ||
                            resumeNote.trim().length < 10 ||
                            !evidenceRefs(resumeEvidence).length
                          }
                        >
                          {resumeToken || preview.drainState === "RESUMING"
                            ? "重新签发恢复票据并废弃旧票据"
                            : "签发一次性恢复票据"}
                        </Button>
                      </form>
                      {resumeToken ? (
                        <section
                          className="dp-form"
                          aria-label="一次性恢复票据"
                        >
                          <p>
                            票据仅在本页面临时显示，10 分钟有效，到期时间：
                            {when(resumeToken.expiresAt)}
                            。刷新页面、切换详情或隐藏后无法再次查看；需要时可重新签发。
                          </p>
                          <p>原安装 instanceKey：{resumeToken.instanceKey}</p>
                          <label>
                            一次性恢复票据
                            <textarea
                              readOnly
                              autoComplete="off"
                              spellCheck={false}
                              value={resumeToken.pairingToken}
                            />
                          </label>
                          <ol>
                            <li>
                              在原宿主使用原服务用户，保留原
                              HOME、DEVPROOF_RUNTIME_HOME 和
                              instanceKey；确认旧服务已停止。
                            </li>
                            <li>
                              运行下列命令，待命令读取标准输入时粘贴上方票据，以换行后
                              Ctrl-D 结束输入。不要把票据加到命令参数或地址中。
                              <pre>
                                {"DEVPROOF_INSTANCE_KEY=" +
                                  shellQuote(resumeToken.instanceKey) +
                                  " " +
                                  resumeCommand}
                              </pre>
                            </li>
                            <li>
                              配对成功后启动原 Runtime
                              服务，再点击“刷新节点恢复状态”确认新进程已完成握手。
                            </li>
                          </ol>
                          <Button onClick={() => setResumeToken(null)}>
                            隐藏恢复票据
                          </Button>
                        </section>
                      ) : null}
                    </section>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
