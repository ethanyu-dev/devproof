import { displayMessage } from "./display-text";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export async function requestWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) abort();
  else init?.signal?.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error("请求超时，请检查服务状态后重试。");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", abort);
  }
}

export async function consoleApi<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await requestWithTimeout("/console/api" + path, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 401) {
    window.location.href = "/login";
    throw new Error("登录状态已过期。");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      issues?: Array<{ message?: string; path?: Array<number | string> }>;
      message?: string | string[];
    } | null;
    const message = Array.isArray(body?.message)
      ? body.message.join(", ")
      : body?.message;
    const validationMessage = body?.issues
      ?.map((issue) => {
        const field = issue.path?.join(".");
        if (!issue.message) return null;
        return field ? `${field}: ${issue.message}` : issue.message;
      })
      .filter((value): value is string => Boolean(value))
      .join("；");
    throw new Error(
      message
        ? displayMessage(message)
        : validationMessage
          ? displayMessage(validationMessage)
          : body?.error
            ? displayMessage(body.error)
            : "请求失败，请稍后重试。",
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
