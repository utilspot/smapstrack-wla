import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, listProcesses } from '../api';
import type { ProcessInfo } from '../types';
import { formatClock, formatKb } from '../lib/memory';

type SortKey = 'pid' | 'name' | 'user' | 'rss_kb' | 'swap_kb' | 'threads';

/** Rendering thousands of rows makes typing in the filter sluggish; the filter narrows it down. */
const ROW_LIMIT = 400;

/** Auto-refresh choices, ms; 0 is off. Listing over SSH takes a second or more, so no faster than 2 s. */
const AUTO_REFRESH = [0, 2000, 5000, 10000, 30000];
const AUTO_REFRESH_DEFAULT = 5000;

function formatInterval(ms: number): string {
  return ms === 0 ? 'Off' : `${ms / 1000} s`;
}

interface ProcessListProps {
  /** Null blocks the list: nothing is listed and the controls are disabled. */
  session: string | null;
  /** Shown in place of the rows while blocked, e.g. why there is no session. */
  blocked?: ReactNode;
  onSelect: (process: ProcessInfo) => void;
  onSessionLost: (message: string) => void;
}

export function ProcessList({ session, blocked, onSelect, onSessionLost }: ProcessListProps) {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  /** A Refresh click (or the first load) in flight: the button shows it. */
  const [pending, setPending] = useState(false);
  /** An automatic refresh in flight: only the status line mentions it. */
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefreshMs, setAutoRefreshMs] = useState(AUTO_REFRESH_DEFAULT);
  /** Keeps a click and the timer from listing at the same time. */
  const inFlight = useRef(false);

  const [filter, setFilter] = useState('');
  const [showKernel, setShowKernel] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('rss_kb');
  const [sortDesc, setSortDesc] = useState(true);

  /** Lists the processes again; a failed automatic refresh keeps the rows already shown. */
  const refresh = useCallback(
    async (automatic: boolean) => {
      if (session === null || inFlight.current) return;
      inFlight.current = true;
      (automatic ? setUpdating : setPending)(true);
      try {
        const response = await listProcesses(session);
        setProcesses(response.processes);
        setFetchedAt(response.time);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.sessionLost) {
          onSessionLost(err.message);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight.current = false;
        (automatic ? setUpdating : setPending)(false);
      }
    },
    [session, onSessionLost],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  // Keeps the list current until a process is chosen, which unmounts this
  // panel and so ends the loop. Each wait starts once the previous listing
  // is done, and a hidden tab skips its turn.
  useEffect(() => {
    if (autoRefreshMs === 0 || session === null) return;
    let cancelled = false;
    let timer = 0;
    const tick = async () => {
      if (cancelled) return;
      if (!document.hidden) await refresh(true);
      if (!cancelled) timer = window.setTimeout(tick, autoRefreshMs);
    };
    timer = window.setTimeout(tick, autoRefreshMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [autoRefreshMs, session, refresh]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = processes.filter((p) => {
      if (!showKernel && p.kernel_thread) return false;
      if (!needle) return true;
      return (
        String(p.pid) === needle ||
        p.name.toLowerCase().includes(needle) ||
        p.cmdline.toLowerCase().includes(needle) ||
        (p.user ?? '').toLowerCase().includes(needle)
      );
    });
    const dir = sortDesc ? -1 : 1;
    rows.sort((a, b) => {
      const av = a[sortKey] ?? (sortKey === 'user' ? '' : -1);
      const bv = b[sortKey] ?? (sortKey === 'user' ? '' : -1);
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * dir;
      return (av - bv) * dir || a.pid - b.pid;
    });
    return rows;
  }, [processes, filter, showKernel, sortKey, sortDesc]);

  function sortBy(key: SortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      // Sizes read best largest-first, names and ids from the top of the alphabet.
      setSortDesc(key === 'rss_kb' || key === 'swap_kb' || key === 'threads');
    }
  }

  function header(key: SortKey, label: string, numeric = false) {
    const active = key === sortKey;
    return (
      <th className={numeric ? 'num' : undefined} aria-sort={active ? (sortDesc ? 'descending' : 'ascending') : 'none'}>
        <button type="button" className="th-sort" onClick={() => sortBy(key)}>
          {label}
          <span className="th-sort__arrow" aria-hidden="true">
            {active ? (sortDesc ? '▾' : '▴') : ''}
          </span>
        </button>
      </th>
    );
  }

  const isBlocked = session === null;

  return (
    <section className="card" aria-busy={isBlocked}>
      {/* A disabled fieldset disables every control in the toolbar at once. */}
      <fieldset className="toolbar" disabled={isBlocked}>
        <h2 className="card__title">Processes</h2>
        <input
          type="search"
          className="toolbar__search"
          placeholder="Filter by name, command, user or PID"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter processes"
        />
        <label className="check">
          <input type="checkbox" checked={showKernel} onChange={(e) => setShowKernel(e.target.checked)} />
          <span>Kernel threads</span>
        </label>
        <label className="inline-field">
          <span>Auto-refresh</span>
          <select value={autoRefreshMs} onChange={(e) => setAutoRefreshMs(Number(e.target.value))}>
            {AUTO_REFRESH.map((ms) => (
              <option key={ms} value={ms}>
                {formatInterval(ms)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn--secondary" onClick={() => void refresh(false)} disabled={pending}>
          {pending ? 'Refreshing…' : 'Refresh'}
        </button>
      </fieldset>

      {isBlocked && blocked}
      {!isBlocked && error && <p className="alert">{error}</p>}

      <p className="muted small">
        {fetchedAt !== null
          ? `${visible.length} of ${processes.length} processes · listed at ${formatClock(fetchedAt)}`
          : pending
            ? 'Listing processes…'
            : ''}
        {fetchedAt !== null && (updating ? ' · updating…' : autoRefreshMs > 0 ? ` · updates every ${formatInterval(autoRefreshMs)}` : '')}
        {visible.length > ROW_LIMIT && ` · showing the first ${ROW_LIMIT}, filter to narrow down`}
      </p>

      <div className="table-wrap table-wrap--full">
        <table className="table table--hover">
          <thead>
            <tr>
              {header('pid', 'PID', true)}
              {header('name', 'Name')}
              {header('user', 'User')}
              {header('rss_kb', 'RSS', true)}
              {header('swap_kb', 'Swap', true)}
              {header('threads', 'Threads', true)}
              <th>Command</th>
            </tr>
          </thead>
          <tbody>
            {!isBlocked && visible.slice(0, ROW_LIMIT).map((p) => (
              <tr
                key={p.pid}
                tabIndex={0}
                onClick={() => onSelect(p)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(p);
                  }
                }}
                title="Track this process"
              >
                <td className="num mono">{p.pid}</td>
                <td className="strong">{p.name}</td>
                <td>{p.user ?? p.uid ?? '—'}</td>
                <td className="num mono">{formatKb(p.rss_kb)}</td>
                <td className="num mono">{p.swap_kb ? formatKb(p.swap_kb) : '—'}</td>
                <td className="num mono">{p.threads}</td>
                <td className="cmdline mono" title={p.cmdline}>
                  {p.cmdline || <span className="muted">[{p.name}]</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
