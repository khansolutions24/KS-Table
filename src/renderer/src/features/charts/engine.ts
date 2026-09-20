// Chart data processing (filters, grouping, aggregation, sort, top N) and ECharts options.

import type { EChartsOption } from 'echarts';
import { locale, tr } from '@shared/i18n';
import type { CellValue } from '@shared/types';
import type { Aggregation, ChartDef, ChartFilter, DatePart, NumberFormat } from './model';

export interface SourceData {
  columns: { name: string; numeric: boolean }[];
  rows: CellValue[][];
  loadedAt: number;
  truncated: boolean;
}

export interface Processed {
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
  /** heatmap: [x, y, value] */
  cells?: [number, number, number | null][];
  yCategories?: string[];
  /** scatter points [x, y] */
  points?: { name: string; data: [number, number][] }[];
  /** table output */
  table?: { columns: string[]; rows: (string | number | null)[][] };
  /** kpi / gauge */
  value?: number | null;
}

const KS = String.fromCharCode(1);
const text = (v: CellValue | undefined): string => (v === null || v === undefined ? '' : v instanceof Uint8Array ? `0x${[...v.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}` : v);
const num = (v: CellValue | undefined): number | null => {
  if (v === null || v === undefined || v instanceof Uint8Array || v.trim() === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
};

function matches(f: ChartFilter, v: CellValue): boolean {
  const s = text(v);
  const ls = s.toLowerCase();
  const val = f.value.toLowerCase();
  const n = num(v);
  const cmp = (a: string) => {
    const na = Number(a);
    return n !== null && a.trim() !== '' && isFinite(na) ? n - na : s.localeCompare(a);
  };
  switch (f.op) {
    case '=':
      return cmp(f.value) === 0;
    case '!=':
      return cmp(f.value) !== 0;
    case '<':
      return cmp(f.value) < 0;
    case '<=':
      return cmp(f.value) <= 0;
    case '>':
      return cmp(f.value) > 0;
    case '>=':
      return cmp(f.value) >= 0;
    case 'contains':
      return ls.includes(val);
    case 'notContains':
      return !ls.includes(val);
    case 'startsWith':
      return ls.startsWith(val);
    case 'endsWith':
      return ls.endsWith(val);
    case 'empty':
      return v === null || s === '';
    case 'notEmpty':
      return v !== null && s !== '';
    case 'between':
      return cmp(f.value) >= 0 && cmp(f.value2) <= 0;
    case 'in':
      return f.value
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .includes(ls);
  }
  return true;
}

const WEEKDAYS = () => [tr('So', 'Sun'), tr('Mo', 'Mon'), tr('Di', 'Tue'), tr('Mi', 'Wed'), tr('Do', 'Thu'), tr('Fr', 'Fri'), tr('Sa', 'Sat')];

function datePart(v: CellValue, part: DatePart): string {
  const s = text(v);
  if (!part || !s) return s;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}))?/.exec(s);
  if (!m) return s;
  switch (part) {
    case 'year':
      return m[1];
    case 'quarter':
      return `${m[1]}-Q${Math.floor((Number(m[2]) - 1) / 3) + 1}`;
    case 'month':
      return `${m[1]}-${m[2]}`;
    case 'day':
      return `${m[1]}-${m[2]}-${m[3]}`;
    case 'hour':
      return `${m[1]}-${m[2]}-${m[3]} ${m[4] ?? '00'}:00`;
    case 'weekday':
      return `${new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()} ${WEEKDAYS()[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()]}`;
  }
  return s;
}

class Acc {
  sum = 0;
  count = 0;
  nonNull = 0;
  min: number | null = null;
  max: number | null = null;
  distinct = new Set<string>();
  add(v: CellValue) {
    this.count++;
    if (v === null) return;
    this.nonNull++;
    this.distinct.add(text(v));
    const n = num(v);
    if (n === null) return;
    this.sum += n;
    this.min = this.min === null ? n : Math.min(this.min, n);
    this.max = this.max === null ? n : Math.max(this.max, n);
  }
  result(agg: Aggregation, numericCount: number): number | null {
    switch (agg) {
      case 'count':
        return this.nonNull;
      case 'distinct':
        return this.distinct.size;
      case 'avg':
        return numericCount ? this.sum / numericCount : null;
      case 'min':
        return this.min;
      case 'max':
        return this.max;
      default:
        return this.min === null ? null : this.sum;
    }
  }
}

