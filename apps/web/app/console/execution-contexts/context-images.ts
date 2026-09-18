/** Extract image parts without changing the complete raw content. */
export function contextImages(value: unknown): string[] {
  const images = new Set<string>();
  function add(source: unknown, imageField = false) {
    if (typeof source !== "string") return;
    if (
      /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z\d+/=\s]+$/iu.test(
        source,
      ) ||
      (imageField && /^https?:\/\//iu.test(source))
    )
      images.add(source);
  }
  function visit(item: unknown) {
    if (typeof item === "string") {
      add(item);
      if (/^\s*[\[{]/u.test(item)) {
        try {
          visit(JSON.parse(item));
        } catch {
          /* Keep plain text as-is. */
        }
      }
      return;
    }
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    const record = item as Record<string, unknown>;
    if (record.image_url && typeof record.image_url === "object") {
      add((record.image_url as Record<string, unknown>).url, true);
    } else {
      add(record.image_url, true);
    }
    if (
      record.type === "image" &&
      record.source &&
      typeof record.source === "object"
    ) {
      const source = record.source as Record<string, unknown>;
      if (source.type === "base64" && typeof source.data === "string") {
        add(`data:${source.media_type};base64,${source.data}`);
      } else if (source.type === "url") add(source.url, true);
    }
    Object.values(record).forEach(visit);
  }
  visit(value);
  return [...images];
}
