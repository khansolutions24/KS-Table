// Reverse engineering: imports tables and views of a database into a model
// (existing objects with the same name are updated in place, new ones are laid out).

import { useEffect, useState } from 'react';
import { DatabaseZap } from 'lucide-react';
import { tr } from '@shared/i18n';
import { newId } from '@shared/defaults';
import { toModelDesign } from '@shared/model/normalize';
import type { ModelDoc, ModelTable, ModelView, ViewAlgorithm, ViewCheckOption, ViewSecurity } from '@shared/model/types';
import { typeLabel } from '@shared/model/util';
import { api } from '../../api/client';
import { Button, Checkbox, SearchInput, Spinner } from '../../components/ui/controls';
import { Dialog, errorDialog, openDialog } from '../../components/ui/Dialog';
import { getProfile, metaSession, useWorkspace } from '../../store/workspace';
import { ConnectionDbPicker } from './ConnectionPicker';
import { layoutGraph } from './diagram/layout';
import { estimateTableSize } from './diagram/types';

export interface ReverseResult {
  connectionId: string;
  database: string;
  tables: string[];
  views: string[];
}

/** Loads the objects and merges them into `doc` (returns the new document). */
export async function reverseInto(doc: ModelDoc, r: ReverseResult): Promise<ModelDoc> {
  if (!(await useWorkspace.getState().openConnection(r.connectionId))) throw new Error(tr('Die Verbindung konnte nicht geöffnet werden.', 'The connection could not be opened.'));
  const sid = metaSession(r.connectionId);
  const designs = r.tables.length ? await api.model.tableDesigns(sid, r.database, r.tables) : [];
  const views = r.views.length ? await api.model.viewDefinitions(sid, r.database, r.views) : [];
  const lc = (s: string) => s.toLowerCase();
  const tables = [...doc.tables];
  const added: ModelTable[] = [];
  for (const d of designs) {
    const design = toModelDesign(d, r.database);
    const i = tables.findIndex((t) => lc(t.design.name) === lc(d.name));
    if (i >= 0) tables[i] = { ...tables[i], design };
    else {
      const t: ModelTable = { id: newId('mt'), design, x: 0, y: 0, color: null };
      tables.push(t);
      added.push(t);
    }
  }
  const mviews = [...doc.views];
  const addedViews: ModelView[] = [];
  for (const v of views) {
    const data = {
      name: v.name,
      definition: v.definition,
      algorithm: (v.algorithm || '') as ViewAlgorithm,
      security: (v.security || '') as ViewSecurity,
      checkOption: (v.checkOption || '') as ViewCheckOption,
      syncedAs: null
    };
    const i = mviews.findIndex((x) => lc(x.name) === lc(v.name));
    if (i >= 0) mviews[i] = { ...mviews[i], ...data };
    else {
      const nv: ModelView = { id: newId('mv'), comment: '', x: 0, y: 0, color: null, ...data };
      mviews.push(nv);
      addedViews.push(nv);
    }
  }
  // place new objects below the existing content
  const existing = doc.tables.map((t) => t.y + estimateTableSize(t.design.name, t.design.fields.map((f) => ({ name: f.name, type: typeLabel(f) })), doc.display.showTypes).height);
  const originY = doc.tables.length || doc.views.length ? Math.max(0, ...existing, ...doc.views.map((v) => v.y + 160)) + 100 : 0;
  const positions = layoutGraph(
    [
      ...added.map((t) => ({ id: t.id, ...estimateTableSize(t.design.name, t.design.fields.map((f) => ({ name: f.name, type: typeLabel(f) })), doc.display.showTypes) })),
      ...addedViews.map((v) => ({ id: v.id, width: 260, height: 140 }))
    ],
    added.flatMap((t) => t.design.foreignKeys.filter((fk) => !fk.refSchema).map((fk) => ({ from: t.id, to: tables.find((x) => lc(x.design.name) === lc(fk.refTable))?.id ?? '' }))),
    { origin: { x: 0, y: originY } }
  );
  const place = <T extends { id: string; x: number; y: number }>(o: T): T => {
    const p = positions.get(o.id);
    return p ? { ...o, x: p.x, y: p.y } : o;
  };
  return {
    ...doc,
    schema: doc.schema || r.database,
    tables: tables.map(place),
    views: mviews.map(place),
    name: doc.tables.length || doc.views.length ? doc.name : r.database,
    source: { connection: getProfile(r.connectionId)?.name ?? '', database: r.database, time: Date.now() }
  };
}

