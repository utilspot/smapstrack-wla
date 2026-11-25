/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the JSON API, e.g. "http://localhost:3001". Empty = same origin. */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Project homepage (package.json `homepage`), injected via `define` in vite.config.ts. */
declare const __HOMEPAGE__: string;

/**
 * SSH target the app connects to by itself, from `endpoint` in the build's
 * config.json (SMAPSTRACK_ENDPOINT in CMake); null shows the connect form.
 * Host "0.0.0.0" stands for the hostname of the page itself.
 */
declare const __ENDPOINT__: { user: string; host: string; port: number } | null;
