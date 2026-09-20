// Chart workspaces (.kscharts): data sources (SQL queries), charts and dashboards.

import { newId } from '@shared/defaults';
import { tr } from '@shared/i18n';

export const WORKSPACE_FORMAT = 'ks-charts';
export const WORKSPACE_EXT = 'kscharts';

export interface DataSource {
  id: string;
  name: string;
  connectionId: string;
  database: string;
  sql: string;
  /** Row limit of the query (0 = unlimited) */
  maxRows: number;
}

export type ChartType = 'bar' | 'barStacked' | 'barHorizontal' | 'line' | 'area' | 'pie' | 'donut' | 'scatter' | 'heatmap' | 'kpi' | 'gauge' | 'table';
export type Aggregation = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'distinct' | 'none';
export type DatePart = '' | 'year' | 'quarter' | 'month' | 'day' | 'hour' | 'weekday';
export type FilterOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'contains' | 'notContains' | 'startsWith' | 'endsWith' | 'empty' | 'notEmpty' | 'between' | 'in';
export type SortMode = 'none' | 'category' | 'categoryDesc' | 'valueAsc' | 'valueDesc';

export interface ValueField {
  field: string;
  agg: Aggregation;
  label: string;
}

export interface ChartFilter {
  field: string;
  op: FilterOp;
  value: string;
  value2: string;
}

export interface NumberFormat {
  decimals: number | null;
  prefix: string;
  suffix: string;
  thousands: boolean;
  unit: '' | 'K' | 'M' | 'B';
}

export interface ChartDef {
  id: string;
  name: string;
  sourceId: string;
  type: ChartType;
  /** Category / x axis field */
  category: string;
  datePart: DatePart;
  values: ValueField[];
  /** Series / color by field */
  series: string;
  filters: ChartFilter[];
  sort: SortMode;
  /** Top N categories (0 = all) */
  limit: number;
  title: string;
  showTitle: boolean;
  legend: 'top' | 'bottom' | 'right' | 'none';
  labels: boolean;
  smooth: boolean;
  palette: string;
  format: NumberFormat;
  /** KPI / gauge */
  target: number | null;
  min: number | null;
  max: number | null;
}

export interface DashboardItem {
  id: string;
  kind: 'chart' | 'text';
  chartId: string;
  text: string;
  /** Grid units (12 columns, rows of ROW_HEIGHT px) */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Dashboard {
  id: string;
  name: string;
  items: DashboardItem[];
  /** Seconds, 0 = off */
  refresh: number;
}

export interface ChartWorkspace {
  format: typeof WORKSPACE_FORMAT;
  version: number;
  name: string;
  sources: DataSource[];
  charts: ChartDef[];
  dashboards: Dashboard[];
  updatedAt: number;
}

export const DASH_COLUMNS = 12;
export const ROW_HEIGHT = 44;

export function newWorkspace(name: string): ChartWorkspace {
  return { format: WORKSPACE_FORMAT, version: 1, name, sources: [], charts: [], dashboards: [], updatedAt: Date.now() };
}

export function newSource(name: string, connectionId = '', database = ''): DataSource {
  return { id: newId('ds'), name, connectionId, database, sql: '', maxRows: 50000 };
}

export function newChart(name: string, sourceId: string): ChartDef {
  return {
    id: newId('ch'),
    name,
    sourceId,
    type: 'bar',
    category: '',
    datePart: '',
    values: [],
    series: '',
    filters: [],
    sort: 'none',
    limit: 0,
    title: '',
    showTitle: true,
    legend: 'bottom',
    labels: false,
    smooth: false,
    palette: 'default',
    format: { decimals: null, prefix: '', suffix: '', thousands: true, unit: '' },
    target: null,
    min: null,
    max: null
  };
}

export function newDashboard(name: string): Dashboard {
  return { id: newId('db'), name, items: [], refresh: 0 };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge<T extends object>(def: T, raw: unknown): T {
  if (!isObj(raw)) return def;
  const out: Obj = { ...(def as Obj) };
  for (const [k, dv] of Object.entries(def as Obj)) {
    const v = raw[k];
    if (v === undefined) continue;
    if (dv === null ? v === null || typeof v === 'number' : Array.isArray(dv) ? Array.isArray(v) : isObj(dv) ? isObj(v) : typeof v === typeof dv) out[k] = isObj(dv) && isObj(v) ? merge(dv, v) : v;
  }
  return out as T;
}

export function parseWorkspace(text: string): ChartWorkspace {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(tr('Die Datei ist beschädigt (kein gültiges JSON).', 'The file is damaged (not valid JSON).'));
  }
  if (!isObj(raw) || raw.format !== WORKSPACE_FORMAT) throw new Error(tr('Die Datei ist kein KS-Table-Diagramm-Arbeitsbereich.', 'The file is not a KS Table chart workspace.'));
  const ws = merge(newWorkspace(''), raw);
  return {
    ...ws,
    sources: (Array.isArray(raw.sources) ? raw.sources : []).map((s) => merge(newSource(''), s)),
    charts: (Array.isArray(raw.charts) ? raw.charts : []).map((c) => {
      const ch = merge(newChart('', ''), c);
      return {
        ...ch,
        values: ch.values.filter(isObj).map((v) => merge<ValueField>({ field: '', agg: 'sum', label: '' }, v)),
        filters: ch.filters.filter(isObj).map((f) => merge<ChartFilter>({ field: '', op: '=', value: '', value2: '' }, f))
      };
    }),
    dashboards: (Array.isArray(raw.dashboards) ? raw.dashboards : []).map((d) => {
      const db = merge(newDashboard(''), d);
      return { ...db, items: db.items.filter(isObj).map((i) => merge<DashboardItem>({ id: newId('di'), kind: 'chart', chartId: '', text: '', x: 0, y: 0, w: 6, h: 6 }, i)) };
    })
  };
}

export const CHART_TYPES: { type: ChartType; label: () => string }[] = [
  { type: 'bar', label: () => tr('Säulen', 'Bars') },
  { type: 'barStacked', label: () => tr('Gestapelte Säulen', 'Stacked bars') },
  { type: 'barHorizontal', label: () => tr('Balken (horizontal)', 'Horizontal bars') },
  { type: 'line', label: () => tr('Linie', 'Line') },
  { type: 'area', label: () => tr('Fläche', 'Area') },
  { type: 'pie', label: () => tr('Kreis', 'Pie') },
  { type: 'donut', label: () => tr('Ring', 'Donut') },
  { type: 'scatter', label: () => tr('Streuung', 'Scatter') },
  { type: 'heatmap', label: () => tr('Heatmap', 'Heatmap') },
  { type: 'kpi', label: () => tr('Kennzahl', 'KPI value') },
  { type: 'gauge', label: () => tr('Tacho', 'Gauge') },
  { type: 'table', label: () => tr('Tabelle', 'Table') }
];

export const AGGREGATIONS: { value: Aggregation; label: () => string }[] = [
  { value: 'sum', label: () => tr('Summe', 'Sum') },
  { value: 'count', label: () => tr('Anzahl', 'Count') },
  { value: 'distinct', label: () => tr('Anzahl eindeutig', 'Distinct count') },
  { value: 'avg', label: () => tr('Durchschnitt', 'Average') },
  { value: 'min', label: () => tr('Minimum', 'Minimum') },
  { value: 'max', label: () => tr('Maximum', 'Maximum') },
  { value: 'none', label: () => tr('Keine (Rohwerte)', 'None (raw values)') }
];
