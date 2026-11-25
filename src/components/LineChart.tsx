import { useEffect, useMemo, useRef, useState } from 'react';
import { type Marker, formatClock, formatKb } from '../lib/memory';

export interface ChartSeries {
  key: string;
  label: string;
  /** Glossary key explained when the legend entry is hovered. */
  term?: string;
  /** CSS color (a var(--series-n) token). */
  color: string;
  values: number[];
}

interface LineChartProps {
  /** Unix ms, one per sample; every series has a value at each. */
  times: number[];
  series: ChartSeries[];
  height?: number;
  /** Accessible name of the chart. */
  label: string;
  /** Text markers; those inside the plotted time range are drawn. */
  markers?: Marker[];
  /**
   * Makes the chart markable: clicking a point (or Enter on the focused chart)
   * opens an editor for the marker of that sample. Called with the sample's
   * time and the note; an empty note removes the marker.
   */
  onMarkerChange?: (time: number, text: string) => void;
}

const MARGIN = { top: 14, right: 84, bottom: 28, left: 72 };
const LABEL_GAP = 15;

/** Marker labels stack in up to this many rows above the plot; the rest keep only their line. */
const MARKER_ROWS = 3;
const MARKER_ROW_H = 17;
const MARKER_LABEL_CHARS = 28;

function markerLabel(text: string): string {
  return text.length > MARKER_LABEL_CHARS ? `${text.slice(0, MARKER_LABEL_CHARS - 1)}…` : text;
}

/** Rough width of a marker label at 11px, padding included; good enough to keep labels apart. */
function markerLabelWidth(text: string): number {
  return markerLabel(text).length * 6.4 + 12;
}

interface PlacedMarker {
  marker: Marker;
  x: number;
  /** Row of its label, or -1 when no row had room. */
  row: number;
  /** Label grows leftwards from the line when it would leave the plot on the right. */
  flip: boolean;
}

/** First-fit rows, left to right, so labels never overlap. */
function placeMarkers(markers: { marker: Marker; x: number }[], plotRight: number): PlacedMarker[] {
  const rowEnds: number[] = [];
  return [...markers]
    .sort((a, b) => a.x - b.x)
    .map(({ marker, x }) => {
      const w = markerLabelWidth(marker.text);
      const flip = x + w > plotRight;
      const start = flip ? x - w : x;
      let row = rowEnds.findIndex((end) => end + 6 <= start);
      if (row === -1 && rowEnds.length < MARKER_ROWS) row = rowEnds.length;
      if (row !== -1) rowEnds[row] = start + w;
      return { marker, x, row, flip };
    });
}

/** Axis maximum and step in kB, round in the unit the ticks are printed in (KiB, MiB or GiB). */
function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1024, step: 256 };
  const unit = max >= 2 * 1024 * 1024 ? 1024 * 1024 : max >= 2 * 1024 ? 1024 : 1;
  const raw = max / unit / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  return { top: Math.ceil(max / unit / step) * step * unit, step: step * unit };
}

/** Tick labels drop formatKb's padding zeros: "300 MiB", not "300.0 MiB". */
function formatTick(kb: number): string {
  return formatKb(kb).replace(/\.0+ /, ' ');
}

/** Spreads end-of-line labels apart so they never overlap; keeps their order. */
function spreadLabels(ys: { key: string; y: number }[], min: number, max: number) {
  const sorted = [...ys].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < LABEL_GAP) sorted[i].y = sorted[i - 1].y + LABEL_GAP;
  }
  const overflow = sorted.length ? sorted[sorted.length - 1].y - max : 0;
  if (overflow > 0) {
    for (const s of sorted) s.y -= overflow;
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (sorted[i + 1].y - sorted[i].y < LABEL_GAP) sorted[i].y = sorted[i + 1].y - LABEL_GAP;
    }
  }
  for (const s of sorted) s.y = Math.max(min, s.y);
  return new Map(sorted.map((s) => [s.key, s.y]));
}

