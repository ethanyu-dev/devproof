export type SpecificationContextSource = "LINEAR" | "GITHUB" | "KNOWLEDGE";

export class ContextSourceError extends Error {
  constructor(
    readonly source: SpecificationContextSource,
    readonly code: string,
    message: string,
    readonly reference: string | null = null,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ContextSourceError";
  }
}
