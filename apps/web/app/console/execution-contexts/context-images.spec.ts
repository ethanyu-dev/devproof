import { describe, expect, it } from "vitest";
import { contextImages } from "./context-images";

const image = "data:image/png;base64,aGVsbG8=";

describe("context image content", () => {
  it("finds and deduplicates screenshots in message parts and nested JSON strings", () => {
    expect(
      contextImages({
        messages: [
          { content: [{ type: "image_url", image_url: { url: image } }] },
        ],
        nested: JSON.stringify({ screenshot: image }),
      }),
    ).toEqual([image]);
  });
  it("recognizes remote image parts and base64 image sources", () => {
    expect(
      contextImages([
        { type: "image_url", image_url: "https://example.com/image.png" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        },
      ]),
    ).toEqual(["https://example.com/image.png", image]);
  });
  it("does not treat normal links, invalid JSON, or unsafe URLs as images", () => {
    expect(
      contextImages([
        "https://example.com/page",
        "{not JSON}",
        { image_url: { url: "javascript:alert(1)" } },
        { image_url: "data:text/html;base64,aGVsbG8=" },
        null,
      ]),
    ).toEqual([]);
  });
});