export function LineChart({ times, series, height = 280, label, markers = [], onMarkerChange }: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  /** The sample whose marker is being written, by time so it survives the live window shifting. */
  const [editing, setEditing] = useState<{ time: number; text: string } | null>(null);

  // A click anywhere outside the chart closes the editor without saving.
  useEffect(() => {
    if (!editing) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setEditing(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [editing]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = times.length;
  const plotW = width - MARGIN.left - MARGIN.right;
  const t0 = times[0] ?? 0;
  const t1 = times[n - 1] ?? 1;
  const xAt = (time: number) =>
    MARGIN.left + (n <= 1 || t1 === t0 ? plotW / 2 : ((time - t0) / (t1 - t0)) * plotW);

  const placed = placeMarkers(
    n > 0 ? markers.filter((m) => m.time >= t0 && m.time <= t1).map((m) => ({ marker: m, x: xAt(m.time) })) : [],
    MARGIN.left + plotW,
  );
  // The plot moves down to make room for the marker label rows in use.
  const markerRows = placed.reduce((rows, p) => Math.max(rows, p.row + 1), 0);
  const top0 = MARGIN.top + markerRows * MARKER_ROW_H;
  const plotH = height - top0 - MARGIN.bottom;

  const { top, step } = useMemo(
    () => niceScale(Math.max(0, ...series.flatMap((s) => s.values))),
    [series],
  );

  const x = (i: number) => xAt(times[i]);
  const y = (v: number) => top0 + plotH - (v / top) * plotH;

  const yTicks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) yTicks.push(v);

  const xTickCount = Math.max(2, Math.min(6, Math.floor(plotW / 110)));
  const xTicks =
    n > 1
      ? Array.from({ length: xTickCount }, (_, k) => Math.round((k / (xTickCount - 1)) * (n - 1)))
      : n === 1
        ? [0]
        : [];

  const endLabels =
    n > 0
      ? spreadLabels(
          series.map((s) => ({ key: s.key, y: y(s.values[n - 1]) })),
          top0 + 4,
          top0 + plotH,
        )
      : new Map<string, number>();

  function indexAt(clientX: number): number | null {
    const el = wrapRef.current;
    if (!el || n === 0) return null;
    const px = clientX - el.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < n; i++) {
      if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
    }
    return best;
  }

  function openEditor(index: number) {
    if (!onMarkerChange) return;
    const time = times[index];
    setEditing({ time, text: markers.find((m) => m.time === time)?.text ?? '' });
  }

  /** Closes the editor and hands keyboard focus back to the chart it came from. */
  function closeEditor() {
    setEditing(null);
    svgRef.current?.focus({ preventScroll: true });
  }

  function saveEditor(text: string) {
    if (!editing || !onMarkerChange) return;
    onMarkerChange(editing.time, text.trim());
    closeEditor();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (n === 0) return;
    if (e.key === 'Enter' && onMarkerChange) {
      e.preventDefault();
      openEditor(hover ?? n - 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const current = hover ?? n - 1;
      setHover(Math.max(0, Math.min(n - 1, current + (e.key === 'ArrowLeft' ? -1 : 1))));
    } else if (e.key === 'Escape') {
      setHover(null);
    }
  }

  const hx = hover !== null ? x(hover) : 0;
  const tooltipLeft = hover !== null && hx > width / 2;

  // Its sample may have scrolled out of the live window meanwhile.
  const editIndex = editing ? times.indexOf(editing.time) : -1;
  const editExisting = editing ? markers.some((m) => m.time === editing.time) : false;
  const EDITOR_W = 300;
  const editLeft = editIndex >= 0 ? Math.min(Math.max(0, x(editIndex) - EDITOR_W / 2), width - EDITOR_W) : 0;

  // Markers closer to the hovered sample than to its neighbours.
  const hoverMarkers =
    hover === null
      ? []
      : placed
          .map((p) => p.marker)
          .filter(
            (m) =>
              (hover === 0 || m.time > (times[hover - 1] + times[hover]) / 2) &&
              (hover === n - 1 || m.time <= (times[hover] + times[hover + 1]) / 2),
          );

  return (
    <div className="chart" ref={wrapRef}>
      <div className="chart__legend">
        {series.map((s) => (
          <span key={s.key} className="legend-item" data-term={s.term} tabIndex={s.term ? 0 : undefined}>
            <span className="legend-item__key" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <svg
        ref={svgRef}
        width={width}
        height={height}
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={(e) => setHover(indexAt(e.clientX))}
        onClick={(e) => {
          const index = indexAt(e.clientX);
          if (index !== null) openEditor(index);
        }}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line className="chart__grid" x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(v)} y2={y(v)} />
            <text className="chart__tick" x={MARGIN.left - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {formatTick(v)}
            </text>
          </g>
        ))}
        {xTicks.map((i, k) => (
          <text
            key={`${i}-${k}`}
            className="chart__tick"
            x={x(i)}
            y={height - 8}
            textAnchor={n === 1 ? 'middle' : k === 0 ? 'start' : k === xTicks.length - 1 ? 'end' : 'middle'}
          >
            {formatClock(times[i])}
          </text>
        ))}

        {placed.map(({ marker, x: mx, row, flip }) => {
          const w = markerLabelWidth(marker.text);
          const ly = MARGIN.top + row * MARKER_ROW_H;
          return (
            <g key={marker.id} className="chart__marker">
              <title>{`${formatClock(marker.time)} · ${marker.text}`}</title>
              <line className="chart__marker-line" x1={mx} x2={mx} y1={row === -1 ? top0 : ly} y2={top0 + plotH} />
              {row !== -1 && (
                <>
                  <rect
                    className="chart__marker-flag"
                    x={flip ? mx - w : mx}
                    y={ly - 1}
                    width={w}
                    height={MARKER_ROW_H - 3}
                    rx={2}
                  />
                  <text className="chart__marker-text" x={flip ? mx - w + 6 : mx + 6} y={ly + 6.5} dy="0.32em">
                    {markerLabel(marker.text)}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {series.map((s) => (
          <path
            key={s.key}
            className="chart__line"
            stroke={s.color}
            d={s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}
          />
        ))}

        {n > 0 &&
          series.map((s) => {
            const ly = endLabels.get(s.key) ?? y(s.values[n - 1]);
            return (
              <g key={s.key}>
                <circle className="chart__dot" cx={x(n - 1)} cy={y(s.values[n - 1])} r={4} fill={s.color} />
                <line
                  x1={MARGIN.left + plotW + 10}
                  x2={MARGIN.left + plotW + 20}
                  y1={ly}
                  y2={ly}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                />
                <text className="chart__label" x={MARGIN.left + plotW + 24} y={ly} dy="0.32em">
                  {s.label}
                </text>
              </g>
            );
          })}

        {editIndex >= 0 && (
          <line
            className="chart__marker-line chart__marker-line--pending"
            x1={x(editIndex)}
            x2={x(editIndex)}
            y1={top0}
            y2={top0 + plotH}
          />
        )}

        {hover !== null && (
          <g>
            <line className="chart__crosshair" x1={hx} x2={hx} y1={top0} y2={top0 + plotH} />
            {series.map((s) => (
              <circle key={s.key} className="chart__dot" cx={hx} cy={y(s.values[hover])} r={4} fill={s.color} />
            ))}
          </g>
        )}

        {n === 0 && (
          <text className="chart__empty" x={MARGIN.left + plotW / 2} y={top0 + plotH / 2} textAnchor="middle">
            Waiting for the first sample…
          </text>
        )}
      </svg>

      {editing && editIndex >= 0 && (
        <MarkerEditor
          key={editing.time}
          time={editing.time}
          initial={editing.text}
          existing={editExisting}
          style={{ left: editLeft, top: top0 + 6, width: EDITOR_W }}
          onSave={saveEditor}
          onCancel={closeEditor}
        />
      )}

      {hover !== null && !editing && (
        <div
          className="chart__tooltip"
          style={
            tooltipLeft
              ? { right: width - hx + 12, top: top0 }
              : { left: hx + 12, top: top0 }
          }
          role="status"
        >
          <div className="chart__tooltip-time">{formatClock(times[hover])}</div>
          {series.map((s) => (
            <div key={s.key} className="chart__tooltip-row">
              <span className="chart__tooltip-key" style={{ background: s.color }} />
              <strong>{formatKb(s.values[hover])}</strong>
              <span className="muted">{s.label}</span>
            </div>
          ))}
          {hoverMarkers.map((m) => (
            <div key={m.id} className="chart__tooltip-marker">
              <span className="chart__tooltip-marker-key" aria-hidden="true" />
              <span>{m.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface MarkerEditorProps {
  time: number;
  initial: string;
  existing: boolean;
  style: React.CSSProperties;
  onSave: (text: string) => void;
  onCancel: () => void;
}

/** The small form for one sample's marker; Enter saves, Escape cancels, an emptied note removes it. */
function MarkerEditor({ time, initial, existing, style, onSave, onCancel }: MarkerEditorProps) {
  const [text, setText] = useState(initial);
  return (
    <form
      className="chart__editor"
      style={style}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(text);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="chart__editor-title">
        {existing ? 'Marker' : 'New marker'} at <span className="mono">{formatClock(time)}</span>
      </div>
      <input
        type="text"
        className="toolbar__search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Note, e.g. load test started"
        maxLength={80}
        autoFocus
        aria-label="Marker text"
      />
      <div className="chart__editor-actions">
        <button type="submit" className="btn btn--accent" disabled={!existing && text.trim() === ''}>
          {existing ? 'Save' : 'Add'}
        </button>
        {existing && (
          <button type="button" className="btn btn--secondary" onClick={() => onSave('')}>
            Remove
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
