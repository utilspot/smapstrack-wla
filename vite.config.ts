import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  name: string;
  version: string;
  description: string;
  homepage: string;
};

/**
 * Display name of the app, shared by the browser tab and the manifest entry.
 * index.html carries it as the %APP_TITLE% placeholder; the description it
 * carries as %APP_DESCRIPTION% comes straight from package.json.
 */
const APP_TITLE = 'Smaps Tracker';

const MIME: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Reads the JSON file named by the `--config` option, for `npm run build` and
 * `npm run dev` alike:
 *
 *   npm run build --config=path/to/config.json
 *   npm run dev   --config=path/to/config.json
 *
 * npm turns a flag written *before* the script's own `--` into config, which it
 * passes down as `npm_config_config`. It has to be written that way: after a
 * `--` the flag is forwarded to Vite's CLI instead, which takes `--config` as
 * the path of its own config file. A relative path is resolved against the directory npm was
 * invoked from.
 *
 * The file looks like the one CMake writes from config.json.in:
 *
 *   { "name": "smapstrack-wla", "version": "1.0.0", "baseUrl": "/app/",
 *     "endpoint": "root@192.168.1.1:5600" }
 *
 * `name` and `version` must match package.json, so the build cannot drift from
 * the project it is configured for. Null when no file is given.
 */
function readConfig(): { baseUrl?: string; endpoint: Endpoint | null } | null {
  const option = process.env.npm_config_config?.trim();
  // npm sets the config to the string "true" for a bare `--config`.
  if (!option || option === 'true') return null;

  const path = resolve(process.env.INIT_CWD ?? process.cwd(), option);

  const config = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`${path}: expected a JSON object`);
  }

  const { name, version, baseUrl, endpoint } = config as Record<string, unknown>;
  if (name !== pkg.name) {
    throw new Error(`${path}: "name" is ${JSON.stringify(name)}, package.json has ${JSON.stringify(pkg.name)}`);
  }
  if (version !== pkg.version) {
    throw new Error(
      `${path}: "version" is ${JSON.stringify(version)}, package.json has ${JSON.stringify(pkg.version)}`,
    );
  }
  if (baseUrl !== undefined && typeof baseUrl !== 'string') {
    throw new Error(`${path}: "baseUrl" must be a string`);
  }
  if (endpoint !== undefined && typeof endpoint !== 'string') {
    throw new Error(`${path}: "endpoint" must be a string`);
  }
  return { baseUrl, endpoint: parseEndpoint(path, endpoint?.trim() ?? '') };
}

/** The SSH target the app connects to by itself; see __ENDPOINT__ in src/vite-env.d.ts. */
interface Endpoint {
  user: string;
  host: string;
  port: number;
}

const SSH_DEFAULT_PORT = 22;

/**
 * Parses `endpoint` from the config file: `user@host[:port]`, the host an IPv4
 * address or a host name, the port 22 when left out. Host 0.0.0.0 is kept as is; the page swaps in its own hostname at
 * run time. Empty means no fixed endpoint; anything else malformed fails the
 * build rather than shipping a form that cannot connect.
 */
function parseEndpoint(path: string, raw: string): Endpoint | null {
  if (!raw) return null;

  const match = /^([^@\s:]+)@([^@\s:]+)(?::(\d+))?$/.exec(raw);
  const host = match?.[2] ?? '';
  const hostValid = /^[\d.]+$/.test(host)
    ? /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split('.').every((octet) => Number(octet) <= 255)
    : /^(?=.{1,253}$)[a-z\d]([a-z\d-]{0,61}[a-z\d])?(\.[a-z\d]([a-z\d-]{0,61}[a-z\d])?)*$/i.test(host);
  const port = match?.[3] === undefined ? SSH_DEFAULT_PORT : Number(match[3]);
  if (!match || !hostValid || port < 1 || port > 65535) {
    throw new Error(`${path}: "endpoint" is ${JSON.stringify(raw)}, expected user@host[:port]`);
  }
  return { user: match[1], host, port };
}

/**
 * Normalises the base URL for Vite. Unset (or empty) keeps the relative
 * default, which lets the built page work from a file server root or under any
 * path the host serves it from.
 */
