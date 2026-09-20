// Dump SQL file: choose objects, output file and options; runs as a backend task.

import { useEffect, useMemo, useState } from 'react';
import { FileCode, FolderOpen } from 'lucide-react';
import { tr } from '@shared/i18n';
import type { DumpObjects, DumpOptions, DumpProfile } from '@shared/apis/io';
import { defaultDumpOptions } from '@shared/io/defaults';
import { formatStamp } from '@shared/io/datetime';
import { safeFileName } from '@shared/util';
import { api } from '../../api/client';
import { errorDialog } from '../../components/ui/Dialog';
import { Button, Checkbox, Field, NumberInput, RadioGroup, Section, Select, Spinner } from '../../components/ui/controls';
import { PathInput } from '../../components/ui/PathInput';
import { ObjIcon, type ObjKind } from '../../components/icons';
import { TaskPanel } from '../../components/TaskPanel';
import { joinPath } from '../../lib/files';
import type { TabProps } from '../../store/tabs';
import { useTabs } from '../../store/tabs';
import { documentsDir, ProfileButtons, useTaskDone, withMeta, Wizard } from './common';

type Group = keyof DumpObjects;

const GROUPS: { id: Group; kind: ObjKind; label: () => string }[] = [
  { id: 'tables', kind: 'table', label: () => tr('Tabellen', 'Tables') },
  { id: 'views', kind: 'view', label: () => tr('Ansichten', 'Views') },
  { id: 'functions', kind: 'function', label: () => tr('Funktionen', 'Functions') },
  { id: 'procedures', kind: 'procedure', label: () => tr('Prozeduren', 'Procedures') },
  { id: 'triggers', kind: 'trigger', label: () => tr('Trigger', 'Triggers') },
  { id: 'events', kind: 'event', label: () => tr('Ereignisse', 'Events') }
];

const empty = (): DumpObjects => ({ tables: [], views: [], functions: [], procedures: [], triggers: [], events: [] });

