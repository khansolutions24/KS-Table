// Per-tab state of the query editor results (one zustand store per QueryTab instance).

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { newId } from '@shared/defaults';
import type { CellValue, ResultColumn, StatementResult } from '@shared/types';
import type { EditableInfo } from './editableResult';
import { emptyEdits, type GridEditState } from './gridEdits';
import type { StatusDelta } from './statusDiff';

export type FilterOp = 'eq' | 'ne' | 'null' | 'notnull';

export interface ClientFilter {
  col: number;
  op: FilterOp;
  value: CellValue;
}

export interface ResultSet {
  id: string;
  title: string;
  statementIndex: number;
  sql: string;
  columns: ResultColumn[];
  rows: CellValue[][];
  truncated: boolean;
  durationMs: number;
  startedAt: number;
  pinned: boolean;
  /** editing information when the result maps to one table with primary key */
  editable: EditableInfo | null;
  /** why the result is read-only (null while it is being checked) */
  readOnlyReason: string | null;
  editState: GridEditState;
  filters: ClientFilter[];
  sort: { col: number; desc: boolean } | null;
}

export interface RunMessages {
  runId: string;
  results: StatementResult[];
  totalMs: number;
  cancelled: boolean;
  /** statements can be located in the editor */
  mapped: boolean;
  startedAt: number;
  /** result sets that got no own result tab */
  hiddenResults: number;
}

export interface ExplainData {
  sql: string;
  startedAt: number;
  json: string | null;
  jsonError: string | null;
  table: { columns: ResultColumn[]; rows: CellValue[][] } | null;
  tableError: string | null;
  tree: string | null;
  treeError: string | null;
}

export interface ProfileEntry {
  queryId: number;
  durationSec: number;
  sql: string;
  stages: { status: string; durationSec: number }[];
}

export interface QueryStoreState {
  running: 'run' | 'explain' | null;
  cancelling: boolean;
  progress: { index: number; total: number; sql: string } | null;
  startedAt: number | null;
  results: ResultSet[];
  messages: RunMessages | null;
  explain: ExplainData | null;
  profile: ProfileEntry[] | null;
  status: StatusDelta[] | null;
  profileError: string | null;
  activeTab: string;
  lastRun: { totalMs: number; rows: number; affected: number; statements: number; errors: number; cancelled: boolean } | null;
}

export type QueryStore = UseBoundStore<StoreApi<QueryStoreState>>;

/** Callbacks of the query tab used by the result views */
export interface ResultsHost {
  connectionId(): string;
  database(): string | null;
  sessionId(): string | null;
  /** a transaction is open on the tab session (grid edits then run inside it) */
  inTransaction(): boolean;
  /** select statement `index` of the last run in the editor */
  selectStatement(index: number): void;
}

export function createQueryStore(): QueryStore {
  return create<QueryStoreState>(() => ({
    running: null,
    cancelling: false,
    progress: null,
    startedAt: null,
    results: [],
    messages: null,
    explain: null,
    profile: null,
    status: null,
    profileError: null,
    activeTab: 'messages',
    lastRun: null
  }));
}

export function newResultSet(p: Pick<ResultSet, 'title' | 'statementIndex' | 'sql' | 'columns' | 'rows' | 'truncated' | 'durationMs' | 'startedAt'>): ResultSet {
  return { ...p, id: newId('r'), pinned: false, editable: null, readOnlyReason: null, editState: emptyEdits(), filters: [], sort: null };
}

export function patchResult(store: QueryStore, id: string, patch: Partial<ResultSet> | ((r: ResultSet) => Partial<ResultSet>)): void {
  store.setState((s) => ({ results: s.results.map((r) => (r.id === id ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r)) }));
}

/** Pins / unpins a result; pinned results stay left in pin order. */
export function togglePin(store: QueryStore, id: string): void {
  store.setState((s) => {
    const r = s.results.find((x) => x.id === id);
    if (!r) return s;
    const rest = s.results.filter((x) => x.id !== id);
    const pinned = rest.filter((x) => x.pinned);
    const unpinned = rest.filter((x) => !x.pinned);
    const moved = { ...r, pinned: !r.pinned };
    return { results: moved.pinned ? [...pinned, moved, ...unpinned] : [...pinned, moved, ...unpinned] };
  });
}

/** Ids of the visible result tabs in display order (for Alt+1 … Alt+9). */
export function visibleTabIds(s: QueryStoreState): string[] {
  const ids = s.results.map((r) => r.id);
  ids.push('messages');
  if (s.explain) ids.push('explain');
  if (s.profile || s.profileError) ids.push('profile');
  if (s.status) ids.push('status');
  return ids;
}
