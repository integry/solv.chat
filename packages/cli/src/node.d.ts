declare module "node:fs/promises" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }

  export function readFile(path: string, encoding: "utf8"): Promise<string>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<string | undefined>;
  export function writeFile(path: string, data: string, encoding?: "utf8"): Promise<void>;
  export function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
  export const posix: {
    relative(from: string, to: string): string;
  };
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:util" {
  export interface ParseArgsOptionConfig {
    type: "string" | "boolean";
    short?: string;
    multiple?: boolean;
    default?: string | boolean | string[];
  }

  export interface ParseArgsConfig {
    args?: string[];
    options?: Record<string, ParseArgsOptionConfig>;
    strict?: boolean;
    allowPositionals?: boolean;
    allowNegative?: boolean;
    tokens?: boolean;
  }

  export function parseArgs(config?: ParseArgsConfig): {
    values: Record<string, string | boolean | (string | boolean)[] | undefined>;
    positionals: string[];
  };
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
};
