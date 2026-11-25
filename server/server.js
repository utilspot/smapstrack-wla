// Emulation server for the Smaps Tracker WLA UI.
//
// - Zero dependencies (Node built-ins only).
// - POST /api answers the same four methods as module.c (connect, processes,
//   sample, disconnect), but without SSH: "connect" accepts any credentials and
//   every session reads the *local* machine's /proc, so the UI gets real data
//   on a Linux dev box. Parsing follows module.c, so the JSON has the same shape.
// - Also statically serves the built client from ../dist for convenience.

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { hostname, release, machine, type } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(__dirname, '..', 'dist');

const PORT = Number(process.env.PORT) || 3001;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
};

/** Same field table as module.c's kSmapsFields. */
const SMAPS_FIELDS = {
  Size: 'size',
  Rss: 'rss',
  Pss: 'pss',
  Pss_Dirty: 'pss_dirty',
  Pss_Anon: 'pss_anon',
  Pss_File: 'pss_file',
  Pss_Shmem: 'pss_shmem',
  Shared_Clean: 'shared_clean',
  Shared_Dirty: 'shared_dirty',
  Private_Clean: 'private_clean',
  Private_Dirty: 'private_dirty',
  Referenced: 'referenced',
  Anonymous: 'anonymous',
  KSM: 'ksm',
  LazyFree: 'lazy_free',
  AnonHugePages: 'anon_huge_pages',
  ShmemPmdMapped: 'shmem_pmd_mapped',
  FilePmdMapped: 'file_pmd_mapped',
  Shared_Hugetlb: 'shared_hugetlb',
  Private_Hugetlb: 'private_hugetlb',
  Swap: 'swap',
  SwapPss: 'swap_pss',
  Locked: 'locked',
};
const FIELD_ORDER = Object.values(SMAPS_FIELDS);

/** session id → { host, user, lastUsed } */
const sessions = new Map();
const SESSION_IDLE_MS = 15 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...CORS,
  });
  res.end(payload);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        rejectBody(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

/** "1234 kB" / "1234" → 1234, anything else → undefined (module.c's parseCount). */
function parseCount(value) {
  const m = /^(\d+)\s*(kB)?$/.exec(value.trim());
  return m ? Number(m[1]) : undefined;
}

function splitField(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  return [line.slice(0, colon), line.slice(colon + 1).trim()];
}

function mappingKind(name) {
  if (name === '' || name.startsWith('[anon:')) return 'anon';
  if (name === '[heap]') return 'heap';
  if (name.startsWith('[stack')) return 'stack';
  if (/^(\[anon_shmem|\/memfd:|\/dev\/shm\/|\/SYSV)/.test(name)) return 'shmem';
  if (name.startsWith('[')) return 'kernel';
  if (name.startsWith('/')) return /\.so([. ]|$)/.test(name.slice(name.lastIndexOf('/'))) ? 'library' : 'file';
  return 'other';
}

function requireSession(body) {
  const id = typeof body.session === 'string' ? body.session : '';
  if (!id) throw new HttpError(400, '"session" is required');
  const session = sessions.get(id);
  if (!session) throw new HttpError(404, 'SSH session expired or not found, connect again');
  session.lastUsed = Date.now();
  return session;
}

function reapSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) sessions.delete(id);
}

