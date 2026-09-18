import { describe, expect, it } from "vitest";
import {
  networkCheckSchema,
  structuredNetworkMatches,
} from "./network-check.js";
const check = networkCheckSchema.parse({
  method: "PUT",
  path: "/whitelist",
  part: "REQUEST_BODY",
  field: "config",
  equals: '{"value":false}',
  encoding: "JSON_STRING",
  where: [{ part: "REQUEST_BODY", field: "type", equals: "MAPPING" }],
});
const request = {
  method: "PUT",
  url: "https://app.test/whitelist",
  requestBody: { id: 31, type: "MAPPING", config: '{ "value": false }' },
};
describe("structured network contracts", () => {
  it("compares typed fields independently of display labels and JSON formatting", () => {
    expect(structuredNetworkMatches(JSON.stringify(request), check)).toBe(true);
  });
  it.each([
    { ...request, method: "POST" },
    { ...request, url: "https://app.test/other" },
    { ...request, requestBodyTruncated: true },
    { ...request, requestBody: undefined },
    { ...request, requestBody: { ...request.requestBody, type: "LEGACY" } },
    {
      ...request,
      requestBody: { ...request.requestBody, config: { value: false } },
    },
    {
      ...request,
      requestBody: { ...request.requestBody, config: '{"value":true}' },
    },
  ])(
    "rejects wrong method, resource, subject, value, representation or missing body",
    (value) => {
      expect(structuredNetworkMatches(JSON.stringify(value), check)).toBe(
        false,
      );
    },
  );
  it("checks query and response independently, rejecting repeated query fields", () => {
    const q = networkCheckSchema.parse({
      method: "GET",
      path: "/list",
      part: "QUERY",
      field: "type",
      equals: "MAPPING",
    });
    expect(
      structuredNetworkMatches(
        JSON.stringify({
          method: "GET",
          url: "https://app.test/list?type=MAPPING",
          bodyPending: true,
        }),
        q,
      ),
    ).toBe(true);
    expect(
      structuredNetworkMatches(
        JSON.stringify({
          method: "GET",
          url: "https://app.test/list?type=MAPPING&type=LEGACY",
        }),
        q,
      ),
    ).toBe(false);
  });
});
