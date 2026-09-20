// Model documents (.ksmodel) of the data modeling feature: tables (TableDesign), views, notes,
// labels, shapes and layers with their canvas positions plus display options.

import type { CheckDef, FieldDef, ForeignKeyDef, IndexDef, TableDesign, TableOptions, TriggerDef } from '../types';
import { defaultTableOptions, newField, newId } from '../defaults';
import { tr } from '../i18n';

export const MODEL_FORMAT = 'ks-model';
export const MODEL_VERSION = 1;
export const MODEL_EXT = 'ksmodel';

export type Notation = 'crowsfoot' | 'arrow';
export type ShapeKind = 'rect' | 'rounded' | 'ellipse' | 'diamond';

export interface ModelDisplay {
  notation: Notation;
  showTypes: boolean;
  showComments: boolean;
  /** Show only primary key / foreign key / referenced columns */
  keysOnly: boolean;
  showRelationNames: boolean;
  showGrid: boolean;
  snapToGrid: boolean;
  gridSize: number;
  showMinimap: boolean;
}

interface Placed {
  id: string;
  x: number;
  y: number;
}

export interface ModelTable extends Placed {
  /** Table structure. `schema` is empty; foreign keys to tables of the model have an empty `refSchema`. */
  design: TableDesign;
  /** Fixed width in px (undefined = fit content) */
  width?: number;
  color: string | null;
}

export type ViewAlgorithm = '' | 'UNDEFINED' | 'MERGE' | 'TEMPTABLE';
export type ViewSecurity = '' | 'DEFINER' | 'INVOKER';
export type ViewCheckOption = '' | 'CASCADED' | 'LOCAL';

export interface ModelView extends Placed {
  name: string;
  /** SELECT statement of the view (without CREATE VIEW … AS) */
  definition: string;
  algorithm: ViewAlgorithm;
  security: ViewSecurity;
  checkOption: ViewCheckOption;
  /** Documentation only (MySQL views have no comment) */
  comment: string;
  width?: number;
  color: string | null;
  /** Definition as rewritten by the server at the last synchronization of `source` (comparison aid) */
  syncedAs?: { source: string; server: string } | null;
}

export interface ModelNote extends Placed {
  text: string;
  width: number;
  height: number;
  color: string | null;
}

export interface ModelLabel extends Placed {
  text: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string | null;
}

export interface ModelShape extends Placed {
  kind: ShapeKind;
  text: string;
  width: number;
  height: number;
  color: string | null;
}

/** Titled region; objects lying inside move together with the layer. */
export interface ModelLayer extends Placed {
  name: string;
  width: number;
  height: number;
  color: string | null;
}

export interface ModelDoc {
  format: typeof MODEL_FORMAT;
  version: number;
  name: string;
  description: string;
  /** Server type / version the generated SQL is written for */
  target: { type: 'mysql' | 'mariadb'; version: string };
  /** Default database for scripts and synchronization ('' = none) */
  schema: string;
  tables: ModelTable[];
  views: ModelView[];
  notes: ModelNote[];
  labels: ModelLabel[];
  shapes: ModelShape[];
  layers: ModelLayer[];
  /** Line colors of relations, key = relationKey(tableId, foreignKeyId) */
  relationColors: Record<string, string>;
  display: ModelDisplay;
  viewport: { x: number; y: number; zoom: number } | null;
  /** Origin of reverse engineered content */
  source: { connection: string; database: string; time: number } | null;
  createdAt: number;
  updatedAt: number;
}

export function defaultDisplay(): ModelDisplay {
  return {
    notation: 'crowsfoot',
    showTypes: true,
    showComments: false,
    keysOnly: false,
    showRelationNames: false,
    showGrid: true,
    snapToGrid: true,
    gridSize: 16,
    showMinimap: true
  };
}

export function newModelDoc(name: string): ModelDoc {
  const now = Date.now();
  return {
    format: MODEL_FORMAT,
    version: MODEL_VERSION,
    name,
    description: '',
    target: { type: 'mysql', version: '8.0' },
    schema: '',
    tables: [],
    views: [],
    notes: [],
    labels: [],
    shapes: [],
    layers: [],
    relationColors: {},
    display: defaultDisplay(),
    viewport: null,
    source: null,
    createdAt: now,
    updatedAt: now
  };
}

export function isModelEmpty(doc: ModelDoc): boolean {
  return !doc.tables.length && !doc.views.length && !doc.notes.length && !doc.labels.length && !doc.shapes.length && !doc.layers.length;
}

export function serializeModelDoc(doc: ModelDoc): string {
  return JSON.stringify(doc, null, 1);
}

// ───────────────────────── Loading (tolerant validation) ─────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, def = ''): string => (typeof v === 'string' ? v : def);
const numOr = (v: unknown, def: number): number => (typeof v === 'number' && isFinite(v) ? v : def);
const colorOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def);

