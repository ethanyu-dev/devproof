import { isDeepStrictEqual } from "node:util";

const queryTarget =
  /请求.*参数|查询请求|列表查询|query\s*(?:param|parameter)/iu;
const requestBodyTarget = /请求体|request\s*body/iu;
const responseBodyTarget = /响应体|response\s*body/iu;
export const requiresStructuredNetworkTarget = (label: string) =>
  queryTarget.test(label) ||
  requestBodyTarget.test(label) ||
  responseBodyTarget.test(label);

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const parse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/** Compatibility for existing text-based Spec targets. Only observed
 * network citations reach here. Scope comparisons to the declared request part;
 * JSON equality ignores formatting/key order but preserves values and types.
 */
export function networkRequestMatches(
  quote: string,
  target: string,
  expected: string,
) {
  const request = parse(quote);
  if (!object(request)) return false;
  const explicitQuery = /^([A-Za-z_][\w.-]*)=([^\r\n]*)$/u.exec(expected);
  const query = queryTarget.test(target);
  // Do not use a creation receipt to prove a later update's request contract.
  if (/新增|创建/.test(target) && request.method !== "POST") return false;
  if (
    /更新|编辑|修改/.test(target) &&
    !["PUT", "PATCH"].includes(String(request.method))
  )
    return false;
  if (query && explicitQuery) {
    try {
      const params = new URL(String(request.url)).searchParams;
      return (
        params.getAll(explicitQuery[1]!).length === 1 &&
        params.get(explicitQuery[1]!) === explicitQuery[2]
      );
    } catch {
      return false;
    }
  }
  const requestBody = requestBodyTarget.test(target);

  const responseBody = responseBodyTarget.test(target);
  if (!requestBody && !query && !responseBody) return false;
  // Missing response data must not invalidate an independently captured request body.
  if (
    requestBody &&
    (request.requestBodyTruncated === true ||
      request.requestBodyOmitted !== undefined)
  )
    return false;
  if (
    responseBody &&
    (request.bodyPending === true ||
      request.responseBodyTruncated === true ||
      request.responseBodyOmitted !== undefined)
  )
    return false;
  let value: unknown;
  if (query) {
    try {
      const params = new URL(String(request.url)).searchParams;
      // Repeated parameters do not have an unambiguous scalar value.
      if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
        return false;
      value = Object.fromEntries(params);
    } catch {
      return false;
    }
  } else value = request[requestBody ? "requestBody" : "responseBody"];
  if (!object(value)) return false;
  if (/字段集合|field\s*(?:set|keys)/i.test(target)) {
    const keys = expected.split(/\s*[,，、]\s*/).filter(Boolean);
    return (
      keys.length > 0 &&
      new Set(keys).size === keys.length &&
      isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
    );
  }
  // Explicit field names in legacy targets (e.g. 请求体 config（关闭开关）).
  const fields = Object.keys(value).filter((key) =>
    target.split(/[^\p{L}\p{N}_]+/u).includes(key),
  );
  if (fields.length !== 1) return false;
  const observed = value[fields[0]!];
  const expectedJson = parse(expected);
  if (expectedJson !== undefined) {
    return isDeepStrictEqual(
      typeof observed === "string" ? parse(observed) : observed,
      expectedJson,
    );
  }
  return typeof observed === "string" && observed === expected;
}