class NumAcc extends Acc {
  numeric = 0;
  override add(v: CellValue) {
    super.add(v);
    if (num(v) !== null) this.numeric++;
  }
  value(agg: Aggregation) {
    return this.result(agg, this.numeric);
  }
}

const valueName = (v: { field: string; agg: Aggregation; label: string }) => {
  if (v.label) return v.label;
  if (v.agg === 'none') return v.field;
  const a = { sum: tr('Summe', 'Sum'), count: tr('Anzahl', 'Count'), distinct: tr('Eindeutig', 'Distinct'), avg: tr('Ø', 'Avg'), min: 'Min', max: 'Max' }[v.agg];
  return `${a} ${v.field}`;
};

export function processChart(c: ChartDef, data: SourceData): Processed {
  const idx = (name: string) => data.columns.findIndex((x) => x.name === name);
  const filters = c.filters.map((f) => ({ f, i: idx(f.field) })).filter((x) => x.i >= 0);
  const rows = data.rows.filter((r) => filters.every(({ f, i }) => matches(f, r[i])));
  const values = c.values.filter((v) => idx(v.field) >= 0);
  const ci = idx(c.category);
  const si = idx(c.series);

  if (c.type === 'kpi' || c.type === 'gauge') {
    const v = values[0];
    if (!v) return { categories: [], series: [], value: null };
    const acc = new NumAcc();
    const i = idx(v.field);
    for (const r of rows) acc.add(r[i]);
    return { categories: [], series: [], value: acc.value(v.agg === 'none' ? 'sum' : v.agg) };
  }

  if (c.type === 'scatter') {
    const xi = idx(values[0]?.field ?? '');
    const yi = idx(values[1]?.field ?? '');
    const groups = new Map<string, [number, number][]>();
    if (xi >= 0 && yi >= 0) {
      for (const r of rows) {
        const x = num(r[xi]);
        const y = num(r[yi]);
        if (x === null || y === null) continue;
        const g = si >= 0 ? text(r[si]) : values[1]!.field;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push([x, y]);
      }
    }
    let points = [...groups.entries()].map(([name, d]) => ({ name, data: d }));
    if (c.limit > 0) points = points.map((p) => ({ ...p, data: p.data.slice(0, c.limit) }));
    return { categories: [], series: [], points };
  }

  if (c.type === 'table' && ci < 0) {
    const cols = values.length ? values.map((v) => v.field) : data.columns.map((x) => x.name);
    const ids = cols.map(idx);
    const out = (c.limit > 0 ? rows.slice(0, c.limit) : rows).map((r) => ids.map((i) => (data.columns[i]?.numeric ? num(r[i]) : text(r[i]))));
    return { categories: [], series: [], table: { columns: cols.map((x, k) => (values[k] ? valueName(values[k]) : x)), rows: out } };
  }

  // grouped: category × series → accumulators per value field
  const catKey = (r: CellValue[]) => (ci >= 0 ? datePart(r[ci], c.datePart) : tr('Gesamt', 'Total'));
  const catOrder: string[] = [];
  const serOrder: string[] = [];
  const cells = new Map<string, NumAcc[]>();
  const catSeen = new Set<string>();
  const serSeen = new Set<string>();
  for (const r of rows) {
    const k = catKey(r);
    const s = si >= 0 && c.type !== 'pie' && c.type !== 'donut' && c.type !== 'table' ? text(r[si]) : '';
    if (!cells.has(`${k}${KS}${s}`)) {
      cells.set(
        `${k}${KS}${s}`,
        values.map(() => new NumAcc())
      );
    }
    if (!catSeen.has(k)) {
      catSeen.add(k);
      catOrder.push(k);
    }
    if (!serSeen.has(s)) {
      serSeen.add(s);
      serOrder.push(s);
    }
    const accs = cells.get(`${k}${KS}${s}`)!;
    values.forEach((v, j) => accs[j].add(r[idx(v.field)]));
  }
  const agg = (v: ChartDef['values'][number]) => (v.agg === 'none' ? 'sum' : v.agg);
  const at = (k: string, s: string, j: number) => cells.get(`${k}${KS}${s}`)?.[j]?.value(agg(values[j])) ?? null;

  // sort / top N by total of the first value
  const total = (k: string) => serOrder.reduce((sum, s) => sum + (at(k, s, 0) ?? 0), 0);
  let cats = [...catOrder];
  const cmpCat = (a: string, b: string) => a.localeCompare(b, locale(), { numeric: true });
  if (c.sort === 'category' || (c.sort === 'none' && c.datePart)) cats.sort(cmpCat);
  else if (c.sort === 'categoryDesc') cats.sort((a, b) => cmpCat(b, a));
  else if (c.sort === 'valueAsc') cats.sort((a, b) => total(a) - total(b));
  else if (c.sort === 'valueDesc') cats.sort((a, b) => total(b) - total(a));
  if (c.limit > 0 && cats.length > c.limit) {
    if (c.sort !== 'valueAsc' && c.sort !== 'valueDesc') {
      const top = new Set([...cats].sort((a, b) => total(b) - total(a)).slice(0, c.limit));
      cats = cats.filter((x) => top.has(x));
    } else cats = cats.slice(0, c.limit);
  }
  const label = (k: string) => (c.datePart === 'weekday' ? k.replace(/^\d /, '') : k);
  const sers = serOrder.sort((a, b) => a.localeCompare(b, locale(), { numeric: true }));

  if (c.type === 'heatmap') {
    const vals: [number, number, number | null][] = [];
    cats.forEach((k, x) => sers.forEach((s, y) => vals.push([x, y, at(k, s, 0)])));
    return { categories: cats.map(label), series: [], cells: vals, yCategories: sers.map((s) => s || tr('(leer)', '(empty)')) };
  }

  if (c.type === 'table') {
    return {
      categories: cats.map(label),
      series: [],
      table: { columns: [c.category + (c.datePart ? ` (${c.datePart})` : ''), ...values.map(valueName)], rows: cats.map((k) => [label(k), ...values.map((_, j) => at(k, '', j))]) }
    };
  }

  const series: Processed['series'] = [];
  if (si >= 0 && sers.length && c.type !== 'pie' && c.type !== 'donut') {
    for (const s of sers) {
      const vals = cats.map((k) => at(k, s, 0));
      if (vals.some((v) => v !== null)) series.push({ name: s || tr('(leer)', '(empty)'), values: vals });
    }
  } else {
    values.forEach((v, j) => series.push({ name: valueName(v), values: cats.map((k) => at(k, '', j)) }));
  }
  return { categories: cats.map(label), series };
}