function resolveBaseUrl(raw: string | undefined): string {
  if (!raw) return './';

  // Explicitly relative, or an absolute URL: pass through, trailing slash only.
  if (raw === '.' || raw === './') return './';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw.endsWith('/') ? raw : `${raw}/`;

  // Otherwise a server-absolute path, which Vite wants bounded by slashes.
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return path.endsWith('/') ? path : `${path}/`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Substitutes %NAME% placeholders in index.html, so the page and the manifest
 * are filled from the same values instead of drifting apart. Runs in dev and
 * build alike.
 */
function htmlVariables(variables: Record<string, string>): Plugin {
  return {
    name: 'smapstrack-wla:html-variables',
    transformIndexHtml(html) {
      return Object.entries(variables).reduce(
        // A function replacement, so $-sequences in a value stay literal.
        (out, [name, value]) => out.replace(new RegExp(`%${name}%`, 'g'), () => escapeHtml(value)),
        html,
      );
    },
  };
}

/**
 * The path every manifest URL is prefixed with. libnetq's WebManifest reads the
 * "base" key but never applies it (see WebManifest.c), so each `files[].url`
 * has to be the final URL the server will answer on.
 */
function manifestUrlBase(base: string): string {
  if (base.startsWith('.')) return '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return new URL(base).pathname;
  return base;
}

/**
 * The URL index.html is answered on: the base URL path exactly as given, so
 * a baseUrl of `/123` serves the page on /123 rather than /123/. Unset or
 * relative falls back to the manifest base.
 */
function manifestIndexUrl(raw: string | undefined, urlBase: string): string {
  if (!raw || raw.startsWith('.')) return urlBase;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return new URL(raw).pathname;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/**
 * Writes dist/manifest.json for libnetq's WebManifest executor. It has to be
 * generated rather than checked in: `emptyOutDir` clears dist/ on every build,
 * and the URLs have to track whatever the base URL resolved to.
 */
function webManifest(raw: string | undefined, base: string, title: string): Plugin {
  return {
    name: 'smapstrack-wla:web-manifest',
    apply: 'build',
    // writeBundle, not generateBundle: index.html and the stylesheet are only
    // added to the bundle by Vite's own hooks, which run after this plugin's.
    writeBundle(options, bundle) {
      const urlBase = manifestUrlBase(base);
      const indexUrl = manifestIndexUrl(raw, urlBase);

      // Bundled output plus anything copied verbatim out of public/.
      const names = [
        ...Object.keys(bundle),
        ...readdirSync('public', { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name),
      ].sort();

      const files = names.map((name) =>
        name === 'index.html'
          ? { url: indexUrl, file: name, type: MIME['.html'] }
          : {
              url: `${urlBase}${name}`,
              file: name,
              type: MIME[extname(name)] ?? 'application/octet-stream',
            },
      );

      const icons = ['light', 'dark'].map((colorScheme) => ({
        url: `${urlBase}favicon.svg`,
        colorScheme,
      }));

      // Card art the host's main page presents the module with.
      const screenshots = ['light', 'dark'].map((colorScheme) => ({
        url: `${urlBase}logo_wla.svg`,
        colorScheme,
      }));

      const manifest = {
        name: pkg.name,
        base: urlBase,
        entries: [
          {
            title,
            version: pkg.version,
            description: pkg.description,
            main: indexUrl,
            icons,
            screenshots,
          },
        ],
        files,
      };

      writeFileSync(
        join(options.dir ?? 'dist', 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
  };
}

const config = readConfig();
// The base URL as given, before any normalisation; undefined when unset or empty.
const rawBase = config?.baseUrl?.trim() || undefined;
const base = resolveBaseUrl(rawBase);

// Standard Vite build, tuned so `dist/` contains exactly four client files
// plus the generated manifest:
//   index.html, app.js, app.css, favicon.svg, manifest.json
export default defineConfig({
  // Prefixes every generated asset URL, in both `vite build` and `vite dev`.
  base,
  // Compile-time constants from package.json, declared in src/vite-env.d.ts.
  define: {
    __HOMEPAGE__: JSON.stringify(pkg.homepage),
    __ENDPOINT__: JSON.stringify(config?.endpoint ?? null),
  },
  plugins: [
    react(),
    htmlVariables({ APP_TITLE, APP_DESCRIPTION: pkg.description }),
    webManifest(rawBase, base, APP_TITLE),
  ],
  server: {
    port: 5173,
    watch: {
      // bitmake unpacks every bundled dependency under build/ — tens of
      // thousands of files that have nothing to do with the client, and that
      // otherwise exhaust the inotify watch limit (ENOSPC) on startup.
      ignored: ['**/build/**', '**/dist/**'],
    },
    // During `npm run dev` the UI runs on :5173 and the emulation server on
    // :3001 — proxy the JSON API across so the browser stays same-origin.
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Keep the favicon (and any other asset) as a real file, never inlined.
    assetsInlineLimit: 0,
    // One stylesheet, not per-chunk CSS.
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        manualChunks: undefined,
        entryFileNames: 'app.js',
        chunkFileNames: 'app-[name].js',
        assetFileNames: (info) => {
          if (info.name && info.name.endsWith('.css')) return 'app.css';
          return '[name][extname]';
        },
      },
    },
  },
});
