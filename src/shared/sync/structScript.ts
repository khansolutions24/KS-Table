// Structure synchronization: ordering of the deployment statements of the selected diff items and
// the script text. Shared by the structure sync tab (preview) and the headless profile runner.

import type { StructDeployStatement, StructDiffItem, StructPhase, SyncObjectType } from '../apis/sync';
import { tr } from '../i18n';
import { scriptStatement } from './sqlText';

/** Safe order: drop foreign keys → drop objects → tables → routines → views → triggers → events → add foreign keys */
export const STRUCT_PHASES: StructPhase[] = ['dropFk', 'drop', 'table', 'routine', 'view', 'trigger', 'event', 'addFk'];

/** Order of object types inside the drop phase (dependents first) */
const DROP_TYPE_ORDER: SyncObjectType[] = ['event', 'trigger', 'view', 'procedure', 'function', 'table'];

export function objectTypeLabel(type: SyncObjectType): string {
  switch (type) {
    case 'table':
      return tr('Tabelle', 'Table');
    case 'view':
      return tr('Ansicht', 'View');
    case 'function':
      return tr('Funktion', 'Function');
    case 'procedure':
      return tr('Prozedur', 'Procedure');
    case 'trigger':
      return tr('Trigger', 'Trigger');
    case 'event':
      return tr('Ereignis', 'Event');
  }
}

/** Statements of the selected, non-identical items in deployment order */
export function buildStructScript(items: StructDiffItem[], selected: ReadonlySet<string>): StructDeployStatement[] {
  const chosen = items.filter((i) => i.status !== 'same' && selected.has(i.id));
  const out: StructDeployStatement[] = [];
  for (const phase of STRUCT_PHASES) {
    const list = chosen.filter((i) => i.statements.some((s) => s.phase === phase));
    list.sort((a, b) => {
      if (phase === 'drop') {
        const ta = DROP_TYPE_ORDER.indexOf(a.type);
        const tb = DROP_TYPE_ORDER.indexOf(b.type);
        if (ta !== tb) return ta - tb;
      }
      return a.order - b.order || a.name.localeCompare(b.name);
    });
    for (const it of list) {
      for (const st of it.statements) {
        if (st.phase === phase) out.push({ sql: st.sql, itemId: it.id, label: `${objectTypeLabel(it.type)} ${it.name}` });
      }
    }
  }
  return out;
}

/** Script text for preview / file (stored programs wrapped in DELIMITER blocks) */
export function structScriptText(statements: StructDeployStatement[], header: string[] = []): string {
  const parts: string[] = header.map((h) => `-- ${h}`);
  if (parts.length) parts.push('');
  let lastItem: string | null | undefined;
  for (const st of statements) {
    if (st.itemId !== lastItem) {
      if (lastItem !== undefined) parts.push('');
      parts.push(`-- ${st.label}`);
      lastItem = st.itemId;
    }
    parts.push(scriptStatement(st.sql).trimEnd());
  }
  return `${parts.join('\n')}\n`;
}