export default function DumpSqlTab({ tab }: TabProps) {
  const params = tab.params as { connectionId: string; database: string; tables: string[] | null; structureOnly: boolean };
  const cid = params.connectionId;
  const db = params.database;
  const [step, setStep] = useState(0);
  const [all, setAll] = useState<DumpObjects | null>(null);
  const [sel, setSel] = useState<DumpObjects>(empty);
  const [file, setFile] = useState('');
  const [o, setO] = useState<DumpOptions>(() => defaultDumpOptions(params.structureOnly));
  const [taskId, setTaskId] = useState<string | null>(null);
  const [writtenFile, setWrittenFile] = useState<string | null>(null);
  const set = (patch: Partial<DumpOptions>) => setO((x) => ({ ...x, ...patch }));

  useEffect(() => {
    let cancelled = false;
    void withMeta(cid, async (sid) => {
      const [t, v, r, tg, e] = await Promise.all([api.meta.tables(sid, db), api.meta.views(sid, db), api.meta.routines(sid, db), api.meta.triggers(sid, db), api.meta.events(sid, db)]);
      return {
        tables: t.map((x) => x.name),
        views: v.map((x) => x.name),
        functions: r.filter((x) => x.type === 'FUNCTION').map((x) => x.name),
        procedures: r.filter((x) => x.type === 'PROCEDURE').map((x) => x.name),
        triggers: tg.map((x) => x.name),
        events: e.map((x) => x.name)
      } satisfies DumpObjects;
    })
      .then((objs) => {
        if (cancelled) return;
        setAll(objs);
        if (params.tables?.length) {
          const tables = objs.tables.filter((n) => params.tables!.includes(n));
          setSel({ ...empty(), tables, views: objs.views.filter((n) => params.tables!.includes(n)) });
        } else setSel(objs);
      })
      .catch((e) => {
        if (!cancelled) {
          setAll(empty());
          void errorDialog(e);
        }
      });
    void documentsDir().then((d) => {
      if (cancelled) return;
      setFile((f) => f || joinPath(d, `${safeFileName(db)}_${formatStamp('YYYYMMDD_HHmmss', new Date())}.sql`));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, db]);

  const running = useTaskDone(taskId, (status) => {
    if (status === 'done') setWrittenFile(file);
  });

  const count = useMemo(() => GROUPS.reduce((a, g) => a + sel[g.id].length, 0), [sel]);
  const toggle = (g: Group, name: string, on: boolean) =>
    setSel((s) => ({ ...s, [g]: on ? [...s[g], name].filter((x, i, arr) => arr.indexOf(x) === i) : s[g].filter((x) => x !== name) }));

  const profile = (): DumpProfile => {
    const everything = !!all && GROUPS.every((g) => sel[g.id].length === all[g.id].length);
    return { version: 1, connectionId: cid, database: db, file, objects: everything ? null : sel, options: o };
  };

  const start = async () => {
    try {
      setWrittenFile(null);
      setTaskId(await api.io.startDump(profile()));
    } catch (e) {
      void errorDialog(e);
    }
  };

  const steps = [
    { id: 'objects', label: tr('Objekte und Datei', 'Objects and file') },
    { id: 'options', label: tr('Optionen', 'Options') },
    { id: 'run', label: tr('Ausführen', 'Run') }
  ];

  return (
    <Wizard
      steps={steps}
      step={step}
      onStep={setStep}
      maxStep={count && file ? 2 : 0}
      canNext={count > 0 && !!file.trim()}
      running={running}
      onStart={() => void start()}
      startDisabled={!count || !file}
      footerLeft={
        <ProfileButtons<DumpProfile>
          kind="dumpSql"
          disabled={running}
          current={profile}
          onLoad={(p) => {
            if (p.database && p.database !== db) {
              void errorDialog(new Error(tr('Das Profil gehört zur Datenbank „{d}“.', 'The profile belongs to database "{d}".', { d: p.database })));
              return;
            }
            setFile(p.file ?? '');
            setO({ ...defaultDumpOptions(false), ...(p.options ?? {}) });
            if (all) {
              setSel(
                p.objects
                  ? Object.fromEntries(GROUPS.map((g) => [g.id, all[g.id].filter((n) => (p.objects![g.id] ?? []).includes(n))])) as unknown as DumpObjects
                  : all
              );
            }
          }}
        />
      }
    >
      {step === 0 && (
        <>
          <Field label={tr('Ausgabedatei', 'Output file')} labelWidth={130}>
            <PathInput
              mode="save"
              value={file}
              onChange={setFile}
              title={tr('SQL-Datei speichern', 'Save SQL file')}
              filters={[{ name: tr('SQL-Skripte', 'SQL scripts'), extensions: ['sql'] }]}
            />
          </Field>
          <Field label={tr('Inhalt', 'Content')} labelWidth={130}>
            <RadioGroup
              inline
              value={o.structureOnly ? 'structure' : 'data'}
              onChange={(v) => set({ structureOnly: v === 'structure' })}
              options={[
                { value: 'data', label: tr('Struktur und Daten', 'Structure and data') },
                { value: 'structure', label: tr('Nur Struktur', 'Structure only') }
              ]}
            />
          </Field>
          <div className="ks-io-box ks-io-grow">
            <div className="ks-io-box-head">
              <strong>{tr('Objekte von {d}', 'Objects of {d}', { d: db })}</strong>
              <span className="muted">{tr('{n} ausgewählt', '{n} selected', { n: count })}</span>
              <div className="spacer" />
              <Button size="sm" disabled={!all} onClick={() => all && setSel(all)}>
                {tr('Alle auswählen', 'Select all')}
              </Button>
              <Button size="sm" onClick={() => setSel(empty())}>
                {tr('Keine', 'None')}
              </Button>
            </div>
            <div className="ks-io-box-body">
              {!all ? (
                <div className="ks-io-preview-msg">
                  <Spinner />
                </div>
              ) : (
                GROUPS.filter((g) => all[g.id].length).map((g) => {
                  const n = sel[g.id].length;
                  return (
                    <div key={g.id}>
                      <div className="ks-io-list-item">
                        <Checkbox
                          checked={n === all[g.id].length}
                          indeterminate={n > 0 && n < all[g.id].length}
                          onChange={(on) => setSel((s) => ({ ...s, [g.id]: on ? all[g.id] : [] }))}
                          label={
                            <strong>
                              {g.label()} ({all[g.id].length})
                            </strong>
                          }
                        />
                      </div>
                      {all[g.id].map((name) => (
                        <div key={name} className="ks-io-list-item" style={{ paddingLeft: 32 }}>
                          <Checkbox
                            checked={sel[g.id].includes(name)}
                            onChange={(on) => toggle(g.id, name, on)}
                            label={
                              <span className="row" style={{ gap: 6 }}>
                                <ObjIcon kind={g.kind} size={14} />
                                {name}
                              </span>
                            }
                          />
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
              {all && GROUPS.every((g) => !all[g.id].length) && <div className="ks-io-preview-msg">{tr('Die Datenbank enthält keine Objekte.', 'The database contains no objects.')}</div>}
            </div>
          </div>
        </>
      )}
      {step === 1 && (
        <div className="ks-io-form">
          <Section title={tr('Struktur', 'Structure')}>
            <Checkbox checked={o.dropStatements} onChange={(v) => set({ dropStatements: v })} label={tr('DROP-Anweisungen vor CREATE', 'DROP statements before CREATE')} />
            <Checkbox checked={o.createDatabase} onChange={(v) => set({ createDatabase: v })} label={tr('CREATE DATABASE und USE einfügen', 'Add CREATE DATABASE and USE')} />
            <Checkbox checked={o.autoIncrement} onChange={(v) => set({ autoIncrement: v })} label={tr('AUTO_INCREMENT-Werte übernehmen', 'Include AUTO_INCREMENT values')} />
            <Checkbox checked={o.stripDefiner} onChange={(v) => set({ stripDefiner: v })} label={tr('DEFINER-Klauseln entfernen', 'Remove DEFINER clauses')} />
            <Checkbox checked={o.charsetHeader} onChange={(v) => set({ charsetHeader: v })} label={tr('Zeichensatz-Kopf (SET NAMES utf8mb4)', 'Charset header (SET NAMES utf8mb4)')} />
            <Checkbox checked={o.disableFkChecks} onChange={(v) => set({ disableFkChecks: v })} label={tr('Fremdschlüsselprüfung beim Einlesen abschalten', 'Disable foreign key checks while loading')} />
            <Checkbox checked={o.disableUniqueChecks} onChange={(v) => set({ disableUniqueChecks: v })} label={tr('Eindeutigkeitsprüfung beim Einlesen abschalten', 'Disable unique checks while loading')} />
          </Section>
          <Section title={tr('Daten', 'Data')}>
            <fieldset className="ks-plain-fieldset" disabled={o.structureOnly} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Checkbox checked={o.extendedInsert} onChange={(v) => set({ extendedInsert: v })} label={tr('Erweiterte INSERT-Anweisungen (mehrere Zeilen)', 'Extended INSERT statements (multiple rows)')} />
              <Field label={tr('Max. Zeilen je INSERT', 'Max. rows per INSERT')} labelWidth={170}>
                <NumberInput value={o.maxRowsPerInsert} min={1} disabled={!o.extendedInsert || o.structureOnly} style={{ width: 110 }} onChange={(v) => set({ maxRowsPerInsert: v === '' ? 1000 : v })} />
              </Field>
              <Field label={tr('Max. Größe je INSERT (KB)', 'Max. size per INSERT (KB)')} labelWidth={170}>
                <NumberInput value={o.maxInsertKB} min={16} disabled={!o.extendedInsert || o.structureOnly} style={{ width: 110 }} onChange={(v) => set({ maxInsertKB: v === '' ? 1024 : v })} />
              </Field>
              <Checkbox checked={o.completeInsert} onChange={(v) => set({ completeInsert: v })} label={tr('Vollständige Spaltenliste in INSERT', 'Complete column list in INSERT')} />
              <Field label={tr('Binärdaten als', 'Binary data as')} labelWidth={170}>
                <Select
                  value={o.binaryAs}
                  style={{ width: 200 }}
                  onChange={(v) => set({ binaryAs: v })}
                  options={[
                    { value: 'hex', label: tr('Hexadezimal (0x…)', 'Hexadecimal (0x…)') },
                    { value: 'base64', label: 'FROM_BASE64(…)' }
                  ]}
                />
              </Field>
              <Checkbox checked={o.addLocks} onChange={(v) => set({ addLocks: v })} label={tr('LOCK TABLES um die Daten jeder Tabelle', 'LOCK TABLES around the data of each table')} />
            </fieldset>
          </Section>
          <Section title={tr('Konsistenz beim Lesen', 'Read consistency')}>
            <RadioGroup
              value={o.consistency}
              onChange={(v) => set({ consistency: v })}
              options={[
                { value: 'snapshot', label: tr('Konsistenter Schnappschuss (InnoDB-Transaktion)', 'Consistent snapshot (InnoDB transaction)') },
                { value: 'lock', label: tr('Tabellen während der Ausgabe sperren (LOCK TABLES … READ)', 'Lock tables during the dump (LOCK TABLES … READ)') },
                { value: 'none', label: tr('Keine', 'None') }
              ]}
            />
          </Section>
        </div>
      )}
      {step === 2 && (
        <div className="ks-io-run">
          <div className="ks-io-summary">
            <span>{tr('Datenbank', 'Database')}</span>
            <span>{db}</span>
            <span>{tr('Datei', 'File')}</span>
            <span>{file}</span>
            <span>{tr('Inhalt', 'Content')}</span>
            <span>{o.structureOnly ? tr('Nur Struktur', 'Structure only') : tr('Struktur und Daten', 'Structure and data')}</span>
            <span>{tr('Objekte', 'Objects')}</span>
            <span>{GROUPS.filter((g) => sel[g.id].length).map((g) => `${g.label()}: ${sel[g.id].length}`).join(', ')}</span>
          </div>
          {taskId ? (
            <TaskPanel taskId={taskId} />
          ) : (
            <div className="muted">{tr('Klicken Sie auf „Starten“, um die SQL-Datei zu erstellen.', 'Click "Start" to write the SQL file.')}</div>
          )}
          {writtenFile && (
            <div className="row">
              <Button icon={<FileCode size={14} />} onClick={() => openDumpInEditor(cid, db, writtenFile)}>
                {tr('Im SQL-Editor öffnen', 'Open in SQL editor')}
              </Button>
              <Button icon={<FolderOpen size={14} />} onClick={() => void api.app.showItemInFolder(writtenFile)}>
                {tr('Im Ordner anzeigen', 'Show in folder')}
              </Button>
            </div>
          )}
        </div>
      )}
    </Wizard>
  );
}

function openDumpInEditor(connectionId: string, database: string, file: string): void {
  void api.fs
    .stat(file)
    .then((st) => {
      if (st.size > 20 * 1024 * 1024) {
        void errorDialog(new Error(tr('Die Datei ist zu groß für den Editor. Verwenden Sie „SQL-Datei ausführen“.', 'The file is too large for the editor. Use "Execute SQL File".')));
        return;
      }
      useTabs.getState().open({
        kind: 'query',
        key: `query:${file.toLowerCase()}`,
        title: file.split(/[\\/]/).pop() ?? file,
        icon: 'query',
        params: { connectionId, database, sql: null, file, saved: false },
        connectionId
      });
    })
    .catch((e) => void errorDialog(e));
}