// ───────────────────────── formatting ─────────────────────────

export function formatValue(v: number | null | undefined, f: NumberFormat): string {
  if (v === null || v === undefined || !isFinite(v)) return '–';
  const div = f.unit === 'K' ? 1e3 : f.unit === 'M' ? 1e6 : f.unit === 'B' ? 1e9 : 1;
  const x = v / div;
  const decimals = f.decimals ?? (Number.isInteger(x) ? 0 : Math.abs(x) >= 100 ? 1 : 2);
  const s = x.toLocaleString(locale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: f.thousands });
  const unit = f.unit ? ({ K: tr(' Tsd.', 'K'), M: tr(' Mio.', 'M'), B: tr(' Mrd.', 'B') } as const)[f.unit] : '';
  return `${f.prefix}${s}${unit}${f.suffix}`;
}

export const PALETTES: Record<string, { label: () => string; colors: string[] }> = {
  default: { label: () => tr('Standard', 'Default'), colors: ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b'] },
  cool: { label: () => tr('Kühl', 'Cool'), colors: ['#0ea5e9', '#6366f1', '#14b8a6', '#8b5cf6', '#22d3ee', '#3b82f6', '#a78bfa', '#2dd4bf'] },
  warm: { label: () => tr('Warm', 'Warm'), colors: ['#f97316', '#ef4444', '#f59e0b', '#e11d48', '#fb923c', '#facc15', '#dc2626', '#fdba74'] },
  earth: { label: () => tr('Natur', 'Earth'), colors: ['#65a30d', '#a16207', '#0f766e', '#b45309', '#4d7c0f', '#78716c', '#15803d', '#92400e'] },
  mono: { label: () => tr('Einfarbig', 'Monochrome'), colors: ['#1d4ed8', '#3b82f6', '#60a5fa', '#93c5fd', '#2563eb', '#1e40af', '#bfdbfe'] }
};

export interface ChartTheme {
  fg: string;
  muted: string;
  grid: string;
  bg: string;
  accent: string;
  success: string;
  danger: string;
  dark: boolean;
}

export function buildOption(c: ChartDef, p: Processed, t: ChartTheme): EChartsOption {
  const colors = PALETTES[c.palette]?.colors ?? PALETTES.default.colors;
  const fmt = (v: unknown) => formatValue(typeof v === 'number' ? v : Array.isArray(v) ? (v[v.length - 1] as number) : null, c.format);
  const textStyle = { color: t.fg, fontFamily: "'Segoe UI', system-ui, sans-serif" };
  const title = c.showTitle && (c.title || c.name) ? { text: c.title || c.name, left: 'center', top: 6, textStyle: { ...textStyle, fontSize: 14, fontWeight: 600 as const } } : undefined;
  const top = title ? 38 : 14;
  const legend =
    c.legend === 'none'
      ? undefined
      : {
          type: 'scroll' as const,
          textStyle: { color: t.muted },
          pageTextStyle: { color: t.muted },
          ...(c.legend === 'right' ? { orient: 'vertical' as const, right: 6, top: 'middle' } : c.legend === 'top' ? { top: title ? 30 : 6 } : { bottom: 4 })
        };
  const base: EChartsOption = {
    color: colors,
    backgroundColor: 'transparent',
    textStyle,
    title,
    animationDuration: 300,
    tooltip: { trigger: 'item', valueFormatter: (v) => fmt(v), backgroundColor: t.bg, borderColor: t.grid, textStyle: { color: t.fg } }
  };
  const gridBox = {
    left: 12,
    right: c.legend === 'right' ? 130 : 20,
    top: top + (c.legend === 'top' ? 24 : 0),
    bottom: c.legend === 'bottom' ? 36 : 12,
    containLabel: true
  };
  const axisStyle = { axisLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.muted }, splitLine: { lineStyle: { color: t.grid, opacity: 0.6 } } };

  switch (c.type) {
    case 'pie':
    case 'donut': {
      const s = p.series[0];
      return {
        ...base,
        legend,
        series: [
          {
            type: 'pie',
            radius: c.type === 'donut' ? ['45%', '70%'] : '70%',
            center: ['50%', c.legend === 'bottom' ? '52%' : '56%'],
            itemStyle: { borderColor: t.bg, borderWidth: 1 },
            label: { show: c.labels, color: t.fg, formatter: (x) => `${x.name}: ${fmt(x.value)} (${x.percent}%)` },
            data: p.categories.map((name, i) => ({ name, value: s?.values[i] ?? null }))
          }
        ]
      } as EChartsOption;
    }
    case 'scatter':
      return {
        ...base,
        legend,
        grid: gridBox,
        xAxis: { type: 'value', scale: true, name: c.values[0]?.label || c.values[0]?.field, nameTextStyle: { color: t.muted }, ...axisStyle },
        yAxis: { type: 'value', scale: true, name: c.values[1]?.label || c.values[1]?.field, nameTextStyle: { color: t.muted }, ...axisStyle },
        series: (p.points ?? []).map((s) => ({ type: 'scatter', name: s.name, symbolSize: 7, data: s.data }))
      };
    case 'heatmap': {
      const vals = (p.cells ?? []).map((x) => x[2]).filter((x): x is number => x !== null);
      return {
        ...base,
        tooltip: { position: 'top', formatter: (x: unknown) => { const d = (x as { data: [number, number, number | null] }).data; return `${p.categories[d[0]]} / ${p.yCategories?.[d[1]]}: ${fmt(d[2])}`; } },
        grid: { ...gridBox, bottom: 60 },
        xAxis: { type: 'category', data: p.categories, ...axisStyle, splitArea: { show: false } },
        yAxis: { type: 'category', data: p.yCategories ?? [], ...axisStyle },
        visualMap: {
          min: vals.length ? Math.min(...vals) : 0,
          max: vals.length ? Math.max(...vals) : 1,
          calculable: true,
          orient: 'horizontal',
          left: 'center',
          bottom: 4,
          textStyle: { color: t.muted },
          inRange: { color: t.dark ? ['#1e293b', colors[0]] : ['#eff6ff', colors[0]] }
        },
        series: [{ type: 'heatmap', data: p.cells ?? [], label: { show: c.labels, color: t.fg, formatter: (x) => fmt((x.data as number[])[2]) } }]
      };
    }
    case 'gauge': {
      const v = p.value ?? 0;
      const max = c.max ?? (c.target && c.target > v ? c.target * 1.2 : Math.max(1, Math.ceil(v * 1.25)));
      const min = c.min ?? 0;
      const reached = c.target !== null && v >= c.target;
      return {
        ...base,
        series: [
          {
            type: 'gauge',
            min,
            max,
            center: ['50%', title ? '62%' : '58%'],
            radius: '85%',
            progress: { show: true, width: 14, itemStyle: { color: c.target === null ? colors[0] : reached ? t.success : t.danger } },
            axisLine: { lineStyle: { width: 14, color: [[1, t.grid]] } },
            axisTick: { show: false },
            splitLine: { length: 8, lineStyle: { color: t.muted, width: 1 } },
            axisLabel: { color: t.muted, distance: 18, formatter: (x: number) => formatValue(x, { ...c.format, decimals: 0 }) },
            pointer: { itemStyle: { color: t.fg }, width: 4 },
            anchor: { show: true, size: 10, itemStyle: { color: t.fg } },
            detail: { valueAnimation: true, color: t.fg, fontSize: 22, offsetCenter: [0, '42%'], formatter: (x: number) => fmt(x) },
            title: { color: t.muted, offsetCenter: [0, '68%'] },
            markLine: undefined,
            data: [{ value: v, name: c.target !== null ? `${tr('Ziel', 'Target')}: ${fmt(c.target)}` : '' }]
          }
        ]
      };
    }
    default: {
      const horizontal = c.type === 'barHorizontal';
      const cat = { type: 'category' as const, data: p.categories, ...axisStyle, axisLabel: { color: t.muted, hideOverlap: true } };
      const val = { type: 'value' as const, ...axisStyle, axisLabel: { color: t.muted, formatter: (x: number) => formatValue(x, { ...c.format, decimals: null }) } };
      return {
        ...base,
        tooltip: { trigger: 'axis', valueFormatter: (v) => fmt(v), backgroundColor: t.bg, borderColor: t.grid, textStyle: { color: t.fg } },
        legend: p.series.length > 1 ? legend : undefined,
        grid: { ...gridBox, bottom: p.series.length > 1 && c.legend === 'bottom' ? 36 : 12, right: p.series.length > 1 && c.legend === 'right' ? 130 : 20 },
        xAxis: horizontal ? val : cat,
        yAxis: horizontal ? { ...cat, inverse: true } : val,
        series: p.series.map((s) => ({
          type: c.type === 'line' || c.type === 'area' ? 'line' : 'bar',
          name: s.name,
          data: s.values,
          stack: c.type === 'barStacked' || (c.type === 'area' && p.series.length > 1) ? 'total' : undefined,
          smooth: c.smooth,
          areaStyle: c.type === 'area' ? { opacity: 0.35 } : undefined,
          showSymbol: p.categories.length <= 40,
          barMaxWidth: 48,
          label: { show: c.labels, position: c.type === 'barStacked' ? 'inside' : horizontal ? 'right' : 'top', color: c.type === 'barStacked' ? '#fff' : t.fg, formatter: (x: { value: unknown }) => fmt(x.value) }
        }))
      } as EChartsOption;
    }
  }
}
