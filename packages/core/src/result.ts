export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = <T>(...errors: string[]): Result<T> => ({ ok: false, errors });

/** Collects field-prefixed validation errors so every API reports failures in one shape. */
export class Errors {
  readonly list: string[] = [];

  add(field: string, problem: string): void {
    // Field-prefixed so a client can point at the offending input without us
    // shipping a second machine-readable error format.
    this.list.push(`${field}: ${problem}`);
  }

  get failed(): boolean {
    return this.list.length > 0;
  }
}