/** Copies values of `raw` whose type matches the default value. */
function pick<T extends object>(defaults: T, raw: unknown): T {
  const out: Obj = { ...(defaults as Obj) };
  if (!isObj(raw)) return out as T;
  for (const [k, dv] of Object.entries(defaults as Obj)) {
    const v = raw[k];
    if (v === undefined) continue;
    if (Array.isArray(dv) ? Array.isArray(v) : typeof v === typeof dv) out[k] = v;
  }
  return out as T;
}

const optName = (raw: Obj): { origName?: string } => (typeof raw.origName === 'string' && raw.origName ? { origName: raw.origName } : {});

function sanitizeField(raw: unknown): FieldDef | null {
  if (!isObj(raw) || typeof raw.name !== 'string') return null;
  const f = pick(newField(), raw);
  return {
    ...f,
    ...optName(raw),
    id: str(raw.id) || newId('f'),
    type: (f.type || 'VARCHAR').toUpperCase(),
    values: arr(raw.values).map((v) => String(v)),
    defaultKind: oneOf(raw.defaultKind, ['none', 'null', 'empty', 'value', 'expression'] as const, 'none')
  };
}

function sanitizeIndex(raw: unknown): IndexDef | null {
  if (!isObj(raw)) return null;
  const base: IndexDef = { id: '', name: '', fields: [], type: 'NORMAL', method: '', comment: '', invisible: false, parser: '', keyBlockSize: '' };
  const ix = pick(base, raw);
  return {
    ...ix,
    ...optName(raw),
    id: str(raw.id) || newId('i'),
    type: oneOf(raw.type, ['NORMAL', 'UNIQUE', 'FULLTEXT', 'SPATIAL'] as const, 'NORMAL'),
    method: oneOf(raw.method, ['', 'BTREE', 'HASH'] as const, ''),
    fields: arr(raw.fields)
      .filter(isObj)
      .map((p) => ({
        name: str(p.name),
        subPart: str(p.subPart),
        order: oneOf(p.order, ['', 'ASC', 'DESC'] as const, ''),
        ...(typeof p.expr === 'string' && p.expr ? { expr: p.expr } : {})
      }))
  };
}

const FK_ACTIONS = ['', 'RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'] as const;

function sanitizeForeignKey(raw: unknown): ForeignKeyDef | null {
  if (!isObj(raw)) return null;
  return {
    ...optName(raw),
    id: str(raw.id) || newId('r'),
    name: str(raw.name),
    fields: arr(raw.fields).map(String),
    refSchema: str(raw.refSchema),
    refTable: str(raw.refTable),
    refFields: arr(raw.refFields).map(String),
    onDelete: oneOf(raw.onDelete, FK_ACTIONS, ''),
    onUpdate: oneOf(raw.onUpdate, FK_ACTIONS, '')
  };
}

function sanitizeCheck(raw: unknown): CheckDef | null {
  if (!isObj(raw)) return null;
  return { ...optName(raw), id: str(raw.id) || newId('k'), name: str(raw.name), expr: str(raw.expr), enforced: raw.enforced !== false };
}

function sanitizeTrigger(raw: unknown): TriggerDef | null {
  if (!isObj(raw)) return null;
  return {
    ...optName(raw),
    id: str(raw.id) || newId('t'),
    name: str(raw.name),
    timing: oneOf(raw.timing, ['BEFORE', 'AFTER'] as const, 'BEFORE'),
    event: oneOf(raw.event, ['INSERT', 'UPDATE', 'DELETE'] as const, 'INSERT'),
    body: str(raw.body),
    definer: str(raw.definer),
    orderType: oneOf(raw.orderType, ['', 'FOLLOWS', 'PRECEDES'] as const, ''),
    orderOther: str(raw.orderOther)
  };
}

const nn = <T>(x: T | null): x is T => x !== null;

export function sanitizeDesign(raw: unknown): TableDesign | null {
  if (!isObj(raw) || typeof raw.name !== 'string') return null;
  return {
    ...optName(raw),
    schema: str(raw.schema),
    name: raw.name,
    fields: arr(raw.fields).map(sanitizeField).filter(nn),
    primaryKey: arr(raw.primaryKey).map(String),
    indexes: arr(raw.indexes).map(sanitizeIndex).filter(nn),
    foreignKeys: arr(raw.foreignKeys).map(sanitizeForeignKey).filter(nn),
    checks: arr(raw.checks).map(sanitizeCheck).filter(nn),
    triggers: arr(raw.triggers).map(sanitizeTrigger).filter(nn),
    options: pick<TableOptions>(defaultTableOptions(), raw.options),
    comment: str(raw.comment),
    partition: str(raw.partition)
  };
}

function sanitizeTable(raw: unknown): ModelTable | null {
  if (!isObj(raw)) return null;
  const design = sanitizeDesign(raw.design);
  if (!design) return null;
  return {
    id: str(raw.id) || newId('mt'),
    design,
    x: numOr(raw.x, 0),
    y: numOr(raw.y, 0),
    ...(typeof raw.width === 'number' && raw.width > 0 ? { width: raw.width } : {}),
    color: colorOf(raw.color)
  };
}