async function connect(body) {
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  const user = typeof body.user === 'string' ? body.user.trim() : '';
  const port = body.port === undefined ? 22 : body.port;
  if (!host) throw new HttpError(400, '"host" is required');
  if (!user) throw new HttpError(400, '"user" is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, '"port" must be between 1 and 65535');
  }
  // Resolved like module.c does, to an IPv4 address, though nothing connects to it.
  try {
    await lookup(host, { family: 4 });
  } catch (err) {
    throw new HttpError(502, `Could not resolve ${host}: ${err.code ?? err.message}`);
  }
  if (!existsSync('/proc/self/smaps')) {
    throw new HttpError(502, 'Remote host has no readable /proc/<pid>/smaps (Linux required)');
  }

  const session = randomUUID();
  sessions.set(session, { host, user, lastUsed: Date.now() });
  return {
    session,
    host,
    port,
    user,
    auth_method: body.private_key ? 'publickey' : 'password',
    hostkey_type: 'ssh-ed25519',
    fingerprint: 'SHA256:emulation-no-real-ssh-connection-is-made',
    banner: 'SSH-2.0-emulation',
    uname: `${type()} ${hostname()} ${release()} ${machine()}`,
    libssh2_version: 'emulation',
  };
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function listProcesses() {
  const passwd = (await readText('/etc/passwd')) ?? '';
  const users = new Map();
  for (const line of passwd.split('\n')) {
    const [name, , uid] = line.split(':');
    if (name && uid !== undefined) users.set(Number(uid), name);
  }

  const pids = (await readdir('/proc')).filter((d) => /^\d+$/.test(d));
  const processes = [];
  await Promise.all(
    pids.map(async (pid) => {
      const status = await readText(`/proc/${pid}/status`);
      if (!status) return;
      const cmdline = ((await readText(`/proc/${pid}/cmdline`)) ?? '').replace(/\0/g, ' ').trimEnd();
      const p = { pid: Number(pid), ppid: 0, name: '', threads: 0, cmdline };
      let hasRss = false;
      for (const line of status.split('\n')) {
        const kv = splitField(line);
        if (!kv) continue;
        const [key, value] = kv;
        if (key === 'Name') p.name = value;
        else if (key === 'State') p.state = value;
        else if (key === 'PPid') p.ppid = Number.parseInt(value, 10);
        else if (key === 'Uid') p.uid = Number.parseInt(value, 10);
        else if (key === 'Threads') p.threads = Number.parseInt(value, 10);
        else if (key === 'VmRSS') {
          p.rss_kb = parseCount(value);
          hasRss = p.rss_kb !== undefined;
        } else if (key === 'VmSwap') p.swap_kb = parseCount(value);
      }
      if (p.uid !== undefined && users.has(p.uid)) p.user = users.get(p.uid);
      if (!hasRss) delete p.swap_kb;
      p.kernel_thread = !hasRss && cmdline === '';
      processes.push(p);
    }),
  );
  processes.sort((a, b) => a.pid - b.pid);
  return { time: Date.now(), processes };
}

async function sample(body) {
  const pid = body.pid;
  if (!Number.isInteger(pid) || pid < 1) throw new HttpError(400, '"pid" must be a positive integer');

  const started = Date.now();
  if (!existsSync(`/proc/${pid}`)) throw new HttpError(412, `Process ${pid} is not running`);
  const status = await readText(`/proc/${pid}/status`);
  const smaps = await readText(`/proc/${pid}/smaps`);
  if (status === null || smaps === null) {
    throw new HttpError(412, `cat: /proc/${pid}/smaps: Permission denied`);
  }
  const meminfo = (await readText('/proc/meminfo')) ?? '';

  const out = { pid, time: started, status: {}, meminfo: {} };
  for (const line of status.split('\n')) {
    const kv = splitField(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (key === 'Name') out.name = value;
    else if (key === 'State') out.state = value;
    else if (/^(Vm|Rss|Hugetlb)/.test(key) || key === 'Threads' || key === 'FDSize') {
      const n = parseCount(value);
      if (n !== undefined) out.status[key] = n;
    }
  }
  for (const line of meminfo.split('\n')) {
    const kv = splitField(line);
    const n = kv && parseCount(kv[1]);
    if (n !== undefined && n !== null) out.meminfo[kv[0]] = n;
  }

  const present = new Set();
  const totals = { count: 0 };
  const components = new Map();
  let current = null;
  for (const line of smaps.split('\n')) {
    const first = line.split(' ', 1)[0];
    if (first.includes('-') && !first.endsWith(':')) {
      const name = line.split(/\s+/).slice(5).join(' ').trim();
      current = components.get(name);
      if (!current) {
        current = { name: name || '[anon]', kind: mappingKind(name), count: 0, values: {} };
        components.set(name, current);
      }
      current.count++;
      totals.count++;
      continue;
    }
    const kv = splitField(line);
    if (!kv || !(kv[0] in SMAPS_FIELDS)) continue;
    const n = parseCount(kv[1]);
    if (n === undefined) continue;
    const field = SMAPS_FIELDS[kv[0]];
    present.add(field);
    totals[field] = (totals[field] ?? 0) + n;
    if (current) current.values[field] = (current.values[field] ?? 0) + n;
  }

  const fields = FIELD_ORDER.filter((f) => present.has(f));
  const fill = (values) => Object.fromEntries(fields.map((f) => [f, values[f] ?? 0]));

  out.elapsed_ms = Date.now() - started;
  out.fields = fields;
  out.totals = { count: totals.count, ...fill(totals) };
  out.components = [...components.values()].map((c) => ({
    name: c.name,
    kind: c.kind,
    count: c.count,
    ...fill(c.values),
  }));
  return out;
}

async function api(body) {
  reapSessions();
  switch (body.method) {
    case 'connect':
      return connect(body);
    case 'processes':
      requireSession(body);
      return listProcesses();
    case 'sample':
      requireSession(body);
      return sample(body);
    case 'disconnect': {
      const closed = typeof body.session === 'string' && sessions.delete(body.session);
      return { closed };
    }
    case undefined:
      throw new HttpError(400, '"method" is required');
    default:
      throw new HttpError(400, 'Unknown "method"');
  }
}

async function serveStatic(res, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = rel === '' || rel === sep ? join(DIST_DIR, 'index.html') : join(DIST_DIR, rel);

  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'Not found.\n\nThe client is not built yet — run `npm run build`, ' +
        'or use the Vite dev server on http://localhost:5173.\n',
    );
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(500).end('Read error');
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    if (req.method === 'POST' && pathname === '/api') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new HttpError(400, 'Request body must be valid JSON');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'Request body must be a JSON object');
      }
      return sendJson(res, 200, await api(body));
    }

    if (req.method === 'GET') {
      return serveStatic(res, pathname);
    }

    return sendJson(res, 405, { error: `Method ${req.method} not allowed for ${pathname}` });
  } catch (err) {
    return sendJson(res, err.status ?? 500, { error: err.message ?? 'Internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`Smaps Tracker emulation server → http://localhost:${PORT}`);
  console.log(`  JSON API    : POST /api  (reads this machine's /proc; no SSH)`);
  console.log(
    existsSync(join(DIST_DIR, 'index.html'))
      ? `  client      : http://localhost:${PORT}/  (from dist/)`
      : `  client      : run "npm run build" then reload, or use "npm run dev"`,
  );
});
