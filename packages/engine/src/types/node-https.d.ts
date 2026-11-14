declare module "node:https" {
  export interface RequestOptions {
    protocol?: string | undefined;
    host?: string | undefined;
    hostname?: string | undefined;
    port?: number | undefined;
    path?: string | undefined;
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
    servername?: string | undefined;
    lookup?:
      | ((
          hostname: string,
          options: unknown,
          callback: (err: Error | null, address: string, family: number) => void,
        ) => void)
      | undefined;
    signal?: AbortSignal | undefined;
  }

  export interface IncomingMessage {
    statusCode?: number | undefined;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: Uint8Array) => void): this;
    on(event: "end", listener: () => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    resume(): this;
    destroy(error?: Error): this;
  }

  export interface ClientRequest {
    on(event: "error", listener: (err: Error) => void): this;
    end(): this;
    destroy(error?: Error): this;
  }

  export function request(
    options: RequestOptions,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest;
}