function sanitizeView(raw: unknown): ModelView | null {
  if (!isObj(raw) || typeof raw.name !== 'string') return null;
  return {
    id: str(raw.id) || newId('mv'),
    name: raw.name,
    definition: str(raw.definition),
    algorithm: oneOf(raw.algorithm, ['', 'UNDEFINED', 'MERGE', 'TEMPTABLE'] as const, ''),
    security: oneOf(raw.security, ['', 'DEFINER', 'INVOKER'] as const, ''),
    checkOption: oneOf(raw.checkOption, ['', 'CASCADED', 'LOCAL'] as const, ''),
    comment: str(raw.comment),
    x: numOr(raw.x, 0),
    y: numOr(raw.y, 0),
    ...(typeof raw.width === 'number' && raw.width > 0 ? { width: raw.width } : {}),
    color: colorOf(raw.color),
    syncedAs: isObj(raw.syncedAs) && typeof raw.syncedAs.source === 'string' && typeof raw.syncedAs.server === 'string' ? { source: raw.syncedAs.source, server: raw.syncedAs.server } : null
  };
}

function sanitizeBox<T extends Placed & { width: number; height: number; color: string | null }>(raw: unknown, extra: (o: Obj) => Omit<T, keyof Placed | 'width' | 'height' | 'color'> | null, w: number, h: number): T | null {
  if (!isObj(raw)) return null;
  const rest = extra(raw);
  if (!rest) return null;
  return {
    id: str(raw.id) || newId('mo'),
    x: numOr(raw.x, 0),
    y: numOr(raw.y, 0),
    width: Math.max(20, numOr(raw.width, w)),
    height: Math.max(20, numOr(raw.height, h)),
    color: colorOf(raw.color),
    ...rest
  } as T;
}

/** Parses the content of a .ksmodel file (throws a user readable error). */
export function parseModelDoc(text: string): ModelDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(tr('Die Modelldatei ist beschädigt (kein gültiges JSON).', 'The model file is damaged (not valid JSON).'));
  }
  if (!isObj(raw) || raw.format !== MODEL_FORMAT) {
    throw new Error(tr('Die Datei ist kein KS-Table-Modell.', 'The file is not a KS Table model.'));
  }
  if (typeof raw.version === 'number' && raw.version > MODEL_VERSION) {
    throw new Error(tr('Das Modell wurde mit einer neueren Programmversion erstellt.', 'The model was created with a newer version of the program.'));
  }
  const base = newModelDoc(str(raw.name, tr('Modell', 'Model')));
  const target = isObj(raw.target) ? raw.target : {};
  const vp = isObj(raw.viewport) ? raw.viewport : null;
  const src = isObj(raw.source) ? raw.source : null;
  const colors: Record<string, string> = {};
  if (isObj(raw.relationColors)) for (const [k, v] of Object.entries(raw.relationColors)) if (typeof v === 'string') colors[k] = v;
  return {
    ...base,
    description: str(raw.description),
    target: { type: target.type === 'mariadb' ? 'mariadb' : 'mysql', version: str(target.version, '8.0') },
    schema: str(raw.schema),
    tables: arr(raw.tables).map(sanitizeTable).filter(nn),
    views: arr(raw.views).map(sanitizeView).filter(nn),
    notes: arr(raw.notes)
      .map((n) => sanitizeBox<ModelNote>(n, (o) => ({ text: str(o.text) }), 200, 120))
      .filter(nn),
    labels: arr(raw.labels)
      .map((l): ModelLabel | null =>
        isObj(l)
          ? {
              id: str(l.id) || newId('ml'),
              x: numOr(l.x, 0),
              y: numOr(l.y, 0),
              text: str(l.text),
              fontSize: Math.min(96, Math.max(8, numOr(l.fontSize, 16))),
              bold: l.bold === true,
              italic: l.italic === true,
              color: colorOf(l.color)
            }
          : null
      )
      .filter(nn),
    shapes: arr(raw.shapes)
      .map((s) => sanitizeBox<ModelShape>(s, (o) => ({ kind: oneOf(o.kind, ['rect', 'rounded', 'ellipse', 'diamond'] as const, 'rect'), text: str(o.text) }), 140, 90))
      .filter(nn),
    layers: arr(raw.layers)
      .map((g) => sanitizeBox<ModelLayer>(g, (o) => ({ name: str(o.name) }), 400, 300))
      .filter(nn),
    relationColors: colors,
    display: pick(defaultDisplay(), raw.display),
    viewport: vp ? { x: numOr(vp.x, 0), y: numOr(vp.y, 0), zoom: Math.min(4, Math.max(0.05, numOr(vp.zoom, 1))) } : null,
    source: src ? { connection: str(src.connection), database: str(src.database), time: numOr(src.time, 0) } : null,
    createdAt: numOr(raw.createdAt, base.createdAt),
    updatedAt: numOr(raw.updatedAt, base.updatedAt)
  };
}
