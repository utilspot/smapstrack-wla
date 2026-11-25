import { useRef, useState } from 'react';
import { connect } from '../api';
import type { ConnectResponse } from '../types';

type AuthMode = 'password' | 'key';

/** Non-secret fields are remembered per browser; passwords and keys never are. */
const STORAGE_KEY = 'smapstrack.connect';

interface Remembered {
  host: string;
  port: string;
  user: string;
  auth: AuthMode;
}

function loadRemembered(): Remembered {
  const fallback: Remembered = { host: '', port: '22', user: '', auth: 'password' };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<Remembered>) } : fallback;
  } catch {
    return fallback;
  }
}

function saveRemembered(value: Remembered) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable — ignore */
  }
}

/** Successful connections, most recent first; same non-secret fields plus what the host reported. */
const HISTORY_KEY = 'smapstrack.history';
const HISTORY_LIMIT = 10;

interface HistoryEntry {
  host: string;
  port: number;
  user: string;
  auth: AuthMode;
  lastUsed: number;
  fingerprint?: string;
  uname?: string;
}

function historyId(entry: Pick<HistoryEntry, 'host' | 'port' | 'user'>): string {
  return `${entry.user}@${entry.host}:${entry.port}`;
}

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]).filter((e) => e && typeof e.host === 'string') : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    /* storage unavailable — ignore */
  }
}

function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const days = Math.floor(s / 86400);
  return days < 30 ? `${days} d ago` : new Date(ms).toLocaleDateString();
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** RFC 1123 host name; the server resolves it to an IPv4 address. */
const HOSTNAME = /^(?=.{1,253}$)[a-z\d]([a-z\d-]{0,61}[a-z\d])?(\.[a-z\d]([a-z\d-]{0,61}[a-z\d])?)*$/i;

/** An IPv4 address, or a host name that does not merely look like a broken one. */
function isHost(value: string): boolean {
  return IPV4.test(value) || (HOSTNAME.test(value) && !/^[\d.]+$/.test(value));
}

interface ConnectPanelProps {
  onConnected: (connection: ConnectResponse) => void;
  /** Shown above the form, e.g. why the previous session ended. */
  notice?: string | null;
}

export function ConnectPanel({ onConnected, notice }: ConnectPanelProps) {
  const initial = loadRemembered();
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(initial.port);
  const [user, setUser] = useState(initial.user);
  const [auth, setAuth] = useState<AuthMode>(initial.auth);
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');

  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const secretRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const portNumber = Number(port);
  const hostValid = isHost(host.trim());
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const canSubmit =
    hostValid && portValid && user.trim() !== '' && (auth === 'password' || privateKey.trim() !== '');

  async function loadKeyFile(file: File | undefined) {
    if (!file) return;
    setPrivateKey(await file.text());
  }

  function pickEntry(entry: HistoryEntry) {
    setHost(entry.host);
    setPort(String(entry.port));
    setUser(entry.user);
    setAuth(entry.auth);
    setError(null);
    // The secret field renders for the chosen auth mode on the next paint.
    window.requestAnimationFrame(() => secretRef.current?.focus());
  }

  function updateHistory(next: HistoryEntry[]) {
    setHistory(next);
    saveHistory(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    saveRemembered({ host: host.trim(), port, user: user.trim(), auth });
    try {
      const response = await connect({
        host: host.trim(),
        port: portNumber,
        user: user.trim(),
        ...(auth === 'password'
          ? { password }
          : { private_key: privateKey, ...(passphrase ? { passphrase } : {}) }),
      });
      setPassword('');
      setPassphrase('');
      const entry: HistoryEntry = {
        host: response.host,
        port: response.port,
        user: response.user,
        auth,
        lastUsed: Date.now(),
        fingerprint: response.fingerprint,
        uname: response.uname,
      };
      saveHistory([entry, ...history.filter((e) => historyId(e) !== historyId(entry))].slice(0, HISTORY_LIMIT));
      onConnected(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="tool tool--narrow">
      <div className="card">
        <h2 className="card__title">Connect over SSH</h2>
        <p className="card__lead">
          The server opens the SSH session and reads <code>/proc</code> on the target; nothing is
          installed there.
        </p>

        {notice && <p className="alert alert--info">{notice}</p>}

        <form onSubmit={submit} className="form-grid">
          <label className="field field--grow">
            <span className="field__label">Host</span>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.10 or host.local"
              autoComplete="off"
              aria-invalid={host !== '' && !hostValid}
              required
            />
          </label>
          <label className="field field--port">
            <span className="field__label">Port</span>
            <input
              type="text"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              aria-invalid={!portValid}
              required
            />
          </label>
          <label className="field field--full">
            <span className="field__label">User</span>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="root"
              autoComplete="username"
              required
            />
          </label>

          <div className="segmented field--full" role="radiogroup" aria-label="Authentication">
            <button
              type="button"
              role="radio"
              aria-checked={auth === 'password'}
              className={auth === 'password' ? 'is-active' : undefined}
              onClick={() => setAuth('password')}
            >
              Password
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={auth === 'key'}
              className={auth === 'key' ? 'is-active' : undefined}
              onClick={() => setAuth('key')}
            >
              Private key
            </button>
          </div>

          {auth === 'password' ? (
            <label className="field field--full">
              <span className="field__label">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                ref={secretRef}
                autoComplete="current-password"
              />
            </label>
          ) : (
            <>
              <label className="field field--full">
                <span className="field__label">Private key</span>
                <textarea
                  rows={5}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  ref={secretRef}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  spellCheck={false}
                  className="mono"
                />
              </label>
              <label className="file-pick field--full">
                <input type="file" onChange={(e) => loadKeyFile(e.target.files?.[0])} />
                <span>Load from file…</span>
              </label>
              <label className="field field--full">
                <span className="field__label">Passphrase</span>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Only if the key is encrypted"
                  autoComplete="off"
                />
              </label>
            </>
          )}

          {error && <p className="alert field--full">{error}</p>}

          <button type="submit" className="btn btn--primary field--full" disabled={pending || !canSubmit}>
            {pending ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>

      {history.length > 0 && (
        <div className="card">
          <div className="panel-head">
            <h2 className="card__title">Recent connections</h2>
            <button type="button" className="btn btn--link" onClick={() => updateHistory([])}>
              Clear all
            </button>
          </div>
          <ul className="panel-list">
            {history.map((entry) => {
              const id = historyId(entry);
              const selected =
                host.trim() === entry.host && Number(port) === entry.port && user.trim() === entry.user;
              return (
                // The whole row applies the address; its text part is the
                // button, so it is reachable by keyboard too.
                <li
                  key={id}
                  className={`is-clickable${selected ? ' is-selected' : ''}`}
                  onClick={() => pickEntry(entry)}
                >
                  <button
                    type="button"
                    className="panel-list__main panel-list__main--button"
                    title={[entry.uname, entry.fingerprint].filter(Boolean).join('\n') || undefined}
                  >
                    <span className="strong mono ellipsis">
                      {entry.user}@{entry.host}
                      {entry.port !== 22 ? `:${entry.port}` : ''}
                    </span>
                    <span className="muted small">
                      {entry.auth === 'key' ? 'Private key' : 'Password'} · {formatAgo(entry.lastUsed)}
                    </span>
                  </button>
                  <div className="panel-list__actions">
                    <button
                      type="button"
                      className="btn btn--ghost btn--danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        updateHistory(history.filter((h) => historyId(h) !== id));
                      }}
                      aria-label={`Remove ${id} from recent connections`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
