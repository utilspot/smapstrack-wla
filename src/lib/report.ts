import reportCss from '../report/report.css?raw';
import reportJs from '../report/report.js?raw';
import type { ComponentKind, SmapsField } from '../types';
import { GLOSSARY, type GlossaryEntry } from './glossary';
import { type Recording, download, recordingBaseName } from './memory';

/** Per-component series the report charts and tabulates; the rest stay in the JSON export. */
const COMPONENT_FIELDS: SmapsField[] = ['size', 'rss', 'pss', 'private_clean', 'private_dirty', 'swap'];

/** status keys worth keeping per sample. */
const STATUS_KEYS = ['VmHWM', 'VmRSS', 'VmSwap', 'VmSize', 'RssAnon', 'RssFile', 'RssShmem', 'Threads'];

/**
 * The recording as the report script reads it: column-wise arrays, one value
 * per sample, instead of a full object per sample — several times smaller for
 * long recordings. A component missing from a sample counts as 0 there.
 */
interface ReportData {
  meta: {
    name: string;
    pid: number;
    host: string;
    cmdline?: string;
    startedAt: number;
    stoppedAt?: number;
    generatedAt: number;
  };
  times: number[];
  totals: Partial<Record<SmapsField, number[]>>;
  status: Record<string, number[]>;
  memTotal?: number;
  components: (Partial<Record<SmapsField, number[]>> & { name: string; kind: ComponentKind; count: number[] })[];
  /** Text markers added while recording. */
  markers: { time: number; text: string }[];
  /** The app's term explanations, so the report's tooltips say exactly the same. */
  glossary: Record<string, GlossaryEntry>;
}

function reportData(recording: Recording): ReportData {
  const samples = recording.samples;
  const n = samples.length;
  const fields = Array.from(new Set(samples.flatMap((s) => s.fields)));

  const totals: ReportData['totals'] = {};
  for (const f of fields) totals[f] = samples.map((s) => s.totals[f] ?? 0);

  const status: ReportData['status'] = {};
  for (const key of STATUS_KEYS) {
    if (samples.some((s) => s.status[key] !== undefined)) status[key] = samples.map((s) => s.status[key] ?? 0);
  }

  const componentFields = COMPONENT_FIELDS.filter((f) => fields.includes(f));
  const byName = new Map<string, ReportData['components'][number]>();
  samples.forEach((s, i) => {
    for (const c of s.components) {
      let entry = byName.get(c.name);
      if (!entry) {
        entry = { name: c.name, kind: c.kind, count: new Array<number>(n).fill(0) };
        for (const f of componentFields) entry[f] = new Array<number>(n).fill(0);
        byName.set(c.name, entry);
      }
      entry.count[i] = c.count;
      for (const f of componentFields) entry[f]![i] = c[f] ?? 0;
    }
  });

  return {
    meta: {
      name: recording.name,
      pid: recording.pid,
      host: recording.host,
      cmdline: recording.cmdline,
      startedAt: recording.startedAt,
      stoppedAt: recording.stoppedAt,
      generatedAt: Date.now(),
    },
    times: samples.map((s) => s.time),
    totals,
    status,
    memTotal: samples[n - 1]?.meminfo.MemTotal,
    components: [...byName.values()],
    markers: (recording.markers ?? []).map(({ time, text }) => ({ time, text })),
    glossary: GLOSSARY,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * One self-contained HTML file: styles, renderer and data inline, no network
 * access needed to open it. `<` is escaped in the JSON so remote names such as
 * "</script>" cannot end the data block early.
 */
export function buildRecordingReport(recording: Recording): string {
  const json = JSON.stringify(reportData(recording)).replace(/</g, '\\u003c');
  const title = `${recording.name} (PID ${recording.pid}) on ${recording.host} — Smaps Tracker report`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="Smaps Tracker">
<title>${escapeHtml(title)}</title>
<style>
${reportCss}
</style>
</head>
<body>
<main id="app"></main>
<script id="report-data" type="application/json">${json}</script>
<script>
${reportJs}
</script>
</body>
</html>
`;
}

export function exportRecordingHtml(recording: Recording) {
  download(`${recordingBaseName(recording)}.html`, 'text/html', buildRecordingReport(recording));
}
