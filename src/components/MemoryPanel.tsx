import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, sample } from '../api';
import type { ComponentKind, MemComponent, ProcessInfo, SampleResponse, SmapsField } from '../types';
import {
  COMPONENT_COLUMNS,
  KIND_LABELS,
  METRICS,
  type Marker,
  type Recording,
  exportRecordingCsv,
  exportRecordingJson,
  formatClock,
  formatDeltaKb,
  formatDuration,
  formatKb,
  privateKb,
} from '../lib/memory';
import { exportRecordingHtml } from '../lib/report';
import { LineChart, type ChartSeries } from './LineChart';
import { JsonView } from './JsonView';

/** Live samples kept for the chart; recordings keep everything. */
const LIVE_LIMIT = 900;
const COMPONENT_ROW_LIMIT = 300;
const INTERVALS = [500, 1000, 2000, 5000, 10000, 30000];

interface MemoryPanelProps {
  session: string;
  host: string;
  process: ProcessInfo;
  recordings: Recording[];
  onRecordingsChange: (update: (prev: Recording[]) => Recording[]) => void;
  onBack: () => void;
  onSessionLost: (message: string) => void;
}

/** Series for the process total (`component` null) or one component; both legends are explained. */
function chartSeries(samples: SampleResponse[], component: string | null): ChartSeries[] {
  return METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    term: m.key,
    color: m.color,
    values: samples.map((s) =>
      m.value(component === null ? s.totals : s.components.find((c) => c.name === component)),
    ),
  }));
}

function sleep(ms: number, signal: { cancelled: boolean }) {
  return new Promise<void>((resolve) => {
    const id = window.setTimeout(resolve, ms);
    if (signal.cancelled) {
      window.clearTimeout(id);
      resolve();
    }
  });
}