export function openReverseDialog(initial?: { connectionId: string; database: string }): Promise<ReverseResult | null> {
  return openDialog<ReverseResult | null>((close) => <ReverseDialog initial={initial} close={close} />).then((v) => v ?? null);
}

interface Obj {
  name: string;
  kind: 'table' | 'view';
  info: string;
}

function ReverseDialog({ initial, close }: { initial?: { connectionId: string; database: string }; close: (v?: ReverseResult | null) => void }) {
  const [cid, setCid] = useState(initial?.connectionId ?? '');
  const [db, setDb] = useState(initial?.database ?? '');
  const [objs, setObjs] = useState<Obj[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const connOpen = useWorkspace((s) => (cid ? s.conns[cid]?.status === 'open' : false));

  useEffect(() => {
    setObjs(null);
    if (!cid || !db || !connOpen) return;
    let alive = true;
    setLoading(true);
    const sid = metaSession(cid);
    Promise.all([api.meta.tables(sid, db), api.meta.views(sid, db)])
      .then(([t, v]) => {
        if (!alive) return;
        const list: Obj[] = [
          ...t.filter((x) => x.type === 'BASE TABLE').map((x) => ({ name: x.name, kind: 'table' as const, info: x.comment })),
          ...v.map((x) => ({ name: x.name, kind: 'view' as const, info: tr('Ansicht', 'View') }))
        ];
        setObjs(list);
        setChecked(new Set(list.map((o) => `${o.kind}:${o.name}`)));
      })
      .catch((e) => alive && void errorDialog(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cid, db, connOpen]);

  const visible = (objs ?? []).filter((o) => !search || o.name.toLowerCase().includes(search.toLowerCase()));
  const submit = () => {
    if (!objs || !checked.size) return;
    close({
      connectionId: cid,
      database: db,
      tables: objs.filter((o) => o.kind === 'table' && checked.has(`table:${o.name}`)).map((o) => o.name),
      views: objs.filter((o) => o.kind === 'view' && checked.has(`view:${o.name}`)).map((o) => o.name)
    });
  };
  return (
    <Dialog
      title={tr('Datenbank in Modell übernehmen', 'Reverse Engineer Database')}
      icon={<DatabaseZap size={16} />}
      width={560}
      height={600}
      onClose={() => close(null)}
      onSubmit={submit}
      footerLeft={objs && <span className="muted">{tr('{n} ausgewählt', '{n} selected', { n: checked.size })}</span>}
      footer={
        <>
          <Button type="submit" variant="primary" disabled={!checked.size}>
            {tr('Übernehmen', 'Import')}
          </Button>
          <Button onClick={() => close(null)}>{tr('Abbrechen', 'Cancel')}</Button>
        </>
      }
    >
      <div className="ks-form" style={{ height: '100%' }}>
        <ConnectionDbPicker
          connectionId={cid}
          database={db}
          onChange={(c, d) => {
            setCid(c);
            setDb(d);
          }}
        />
        <div className="ks-md-listbar">
          <SearchInput value={search} onChange={setSearch} className="grow" />
          <Button size="sm" variant="link" disabled={!objs} onClick={() => setChecked(new Set((objs ?? []).map((o) => `${o.kind}:${o.name}`)))}>
            {tr('Alle', 'All')}
          </Button>
          <Button size="sm" variant="link" disabled={!objs} onClick={() => setChecked(new Set())}>
            {tr('Keine', 'None')}
          </Button>
        </div>
        <div className="ks-md-objlist" style={{ minHeight: 260 }}>
          {loading && <Spinner />}
          {!loading && !objs && <div className="faint">{tr('Verbindung und Datenbank wählen.', 'Choose a connection and a database.')}</div>}
          {visible.map((o) => {
            const key = `${o.kind}:${o.name}`;
            return (
              <Checkbox
                key={key}
                checked={checked.has(key)}
                onChange={(v) =>
                  setChecked((s) => {
                    const n = new Set(s);
                    if (v) n.add(key);
                    else n.delete(key);
                    return n;
                  })
                }
                label={
                  <span className="row" style={{ gap: 6, minWidth: 0 }}>
                    <span>{o.name}</span>
                    {o.info && <span className="faint ellipsis">{o.info}</span>}
                  </span>
                }
              />
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
