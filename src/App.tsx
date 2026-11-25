import { useCallback, useEffect, useState } from 'react';
import { connect, disconnect } from './api';
import type { ConnectResponse, ProcessInfo } from './types';
import type { Recording } from './lib/memory';
import { FIXED_ENDPOINT, RECONNECT_MS } from './lib/endpoint';
import { ConnectPanel } from './components/ConnectPanel';
import { ProcessList } from './components/ProcessList';
import { MemoryPanel } from './components/MemoryPanel';
import { TermTooltip } from './components/TermTooltip';

/**
 * The app is served from the site root unless it was built with an explicit
 * `baseUrl`; only then is there somewhere else to go "home" to. Vite's
 * default (relative `./`) counts as root: the page could be anywhere.
 */
const BASE_URL = import.meta.env.BASE_URL;
const SHOW_HOME = BASE_URL !== '/' && BASE_URL !== './';

// The page is served at the base URL without its trailing slash ("/123"; see
// manifestIndexUrl in vite.config.ts), except for the site root and a relative
// build, which stay as they are.
const MAIN_URL = SHOW_HOME ? BASE_URL.slice(0, -1) : BASE_URL;

export function App() {
  const [connection, setConnection] = useState<ConnectResponse | null>(null);
  const [process, setProcess] = useState<ProcessInfo | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  // With a fixed endpoint there is no connect form: the app connects by itself
  // and again whenever the session is gone, retrying every RECONNECT_MS.
  const [connecting, setConnecting] = useState(FIXED_ENDPOINT !== null);
  const [connectError, setConnectError] = useState<string | null>(null);
  /** Bumped by "Retry now" to restart the attempt loop without waiting. */
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (FIXED_ENDPOINT === null || connection !== null) return;
    const { host, port, user } = FIXED_ENDPOINT;
    let cancelled = false;
    let timer = 0;
    const attempt = async () => {
      setConnecting(true);
      try {
        const response = await connect({ host, port, user });
        if (cancelled) {
          // Superseded (unmounted, or "Retry now"): do not leak the session.
          disconnect(response.session).catch(() => {});
          return;
        }
        setConnectError(null);
        setNotice(null);
        setConnection(response);
      } catch (err) {
        if (cancelled) return;
        setConnectError(err instanceof Error ? err.message : String(err));
        timer = window.setTimeout(attempt, RECONNECT_MS);
      } finally {
        if (!cancelled) setConnecting(false);
      }
    };
    void attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connection, retryToken]);

  const onSessionLost = useCallback((message: string) => {
    setConnection(null);
    setProcess(null);
    setNotice(`The SSH session ended: ${message}`);
  }, []);

  async function onDisconnect() {
    if (!connection) return;
    const session = connection.session;
    setConnection(null);
    setProcess(null);
    setNotice(null);
    try {
      await disconnect(session);
    } catch {
      /* the session is gone either way */
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-start">
          <a className="brand" href={MAIN_URL}>
            <img src={`${BASE_URL}favicon.svg`} alt="" width={28} height={28} />
            <span>Smaps Tracker</span>
          </a>
          {SHOW_HOME && (
            <a className="header-link" href="/">
              Home
            </a>
          )}
        </div>
        {connection && (
          <div className="header-end">
            <span className="connection" title={`${connection.uname}\n${connection.hostkey_type} ${connection.fingerprint}`}>
              <span className="live-dot" aria-hidden="true" />
              {/* A fixed endpoint keeps its address out of the header. */}
              {FIXED_ENDPOINT ? (
                <span>Connected</span>
              ) : (
                <span className="mono">
                  {connection.user}@{connection.host}
                  {connection.port !== 22 ? `:${connection.port}` : ''}
                </span>
              )}
            </span>
            {/* A fixed endpoint would only be connected to again. */}
            {FIXED_ENDPOINT === null && (
              <button type="button" className="btn btn--ghost" onClick={onDisconnect}>
                Disconnect
              </button>
            )}
          </div>
        )}
      </header>

      <main className={connection || FIXED_ENDPOINT ? 'container container--wide' : 'container'}>
        {!connection && FIXED_ENDPOINT ? (
          <ProcessList
            session={null}
            blocked={
              <p className={connecting ? 'alert alert--info' : 'alert'}>
                {connecting
                  ? `Connecting to ${FIXED_ENDPOINT.user}@${FIXED_ENDPOINT.host}:${FIXED_ENDPOINT.port}…`
                  : `Could not connect to ${FIXED_ENDPOINT.user}@${FIXED_ENDPOINT.host}:${FIXED_ENDPOINT.port}: ${
                      connectError ?? notice
                    }. Retrying every ${RECONNECT_MS / 1000} s.`}{' '}
                {!connecting && (
                  <button type="button" className="btn btn--link" onClick={() => setRetryToken((t) => t + 1)}>
                    Retry now
                  </button>
                )}
              </p>
            }
            onSelect={setProcess}
            onSessionLost={onSessionLost}
          />
        ) : !connection ? (
          <ConnectPanel
            notice={notice}
            onConnected={(c) => {
              setNotice(null);
              setConnection(c);
            }}
          />
        ) : (
          <>
            <p className="host-line muted small">
              <span className="mono">{connection.uname}</span>
            </p>
            {process ? (
              <MemoryPanel
                key={process.pid}
                session={connection.session}
                host={connection.host}
                process={process}
                recordings={recordings}
                onRecordingsChange={setRecordings}
                onBack={() => setProcess(null)}
                onSessionLost={onSessionLost}
              />
            ) : (
              <ProcessList
                key={connection.session}
                session={connection.session}
                onSelect={setProcess}
                onSessionLost={onSessionLost}
              />
            )}
          </>
        )}
      </main>

      <TermTooltip />

      <footer className="site-footer">
        <span>
          Copyright © 2026 · MIT ·{' '}
          <a href={__HOMEPAGE__} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </span>
      </footer>
    </div>
  );
}