export function MemoryPanel({
  session,
  host,
  process,
  recordings,
  onRecordingsChange,
  onBack,
  onSessionLost,
}: MemoryPanelProps) {
  const [tracking, setTracking] = useState(true);
  const [intervalMs, setIntervalMs] = useState(1000);
  const [live, setLive] = useState<SampleResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** The recording in progress — a ref too, so the poll loop and unmount see the current one. */
  const [active, setActive] = useState<Recording | null>(null);
  const activeRef = useRef<Recording | null>(null);

  /** Markers of the live view; those on a sample of the recording in progress also go into it. */
  const [liveMarkers, setLiveMarkers] = useState<Marker[]>([]);

  /** "live" or the id of a finished recording to review. */
  const [view, setView] = useState<string>('live');
  const [component, setComponent] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<ComponentKind | 'all'>('all');
  const [componentFilter, setComponentFilter] = useState('');
  const [sortField, setSortField] = useState<SmapsField | 'delta'>('pss');

  function commitActive() {
    const recording = activeRef.current;
    if (!recording) return;
    activeRef.current = null;
    setActive(null);
    const finished = { ...recording, stoppedAt: Date.now() };
    if (finished.samples.length > 0) onRecordingsChange((prev) => [...prev, finished]);
  }

  // Keep what was recorded when the panel goes away mid-recording.
  useEffect(() => () => commitActive(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tracking) return;
    const signal = { cancelled: false };

    (async () => {
      while (!signal.cancelled) {
        const started = Date.now();
        try {
          const s = await sample(session, process.pid);
          if (signal.cancelled) break;
          setError(null);
          setLive((prev) => {
            const next = prev.length >= LIVE_LIMIT ? prev.slice(prev.length - LIVE_LIMIT + 1) : prev.slice();
            next.push(s);
            return next;
          });
          const recording = activeRef.current;
          if (recording) {
            const updated = { ...recording, samples: [...recording.samples, s] };
            activeRef.current = updated;
            setActive(updated);
          }
        } catch (err) {
          if (signal.cancelled) break;
          if (err instanceof ApiError && err.sessionLost) {
            onSessionLost(err.message);
            return;
          }
          setError(err instanceof Error ? err.message : String(err));
          // The process is gone or unreadable: nothing more will come of polling.
          if (err instanceof ApiError && err.status === 412) {
            commitActive();
            setTracking(false);
            return;
          }
        }
        await sleep(Math.max(0, intervalMs - (Date.now() - started)), signal);
      }
    })();

    return () => {
      signal.cancelled = true;
    };
  }, [tracking, intervalMs, session, process.pid]); // eslint-disable-line react-hooks/exhaustive-deps

  function startRecording() {
    const recording: Recording = {
      id: `${Date.now()}`,
      pid: process.pid,
      name: process.name,
      host,
      cmdline: process.cmdline,
      startedAt: Date.now(),
      samples: [],
    };
    activeRef.current = recording;
    setActive(recording);
    setTracking(true);
  }

  function stopTracking() {
    commitActive();
    setTracking(false);
  }

  /**
   * Drops the live chart — its samples and the markers on them — so collecting
   * starts again from blank (tracking, if on, carries on). Recordings keep
   * their own samples and markers, the one in progress included.
   */
  function clearLive() {
    setLive([]);
    setLiveMarkers([]);
    setError(null);
  }

  /**
   * Sets the note of the sample taken at `time` — markers are only ever placed
   * by picking a point on a chart, one per sample. An empty note removes it.
   * In the live view a sample that belongs to the recording in progress puts
   * the marker into that recording too; when reviewing, it goes into the
   * reviewed recording.
   */
  function setMarker(time: number, text: string) {
    const apply = (list: Marker[] = []): Marker[] => {
      const current = list.find((m) => m.time === time);
      const rest = list.filter((m) => m.time !== time);
      if (!text) return rest;
      return [...rest, { id: current?.id ?? `${time}-${Math.random().toString(36).slice(2, 8)}`, time, text }];
    };
    if (reviewed) {
      const reviewedId = reviewed.id;
      onRecordingsChange((prev) => prev.map((r) => (r.id === reviewedId ? { ...r, markers: apply(r.markers) } : r)));
      return;
    }
    setLiveMarkers((prev) => apply(prev));
    const recording = activeRef.current;
    if (recording?.samples.some((s) => s.time === time)) {
      const updated = { ...recording, markers: apply(recording.markers) };
      activeRef.current = updated;
      setActive(updated);
    }
  }

  // Recordings of other processes are listed below for download, but not viewable here.
  const ownRecordings = recordings.filter((r) => r.pid === process.pid);
  const reviewed = view === 'live' ? null : ownRecordings.find((r) => r.id === view) ?? null;
  const samples = reviewed ? reviewed.samples : live;
  const markers = useMemo(
    () => [...(reviewed ? reviewed.markers ?? [] : liveMarkers)].sort((a, b) => a.time - b.time),
    [reviewed, liveMarkers],
  );
  const latest = samples[samples.length - 1];
  const baseline = samples[0];

  const times = useMemo(() => samples.map((s) => s.time), [samples]);
  const totalSeries = useMemo(() => chartSeries(samples, null), [samples]);
  const componentSeries = useMemo(
    () => (component === null ? null : chartSeries(samples, component)),
    [samples, component],
  );

  const baselineByName = useMemo(
    () => new Map((baseline?.components ?? []).map((c) => [c.name, c])),
    [baseline],
  );

  const kindTotals = useMemo(() => {
    const totals = new Map<ComponentKind, number>();
    for (const c of latest?.components ?? []) totals.set(c.kind, (totals.get(c.kind) ?? 0) + (c.pss ?? 0));
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [latest]);

  const columns = COMPONENT_COLUMNS.filter((c) => latest?.fields.includes(c.field));

  const rows = useMemo(() => {
    const needle = componentFilter.trim().toLowerCase();
    const list = (latest?.components ?? []).filter(
      (c) => (kindFilter === 'all' || c.kind === kindFilter) && (!needle || c.name.toLowerCase().includes(needle)),
    );
    const delta = (c: MemComponent) => (c.pss ?? 0) - (baselineByName.get(c.name)?.pss ?? 0);
    list.sort((a, b) =>
      sortField === 'delta' ? Math.abs(delta(b)) - Math.abs(delta(a)) : (b[sortField] ?? 0) - (a[sortField] ?? 0),
    );
    return list.map((c) => ({ component: c, delta: delta(c) }));
  }, [latest, kindFilter, componentFilter, sortField, baselineByName]);

  const memTotal = latest?.meminfo.MemTotal;
  const pssShare = memTotal && latest?.totals.pss !== undefined ? (latest.totals.pss / memTotal) * 100 : undefined;

  const stats: { label: string; value: string; hint?: string }[] = latest
    ? [
        { label: 'RSS', value: formatKb(latest.totals.rss), hint: `Peak ${formatKb(latest.status.VmHWM)}` },
        {
          label: 'PSS',
          value: formatKb(latest.totals.pss),
          hint: pssShare !== undefined ? `${pssShare.toFixed(1)}% of ${formatKb(memTotal)} RAM` : undefined,
        },
        { label: 'Private', value: formatKb(privateKb(latest.totals)), hint: `Dirty ${formatKb(latest.totals.private_dirty)}` },
        { label: 'Swap', value: formatKb(latest.totals.swap ?? latest.status.VmSwap) },
        { label: 'Virtual', value: formatKb(latest.totals.size), hint: `Peak ${formatKb(latest.status.VmPeak)}` },
        {
          label: 'Anon / File / Shmem',
          value: `${formatKb(latest.status.RssAnon)}`,
          hint: `${formatKb(latest.status.RssFile)} · ${formatKb(latest.status.RssShmem)}`,
        },
        { label: 'Mappings', value: String(latest.totals.count), hint: `${latest.components.length} components` },
        { label: 'Threads', value: String(latest.status.Threads ?? '—'), hint: latest.state },
      ]
    : [];

  return (
    <>
      <section className="card">
        <div className="toolbar">
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            ← Processes
          </button>
          <div className="toolbar__title">
            <h2 className="card__title">
              {process.name} <span className="muted">PID {process.pid}</span>
            </h2>
            <div className="muted small mono ellipsis" title={process.cmdline}>
              {process.cmdline || `[${process.name}]`}
            </div>
          </div>
        </div>

        <div className="toolbar toolbar--controls">
          {tracking ? (
            <button type="button" className="btn btn--secondary" onClick={stopTracking}>
              ■ Stop tracking
            </button>
          ) : (
            <button type="button" className="btn btn--accent" onClick={() => setTracking(true)}>
              ▶ Start tracking
            </button>
          )}

          {active ? (
            <button type="button" className="btn btn--record is-recording" onClick={commitActive}>
              <span className="rec-dot" aria-hidden="true" /> Stop recording · {active.samples.length} samples ·{' '}
              {formatDuration(Date.now() - active.startedAt)}
            </button>
          ) : (
            <button type="button" className="btn btn--record" onClick={startRecording}>
              <span className="rec-dot" aria-hidden="true" /> Record
            </button>
          )}

          <button
            type="button"
            className="btn btn--secondary"
            onClick={clearLive}
            disabled={reviewed !== null || (live.length === 0 && liveMarkers.length === 0)}
            title={
              reviewed
                ? 'Switch to Live to clear the live chart'
                : active
                  ? 'Start the live chart from blank; the recording keeps its samples'
                  : 'Start the live chart from blank'
            }
          >
            Clear
          </button>

          <label className="inline-field">
            <span>Every</span>
            <select value={intervalMs} onChange={(e) => setIntervalMs(Number(e.target.value))}>
              {INTERVALS.map((ms) => (
                <option key={ms} value={ms}>
                  {ms < 1000 ? `${ms} ms` : `${ms / 1000} s`}
                </option>
              ))}
            </select>
          </label>

          <span className="muted small toolbar__end">
            {tracking ? <span className="live-dot" aria-hidden="true" /> : null}
            {latest
              ? `${reviewed ? 'Recording' : 'Last sample'} ${formatClock(latest.time)} · read in ${latest.elapsed_ms} ms`
              : tracking
                ? 'Sampling…'
                : 'Not tracking'}
          </span>
        </div>

        {markers.length > 0 && (
          <ul className="markers" aria-label="Markers">
            {markers.map((m) => (
              <li key={m.id} className="marker-chip">
                <span className="mono muted">{formatClock(m.time)}</span>
                <span className="marker-chip__text" title={m.text}>
                  {m.text}
                </span>
                <button
                  type="button"
                  className="marker-chip__remove"
                  onClick={() => setMarker(m.time, '')}
                  aria-label={`Remove marker ${m.text}`}
                  title="Remove"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="alert">{error}</p>}

        {ownRecordings.length > 0 && (
          <div className="views" role="tablist" aria-label="Data shown">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'live'}
              className={`chip${view === 'live' ? ' is-active' : ''}`}
              onClick={() => setView('live')}
            >
              Live
            </button>
            {ownRecordings.map((r) => (
              <button
                key={r.id}
                type="button"
                role="tab"
                aria-selected={view === r.id}
                className={`chip${view === r.id ? ' is-active' : ''}`}
                onClick={() => setView(r.id)}
              >
                #{recordings.indexOf(r) + 1} {formatClock(r.startedAt)} · {r.samples.length} samples
              </button>
            ))}
          </div>
        )}

        <div className="stats">
          {stats.map((s) => (
            <div key={s.label} className="stat">
              <div className="stat__label">{s.label}</div>
              <div className="stat__value">{s.value}</div>
              {s.hint && <div className="stat__hint">{s.hint}</div>}
            </div>
          ))}
        </div>

        <h3 className="section-title">Process total</h3>
        <LineChart
          times={times}
          series={totalSeries}
          markers={markers}
          onMarkerChange={setMarker}
          label={`Memory of ${process.name} over time`}
        />
        <p className="muted small chart-hint">Click a point on a chart to mark that sample with a note.</p>

        {componentSeries && component !== null && (
          <>
            <div className="section-head">
              <h3 className="section-title ellipsis" title={component}>
                Component: <span className="mono">{component}</span>
              </h3>
              <button type="button" className="btn btn--ghost" onClick={() => setComponent(null)}>
                Close
              </button>
            </div>
            <LineChart
              times={times}
              series={componentSeries}
              markers={markers}
              onMarkerChange={setMarker}
              height={220}
              label={`Memory of ${component} over time`}
            />
          </>
        )}
      </section>

      <section className="card">
        <div className="toolbar">
          <h2 className="card__title">Components</h2>
          <input
            type="search"
            className="toolbar__search"
            placeholder="Filter by path or name"
            value={componentFilter}
            onChange={(e) => setComponentFilter(e.target.value)}
            aria-label="Filter components"
          />
          <label className="inline-field">
            <span>Sort by</span>
            <select value={sortField} onChange={(e) => setSortField(e.target.value as SmapsField | 'delta')}>
              {columns.map((c) => (
                <option key={c.field} value={c.field}>
                  {c.label}
                </option>
              ))}
              <option value="delta">Δ PSS</option>
            </select>
          </label>
        </div>

        <div className="kinds">
          <button
            type="button"
            className={`chip${kindFilter === 'all' ? ' is-active' : ''}`}
            onClick={() => setKindFilter('all')}
          >
            All · {formatKb(latest?.totals.pss)}
          </button>
          {kindTotals.map(([kind, pss]) => (
            <button
              key={kind}
              type="button"
              className={`chip${kindFilter === kind ? ' is-active' : ''}`}
              onClick={() => setKindFilter(kind)}
            >
              {KIND_LABELS[kind]} · {formatKb(pss)}
            </button>
          ))}
        </div>

        <p className="muted small">
          Sizes from <code>/proc/{process.pid}/smaps</code>, summed per backing object. Δ PSS compares with the
          first sample {reviewed ? 'of the recording' : 'since tracking started'}
          {baseline ? ` (${formatClock(baseline.time)})` : ''}. Select a row to chart it.
        </p>

        <div className="table-wrap table-wrap--full table-wrap--wide">
          <table className="table table--hover">
            <thead>
              <tr>
                <th>Component</th>
                <th>Kind</th>
                <th className="num">Maps</th>
                {columns.map((c) => (
                  <th key={c.field} className="num">
                    {c.label}
                  </th>
                ))}
                <th className="num">Δ PSS</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, COMPONENT_ROW_LIMIT).map(({ component: c, delta }) => (
                <tr
                  key={c.name}
                  tabIndex={0}
                  className={component === c.name ? 'is-selected' : undefined}
                  onClick={() => setComponent(c.name)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setComponent(c.name);
                    }
                  }}
                >
                  <td className="mono component-name" title={c.name}>
                    {c.name}
                  </td>
                  <td>
                    <span className={`kind kind--${c.kind}`}>{KIND_LABELS[c.kind]}</span>
                  </td>
                  <td className="num mono">{c.count}</td>
                  {columns.map((col) => (
                    <td key={col.field} className="num mono">
                      {c[col.field] ? formatKb(c[col.field]) : <span className="muted">0</span>}
                    </td>
                  ))}
                  <td className={`num mono ${delta > 0 ? 'delta--up' : delta < 0 ? 'delta--down' : ''}`}>
                    {formatDeltaKb(delta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > COMPONENT_ROW_LIMIT && (
          <p className="muted small">
            Showing {COMPONENT_ROW_LIMIT} of {rows.length} components; filter to narrow down.
          </p>
        )}

        {latest && <JsonView value={latest} />}
      </section>

      {recordings.length > 0 && (
        <section className="card">
          <h2 className="card__title">Recordings</h2>
          <ul className="panel-list">
            {recordings.map((r, i) => (
              <li key={r.id}>
                <div className="panel-list__main">
                  <div className="strong">
                    #{i + 1} {r.name} <span className="muted">PID {r.pid} · {r.host}</span>
                  </div>
                  <div className="muted small">
                    {new Date(r.startedAt).toLocaleString()} · {formatDuration((r.stoppedAt ?? r.startedAt) - r.startedAt)} ·{' '}
                    {r.samples.length} samples
                  </div>
                </div>
                <div className="panel-list__actions">
                  <button type="button" className="btn btn--ghost" onClick={() => setView(r.id)} disabled={r.pid !== process.pid}>
                    View
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => exportRecordingHtml(r)}
                    title="Standalone report: charts and tables in one HTML file"
                  >
                    HTML
                  </button>
                  <button type="button" className="btn btn--secondary" onClick={() => exportRecordingCsv(r)}>
                    CSV
                  </button>
                  <button type="button" className="btn btn--secondary" onClick={() => exportRecordingJson(r)}>
                    JSON
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--danger"
                    onClick={() => {
                      if (view === r.id) setView('live');
                      onRecordingsChange((prev) => prev.filter((x) => x.id !== r.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
