/** Error raised by an LLM provider when a request or stream fails. */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number | undefined;

  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

/** 429 and 5xx are retryable; other 4xx mean we built a bad request. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
