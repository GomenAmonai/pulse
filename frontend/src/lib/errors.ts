/** An error response from the API (or the demo engine). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public data: Record<string, unknown>,
  ) {
    super(ApiError.message(status, data));
  }

  private static message(status: number, data: Record<string, unknown>): string {
    if (typeof data.detail === "string") return data.detail;
    const first = Array.isArray(data.detail) ? (data.detail[0] as { msg?: string } | undefined) : undefined;
    return first?.msg ?? `Request failed with ${status}`;
  }

  /** Machine-readable code of a domain error: "blocked_target", "rate_limited", ... */
  get code(): string | undefined {
    return typeof this.data.code === "string" ? this.data.code : undefined;
  }

  /**
   * Validation messages by field. FastAPI sends `{"detail": [{"loc": ["body", "url"], "msg": ...}]}`;
   * a model-level validator has no field in `loc` and lands under "_".
   */
  get fields(): Record<string, string> {
    if (!Array.isArray(this.data.detail)) return {};
    const out: Record<string, string> = {};
    for (const item of this.data.detail as { loc?: (string | number)[]; msg?: string }[]) {
      const loc = item.loc ?? [];
      const key = loc.length > 1 ? String(loc[loc.length - 1]) : "_";
      out[key] ??= (item.msg ?? "Invalid value").replace(/^Value error, /, "");
    }
    return out;
  }
}
