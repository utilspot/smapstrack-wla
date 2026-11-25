// Renderer of the standalone HTML report (see src/lib/report.ts). Inlined into
// the downloaded file as-is, so it is plain browser JavaScript with no imports;
// it reads the recording from <script id="report-data" type="application/json">.
// Names from the remote host are untrusted: they only ever go in via textContent.
(function () {
  'use strict';

  var SVG = 'http://www.w3.org/2000/svg';
  var data = JSON.parse(document.getElementById('report-data').textContent);
  var n = data.times.length;

  var METRICS = [
    { key: 'rss', label: 'RSS', color: 'var(--series-1)' },
    { key: 'pss', label: 'PSS', color: 'var(--series-2)' },
    { key: 'private', label: 'Private', color: 'var(--series-3)' },
    { key: 'swap', label: 'Swap', color: 'var(--series-4)' },
  ];

  var KIND_LABELS = {
    heap: 'Heap',
    stack: 'Stack',
    anon: 'Anonymous',
    library: 'Library',
    file: 'File',
    shmem: 'Shared mem',
    kernel: 'Kernel',
    other: 'Other',
  };

  // ------------------------------------------------------------ formatting

  function formatKb(kb) {
    if (kb === undefined || kb === null || !isFinite(kb)) return '—';
    var abs = Math.abs(kb);
    if (abs < 1024) return kb + ' KiB';
    if (abs < 1024 * 1024) return (kb / 1024).toFixed(abs < 10 * 1024 ? 2 : 1) + ' MiB';
    return (kb / 1024 / 1024).toFixed(2) + ' GiB';
  }

  function formatDelta(kb) {
    if (!kb) return '';
    return (kb > 0 ? '+' : '−') + formatKb(Math.abs(kb));
  }

  function formatClock(ms) {
    return new Date(ms).toLocaleTimeString([], { hour12: false });
  }

  function formatDuration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var mmss = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return h > 0 ? h + ':' + mmss : mmss;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(tag, attrs) {
    var node = document.createElementNS(SVG, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  // ------------------------------------------------------------ chart

  var MARGIN = { top: 14, right: 84, bottom: 28, left: 72 };

  // Text markers, laid out as in the app's LineChart: labels in up to three
  // first-fit rows above the plot; one that fits no row keeps only its line.
  var MARKER_ROWS = 3;
  var MARKER_ROW_H = 17;
  var MARKER_LABEL_CHARS = 28;
  var markers = (data.markers || []).slice().sort(function (a, b) {
    return a.time - b.time;
  });

  function markerLabel(text) {
    return text.length > MARKER_LABEL_CHARS ? text.slice(0, MARKER_LABEL_CHARS - 1) + '…' : text;
  }

  function markerLabelWidth(text) {
    return markerLabel(text).length * 6.4 + 12;
  }

  function placeMarkers(items, plotRight) {
    var rowEnds = [];
    return items
      .slice()
      .sort(function (a, b) {
        return a.x - b.x;
      })
      .map(function (item) {
        var w = markerLabelWidth(item.marker.text);
        var flip = item.x + w > plotRight;
        var start = flip ? item.x - w : item.x;
        var row = -1;
        for (var r = 0; r < rowEnds.length; r++) {
          if (rowEnds[r] + 6 <= start) {
            row = r;
            break;
          }
        }
        if (row === -1 && rowEnds.length < MARKER_ROWS) row = rowEnds.length;
        if (row !== -1) rowEnds[row] = start + w;
        return { marker: item.marker, x: item.x, row: row, flip: flip, w: w };
      });
  }
  var LABEL_GAP = 15;

  function niceScale(max) {
    if (max <= 0) return { top: 1024, step: 256 };
    var unit = max >= 2 * 1024 * 1024 ? 1024 * 1024 : max >= 2 * 1024 ? 1024 : 1;
    var raw = max / unit / 4;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var steps = [1, 2, 2.5, 5, 10];
    var step = 10 * pow;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * pow >= raw) {
        step = steps[i] * pow;
        break;
      }
    }
    return { top: Math.ceil(max / unit / step) * step * unit, step: step * unit };
  }

  function formatTick(kb) {
    return formatKb(kb).replace(/\.0+ /, ' ');
  }

  /** Line chart with legend, end labels and a crosshair tooltip; series values are kB. */
  function renderChart(container, series, height) {
    container.textContent = '';
    container.classList.add('chart');

    var legend = el('div', 'chart__legend');
    series.forEach(function (s) {
      var item = el('span', 'legend-item');
      if (s.term && data.glossary[s.term]) {
        item.setAttribute('data-term', s.term);
        item.tabIndex = 0;
      }
      var key = el('span', 'legend-item__key');
      key.style.background = s.color;
      item.appendChild(key);
      item.appendChild(document.createTextNode(s.label));
      legend.appendChild(item);
    });
    container.appendChild(legend);

    var width = Math.max(320, container.clientWidth);
    var plotW = width - MARGIN.left - MARGIN.right;
    var max = 0;
    series.forEach(function (s) {
      s.values.forEach(function (v) {
        if (v > max) max = v;
      });
    });
    var scale = niceScale(max);
    var t0 = data.times[0];
    var t1 = data.times[n - 1];

    function xAt(time) {
      return MARGIN.left + (n <= 1 || t1 === t0 ? plotW / 2 : ((time - t0) / (t1 - t0)) * plotW);
    }
    function x(i) {
      return xAt(data.times[i]);
    }

    var placed = placeMarkers(
      markers
        .filter(function (m) {
          return m.time >= t0 && m.time <= t1;
        })
        .map(function (m) {
          return { marker: m, x: xAt(m.time) };
        }),
      MARGIN.left + plotW,
    );
    // The plot moves down to make room for the marker label rows in use.
    var markerRows = placed.reduce(function (rows, p) {
      return Math.max(rows, p.row + 1);
    }, 0);
    var top0 = MARGIN.top + markerRows * MARKER_ROW_H;
    var plotH = height - top0 - MARGIN.bottom;

    function y(v) {
      return top0 + plotH - (v / scale.top) * plotH;
    }

    var root = svg('svg', { width: width, height: height, role: 'img', tabindex: '0' });
    root.setAttribute('aria-label', container.getAttribute('data-label') || 'Memory over time');

    for (var v = 0; v <= scale.top + scale.step / 2; v += scale.step) {
      root.appendChild(svg('line', { class: 'chart__grid', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y(v), y2: y(v) }));
      var tick = svg('text', { class: 'chart__tick', x: MARGIN.left - 8, y: y(v), dy: '0.32em', 'text-anchor': 'end' });
      tick.textContent = formatTick(v);
      root.appendChild(tick);
    }

    var xTickCount = Math.max(2, Math.min(8, Math.floor(plotW / 110)));
    for (var k = 0; k < xTickCount && n > 0; k++) {
      var i = n === 1 ? 0 : Math.round((k / (xTickCount - 1)) * (n - 1));
      var anchor = n === 1 ? 'middle' : k === 0 ? 'start' : k === xTickCount - 1 ? 'end' : 'middle';
      var xt = svg('text', { class: 'chart__tick', x: x(i), y: height - 8, 'text-anchor': anchor });
      xt.textContent = formatClock(data.times[i]);
      root.appendChild(xt);
      if (n === 1) break;
    }

    placed.forEach(function (p) {
      var g = svg('g', { class: 'chart__marker' });
      var title = svg('title', {});
      title.textContent = formatClock(p.marker.time) + ' · ' + p.marker.text;
      g.appendChild(title);
      var ly = MARGIN.top + p.row * MARKER_ROW_H;
      g.appendChild(svg('line', { class: 'chart__marker-line', x1: p.x, x2: p.x, y1: p.row === -1 ? top0 : ly, y2: top0 + plotH }));
      if (p.row !== -1) {
        g.appendChild(
          svg('rect', { class: 'chart__marker-flag', x: p.flip ? p.x - p.w : p.x, y: ly - 1, width: p.w, height: MARKER_ROW_H - 3, rx: 2 }),
        );
        var text = svg('text', { class: 'chart__marker-text', x: p.flip ? p.x - p.w + 6 : p.x + 6, y: ly + 6.5, dy: '0.32em' });
        text.textContent = markerLabel(p.marker.text);
        g.appendChild(text);
      }
      root.appendChild(g);
    });

    series.forEach(function (s) {
      var d = s.values
        .map(function (val, idx) {
          return (idx === 0 ? 'M' : 'L') + x(idx).toFixed(1) + ',' + y(val).toFixed(1);
        })
        .join('');
      root.appendChild(svg('path', { class: 'chart__line', d: d, stroke: s.color }));
    });

    // End labels, spread apart so they never overlap.
    var ends = series
      .map(function (s) {
        return { s: s, y: y(s.values[n - 1]) };
      })
      .sort(function (a, b) {
        return a.y - b.y;
      });
    for (var j = 1; j < ends.length; j++) {
      if (ends[j].y - ends[j - 1].y < LABEL_GAP) ends[j].y = ends[j - 1].y + LABEL_GAP;
    }
    var overflow = ends.length ? ends[ends.length - 1].y - (top0 + plotH) : 0;
    if (overflow > 0) {
      ends.forEach(function (e) {
        e.y -= overflow;
      });
      for (var m = ends.length - 2; m >= 0; m--) {
        if (ends[m + 1].y - ends[m].y < LABEL_GAP) ends[m].y = ends[m + 1].y - LABEL_GAP;
      }
    }
    ends.forEach(function (e) {
      root.appendChild(svg('circle', { class: 'chart__dot', cx: x(n - 1), cy: y(e.s.values[n - 1]), r: 4, fill: e.s.color }));
      root.appendChild(
        svg('line', {
          x1: MARGIN.left + plotW + 10,
          x2: MARGIN.left + plotW + 20,
          y1: e.y,
          y2: e.y,
          stroke: e.s.color,
          'stroke-width': 2,
          'stroke-linecap': 'round',
        }),
      );
      var label = svg('text', { class: 'chart__label', x: MARGIN.left + plotW + 24, y: e.y, dy: '0.32em' });
      label.textContent = e.s.label;
      root.appendChild(label);
    });

    var hoverLayer = svg('g', {});
    root.appendChild(hoverLayer);
    container.appendChild(root);

    var tooltip = el('div', 'chart__tooltip');
    tooltip.hidden = true;
    container.appendChild(tooltip);

    var current = null;
    function show(index) {
      current = index;
      hoverLayer.textContent = '';
      if (index === null) {
        tooltip.hidden = true;
        return;
      }
      var hx = x(index);
      hoverLayer.appendChild(svg('line', { class: 'chart__crosshair', x1: hx, x2: hx, y1: top0, y2: top0 + plotH }));
      series.forEach(function (s) {
        hoverLayer.appendChild(svg('circle', { class: 'chart__dot', cx: hx, cy: y(s.values[index]), r: 4, fill: s.color }));
      });

      tooltip.textContent = '';
      tooltip.appendChild(el('div', 'chart__tooltip-time', formatClock(data.times[index])));
      series.forEach(function (s) {
        var row = el('div', 'chart__tooltip-row');
        var key = el('span', 'chart__tooltip-key');
        key.style.background = s.color;
        row.appendChild(key);
        row.appendChild(el('strong', '', formatKb(s.values[index])));
        row.appendChild(el('span', 'muted', s.label));
        tooltip.appendChild(row);
      });
      // Markers closer to this sample than to its neighbours.
      placed.forEach(function (p) {
        var t = p.marker.time;
        if (index > 0 && t <= (data.times[index - 1] + data.times[index]) / 2) return;
        if (index < n - 1 && t > (data.times[index] + data.times[index + 1]) / 2) return;
        var row = el('div', 'chart__tooltip-marker');
        row.appendChild(el('span', 'chart__tooltip-marker-key'));
        row.appendChild(el('span', '', p.marker.text));
        tooltip.appendChild(row);
      });
      tooltip.hidden = false;
      tooltip.style.top = top0 + 'px';
      if (hx > width / 2) {
        tooltip.style.left = '';
        tooltip.style.right = width - hx + 12 + 'px';
      } else {
        tooltip.style.right = '';
        tooltip.style.left = hx + 12 + 'px';
      }
    }

    root.addEventListener('pointermove', function (e) {
      var px = e.clientX - root.getBoundingClientRect().left;
      var best = 0;
      for (var q = 1; q < n; q++) if (Math.abs(x(q) - px) < Math.abs(x(best) - px)) best = q;
      show(best);
    });
    root.addEventListener('pointerleave', function () {
      show(null);
    });
    root.addEventListener('blur', function () {
      show(null);
    });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        var base = current === null ? n - 1 : current;
        show(Math.max(0, Math.min(n - 1, base + (e.key === 'ArrowLeft' ? -1 : 1))));
      } else if (e.key === 'Escape') {
        show(null);
      }
    });
  }

  // ------------------------------------------------------------ data access

  function totalSeries(key) {
    if (key === 'private') {
      var clean = data.totals.private_clean || [];
      var dirty = data.totals.private_dirty || [];
      return data.times.map(function (_, i) {
        return (clean[i] || 0) + (dirty[i] || 0);
      });
    }
    return data.totals[key] || data.times.map(function () {
      return 0;
    });
  }

  /** Chart series; each legend entry gets the glossary tooltip of its metric. */
  function chartSeriesOf(values) {
    return METRICS.map(function (m) {
      return { key: m.key, term: m.key, label: m.label, color: m.color, values: values(m.key) };
    });
  }

  function last(values) {
    return values[n - 1] || 0;
  }

  // ------------------------------------------------------------ page

  var app = document.getElementById('app');

  var header = el('header', 'report-header');
  var title = el('h1', '', data.meta.name + ' ');
  title.appendChild(el('span', 'muted', 'PID ' + data.meta.pid));
  header.appendChild(title);
  if (data.meta.cmdline) header.appendChild(el('div', 'mono muted ellipsis', data.meta.cmdline));
  header.appendChild(
    el(
      'div',
      'muted small',
      new Date(data.meta.startedAt).toLocaleString() +
        ' · ' +
        formatDuration((data.meta.stoppedAt || data.times[n - 1]) - data.meta.startedAt) +
        ' · ' +
        n +
        ' samples',
    ),
  );
  app.appendChild(header);

  // Summary: start, end, change, min and peak of each total.
  var summaryCard = el('section', 'card');
  summaryCard.appendChild(el('h2', '', 'Summary'));
  var summary = el('table', 'table');
  var head = el('tr');
  ['Metric', 'Start', 'End', 'Change', 'Min', 'Peak', 'Peak at'].forEach(function (h, i) {
    head.appendChild(el('th', i > 0 && i < 6 ? 'num' : '', h));
  });
  var thead = el('thead');
  thead.appendChild(head);
  summary.appendChild(thead);
  var tbody = el('tbody');
  METRICS.concat([{ key: 'size', label: 'Virtual' }]).forEach(function (m) {
    var values = totalSeries(m.key);
    var min = Infinity;
    var peak = -Infinity;
    var peakAt = 0;
    values.forEach(function (v, i) {
      if (v < min) min = v;
      if (v > peak) {
        peak = v;
        peakAt = i;
      }
    });
    var row = el('tr');
    row.appendChild(el('td', 'strong', m.label));
    row.appendChild(el('td', 'num mono', formatKb(values[0])));
    row.appendChild(el('td', 'num mono', formatKb(last(values))));
    var change = last(values) - values[0];
    row.appendChild(el('td', 'num mono ' + (change > 0 ? 'delta--up' : change < 0 ? 'delta--down' : ''), formatDelta(change)));
    row.appendChild(el('td', 'num mono', formatKb(min)));
    row.appendChild(el('td', 'num mono', formatKb(peak)));
    row.appendChild(el('td', 'mono', formatClock(data.times[peakAt])));
    tbody.appendChild(row);
  });
  summary.appendChild(tbody);
  var summaryWrap = el('div', 'table-wrap');
  summaryWrap.appendChild(summary);
  summaryCard.appendChild(summaryWrap);

  var facts = [];
  if (data.status.VmHWM) facts.push('Peak RSS (VmHWM) ' + formatKb(last(data.status.VmHWM)));
  if (data.status.Threads) facts.push(last(data.status.Threads) + ' threads');
  if (data.memTotal) facts.push('host RAM ' + formatKb(data.memTotal));
  if (facts.length) summaryCard.appendChild(el('p', 'muted small', 'At the last sample: ' + facts.join(' · ')));

  if (markers.length) {
    summaryCard.appendChild(el('h3', 'section-title', 'Markers'));
    var markerList = el('ul', 'marker-list');
    markers.forEach(function (m) {
      var item = el('li');
      item.appendChild(el('span', 'mono muted', formatClock(m.time)));
      item.appendChild(el('span', 'mono muted', '+' + formatDuration(m.time - data.meta.startedAt)));
      item.appendChild(el('span', '', m.text));
      markerList.appendChild(item);
    });
    summaryCard.appendChild(markerList);
  }
  app.appendChild(summaryCard);

  // Charts.
  var chartCard = el('section', 'card');
  chartCard.appendChild(el('h2', '', 'Process total'));
  var totalChart = el('div');
  totalChart.setAttribute('data-label', 'Memory of ' + data.meta.name + ' over time');
  chartCard.appendChild(totalChart);

  var componentHead = el('div', 'section-head');
  var componentTitle = el('h2', 'ellipsis');
  var closeButton = el('button', 'btn btn--ghost', 'Close');
  closeButton.type = 'button';
  componentHead.appendChild(componentTitle);
  componentHead.appendChild(closeButton);
  componentHead.hidden = true;
  chartCard.appendChild(componentHead);
  var componentChart = el('div');
  chartCard.appendChild(componentChart);
  app.appendChild(chartCard);

  var selected = null;

  function componentValues(c) {
    return function (key) {
      if (key === 'private') {
        return data.times.map(function (_, i) {
          return (c.private_clean ? c.private_clean[i] : 0) + (c.private_dirty ? c.private_dirty[i] : 0);
        });
      }
      return c[key] || data.times.map(function () {
        return 0;
      });
    };
  }

  function renderCharts() {
    renderChart(totalChart, chartSeriesOf(totalSeries), 300);
    if (selected) {
      componentHead.hidden = false;
      componentTitle.textContent = 'Component: ' + selected.name;
      componentTitle.title = selected.name;
      componentChart.setAttribute('data-label', 'Memory of ' + selected.name + ' over time');
      renderChart(componentChart, chartSeriesOf(componentValues(selected)), 240);
    } else {
      componentHead.hidden = true;
      componentChart.textContent = '';
    }
  }

  closeButton.addEventListener('click', function () {
    selected = null;
    renderTable();
    renderCharts();
  });

  // Components table.
  var COLUMNS = [
    { key: 'maps', label: 'Maps', value: function (c) { return last(c.count); }, kb: false },
    { key: 'size', label: 'Virtual', value: function (c) { return last(c.size || []); }, kb: true },
    { key: 'rss', label: 'RSS', value: function (c) { return last(c.rss || []); }, kb: true },
    { key: 'pss', label: 'PSS', value: function (c) { return last(c.pss || []); }, kb: true },
    { key: 'private_dirty', label: 'Priv. dirty', value: function (c) { return last(c.private_dirty || []); }, kb: true },
    { key: 'swap', label: 'Swap', value: function (c) { return last(c.swap || []); }, kb: true },
    { key: 'peak', label: 'Peak PSS', value: function (c) { return Math.max.apply(null, c.pss || [0]); }, kb: true },
    {
      key: 'delta',
      label: 'Δ PSS',
      value: function (c) {
        var p = c.pss || [0];
        return p[p.length - 1] - p[0];
      },
      kb: true,
      delta: true,
    },
  ];

  var tableCard = el('section', 'card');
  tableCard.appendChild(el('h2', '', 'Components'));
  var tools = el('div', 'toolbar');
  var filter = el('input', 'toolbar__search');
  filter.type = 'search';
  filter.placeholder = 'Filter by path or name';
  filter.setAttribute('aria-label', 'Filter components');
  var kindSelect = el('select');
  kindSelect.setAttribute('aria-label', 'Kind');
  var kinds = {};
  data.components.forEach(function (c) {
    kinds[c.kind] = (kinds[c.kind] || 0) + last(c.pss || []);
  });
  var allOption = el('option', '', 'All kinds');
  allOption.value = '';
  kindSelect.appendChild(allOption);
  Object.keys(kinds)
    .sort(function (a, b) {
      return kinds[b] - kinds[a];
    })
    .forEach(function (kind) {
      var option = el('option', '', (KIND_LABELS[kind] || kind) + ' · ' + formatKb(kinds[kind]));
      option.value = kind;
      kindSelect.appendChild(option);
    });
  tools.appendChild(filter);
  tools.appendChild(kindSelect);
  tableCard.appendChild(tools);
  tableCard.appendChild(
    el(
      'p',
      'muted small',
      'Values at the last sample, summed per backing object from /proc/' +
        data.meta.pid +
        '/smaps. Δ PSS is last minus first sample. Select a row to chart it; select a header to sort.',
    ),
  );

  var tableWrap = el('div', 'table-wrap table-wrap--full');
  var table = el('table', 'table table--hover');
  tableWrap.appendChild(table);
  tableCard.appendChild(tableWrap);
  app.appendChild(tableCard);

  var sortKey = 'pss';
  var sortDesc = true;

  function renderTable() {
    table.textContent = '';
    var headRow = el('tr');
    var nameTh = el('th', '', 'Component');
    headRow.appendChild(nameTh);
    headRow.appendChild(el('th', '', 'Kind'));
    COLUMNS.forEach(function (col) {
      var th = el('th', 'num');
      var button = el('button', 'th-sort', col.label + (col.key === sortKey ? (sortDesc ? ' ▾' : ' ▴') : ''));
      button.type = 'button';
      button.addEventListener('click', function () {
        if (sortKey === col.key) sortDesc = !sortDesc;
        else {
          sortKey = col.key;
          sortDesc = true;
        }
        renderTable();
      });
      th.setAttribute('aria-sort', col.key === sortKey ? (sortDesc ? 'descending' : 'ascending') : 'none');
      th.appendChild(button);
      headRow.appendChild(th);
    });
    var thead = el('thead');
    thead.appendChild(headRow);
    table.appendChild(thead);

    var needle = filter.value.trim().toLowerCase();
    var kind = kindSelect.value;
    var sortColumn = COLUMNS.filter(function (c) {
      return c.key === sortKey;
    })[0];
    var rows = data.components.filter(function (c) {
      return (!kind || c.kind === kind) && (!needle || c.name.toLowerCase().indexOf(needle) >= 0);
    });
    rows.sort(function (a, b) {
      var av = sortColumn.value(a);
      var bv = sortColumn.value(b);
      if (sortColumn.delta) {
        av = Math.abs(av);
        bv = Math.abs(bv);
      }
      return sortDesc ? bv - av : av - bv;
    });

    var body = el('tbody');
    rows.forEach(function (c) {
      var row = el('tr', selected === c ? 'is-selected' : '');
      row.tabIndex = 0;
      var name = el('td', 'mono component-name', c.name);
      name.title = c.name;
      row.appendChild(name);
      var kindCell = el('td');
      kindCell.appendChild(el('span', 'kind', KIND_LABELS[c.kind] || c.kind));
      row.appendChild(kindCell);
      COLUMNS.forEach(function (col) {
        var v = col.value(c);
        var cls = 'num mono';
        if (col.delta) cls += v > 0 ? ' delta--up' : v < 0 ? ' delta--down' : '';
        row.appendChild(el('td', cls, col.delta ? formatDelta(v) : col.kb ? formatKb(v) : String(v)));
      });
      function choose() {
        selected = c;
        renderTable();
        renderCharts();
        componentHead.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      row.addEventListener('click', choose);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose();
        }
      });
      body.appendChild(row);
    });
    table.appendChild(body);
  }

  filter.addEventListener('input', renderTable);
  kindSelect.addEventListener('change', renderTable);

  var footer = el(
    'footer',
    'muted small',
    'Generated by Smaps Tracker on ' + new Date(data.meta.generatedAt).toLocaleString() + '.',
  );
  app.appendChild(footer);

  // ------------------------------------------------------------ term tooltip

  // One hover widget for every [data-term]: after a short delay on pointer
  // hover, at once on keyboard focus; Escape, scrolling or leaving hides it.
  var tip = el('div', 'term-tooltip');
  tip.id = 'term-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.appendChild(tip);
  var tipTarget = null;
  var tipTimer = 0;

  function termTarget(node) {
    return node && node.closest ? node.closest('[data-term]') : null;
  }

  function showTip(target) {
    var entry = data.glossary[target.getAttribute('data-term')];
    if (!entry || tipTarget === target) return;
    hideTip();
    tip.textContent = '';
    tip.appendChild(el('div', 'term-tooltip__title', entry.title));
    tip.appendChild(el('div', 'term-tooltip__body', entry.body));
    if (entry.source) tip.appendChild(el('div', 'term-tooltip__source', entry.source));
    tip.hidden = false;
    var rect = target.getBoundingClientRect();
    var top = rect.bottom + 6;
    if (top + tip.offsetHeight > window.innerHeight - 8 && rect.top - 6 - tip.offsetHeight >= 8) {
      top = rect.top - 6 - tip.offsetHeight;
    }
    tip.style.top = top + 'px';
    tip.style.left = Math.min(Math.max(8, rect.left), window.innerWidth - tip.offsetWidth - 8) + 'px';
    target.setAttribute('aria-describedby', tip.id);
    tipTarget = target;
  }

  function hideTip() {
    clearTimeout(tipTimer);
    if (tipTarget) tipTarget.removeAttribute('aria-describedby');
    tipTarget = null;
    tip.hidden = true;
  }

  document.addEventListener('pointerover', function (e) {
    var target = termTarget(e.target);
    clearTimeout(tipTimer);
    if (target) {
      tipTimer = setTimeout(function () {
        showTip(target);
      }, 350);
    }
  });
  document.addEventListener('pointerout', function (e) {
    var from = termTarget(e.target);
    if (from && from !== termTarget(e.relatedTarget)) hideTip();
  });
  document.addEventListener('focusin', function (e) {
    var target = termTarget(e.target);
    if (target && e.target.matches(':focus-visible')) showTip(target);
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hideTip();
  });
  window.addEventListener('scroll', hideTip, true);

  renderTable();
  renderCharts();

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 150);
  });
})();
