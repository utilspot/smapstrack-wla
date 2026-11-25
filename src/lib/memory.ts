import type { ComponentKind, SampleResponse, SmapsField, SmapsValues } from '../types';

/** "12.3 MiB" from a kB count, the unit /proc prints everything in. */
export function formatKb(kb: number | undefined): string {
  if (kb === undefined || !Number.isFinite(kb)) return '—';
  const abs = Math.abs(kb);
  if (abs < 1024) return `${kb} KiB`;
  if (abs < 1024 * 1024) return `${(kb / 1024).toFixed(abs < 10 * 1024 ? 2 : 1)} MiB`;
  return `${(kb / 1024 / 1024).toFixed(2)} GiB`;
}

/** Signed change, "+1.2 MiB" / "−300 KiB"; empty for no change. */
export function formatDeltaKb(kb: number): string {
  if (kb === 0) return '';
  const text = formatKb(Math.abs(kb));
  return kb > 0 ? `+${text}` : `−${text}`;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Private_Clean + Private_Dirty: what freeing this process would give back. */
export function privateKb(values: SmapsValues | undefined): number {
  if (!values) return 0;
  return (values.private_clean ?? 0) + (values.private_dirty ?? 0);
}

/**
 * The series every memory chart plots. Color follows the metric, never its
 * rank; the key doubles as the metric's glossary entry.
 */
export interface MetricSeries {
  key: 'rss' | 'pss' | 'private' | 'swap';
  label: string;
  /** CSS custom property holding the series color (see styles.css). */
  color: string;
  value: (values: SmapsValues | undefined) => number;
}

export const METRICS: MetricSeries[] = [
  {
    key: 'rss',
    label: 'RSS',
    color: 'var(--series-1)',
    value: (v) => v?.rss ?? 0,
  },
  {
    key: 'pss',
    label: 'PSS',
    color: 'var(--series-2)',
    value: (v) => v?.pss ?? 0,
  },
  {
    key: 'private',
    label: 'Private',
    color: 'var(--series-3)',
    value: privateKb,
  },
  {
    key: 'swap',
    label: 'Swap',
    color: 'var(--series-4)',
    value: (v) => v?.swap ?? 0,
  },
];

export const KIND_LABELS: Record<ComponentKind, string> = {
  heap: 'Heap',
  stack: 'Stack',
  anon: 'Anonymous',
  library: 'Library',
  file: 'File',
  shmem: 'Shared mem',
  kernel: 'Kernel',
  other: 'Other',
};

/** Columns of the component table, in display order. */
export const COMPONENT_COLUMNS: { field: SmapsField; label: string }[] = [
  { field: 'size', label: 'Virtual' },
  { field: 'rss', label: 'RSS' },
  { field: 'pss', label: 'PSS' },
  { field: 'private_dirty', label: 'Priv. dirty' },
  { field: 'private_clean', label: 'Priv. clean' },
  { field: 'shared_dirty', label: 'Shr. dirty' },
  { field: 'shared_clean', label: 'Shr. clean' },
  { field: 'swap', label: 'Swap' },
];

/** A text note pinned to a moment, drawn on the charts as a labelled vertical line. */
export interface Marker {
  id: string;
  /** Unix ms. */
  time: number;
  text: string;
}

/** A start/stop span of samples, kept in the page until it is downloaded or deleted. */
export interface Recording {
  id: string;
  pid: number;
  name: string;
  host: string;
  cmdline?: string;
  startedAt: number;
  stoppedAt?: number;
  samples: SampleResponse[];
  /** Markers added while recording. */
  markers?: Marker[];
}

export function download(filename: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function recordingBaseName(recording: Recording): string {
  const stamp = new Date(recording.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = recording.name.replace(/[^\w.-]+/g, '_');
  return `smaps-${recording.pid}-${name}-${stamp}`;
}

/** The full samples — every component of every sample — as captured. */
export function exportRecordingJson(recording: Recording) {
  download(`${recordingBaseName(recording)}.json`, 'application/json', JSON.stringify(recording, null, 2));
}

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One row per sample and component (plus a "[total]" row per sample), every
 * smaps field the kernel reported as its own column — ready for a spreadsheet
 * pivot. Markers are "[marker]" rows in time order, their text in `note`.
 */
export function exportRecordingCsv(recording: Recording) {
  const fields = Array.from(new Set(recording.samples.flatMap((s) => s.fields)));
  const header = ['time', 'iso_time', 'component', 'kind', 'mappings', ...fields.map((f) => `${f}_kb`), 'note'];
  const rows = [header.join(',')];
  const markers = [...(recording.markers ?? [])].sort((a, b) => a.time - b.time);
  let next = 0;
  const pushMarkersUntil = (time: number) => {
    for (; next < markers.length && markers[next].time <= time; next++) {
      const m = markers[next];
      rows.push(
        [m.time, new Date(m.time).toISOString(), '[marker]', 'marker', undefined, ...fields.map(() => undefined), m.text]
          .map(csvCell)
          .join(','),
      );
    }
  };
  for (const s of recording.samples) {
    pushMarkersUntil(s.time);
    const iso = new Date(s.time).toISOString();
    rows.push(
      [s.time, iso, '[total]', '', s.totals.count, ...fields.map((f) => s.totals[f]), undefined].map(csvCell).join(','),
    );
    for (const c of s.components) {
      rows.push([s.time, iso, c.name, c.kind, c.count, ...fields.map((f) => c[f]), undefined].map(csvCell).join(','));
    }
  }
  pushMarkersUntil(Infinity);
  download(`${recordingBaseName(recording)}.csv`, 'text/csv', `${rows.join('\n')}\n`);
}
